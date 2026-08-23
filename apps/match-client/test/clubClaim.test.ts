// The one-club handoff. These guard the two rules that make adopting a
// local draft SAFE: never overwrite a club the player already named
// online, and adopt exactly once per browser (not once per account —
// email in one tab and a wallet in another must not mint twin clubs).
import { describe, expect, test } from 'vitest';
import { CLUB_KEY, claimPendingClub, defaultTeamName, planClubClaim } from '../src/clubClaim.js';

const draft = (over: Record<string, unknown> = {}) => ({
  name: 'SKY COMETS',
  colors: { primary: '#a855f7', secondary: '#f8fafc' },
  squad: { players: [] },
  ...over,
});

/** a freshly created account, still wearing the server's default name */
const freshAccount = { handle: 'santi', teamName: 'SANTI FC' };

const storageWith = (value: unknown) => {
  let raw = value === undefined ? null : JSON.stringify(value);
  return {
    getItem: () => raw,
    setItem: (_k: string, v: string) => { raw = v; },
    current: () => (raw === null ? null : JSON.parse(raw)),
  };
};

const okJson = (body: unknown = {}) => ({ ok: true, json: async () => body });
const errJson = (body: unknown) => ({ ok: false, json: async () => body });

function recordingApi(responder: (path: string) => unknown = () => okJson()){
  const calls: Array<{ path: string; body: unknown }> = [];
  const api = async (path: string, init: { body?: unknown } = {}) => {
    calls.push({ path, body: init.body });
    return responder(path) as never;
  };
  return { api, calls };
}

describe('planClubClaim (pure)', () => {
  test('a fresh account adopts the draft name and kit', () => {
    expect(planClubClaim(draft(), freshAccount)).toEqual({
      teamName: 'SKY COMETS',
      colors: { primary: '#a855f7', secondary: '#f8fafc' },
    });
  });

  test('RULE 1 — a club already named online is never clobbered', () => {
    const returning = { handle: 'santi', teamName: 'DEPORTIVO REAL' };
    expect(planClubClaim(draft(), returning)).toBeNull();
  });

  test('RULE 2 — a claimed draft is never applied again', () => {
    expect(planClubClaim(draft({ claimed: true }), freshAccount)).toBeNull();
  });

  test('the default-name rule matches the server, including the 32-char cap', () => {
    expect(defaultTeamName('santi')).toBe('SANTI FC');
    const long = 'abcdefghijklmnopqrstuvwxyz0123456789';
    expect(defaultTeamName(long)).toHaveLength(32);
    expect(planClubClaim(draft(), { handle: long, teamName: defaultTeamName(long) }))
      .toMatchObject({ teamName: 'SKY COMETS' });
  });

  test('junk is dropped, not forwarded to the server', () => {
    expect(planClubClaim(draft({ name: 'X', colors: null }), freshAccount)).toBeNull();
    expect(planClubClaim(draft({ name: 'ok name', colors: { primary: 'purple' } }), freshAccount))
      .toEqual({ teamName: 'ok name' });
    expect(planClubClaim(null, freshAccount)).toBeNull();
    expect(planClubClaim(draft(), null)).toBeNull();
  });

  test('a draft whose name already equals the account name pushes only the kit', () => {
    expect(planClubClaim(draft({ name: 'SANTI FC' }), freshAccount))
      .toEqual({ colors: { primary: '#a855f7', secondary: '#f8fafc' } });
  });
});

describe('claimPendingClub (the runner)', () => {
  test('adopts the club, then marks the draft so it never repeats', async () => {
    const storage = storageWith(draft());
    const { api, calls } = recordingApi();
    const out = await claimPendingClub({ api, account: freshAccount, storage });

    expect(out).toMatchObject({ ok: true, teamName: 'SKY COMETS' });
    expect(calls.map(c => c.path)).toEqual(['/account/team', '/squad']);
    expect(calls[0]!.body).toEqual({ teamName: 'SKY COMETS' });
    expect(calls[1]!.body).toEqual({ colors: { primary: '#a855f7', secondary: '#f8fafc' } });
    expect(storage.current()).toMatchObject({ claimed: true, name: 'SKY COMETS' });

    // a second entry in the same browser does nothing at all
    const second = recordingApi();
    expect(await claimPendingClub({ api: second.api, account: freshAccount, storage })).toBeNull();
    expect(second.calls).toHaveLength(0);
  });

  test('a REFUSED name is consumed with its reason — it must not retry forever', async () => {
    const storage = storageWith(draft({ name: 'BADWORD FC' }));
    const { api, calls } = recordingApi(() => errJson({ error: 'that name is not allowed' }));
    const out = await claimPendingClub({ api, account: freshAccount, storage });

    expect(out).toEqual({ ok: false, reason: 'that name is not allowed' });
    expect(calls).toHaveLength(1);                       // never reached /squad
    expect(storage.current()).toMatchObject({ claimed: true });
  });

  test('a network blip leaves the draft CLAIMABLE — the named club is not lost', async () => {
    const storage = storageWith(draft());
    const dead = async () => { throw new Error('offline'); };
    expect(await claimPendingClub({ api: dead, account: freshAccount, storage })).toBeNull();
    expect(storage.current()?.claimed).toBeUndefined();

    // …and the next entry adopts it for real
    const { api, calls } = recordingApi();
    expect(await claimPendingClub({ api, account: freshAccount, storage })).toMatchObject({ ok: true });
    expect(calls.map(c => c.path)).toEqual(['/account/team', '/squad']);
  });

  test('no draft in this browser is a silent no-op', async () => {
    const { api, calls } = recordingApi();
    const empty = { getItem: () => null, setItem: () => {}, current: () => null };
    expect(await claimPendingClub({ api, account: freshAccount, storage: empty })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(CLUB_KEY).toBe('fobal.club');
  });
});
