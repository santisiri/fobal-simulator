// The ONE auth state machine. What is locked down: the status ladder
// (signed_out → entering → signed_in), a network wobble never reading as a
// logout, sign-out reasons surviving to the snapshot, and the club-claim
// discipline — run when `me` arrives, retried after a transient failure,
// settled exactly once, re-armed only by a fresh sign-in.
import { describe, expect, test, vi } from 'vitest';
import { createAuthMachine } from '../src/authMachine.js';

/** A stand-in LobbyService: same events, same methods, hand-cranked polls. */
function fakeLobby() {
  const listeners = new Map<string, Set<Function>>();
  const on = (ev: string, fn: Function) => {
    (listeners.get(ev) ?? listeners.set(ev, new Set()).get(ev)!).add(fn);
  };
  const emit = (ev: string, payload: unknown) => {
    for (const fn of listeners.get(ev) ?? []) fn(payload);
  };
  return {
    on,
    off: (ev: string, fn: Function) => listeners.get(ev)?.delete(fn),
    emit,
    resume: vi.fn(() => true),
    loginEmailRequest: vi.fn(async () => ({ devCode: '123456' })),
    loginEmailVerify: vi.fn(async () => ({ handle: 'santi' })),
    loginWallet: vi.fn(async () => ({ handle: '0xabc' })),
    logout: vi.fn(function (this: any) { emit('logout', { reason: 'logout' }); }),
    /** crank one poll result through the 'state' event */
    poll(over: Record<string, unknown> = {}) {
      emit('state', {
        connectionStatus: 'connected',
        me: { accountId: 'a1', handle: 'santi', teamName: 'SANTI FC' },
        error: null,
        ...over,
      });
    },
  };
}

const storageWith = (session: unknown) => ({
  getItem: () => (session === undefined ? null : JSON.stringify(session)),
});

function machine({ claim, session = { url: 'http://lobby', token: 't1' } }: { claim?: any; session?: unknown } = {}) {
  const lobby = fakeLobby();
  const claimClub = claim ?? vi.fn(async () => null);
  const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  const auth = createAuthMachine({
    lobby, claimClub, storage: storageWith(session), fetchImpl,
  });
  return { lobby, auth, claim: claimClub, fetchImpl };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the status ladder', () => {
  test('boot is signed_out; resume enters; the first poll signs in', () => {
    const { lobby, auth } = machine();
    expect(auth.state.status).toBe('signed_out');
    auth.resume();
    expect(lobby.resume).toHaveBeenCalled();
    expect(auth.state.status).toBe('entering');
    lobby.poll();
    expect(auth.state.status).toBe('signed_in');
    expect(auth.state.me?.teamName).toBe('SANTI FC');
  });

  test('a network wobble is a connection state, never a logout', () => {
    const { lobby, auth } = machine();
    auth.resume();
    lobby.poll();
    lobby.poll({ connectionStatus: 'reconnecting', error: 'fetch failed' });
    expect(auth.state.status).toBe('signed_in');
    expect(auth.state.connection).toBe('reconnecting');
    expect(auth.state.error).toBe('fetch failed');
    lobby.poll();
    expect(auth.state.connection).toBe('connected');
  });

  test('sign-out carries its reason; a failed verify falls back cleanly', async () => {
    const { lobby, auth } = machine();
    auth.resume();
    lobby.poll();
    lobby.emit('logout', { reason: 'wallet account changed' });
    expect(auth.state.status).toBe('signed_out');
    expect(auth.state.reason).toBe('wallet account changed');
    expect(auth.state.me).toBeNull();

    lobby.loginEmailVerify.mockRejectedValueOnce(new Error('wrong code'));
    await expect(auth.emailVerify('a@b.c', '000000')).rejects.toThrow('wrong code');
    expect(auth.state.status).toBe('signed_out');
  });
});

describe('the club claim', () => {
  test('runs when me arrives, retries after a transient null, settles once', async () => {
    const claim = vi.fn()
      .mockResolvedValueOnce(null)                                  // network blip
      .mockResolvedValueOnce({ ok: true, teamName: 'SKY COMETS' }); // adopted
    const { lobby, auth } = machine({ claim });
    const claimed: unknown[] = [];
    auth.on('claimed', (out: unknown) => claimed.push(out));

    auth.resume();
    lobby.poll(); await tick();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(auth.state.claim).toBeNull();          // transient — still open

    lobby.poll(); await tick();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(auth.state.claim).toEqual({ ok: true, teamName: 'SKY COMETS' });
    expect(claimed).toEqual([{ ok: true, teamName: 'SKY COMETS' }]);

    lobby.poll(); await tick();
    expect(claim).toHaveBeenCalledTimes(2);       // settled — never again
  });

  test('a refusal settles too — a rejected name must not retry forever', async () => {
    const claim = vi.fn(async () => ({ ok: false, reason: 'that club name was not accepted' }));
    const { lobby, auth } = machine({ claim });
    auth.resume();
    lobby.poll(); await tick();
    lobby.poll(); await tick();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(auth.state.claim).toEqual({ ok: false, reason: 'that club name was not accepted' });
  });

  test('a fresh sign-in re-arms the latch (clubClaim itself still guards the browser)', async () => {
    const claim = vi.fn(async () => ({ ok: true, teamName: 'SKY COMETS' }));
    const { lobby, auth } = machine({ claim });
    auth.resume();
    lobby.poll(); await tick();
    expect(claim).toHaveBeenCalledTimes(1);
    lobby.emit('logout', { reason: 'logout' });
    expect(auth.state.claim).toBeNull();
    lobby.poll(); await tick();
    expect(claim).toHaveBeenCalledTimes(2);
  });

  test('hands the claim an authenticated api built from the stored session', async () => {
    let seenApi: Function | null = null;
    const claim = vi.fn(async ({ api }: { api: Function }) => { seenApi = api; return null; });
    const { lobby, auth, fetchImpl } = machine({ claim });
    auth.resume();
    lobby.poll(); await tick();
    await seenApi!('/account/team', { method: 'POST', body: { teamName: 'SKY COMETS' } });
    expect(fetchImpl).toHaveBeenCalledWith('http://lobby/account/team', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer t1' }),
      body: JSON.stringify({ teamName: 'SKY COMETS' }),
    }));
  });

  test('one claim in flight at a time — a slow claim is not doubled by the next poll', async () => {
    let release: (v: unknown) => void = () => {};
    const claim = vi.fn(() => new Promise((r) => { release = r; }));
    const { lobby, auth } = machine({ claim });
    auth.resume();
    lobby.poll();
    lobby.poll();
    expect(claim).toHaveBeenCalledTimes(1);
    release({ ok: true, teamName: 'SKY COMETS' }); await tick();
    lobby.poll(); await tick();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(auth.state.claim).toEqual({ ok: true, teamName: 'SKY COMETS' });
  });
});
