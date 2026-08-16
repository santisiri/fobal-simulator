// M1 slice 1 — stored, editable squads. Names and kit colors are the
// player's identity; ratings and roles stay generated (no self-buffing).
// The manifest contract is the gate: an edit the match server would reject
// never reaches the store, and an accepted edit MUST surface in the next
// match's manifest.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { startMatchServer } from '@fobal/match-server';
import { startLobbyServer } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-squad-'));

const post = (url: string, body: unknown, token?: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = (url: string, token: string) =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } });

interface SquadView {
  teamName: string;
  colors: { primary?: string; secondary?: string } | null;
  source?: string;
  players: Array<{ playerId: string; name: string; defaultName: string; role: string; shirtNumber: number;
    ratings?: Record<string, number>; overall?: number; tokenId?: string }>;
}

async function boot(){
  const match = await startMatchServer({ port: 0, storeRoot: tmp(), createKey: 'squad-ck', autoDrive: false });
  const lobby = await startLobbyServer({
    port: 0, devAuth: true, authRequestIntervalMs: 0, storeRoot: tmp(),
    matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'squad-ck' },
  });
  const base = `http://127.0.0.1:${lobby.port}`;
  const login = async (email: string) => {
    const { devCode } = await (await post(`${base}/auth/request`, { email })).json() as { devCode: string };
    const out = await (await post(`${base}/auth/verify`, { email, code: devCode })).json() as
      { token: string; account: { accountId: string } };
    return { token: out.token, accountId: out.account.accountId };
  };
  return { match, lobby, base, login, close: async () => { await lobby.close(); await match.close(); } };
}

describe('squad editor', () => {
  test('GET /squad shows the generated sixteen with defaults annotated', async () => {
    const { base, login, close } = await boot();
    try {
      const a = await login('santi@fobal.ai');
      const squad = await (await get(`${base}/squad`, a.token)).json() as SquadView;
      expect(squad.players).toHaveLength(16);
      expect(squad.colors).toBeNull();
      expect(squad.players[0]).toMatchObject({ role: 'GK', shirtNumber: 1 });
      expect(squad.players[0]!.name).toBe(squad.players[0]!.defaultName);
      expect(new Set(squad.players.map(p => p.playerId)).size).toBe(16);
      // product-UI contract: cards render from this payload alone
      expect(squad.source).toBe('generated');
      for (const p of squad.players){
        expect(p.overall).toBeGreaterThanOrEqual(30);
        expect(p.overall).toBeLessThanOrEqual(95);
        expect(Object.keys(p.ratings ?? {})).toHaveLength(13);
        expect(p.tokenId).toBeUndefined();      // generated squads are not NFTs
      }
    } finally { await close(); }
  });

  test('edits stick, defaults reset overrides, and the NEXT MATCH manifest carries them', async () => {
    const { match, base, login, close } = await boot();
    try {
      const a = await login('santi@fobal.ai');
      const b = await login('rival@fobal.ai');
      const before = await (await get(`${base}/squad`, a.token)).json() as SquadView;
      const striker = before.players.find(p => p.role === 'ST')!;
      const keeper = before.players.find(p => p.role === 'GK')!;

      const saved = await post(`${base}/squad`, {
        colors: { primary: '#FF00FF', secondary: '#222222' },
        players: [
          { playerId: striker.playerId, name: '  La Pulga  ' },
          { playerId: keeper.playerId, name: 'El Muro' },
        ],
      }, a.token);
      expect(saved.status).toBe(200);
      const view = await saved.json() as SquadView;
      expect(view.colors).toEqual({ primary: '#ff00ff', secondary: '#222222' });   // lowercased
      expect(view.players.find(p => p.playerId === striker.playerId)!.name).toBe('La Pulga');  // trimmed

      // resetting to the default clears the stored override
      const reset = await (await post(`${base}/squad`, {
        players: [{ playerId: keeper.playerId, name: keeper.defaultName }],
      }, a.token)).json() as SquadView;
      expect(reset.players.find(p => p.playerId === keeper.playerId)!.name).toBe(keeper.defaultName);

      // the next match REALLY uses the edited identity
      const { challenge } = await (await post(`${base}/challenges`, { to: b.accountId }, a.token)).json() as { challenge: { id: string } };
      expect((await post(`${base}/challenges/${challenge.id}/accept`, {}, b.token)).status).toBe(201);
      const room = [...match.rooms.values()][0]!;
      const teamA = room.manifest.teams.find(t => t.teamId.includes('santi'))!;
      expect(teamA.colors).toEqual({ primary: '#ff00ff', secondary: '#222222' });
      expect(teamA.players.find(p => p.playerId === striker.playerId)!.name).toBe('La Pulga');
      expect(teamA.players.find(p => p.playerId === keeper.playerId)!.name).toBe(keeper.defaultName);
    } finally { await close(); }
  });

  test('validation: unknown player, bad names, bad colors — nothing partial is stored', async () => {
    const { base, login, close } = await boot();
    try {
      const a = await login('santi@fobal.ai');
      expect((await post(`${base}/squad`, { players: [{ playerId: 'nope-p01', name: 'Ghost' }] }, a.token)).status).toBe(400);
      const squad = await (await get(`${base}/squad`, a.token)).json() as SquadView;
      const pid = squad.players[3]!.playerId;
      expect((await post(`${base}/squad`, { players: [{ playerId: pid, name: 'X' }] }, a.token)).status).toBe(400);
      expect((await post(`${base}/squad`, { players: [{ playerId: pid, name: 'Y'.repeat(30) }] }, a.token)).status).toBe(400);
      expect((await post(`${base}/squad`, { colors: { primary: 'red' } }, a.token)).status).toBe(400);
      expect((await post(`${base}/squad`, { colors: { primary: '#12345' } }, a.token)).status).toBe(400);
      const after = await (await get(`${base}/squad`, a.token)).json() as SquadView;
      expect(after.colors).toBeNull();
      expect(after.players[3]!.name).toBe(after.players[3]!.defaultName);
    } finally { await close(); }
  });

  test('squad customization survives a lobby restart (file store)', async () => {
    const root = tmp();
    const matchA = await startMatchServer({ port: 0, storeRoot: tmp(), createKey: 'ck', autoDrive: false });
    const first = await startLobbyServer({
      port: 0, devAuth: true, authRequestIntervalMs: 0, storeRoot: root,
      matchServer: { url: `http://127.0.0.1:${matchA.port}`, createKey: 'ck' },
    });
    const base1 = `http://127.0.0.1:${first.port}`;
    const { devCode } = await (await post(`${base1}/auth/request`, { email: 's@fobal.ai' })).json() as { devCode: string };
    const { token } = await (await post(`${base1}/auth/verify`, { email: 's@fobal.ai', code: devCode })).json() as { token: string };
    const squad = await (await get(`${base1}/squad`, token)).json() as SquadView;
    await post(`${base1}/squad`, {
      colors: { primary: '#010203' },
      players: [{ playerId: squad.players[10]!.playerId, name: 'Fenix' }],
    }, token);
    await first.close();

    const second = await startLobbyServer({
      port: 0, devAuth: true, authRequestIntervalMs: 0, storeRoot: root,
      matchServer: { url: `http://127.0.0.1:${matchA.port}`, createKey: 'ck' },
    });
    try {
      const base2 = `http://127.0.0.1:${second.port}`;
      const { devCode: code2 } = await (await post(`${base2}/auth/request`, { email: 's@fobal.ai' })).json() as { devCode: string };
      const { token: token2 } = await (await post(`${base2}/auth/verify`, { email: 's@fobal.ai', code: code2 })).json() as { token: string };
      const restored = await (await get(`${base2}/squad`, token2)).json() as SquadView;
      expect(restored.colors).toEqual({ primary: '#010203' });
      expect(restored.players[10]!.name).toBe('Fenix');
    } finally {
      await second.close();
      await matchA.close();
    }
  });
});
