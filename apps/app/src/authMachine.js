// The unified app's ONE auth state machine.
//
// Before workstream J every page carried its own copy of "am I signed in":
// lobby.html hand-rolled fetch + poll, the hub read a session it never
// wrote, onboarding knew nothing at all. This machine is the single answer.
// It wraps the tested LobbyService (the ONLY transport boundary a UI may
// import) and adds the two things a whole-app session needs on top:
//
//   1. One coherent snapshot every surface renders from —
//      status: 'signed_out' | 'entering' | 'signed_in'
//      connection: LobbyService's connectionStatus, surfaced so a network
//      wobble reads "signal lost — reconnecting", never "logged out".
//   2. The club claim, run EXACTLY ONCE per settled outcome. The draft a
//      player wrote in onboarding is adopted onto their account on first
//      sign-in — clubClaim.js owns the safety rules (never clobber a named
//      club, claim once per browser); this machine owns WHEN: whenever a
//      poll delivers `me` and no claim attempt is in flight or settled. A
//      transient failure (claimPendingClub → null) leaves the latch open,
//      so a network blip retries on the next poll and the name someone
//      chose is never lost. A draft written AFTER sign-in (founding a club
//      while signed in) is picked up the same way, by the next poll.
//
// Sign-out is an event with a reason — 'logout', 'session expired',
// 'wallet account changed' — because the product voice differs for each.

/**
 * @param {{
 *   lobby: any,                      // createLobbyService(...) instance
 *   claimClub: Function,             // claimPendingClub from clubClaim.js
 *   storage?: { getItem(k: string): string | null } | null,
 *   fetchImpl?: (url: string, init?: any) => Promise<any>,
 *   sessionKey?: string,
 * }} options
 */
export function createAuthMachine({
  lobby,
  claimClub,
  storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null,
  fetchImpl = typeof fetch !== 'undefined' ? fetch : /** @type {any} */ (undefined),
  sessionKey = 'fobal.lobby.session',
}) {
  const listeners = new Map();
  /** @type {{ status: 'signed_out'|'entering'|'signed_in', connection: string,
   *           me: any, claim: any, reason: string|null, error: string|null }} */
  const state = {
    status: 'signed_out',
    connection: 'idle',        // mirrors LobbyService connectionStatus
    me: null,
    claim: null,               // {ok:true,teamName}|{ok:false,reason} once settled
    reason: null,              // why the last sign-out happened
    error: null,               // last transport/api error line (or null)
  };
  let claimBusy = false;

  const emit = (event, payload) => {
    for (const fn of listeners.get(event) ?? []) {
      try { fn(payload); } catch { /* one broken listener never breaks the session */ }
    }
  };
  const changed = () => emit('change', state);

  // claimPendingClub speaks raw Response ({ok, json()}), same contract the
  // lobby pages used — built here from the stored session, injectable for tests
  const claimApi = async (path, { method = 'GET', body } = {}) => {
    let session = null;
    try { session = JSON.parse(storage?.getItem(sessionKey) ?? 'null'); } catch { /* no session, no claim */ }
    if (!session?.url || !session?.token) throw new Error('no session');
    return fetchImpl(`${session.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  function adoptNamedClub(me) {
    if (state.claim || claimBusy) return;
    claimBusy = true;
    Promise.resolve(claimClub({ api: claimApi, account: me }))
      .then((out) => {
        if (!out) return;                 // nothing to adopt, or transient — retry next poll
        state.claim = out;
        changed();
        emit('claimed', out);
      })
      .catch(() => { /* claimPendingClub never throws; belt and braces */ })
      .finally(() => { claimBusy = false; });
  }

  lobby.on('state', (s) => {
    state.connection = s.connectionStatus;
    state.me = s.me;
    state.error = s.error ?? null;
    if (s.me) {
      state.status = 'signed_in';
      state.reason = null;
      adoptNamedClub(s.me);
    } else if (state.status === 'signed_in' && s.connectionStatus !== 'idle') {
      // connected once, currently between polls — stay signed in
    } else if (s.connectionStatus === 'connecting') {
      state.status = 'entering';
    }
    changed();
  });

  lobby.on('logout', ({ reason }) => {
    state.status = 'signed_out';
    state.connection = 'idle';
    state.me = null;
    state.reason = reason ?? null;
    state.claim = null;               // a NEW sign-in re-evaluates; clubClaim's
    claimBusy = false;                // own claimed-flag still guards the browser
    changed();
    emit('signed_out', { reason });
  });

  return {
    get state() { return state; },
    on(event, fn) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)).add(fn); return this; },
    off(event, fn) { listeners.get(event)?.delete(fn); return this; },

    /** Wake a stored session (refresh, returning tab). True if one existed. */
    resume() {
      const had = lobby.resume();
      if (had) { state.status = 'entering'; changed(); }
      return had;
    },

    /** Email step 1 — request the code. Returns the server payload (devCode in dev). */
    async emailRequest(email) {
      return lobby.loginEmailRequest(email);
    },
    /** Email step 2 — verify the code; the session is live when this resolves. */
    async emailVerify(email, code) {
      state.status = 'entering'; changed();
      try { return await lobby.loginEmailVerify(email, code); }
      catch (err) { state.status = 'signed_out'; changed(); throw err; }
    },
    /** Wallet sign-in: challenge → personal_sign → verify (no gas, no tx). */
    async walletSignIn(ethereum) {
      state.status = 'entering'; changed();
      try { return await lobby.loginWallet(ethereum); }
      catch (err) { state.status = 'signed_out'; changed(); throw err; }
    },

    signOut() { lobby.logout(); },
  };
}
