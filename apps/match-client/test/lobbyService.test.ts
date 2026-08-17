// LobbyService — the charter's two-client matrix, against REAL servers:
// two service instances are two browsers. A sees B, challenge → delivered →
// accept → one canonical matchId, decline, expiry, duplicates converging,
// reconnect across a lobby-server restart, and a wallet switch ending the
// session. The transport (polling) is an implementation detail the tests
// never touch — everything goes through the service boundary.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { startMatchServer } from '@fobal/match-server';
import { startLobbyServer } from '@fobal/lobby-server';
import { createLobbyService } from '../src/lobbyService.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-lsvc-'));

async function until<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 4000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

interface Rig {
  base: string;
  close: () => Promise<void>;
  closeLobbyOnly: () => Promise<void>;
  restartLobby: () => Promise<void>;
}

async function rig(lobbyOverrides: Record<string, unknown> = {}): Promise<Rig> {
  const match = await startMatchServer({ port: 0, storeRoot: tmp(), createKey: 'ck', autoDrive: false });
  const options = {
    port: 0, devAuth: true, authRequestIntervalMs: 0, secret: 'lsvc-secret', storeRoot: tmp(),
    matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'ck' },
    ...lobbyOverrides,
  };
  let lobby = await startLobbyServer(options as never);
  const lobbyPort = lobby.port;
  return {
    base: `http://127.0.0.1:${lobbyPort}`,
    close: async () => { await lobby.close().catch(() => {}); await match.close(); },
    closeLobbyOnly: async () => { await lobby.close(); },
    restartLobby: async () => {
      lobby = await startLobbyServer({ ...options, port: lobbyPort } as never);
    },
  };
}

const services: Array<{ dispose: () => void }> = [];
// the service is untyped browser JS by design — the RUNTIME contract is
// what this suite pins down; `any` keeps the assertions on behavior
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = (base: string): any => {
  const s = createLobbyService({ lobbyUrl: base, pollMs: 100, storage: null });
  services.push(s);
  return s;
};
afterEach(() => { for (const s of services.splice(0)) s.dispose(); });

async function emailLogin(s: ReturnType<typeof createLobbyService>, email: string){
  const { devCode } = await s.loginEmailRequest(email);
  await s.loginEmailVerify(email, devCode);
  await until(() => s.state.connectionStatus === 'connected', `${email} connected`);
}

describe('LobbyService — two clients', () => {
  test('A sees B, B sees A — with the normalized identity shape', async () => {
    const r = await rig();
    try {
      const A = svc(r.base), B = svc(r.base);
      await emailLogin(A, 'a@fobal.ai');
      await emailLogin(B, 'b@fobal.ai');
      const bSeenByA = await until(
        () => A.state.participants.find((p: { displayName: string }) => p.displayName === 'b'), 'A sees B');
      await until(() => B.state.participants.find((p: { displayName: string }) => p.displayName === 'a'), 'B sees A');
      expect(bSeenByA).toMatchObject({
        walletAddress: null,
        displayName: 'b',
        squadName: 'B FC',
        status: 'available',
      });
      expect(bSeenByA.squadId).toMatch(/^team-/);
      expect(bSeenByA.teamOverall).toBeGreaterThan(30);
      expect(bSeenByA.teamOverall).toBeLessThanOrEqual(100);
      expect(Date.parse(bSeenByA.joinedAt)).toBeGreaterThan(0);
    } finally { await r.close(); }
  });

  test('challenge → delivered → accept → ONE canonical matchId on both clients', async () => {
    const r = await rig();
    try {
      const A = svc(r.base), B = svc(r.base);
      await emailLogin(A, 'a@fobal.ai');
      await emailLogin(B, 'b@fobal.ai');
      const bId = (await until(() => A.state.participants[0], 'roster')).accountId;

      let incomingEvent: { id: string } | null = null;
      B.on('challenge', (c: { id: string }) => { incomingEvent = c; });
      await A.challenge(bId);
      await until(() => incomingEvent, 'B receives the challenge event');
      // both statuses flip, and the challenger sees delivery ("seen")
      await until(() => A.state.outgoingChallenges[0]?.status === 'delivered', 'delivered');
      await until(() => A.state.me?.status === 'challenged', 'A challenged');
      expect(B.state.me.status).toBe('challenged');

      const match = await B.accept(incomingEvent!.id);
      const aMatch = await until(() => A.state.match, 'A converges on the match');
      expect(aMatch.matchId).toBe(match.matchId);
      expect(B.state.match.matchId).toBe(match.matchId);
      // canonical participants: each side holds its own token + teamId
      expect(aMatch.teamId).not.toBe(B.state.match.teamId);
      expect(aMatch.token).not.toBe(B.state.match.token);
      expect(aMatch.spectatorToken).toBe(B.state.match.spectatorToken);
      expect(A.state.me.status).toBe('preparing_match');
      expect(B.matchEntry()).toMatchObject({ matchId: match.matchId, status: 'preparing' });
      expect(B.matchEntry().wsUrl).toMatch(/^ws/);
    } finally { await r.close(); }
  });

  test('decline clears both sides; declining again stays a clean no-op', async () => {
    const r = await rig();
    try {
      const A = svc(r.base), B = svc(r.base);
      await emailLogin(A, 'a@fobal.ai');
      await emailLogin(B, 'b@fobal.ai');
      const bId = (await until(() => A.state.participants[0], 'roster')).accountId;
      await A.challenge(bId);
      const ch = await until(() => B.state.incomingChallenges[0], 'incoming');
      await B.decline(ch.id);
      await until(() => A.state.outgoingChallenges.length === 0, 'A side cleared');
      expect(B.state.incomingChallenges).toHaveLength(0);
      await expect(B.decline(ch.id)).resolves.toMatchObject({ ok: true });   // idempotent
    } finally { await r.close(); }
  });

  test('duplicates converge: re-challenge returns the same id, double-accept the same match', async () => {
    const r = await rig();
    try {
      const A = svc(r.base), B = svc(r.base);
      await emailLogin(A, 'a@fobal.ai');
      await emailLogin(B, 'b@fobal.ai');
      const bId = (await until(() => A.state.participants[0], 'roster')).accountId;
      const first = await A.challenge(bId);
      const second = await A.challenge(bId);
      expect(second.challenge.id).toBe(first.challenge.id);

      const match1 = await B.accept(first.challenge.id);
      const match2 = await B.accept(first.challenge.id);      // double-click
      expect(match2.matchId).toBe(match1.matchId);
    } finally { await r.close(); }
  });

  test('an unanswered challenge expires on both sides; late accept fails honestly', async () => {
    const r = await rig({ challengeTtlMs: 250 });
    try {
      const A = svc(r.base), B = svc(r.base);
      await emailLogin(A, 'a@fobal.ai');
      await emailLogin(B, 'b@fobal.ai');
      const bId = (await until(() => A.state.participants[0], 'roster')).accountId;
      await A.challenge(bId);
      const ch = await until(() => B.state.incomingChallenges[0], 'incoming');
      await until(() => B.state.incomingChallenges.length === 0, 'expired for B');
      await until(() => A.state.outgoingChallenges.length === 0, 'expired for A');
      await expect(B.accept(ch.id)).rejects.toThrow(/unknown or expired/);
    } finally { await r.close(); }
  });

  test('a silent client goes disconnected for others; ghosts age out by TTL', async () => {
    const r = await rig({ presenceTtlMs: 300 });
    try {
      const A = svc(r.base), B = svc(r.base);
      await emailLogin(A, 'a@fobal.ai');
      await emailLogin(B, 'b@fobal.ai');
      await until(() => A.state.participants[0]?.status === 'available', 'B available');
      B.dispose();               // tab closed mid-session, no goodbye
      await until(() => A.state.participants[0]?.status === 'disconnected', 'B disconnected');
    } finally { await r.close(); }
  });

  test('reconnect: a lobby-server restart heals on the next poll, session intact', async () => {
    const r = await rig();
    try {
      const A = svc(r.base);
      await emailLogin(A, 'a@fobal.ai');
      await r.closeLobbyOnly();
      await until(() => A.state.connectionStatus === 'reconnecting', 'reconnecting surfaced');
      await r.restartLobby();
      await until(() => A.state.connectionStatus === 'connected', 'healed');
      expect(A.state.me.displayName).toBe('a');    // same session, same account
    } finally { await r.close(); }
  });

  test('scouting: A inspects B — identity, form, XI overalls, and NEVER the rating sheet', async () => {
    const r = await rig();
    try {
      const A = svc(r.base), B = svc(r.base);
      await emailLogin(A, 'a@fobal.ai');
      await emailLogin(B, 'b@fobal.ai');
      const bId = (await until(() => A.state.participants[0], 'roster')).accountId;

      const card = await A.inspect(bId);
      expect(card).toMatchObject({
        displayName: 'b', squadName: 'B FC', status: 'available', chainTeam: false,
      });
      expect(card.squad.players).toHaveLength(11);
      expect(card.squad.formation).toBeTruthy();
      for (const p of card.squad.players){
        expect(p.name.length).toBeGreaterThan(1);
        expect(p.overall).toBeGreaterThan(20);
        expect(p.overall).toBeLessThanOrEqual(100);
        expect(p.shirtNumber).toBeGreaterThan(0);
        // the deliberate withholding: strength, not the spreadsheet
        expect(p).not.toHaveProperty('ratings');
      }
      expect(card.squad.players.some((p: { role: string }) => p.role === 'GK')).toBe(true);

      // kit colors surface once the scouted coach saves them
      await B.saveSquad({ colors: { primary: '#a855f7', secondary: '#f8fafc' } });
      const dressed = await A.inspect(bId);
      expect(dressed.kit).toMatchObject({ primary: '#a855f7' });

      await expect(A.inspect('acc-00000000')).rejects.toThrow(/unknown coach/);
    } finally { await r.close(); }
  });

  test('wallet login works through the service; switching accounts ends the session', async () => {
    const r = await rig();
    try {
      const PK = Buffer.from('2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', 'hex');
      const pub = secp256k1.getPublicKey(PK, false);
      const address = `0x${Buffer.from(keccak_256(pub.subarray(1)).slice(-20)).toString('hex')}`;
      const handlers = new Map<string, (a: string[]) => void>();
      const ethereum = {
        request: async ({ method, params }: { method: string; params?: string[] }) => {
          if (method === 'eth_requestAccounts') return [address];
          if (method === 'personal_sign') {
            const msg = Buffer.from(params![0]!.slice(2), 'hex');
            const digest = keccak_256(Buffer.concat([
              Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`, 'utf8'), msg]));
            const sig = secp256k1.sign(digest, PK);
            return `0x${sig.toCompactHex()}${(27 + sig.recovery!).toString(16)}`;
          }
          throw new Error(`unexpected ${method}`);
        },
        on: (event: string, fn: (a: string[]) => void) => handlers.set(event, fn),
        removeListener: (event: string) => handlers.delete(event),
      };

      const A = svc(r.base);
      const account = await A.loginWallet(ethereum);
      expect(account.wallet).toBe(address);
      await until(() => A.state.connectionStatus === 'connected', 'wallet session connected');
      expect(A.state.me.walletAddress).toBe(address);

      let loggedOut: { reason: string } | null = null;
      A.on('logout', (e: { reason: string }) => { loggedOut = e; });
      handlers.get('accountsChanged')!(['0x' + 'ab'.repeat(20)]);
      expect(loggedOut).toMatchObject({ reason: 'wallet account changed' });
      expect(A.state.connectionStatus).toBe('idle');
    } finally { await r.close(); }
  });
});
