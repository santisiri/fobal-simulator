// Workstream I — the market over HTTP. The index is injected, so these
// tests are about the ROUTES: public access, the join with player data,
// throttled refresh, and degrading honestly when a read fails.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { startMatchServer } from '@fobal/match-server';
import { startLobbyServer } from '../src/index.js';
import type { Listing, MarketReader, Sale } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-mkt-'));

const listing = (tokenId: string, price: string): Listing => ({
  tokenId, seller: '0xaaa', asset: '0x' + '0'.repeat(40), price, expiry: 0, block: 10,
});
const sale = (tokenId: string, price: string, block: number): Sale => ({
  tokenId, seller: '0xaaa', buyer: '0xbbb', asset: '0x' + '0'.repeat(40), price, fee: '1', block,
});

function fakeMarket(overrides: Partial<MarketReader> = {}){
  let refreshes = 0;
  const reader: MarketReader = {
    async refresh(){ refreshes++; },
    listings: () => [listing('7', '2500000000000000000'), listing('9', '1000000000000000000')],
    listingFor: id => (id === '7' ? listing('7', '2500000000000000000') : null),
    salesFor: id => (id === '7' ? [sale('7', '900', 5), sale('7', '2000', 9)] : []),
    summary: () => ({ listed: 2, sales: 2, floor: '1000000000000000000', lastBlock: 42 }),
    lastBlock: 42,
    ...overrides,
  };
  return { reader, refreshes: () => refreshes };
}

const fakeChain = (fail = false) => ({
  readTeam: async () => { throw new Error('unused'); },
  readPlayer: async (tokenId: bigint) => {
    if (fail) throw new Error('rpc down');
    return {
      tokenId: tokenId.toString(), name: `Player ${tokenId}`, owner: '0xaaa', lockedBy: null,
      position: 3, role: 'ST', generation: 1, level: 2, xp: 120,
      career: { matchesPlayed: 3, wins: 2, draws: 0, losses: 1, goals: 4, assists: 1, cleanSheets: 0 },
      ratings: {
        pace: 80, accel: 80, stamina: 70, strength: 60, passing: 65, shooting: 88,
        tackling: 40, dribbling: 75, vision: 70, positioning: 72, aggression: 55, composure: 66, gk: 5,
      },
      overall: 68,
    };
  },
}) as never;

async function boot(opts: Record<string, unknown> = {}){
  const match = await startMatchServer({ port: 0, storeRoot: tmp(), createKey: 'mkt-ck', autoDrive: false });
  const lobby = await startLobbyServer({
    port: 0, devAuth: true, authRequestIntervalMs: 0, storeRoot: tmp(),
    matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'mkt-ck' },
    ...opts,
  });
  return { base: `http://127.0.0.1:${lobby.port}`, close: async () => { await lobby.close(); await match.close(); } };
}

describe('market routes', () => {
  test('unconfigured → 501 on both routes, never a fake empty shop', async () => {
    const { base, close } = await boot();
    try {
      expect((await fetch(`${base}/market`)).status).toBe(501);
      expect((await fetch(`${base}/market/7`)).status).toBe(501);
    } finally { await close(); }
  });

  test('browsing is PUBLIC and joins the player to the price', async () => {
    const { reader } = fakeMarket();
    const { base, close } = await boot({ market: reader, chainReader: fakeChain() });
    try {
      const res = await fetch(`${base}/market`);            // no session header
      expect(res.status).toBe(200);
      const out = await res.json() as {
        listed: number; floor: string; lastBlock: number;
        listings: Array<{ tokenId: string; price: string; lastSale: Sale | null; player: { name: string; overall: number } | null }>;
      };
      expect(out).toMatchObject({ listed: 2, floor: '1000000000000000000', lastBlock: 42 });
      expect(out.listings[0]).toMatchObject({ tokenId: '7', price: '2500000000000000000' });
      expect(out.listings[0]!.player).toMatchObject({ name: 'Player 7', overall: 68 });
      expect(out.listings[0]!.lastSale!.price).toBe('2000');   // most recent sale
      expect(out.listings[1]!.lastSale).toBeNull();
    } finally { await close(); }
  });

  test('one player: the listing, the whole price history, the footballer', async () => {
    const { reader } = fakeMarket();
    const { base, close } = await boot({ market: reader, chainReader: fakeChain() });
    try {
      const out = await (await fetch(`${base}/market/7`)).json() as {
        tokenId: string; listing: Listing | null; history: Sale[]; player: { role: string } | null;
      };
      expect(out.tokenId).toBe('7');
      expect(out.listing!.price).toBe('2500000000000000000');
      expect(out.history.map(s => s.price)).toEqual(['900', '2000']);   // oldest first
      expect(out.player!.role).toBe('ST');

      const unlisted = await (await fetch(`${base}/market/9`)).json() as { listing: Listing | null; history: Sale[] };
      expect(unlisted.listing).toBeNull();
      expect(unlisted.history).toEqual([]);
    } finally { await close(); }
  });

  test('refresh is throttled — a busy shop does not hammer the chain', async () => {
    const { reader, refreshes } = fakeMarket();
    const { base, close } = await boot({ market: reader, chainReader: fakeChain(), marketRefreshMs: 60_000 });
    try {
      await fetch(`${base}/market`);
      await fetch(`${base}/market`);
      await fetch(`${base}/market/7`);
      expect(refreshes()).toBe(1);
    } finally { await close(); }
  });

  test('a failing refresh still serves the window; an unreadable player is listed bare', async () => {
    const { reader } = fakeMarket({ refresh: async () => { throw new Error('rpc down'); } });
    const { base, close } = await boot({ market: reader, chainReader: fakeChain(true) });
    try {
      const res = await fetch(`${base}/market`);
      expect(res.status).toBe(200);                          // stale beats broken
      const out = await res.json() as { listings: Array<{ tokenId: string; player: unknown }> };
      expect(out.listings).toHaveLength(2);
      expect(out.listings[0]!.player).toBeNull();            // honest about the gap
    } finally { await close(); }
  });
});
