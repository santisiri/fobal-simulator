// B5 — match lifecycle: the lobby detects full time from the SIGNED result
// (read back with its own spectator token), frees the players automatically,
// serves per-account history with W/D/L perspective, and treats rematch as a
// decorated challenge. A real match server plays a real match to full time.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { startMatchServer } from '@fobal/match-server';
import { startLobbyServer } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-history-'));

const post = (url: string, body: unknown, token?: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = async <T>(url: string, token: string): Promise<T> => {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return await res.json() as T;
};

interface HistoryEntry {
  matchId: string; finishedAt: string | null;
  opponent: { handle: string; teamName: string } | null;
  outcome: 'W' | 'D' | 'L' | null; score: [number, number] | null;
}
interface State {
  me: { record: { w: number; d: number; l: number } };
  players: Array<{ accountId: string; inMatch: boolean; record: { w: number; d: number; l: number } }>;
  challenges: { incoming: Array<{ id: string; rematch: boolean }> };
  match: { matchId: string } | null;
}

describe('B5 — history, auto-free and rematch', () => {
  test('full time is detected from the signed result; history and records follow', async () => {
    const match = await startMatchServer({ port: 0, storeRoot: tmp(), createKey: 'b5-ck', autoDrive: false });
    const lobby = await startLobbyServer({
      port: 0, devAuth: true, authRequestIntervalMs: 0,
      resultCheckAfterMs: 0, resultCheckEveryMs: 0,     // tests poll immediately
      matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'b5-ck' },
    });
    const base = `http://127.0.0.1:${lobby.port}`;
    try {
      const login = async (email: string) => {
        const { devCode } = await (await post(`${base}/auth/request`, { email })).json() as { devCode: string };
        const out = await (await post(`${base}/auth/verify`, { email, code: devCode })).json() as
          { token: string; account: { accountId: string } };
        return { token: out.token, accountId: out.account.accountId };
      };
      const a = await login('home@fobal.ai');
      const b = await login('away@fobal.ai');

      const { challenge } = await (await post(`${base}/challenges`, { to: b.accountId }, a.token)).json() as { challenge: { id: string } };
      expect((await post(`${base}/challenges/${challenge.id}/accept`, {}, b.token)).status).toBe(201);
      const inMatch = await get<State>(`${base}/lobby`, a.token);
      const matchId = inMatch.match!.matchId;

      // unfinished: history lists the match with no outcome yet
      const before = await get<{ matches: HistoryEntry[] }>(`${base}/history`, a.token);
      expect(before.matches[0]).toMatchObject({ matchId, outcome: null, finishedAt: null });

      // play the whole match server-side (turbo), room evicts on finalize —
      // the lobby must STILL learn the result from the persisted store
      const room = match.rooms.get(matchId)!;
      const result = await room.runTurbo();
      expect(match.rooms.has(matchId)).toBe(false);

      // the next poll notices full time and frees both players — no LEAVE
      const afterA = await get<State>(`${base}/lobby`, a.token);
      expect(afterA.match).toBeNull();
      expect(afterA.players.find(p => p.accountId === b.accountId)?.inMatch).toBe(false);

      // history carries the signed result's numbers, each from its own side
      const historyA = await get<{ matches: HistoryEntry[] }>(`${base}/history`, a.token);
      const historyB = await get<{ matches: HistoryEntry[] }>(`${base}/history`, b.token);
      const entryA = historyA.matches.find(m => m.matchId === matchId)!;
      const entryB = historyB.matches.find(m => m.matchId === matchId)!;
      expect(entryA.finishedAt).not.toBeNull();
      expect(entryA.opponent).toMatchObject({ handle: 'away' });
      expect(entryB.opponent).toMatchObject({ handle: 'home' });
      // A is the challenger → home → teams[0] of the signed result
      expect(entryA.score).toEqual(result.finalScore);
      expect(entryB.score).toEqual([result.finalScore[1], result.finalScore[0]]);
      const flip = { W: 'L', L: 'W', D: 'D' } as const;
      expect(entryB.outcome).toBe(flip[entryA.outcome!]);

      // W/D/L tallies agree with the outcomes
      const tallies = await get<State>(`${base}/lobby`, a.token);
      const expected = entryA.outcome === 'W' ? { w: 1, d: 0, l: 0 }
        : entryA.outcome === 'L' ? { w: 0, d: 0, l: 1 } : { w: 0, d: 1, l: 0 };
      expect(tallies.me.record).toEqual(expected);

      // rematch: a decorated challenge referencing the played match
      expect((await post(`${base}/challenges`, { to: b.accountId, rematchOf: 'lm-nope' }, a.token)).status).toBe(400);
      const rematch = await post(`${base}/challenges`, { to: b.accountId, rematchOf: matchId }, a.token);
      expect(rematch.status).toBe(201);
      const bState = await get<State>(`${base}/lobby`, b.token);
      expect(bState.challenges.incoming[0]!.rematch).toBe(true);
    } finally {
      await lobby.close();
      await match.close();
    }
  }, 120_000);
});
