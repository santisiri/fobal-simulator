// B1 — the matchmaking lobby. The centerpiece test runs the real match
// server in-process: challenge → accept must produce an authoritative match
// whose role-scoped tokens verify against the match server's own secret,
// while the create key never appears in anything a client can see.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { startMatchServer, verifyToken } from '@fobal/match-server';
import { startLobbyServer, LobbyServerOptions } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-lobby-'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const post = (url: string, body: unknown, token?: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = (url: string, token: string) =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } });

interface LobbyState {
  me: { accountId: string; handle: string; teamName: string; email: string };
  players: Array<{ accountId: string; handle: string; teamName: string; online: boolean; inMatch: boolean }>;
  challenges: { incoming: Array<{ id: string }>; outgoing: Array<{ id: string }> };
  match: { matchId: string; matchUrl: string; teamId: string; token: string; spectatorToken: string } | null;
}

async function boot(overrides: Partial<LobbyServerOptions> = {}){
  const match = await startMatchServer({ port: 0, storeRoot: tmp(), createKey: 'lobby-ck', autoDrive: false });
  const lobby = await startLobbyServer({
    port: 0, devAuth: true, authRequestIntervalMs: 0,
    matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'lobby-ck' },
    ...overrides,
  });
  const base = `http://127.0.0.1:${lobby.port}`;
  const close = async () => { await lobby.close(); await match.close(); };
  return { match, lobby, base, close };
}

async function login(base: string, email: string): Promise<{ token: string; accountId: string }> {
  const requested = await post(`${base}/auth/request`, { email });
  expect(requested.status).toBe(200);
  const { devCode } = await requested.json() as { devCode: string };
  const verified = await post(`${base}/auth/verify`, { email, code: devCode });
  expect(verified.status).toBe(200);
  const out = await verified.json() as { token: string; account: { accountId: string } };
  return { token: out.token, accountId: out.account.accountId };
}

const state = async (base: string, token: string): Promise<LobbyState> => {
  const res = await get(`${base}/lobby`, token);
  expect(res.status).toBe(200);
  return await res.json() as LobbyState;
};

describe('lobby auth', () => {
  test('magic-code flow: request → verify → session works; codes are single-use', async () => {
    const { base, close } = await boot();
    try {
      const requested = await post(`${base}/auth/request`, { email: 'santi@fobal.ai' });
      const { devCode } = await requested.json() as { devCode: string };

      const wrong = await post(`${base}/auth/verify`, { email: 'santi@fobal.ai', code: 'nope' });
      expect(wrong.status).toBe(401);

      const ok = await post(`${base}/auth/verify`, { email: 'santi@fobal.ai', code: devCode });
      expect(ok.status).toBe(200);
      const { token, account } = await ok.json() as { token: string; account: { handle: string; teamName: string } };
      expect(account.handle).toBe('santi');
      expect(account.teamName).toBe('SANTI FC');

      const reused = await post(`${base}/auth/verify`, { email: 'santi@fobal.ai', code: devCode });
      expect(reused.status).toBe(401);

      expect((await get(`${base}/lobby`, token)).status).toBe(200);
      expect((await get(`${base}/lobby`, 'garbage-token')).status).toBe(401);
      expect((await post(`${base}/auth/request`, { email: 'not-an-email' })).status).toBe(400);
    } finally { await close(); }
  });

  test('the same email logs back into the same account (accounts persist)', async () => {
    const root = tmp();
    const first = await boot({ storeRoot: root });
    const a1 = await login(first.base, 'santi@fobal.ai');
    await first.close();

    const second = await boot({ storeRoot: root });
    try {
      const a2 = await login(second.base, 'santi@fobal.ai');
      expect(a2.accountId).toBe(a1.accountId);
    } finally { await second.close(); }
  });
});

describe('presence and roster', () => {
  test('players see each other online; presence expires without polling', async () => {
    const { base, close } = await boot({ presenceTtlMs: 60 });
    try {
      const a = await login(base, 'a@fobal.ai');
      const b = await login(base, 'b@fobal.ai');

      const seenByA = await state(base, a.token);
      expect(seenByA.players).toHaveLength(1);
      expect(seenByA.players[0]).toMatchObject({ handle: 'b', online: true, inMatch: false });

      await sleep(90);                              // a stops polling
      const seenByB = await state(base, b.token);   // refreshes only b
      expect(seenByB.players.find(p => p.accountId === a.accountId)?.online).toBe(false);
    } finally { await close(); }
  });

  test('team rename validates and sticks', async () => {
    const { base, close } = await boot();
    try {
      const a = await login(base, 'a@fobal.ai');
      expect((await post(`${base}/account/team`, { teamName: 'X' }, a.token)).status).toBe(400);
      expect((await post(`${base}/account/team`, { teamName: 'Y'.repeat(40) }, a.token)).status).toBe(400);
      expect((await post(`${base}/account/team`, { teamName: 'Golden Puppets' }, a.token)).status).toBe(200);
      expect((await state(base, a.token)).me.teamName).toBe('Golden Puppets');
    } finally { await close(); }
  });
});

describe('challenge → accept → authoritative match', () => {
  test('the full loop: both players get role-scoped tokens on the SAME match; the create key never leaks', async () => {
    const { match, base, close } = await boot();
    try {
      const a = await login(base, 'santi@fobal.ai');
      const b = await login(base, 'rival@fobal.ai');
      await post(`${base}/account/team`, { teamName: 'GOLDEN PUPPETS' }, a.token);

      const challenged = await post(`${base}/challenges`, { to: b.accountId }, a.token);
      expect(challenged.status).toBe(201);
      const { challenge } = await challenged.json() as { challenge: { id: string } };

      const bState = await state(base, b.token);
      expect(bState.challenges.incoming).toHaveLength(1);

      const accepted = await post(`${base}/challenges/${challenge.id}/accept`, {}, b.token);
      expect(accepted.status).toBe(201);

      const [aState, bAfter] = [await state(base, a.token), await state(base, b.token)];
      expect(aState.match).not.toBeNull();
      expect(bAfter.match).not.toBeNull();
      expect(aState.match!.matchId).toBe(bAfter.match!.matchId);
      expect(aState.match!.teamId).not.toBe(bAfter.match!.teamId);
      expect(aState.match!.token).not.toBe(bAfter.match!.token);
      expect(aState.players.find(p => p.accountId === b.accountId)?.inMatch).toBe(true);

      // the match REALLY exists on the match server, named after the accounts
      expect(match.rooms.size).toBe(1);
      const room = match.rooms.get(aState.match!.matchId)!;
      expect(room.manifest.teams.map(t => t.name)).toEqual(['GOLDEN PUPPETS', 'RIVAL FC']);

      // tokens verify against the MATCH SERVER's secret, scoped to each role
      const aPayload = verifyToken(aState.match!.token, match.secret)!;
      expect(aPayload).toMatchObject({ matchId: aState.match!.matchId, role: 'controller', teamId: aState.match!.teamId });
      const spec = verifyToken(aState.match!.spectatorToken, match.secret)!;
      expect(spec.role).toBe('spectator');

      // the lobby holds the create key server-side — never in client payloads
      for (const payload of [aState, bAfter, challenge])
        expect(JSON.stringify(payload)).not.toContain('lobby-ck');

      // leaving frees both for a rematch
      await post(`${base}/matches/${aState.match!.matchId}/leave`, {}, a.token);
      await post(`${base}/matches/${bAfter.match!.matchId}/leave`, {}, b.token);
      expect((await state(base, a.token)).match).toBeNull();
      const again = await post(`${base}/challenges`, { to: b.accountId }, a.token);
      expect(again.status).toBe(201);
    } finally { await close(); }
  });

  test('challenge guards: self, offline, duplicates, wrong accepter, decline', async () => {
    const { base, close } = await boot({ presenceTtlMs: 60 });
    try {
      const a = await login(base, 'a@fobal.ai');
      const b = await login(base, 'b@fobal.ai');
      const c = await login(base, 'c@fobal.ai');

      expect((await post(`${base}/challenges`, { to: a.accountId }, a.token)).status).toBe(400);
      expect((await post(`${base}/challenges`, { to: 'acc-nobody' }, a.token)).status).toBe(404);

      const { challenge } = await (await post(`${base}/challenges`, { to: b.accountId }, a.token)).json() as { challenge: { id: string } };
      expect((await post(`${base}/challenges`, { to: a.accountId }, b.token)).status).toBe(409);   // pending pair
      expect((await post(`${base}/challenges/${challenge.id}/accept`, {}, c.token)).status).toBe(403);
      expect((await post(`${base}/challenges/${challenge.id}/decline`, {}, b.token)).status).toBe(200);
      expect((await post(`${base}/challenges/${challenge.id}/accept`, {}, b.token)).status).toBe(404);

      await sleep(90);                              // c's presence expires
      const seenByA = await state(base, a.token);
      expect(seenByA.players.find(p => p.accountId === c.accountId)?.online).toBe(false);
      expect((await post(`${base}/challenges`, { to: c.accountId }, a.token)).status).toBe(409);   // offline
    } finally { await close(); }
  });

  test('a dead match server yields 502 and no phantom match record', async () => {
    const match = await startMatchServer({ port: 0, storeRoot: tmp(), createKey: 'lobby-ck', autoDrive: false });
    const deadPort = match.port;
    await match.close();
    const lobby = await startLobbyServer({
      port: 0, devAuth: true, authRequestIntervalMs: 0,
      matchServer: { url: `http://127.0.0.1:${deadPort}`, createKey: 'lobby-ck' },
    });
    const base = `http://127.0.0.1:${lobby.port}`;
    try {
      const a = await login(base, 'a@fobal.ai');
      const b = await login(base, 'b@fobal.ai');
      const { challenge } = await (await post(`${base}/challenges`, { to: b.accountId }, a.token)).json() as { challenge: { id: string } };
      const accepted = await post(`${base}/challenges/${challenge.id}/accept`, {}, b.token);
      expect(accepted.status).toBe(502);
      expect((await state(base, a.token)).match).toBeNull();
      expect((await state(base, b.token)).match).toBeNull();
    } finally { await lobby.close(); }
  });
});

describe('object-store persistence (staging: ephemeral Fargate disk)', () => {
  test('accounts and match records hydrate from the object store across a "task replacement"', async () => {
    const { MemoryObjectStore } = await import('@fobal/match-server');
    const { LobbyStore } = await import('../src/index.js');
    const objects = new MemoryObjectStore();

    const first = new LobbyStore({ objectStore: objects });
    await first.hydrate();
    first.saveAccount({
      accountId: 'acc-11111111', email: 'santi@fobal.ai', handle: 'santi',
      teamKey: 'santi-11111111', teamName: 'GOLDEN PUPPETS', createdAt: new Date().toISOString(),
    });
    first.saveMatch({
      matchId: 'lm-x', matchUrl: 'https://matches-staging.fobal.ai',
      createdAt: new Date().toISOString(), spectatorToken: 'spec',
      players: { 'acc-11111111': { teamId: 'team-santi-11111111', token: 't' } }, left: {},
    });
    await new Promise(r => setTimeout(r, 20));      // fire-and-forget mirror settles

    // brand-new task: empty disk, same bucket
    const second = new LobbyStore({ objectStore: objects });
    await second.hydrate();
    expect(second.getAccountByEmail('santi@fobal.ai')?.teamName).toBe('GOLDEN PUPPETS');
    expect(second.matchesFor('acc-11111111')).toHaveLength(1);
  });
});
