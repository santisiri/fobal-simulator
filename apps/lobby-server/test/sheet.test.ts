// Workstream H — the team sheet, end to end. The claim these tests defend:
// what a manager sets in the squad room is what the match server receives
// in the manifest, and a sheet that has gone stale never stops a kickoff.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { startMatchServer } from '@fobal/match-server';
import { startLobbyServer } from '../src/index.js';
import type { TeamSheet } from '@fobal/protocol';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-sheet-'));

const post = (url: string, body: unknown, token?: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const send = (url: string, method: string, body: unknown, token: string) =>
  fetch(url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (url: string, token: string) =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } });

interface SheetView {
  sheet: TeamSheet;
  saved: boolean;
  issue?: string;
  squad: Array<{ playerId: string; name: string; shirtNumber: number; role: string }>;
}

async function boot(){
  const match = await startMatchServer({ port: 0, storeRoot: tmp(), createKey: 'sheet-ck', autoDrive: false });
  const lobby = await startLobbyServer({
    port: 0, devAuth: true, authRequestIntervalMs: 0, storeRoot: tmp(),
    matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'sheet-ck' },
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

describe('team sheet', () => {
  test('with nothing saved, the sheet IS what the squad plays today', async () => {
    const { base, login, close } = await boot();
    try {
      const a = await login('santi@fobal.ai');
      const view = await (await get(`${base}/sheet`, a.token)).json() as SheetView;
      expect(view.saved).toBe(false);
      expect(view.squad).toHaveLength(16);                    // every player, to pick from
      expect(view.sheet.lineup).toHaveLength(11);
      expect(view.sheet.bench).toHaveLength(5);
      expect(view.sheet.lineup[0]).toBe(view.squad[0]!.playerId);
      expect(view.squad[0]!.role).toBe('GK');
    } finally { await close(); }
  });

  test('a saved sheet survives, and the XI it names leads the squad', async () => {
    const { base, login, close } = await boot();
    try {
      const a = await login('santi@fobal.ai');
      const view = await (await get(`${base}/sheet`, a.token)).json() as SheetView;
      const ids = view.squad.map(p => p.playerId);
      // bench the second striker (index 10), start the reserve winger (index 14)
      const lineup = [...view.sheet.lineup.slice(0, 10), ids[14]!];
      const res = await send(`${base}/sheet`, 'PUT', {
        version: 1, lineup, bench: [ids[10]!, ids[11]!], formation: '433',
        tactics: { pressing: 0.9, defLine: 0.8 },
      }, a.token);
      expect(res.status).toBe(200);
      const saved = await res.json() as { xi: Array<{ playerId: string }>; formation: string };
      expect(saved.xi.map(p => p.playerId)).toEqual(lineup);
      expect(saved.formation).toBe('433');

      const after = await (await get(`${base}/sheet`, a.token)).json() as SheetView;
      expect(after.saved).toBe(true);
      expect(after.issue).toBeUndefined();
      expect(after.sheet.tactics).toMatchObject({ pressing: 0.9, defLine: 0.8 });
    } finally { await close(); }
  });

  test('an illegal eleven is refused with the real reason, and nothing is stored', async () => {
    const { base, login, close } = await boot();
    try {
      const a = await login('santi@fobal.ai');
      const view = await (await get(`${base}/sheet`, a.token)).json() as SheetView;
      const outfield = view.squad.filter(p => p.role !== 'GK').map(p => p.playerId);
      const res = await send(`${base}/sheet`, 'PUT',
        { version: 1, lineup: outfield.slice(0, 11), bench: [] }, a.token);
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain('goalkeeper');
      expect(((await (await get(`${base}/sheet`, a.token)).json()) as SheetView).saved).toBe(false);
    } finally { await close(); }
  });

  test('THE PROOF: the sheet reaches the match manifest — XI, formation and tactics', async () => {
    const { base, login, match, close } = await boot();
    try {
      const home = await login('home@fobal.ai');
      const away = await login('away@fobal.ai');
      const view = await (await get(`${base}/sheet`, home.token)).json() as SheetView;
      const ids = view.squad.map(p => p.playerId);
      const lineup = [...view.sheet.lineup.slice(0, 10), ids[15]!];   // start the reserve forward
      await send(`${base}/sheet`, 'PUT', {
        version: 1, lineup, bench: [ids[10]!], formation: '352',
        tactics: { pressing: 0.85, tempo: 0.25 },
      }, home.token);

      const ch = await (await post(`${base}/challenges`, { to: away.accountId }, home.token)).json() as
        { challenge: { id: string } };
      const acc = await (await post(`${base}/challenges/${ch.challenge.id}/accept`, {}, away.token)).json() as
        { match: { matchId: string } };
      const manifest = match.rooms.get(acc.match.matchId)!.manifest;
      const homeTeam = manifest.teams.find(t => t.players[0]!.playerId === lineup[0])!;

      expect(homeTeam.players.slice(0, 11).map(p => p.playerId)).toEqual(lineup);
      expect(homeTeam.players).toHaveLength(12);              // XI + the one named sub
      expect(homeTeam.formation).toBe('352');
      expect(homeTeam.tactics).toMatchObject({ pressing: 0.85, tempo: 0.25 });
    } finally { await close(); }
  });

  test('a STALE sheet (a sold player) never stops a kickoff — the squad order carries on', async () => {
    const { base, login, lobby, match, close } = await boot();
    try {
      const home = await login('home@fobal.ai');
      const away = await login('away@fobal.ai');
      const account = lobby.store.getAccount(home.accountId)!;
      const squad = (await (await get(`${base}/sheet`, home.token)).json() as SheetView).squad;
      // a sheet naming a player this account no longer owns
      lobby.store.saveAccount({
        ...account,
        teamSheet: {
          version: 1,
          lineup: [...squad.slice(0, 10).map(p => p.playerId), 'nft-sold-to-someone-else'],
          bench: [],
        },
      });
      const view = await (await get(`${base}/sheet`, home.token)).json() as SheetView;
      expect(view.saved).toBe(true);
      expect(view.issue).toContain('nft-sold-to-someone-else');   // the room can say so

      const ch = await (await post(`${base}/challenges`, { to: away.accountId }, home.token)).json() as
        { challenge: { id: string } };
      const acc = await post(`${base}/challenges/${ch.challenge.id}/accept`, {}, away.token);
      expect(acc.status).toBe(201);                                // kickoff survives
      const manifest = match.rooms.get(((await acc.json()) as { match: { matchId: string } }).match.matchId)!.manifest;
      expect(manifest.teams.every(t => t.players.length >= 11)).toBe(true);
    } finally { await close(); }
  });

  test('DELETE returns the squad to its own order', async () => {
    const { base, login, close } = await boot();
    try {
      const a = await login('santi@fobal.ai');
      const view = await (await get(`${base}/sheet`, a.token)).json() as SheetView;
      const ids = view.squad.map(p => p.playerId);
      await send(`${base}/sheet`, 'PUT',
        { version: 1, lineup: [...view.sheet.lineup.slice(0, 10), ids[14]!], bench: [] }, a.token);
      expect(await (await send(`${base}/sheet`, 'DELETE', undefined, a.token)).status).toBe(200);
      const after = await (await get(`${base}/sheet`, a.token)).json() as SheetView;
      expect(after.saved).toBe(false);
      expect(after.sheet.lineup).toEqual(ids.slice(0, 11));
    } finally { await close(); }
  });
});
