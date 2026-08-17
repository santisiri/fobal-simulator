// LobbyService — the client-side matchmaking boundary (workstream charter).
// The UI consumes THIS, never the transport: today the transport is HTTP
// polling (roadmap open decision 2 — deliberate at current scale); if a
// socket lobby ever replaces it, this file changes and no UI does.
//
//   const lobby = createLobbyService({ lobbyUrl });
//   lobby.on('state', s => render(s));
//   await lobby.loginWallet(window.ethereum);   // or loginEmail* / resume()
//   await lobby.challenge(accountId);
//
// State shape (every 'state' event, and lobby.state at any time):
//   {
//     connectionStatus: 'idle'|'connecting'|'connected'|'reconnecting',
//     me,                  // participant view of yourself (+ email)
//     participants,        // normalized: { accountId, walletAddress,
//                          //   displayName, squadId, squadName, teamOverall,
//                          //   status, joinedAt, record, ... }
//     incomingChallenges,  // [{ id, from, status, expiresAt, ... }]
//     outgoingChallenges,
//     match,               // { matchId, matchUrl, token, spectatorToken,
//                          //   teamId, status: 'preparing'|'live' } | null
//     error,               // last transport/api error string or null
//   }
// Events: 'state' (any change), 'challenge' (a NEW incoming id),
//   'match' (a match appeared), 'logout' (session ended: expiry, logout(),
//   or the wallet switched accounts).
//
// Reliability model: polling is stateless, so reconnect after a network
// drop, a server restart, or a laptop sleep is just the next successful
// poll — connectionStatus surfaces 'reconnecting' between failures, and the
// session token keeps working across lobby-server restarts because sessions
// are stateless HMAC. A browser refresh resumes from storage via resume().

/**
 * @param {{ lobbyUrl?: string, pollMs?: number, fetchImpl?: typeof fetch,
 *           storage?: Pick<Storage, 'getItem'|'setItem'|'removeItem'> | null,
 *           storageKey?: string }} [options]
 */
export function createLobbyService({
  lobbyUrl,
  pollMs = 2000,
  fetchImpl = fetch,
  storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null,
  storageKey = 'fobal.lobby.session',
} = {}){
  const listeners = new Map();     // event → Set<fn>
  let base = (lobbyUrl ?? '').replace(/\/+$/, '');
  let token = null;
  let timer = null;
  let failures = 0;
  let seenChallenges = new Set();
  let ethereumRef = null;
  let accountsChangedHandler = null;

  const state = {
    connectionStatus: 'idle',
    me: null,
    participants: [],
    incomingChallenges: [],
    outgoingChallenges: [],
    match: null,
    error: null,
  };

  const emit = (event, payload) => {
    for (const fn of listeners.get(event) ?? []) {
      try { fn(payload); } catch { /* a broken listener never breaks the service */ }
    }
  };
  const changed = () => emit('state', state);

  const api = async (path, { method = 'GET', body, auth = true } = {}) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(out.error ?? `request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return out;
  };

  function sessionUp(newToken){
    token = newToken;
    storage?.setItem(storageKey, JSON.stringify({ url: base, token }));
    state.connectionStatus = 'connecting';
    state.error = null;
    seenChallenges = new Set();
    changed();
    void poll();
    clearInterval(timer);
    timer = setInterval(() => void poll(), pollMs);
  }

  function sessionDown(reason){
    clearInterval(timer);
    timer = null;
    token = null;
    storage?.removeItem(storageKey);
    state.connectionStatus = 'idle';
    state.me = null;
    state.participants = [];
    state.incomingChallenges = [];
    state.outgoingChallenges = [];
    state.match = null;
    changed();
    emit('logout', { reason });
  }

  async function poll(){
    if (!token) return;
    try {
      const s = await api('/lobby');
      failures = 0;
      state.connectionStatus = 'connected';
      state.error = null;
      state.me = s.me;
      state.participants = s.players;
      state.incomingChallenges = s.challenges.incoming;
      state.outgoingChallenges = s.challenges.outgoing;
      const hadMatch = state.match?.matchId;
      state.match = s.match;
      for (const c of s.challenges.incoming)
        if (!seenChallenges.has(c.id)) { seenChallenges.add(c.id); emit('challenge', c); }
      if (s.match && s.match.matchId !== hadMatch) emit('match', s.match);
      changed();
    } catch (err) {
      if (err.status === 401) return sessionDown('session expired');
      failures++;
      // transport trouble ≠ logout: keep the session, surface the state,
      // and let the next poll heal it (server restarts included)
      state.connectionStatus = failures >= 2 ? 'reconnecting' : state.connectionStatus;
      state.error = String(err.message ?? err);
      changed();
    }
  }

  function watchWallet(ethereum){
    if (!ethereum?.on || ethereumRef === ethereum) return;
    ethereumRef = ethereum;
    accountsChangedHandler = (accounts) => {
      const current = state.me?.walletAddress;
      if (!current) return;
      const next = (accounts?.[0] ?? '').toLowerCase();
      // the person at the keyboard changed — this session no longer speaks
      // for them; end it rather than acting as the previous wallet
      if (next !== current) sessionDown('wallet account changed');
    };
    ethereum.on('accountsChanged', accountsChangedHandler);
  }

  return {
    get state(){ return state; },
    on(event, fn){ (listeners.get(event) ?? listeners.set(event, new Set()).get(event)).add(fn); return this; },
    off(event, fn){ listeners.get(event)?.delete(fn); return this; },

    /** Resume a stored session (browser refresh). Returns true if one existed. */
    resume(){
      try {
        const saved = JSON.parse(storage?.getItem(storageKey) ?? 'null');
        if (!saved?.token) return false;
        if (saved.url) base = saved.url;
        sessionUp(saved.token);
        return true;
      } catch { return false; }
    },

    async loginEmailRequest(email){
      return api('/auth/request', { method: 'POST', body: { email }, auth: false });
    },
    async loginEmailVerify(email, code){
      const out = await api('/auth/verify', { method: 'POST', body: { email, code }, auth: false });
      sessionUp(out.token);
      return out.account;
    },

    /** Wallet sign-in: challenge → personal_sign → verify. Also subscribes
     *  to accountsChanged so a wallet switch ends the session. */
    async loginWallet(ethereum){
      if (!ethereum) throw new Error('no wallet provider given');
      const [address] = await ethereum.request({ method: 'eth_requestAccounts' });
      const { message } = await api('/auth/wallet', { method: 'POST', body: { address }, auth: false });
      const hexMessage = '0x' + [...new TextEncoder().encode(message)]
        .map(b => b.toString(16).padStart(2, '0')).join('');
      const signature = await ethereum.request({ method: 'personal_sign', params: [hexMessage, address] });
      const out = await api('/auth/wallet/verify', { method: 'POST', body: { address, signature }, auth: false });
      sessionUp(out.token);
      watchWallet(ethereum);
      return out.account;
    },

    logout(){ sessionDown('logout'); },

    // ---- matchmaking ----
    async challenge(accountId, rematchOf){
      return api('/challenges', { method: 'POST', body: { to: accountId, ...(rematchOf ? { rematchOf } : {}) } });
    },
    async accept(challengeId){
      const out = await api(`/challenges/${challengeId}/accept`, { method: 'POST', body: {} });
      await poll();                    // converge immediately, not next tick
      return out.match;
    },
    async decline(challengeId){
      const out = await api(`/challenges/${challengeId}/decline`, { method: 'POST', body: {} });
      await poll();
      return out;
    },
    async leaveMatch(){
      if (!state.match) return;
      await api(`/matches/${state.match.matchId}/leave`, { method: 'POST', body: {} });
      await poll();
    },

    /** Scouting card for any coach in the roster: identity + form + kit +
     *  the XI as name/role/shirt/overall (never the full rating sheet —
     *  that reveals itself on the pitch). */
    async inspect(accountId){
      return (await api(`/coaches/${accountId}`)).coach;
    },

    // ---- squad / identity ----
    async getSquad(){ return api('/squad'); },
    async saveSquad(body){ return api('/squad', { method: 'POST', body }); },
    async rename(teamName){ return api('/account/team', { method: 'POST', body: { teamName } }); },
    async linkChainTeam(teamId){ return api('/squad/chain', { method: 'POST', body: { teamId } }); },
    async unlinkChainTeam(){ return api('/squad/chain', { method: 'DELETE' }); },
    async history(){ return api('/history'); },

    /** Everything the match client needs to join the current match. */
    matchEntry(){
      const m = state.match;
      if (!m) return null;
      return {
        matchId: m.matchId,
        wsUrl: m.matchUrl.replace(/^http/, 'ws'),
        token: m.token,
        spectatorToken: m.spectatorToken,
        teamId: m.teamId,
        status: m.status,
      };
    },

    /** Stop polling and release everything (tests, page teardown). */
    dispose(){
      clearInterval(timer);
      timer = null;
      if (ethereumRef?.removeListener && accountsChangedHandler)
        ethereumRef.removeListener('accountsChanged', accountsChangedHandler);
      ethereumRef = null;
    },
  };
}
