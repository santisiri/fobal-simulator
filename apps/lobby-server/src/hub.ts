// Matchmaking lobby front door (B1). Plain HTTP + polling — presence at
// staging scale does not justify a WS fan-out (roadmap open decision 2:
// polling first; a socket lobby can replace this transport later without
// touching the flow).
//
//   GET  /health                      unauthenticated liveness
//   POST /auth/request                {email} → login code (dev: returned)
//   POST /auth/verify                 {email, code} → {token, account}
//   GET  /lobby                       roster + challenges + my active match
//   POST /account/team                {teamName} rename my team
//   GET  /squad                       my players + kit (defaults annotated)
//   POST /squad                       {colors?, players?} edit names/kit
//   POST /challenges                  {to, rematchOf?} challenge a player
//   POST /challenges/:id/accept       creates the authoritative match
//   POST /challenges/:id/decline      decline (or cancel your own)
//   POST /matches/:id/leave           back to the lobby
//   GET  /history                     my finished matches, W/D/L perspective
//
// Trust boundary: the lobby holds the match-server create key SERVER-SIDE
// and never serves it. Players receive only role-scoped match tokens; the
// match server remains the sole author of match state and signed results —
// B5 history merely CACHES result summaries the lobby reads back with the
// spectator token it already holds (and uses them to auto-free players at
// full time, so nobody has to click LEAVE).
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { TeamSnapshot } from '@fobal/protocol';
import { signSession, verifySession } from './sessions.js';
import { Account, LobbyStore, MatchRecord, SquadCustomization } from './store.js';
import { buildManifest, buildTeam } from './teams.js';
import { nameAllowed } from './names.js';
import { ChainReader, ChainReadError } from './chain.js';
import { MintError, MintProgress, MintService, PlayerSeedInput } from './mint.js';
import { ADDRESS_RE, challengeMessage, recoverPersonalSigner } from './wallet.js';

export interface LobbyServerOptions {
  port?: number;                    // 0 → ephemeral
  secret?: string;                  // session HMAC secret
  /** root for the file-backed store; omitted → memory-only (tests) */
  storeRoot?: string;
  /** pre-built store (e.g. S3-mirrored, already hydrated) — overrides storeRoot */
  store?: LobbyStore;
  /** where and how to create authoritative matches */
  matchServer: {
    url: string;                    // lobby → match server (may be internal)
    createKey: string;
    publicUrl?: string;             // browser → match server (default: url)
  };
  /** return login codes in the response instead of delivering them (LOCAL
   *  DEV ONLY — staging/production deliver by email via deliverCode) */
  devAuth?: boolean;
  /** production code delivery (SES: createSesDeliverer). With neither this
   *  nor devAuth configured, /auth/request answers 501 — codes must never
   *  silently vanish into a black hole. */
  deliverCode?: (email: string, code: string) => void | Promise<void>;
  /** acceptance backdoor: requests carrying x-fobal-test-key equal to this
   *  secret get the code in the response even with devAuth off. Held in
   *  Secrets Manager on staging; never reaches clients. */
  testLoginKey?: string;
  corsOrigin?: string;              // default '*'
  presenceTtlMs?: number;           // default 12s (client polls every ~2s)
  matchActiveMs?: number;           // default 10min (matches run ~3.5min)
  challengeTtlMs?: number;          // default 2min
  authRequestIntervalMs?: number;   // default 5s per email
  /** don't look for a result before a match is this old (default 3min) */
  resultCheckAfterMs?: number;
  /** min interval between result checks per match (default 20s) */
  resultCheckEveryMs?: number;
  /** challenge-spam guard (M2): max challenges an account may CREATE per
   *  rolling window (default 8 per 10min) */
  challengeLimit?: { count: number; windowMs: number };
  /** D1: chain registry reader (createChainReader). Absent → POST
   *  /squad/chain answers 501. Wallet AUTH needs no configuration at all —
   *  signature recovery is offline. */
  chainReader?: ChainReader | null;
  /** M5: the mint step machine (createMintService). Absent → POST
   *  /mint/prepare answers 501. Requires the generator signer key. */
  mintService?: MintService | null;
}

export interface LobbyServer {
  httpServer: Server;
  port: number;
  secret: string;
  store: LobbyStore;
  close(): Promise<void>;
}

interface Challenge { id: string; from: string; to: string; createdAt: number; deliveredAt?: number; rematchOf?: string; }
interface LoginCode { code: string; expiresAt: number; lastRequestAt: number; }

const LOGIN_CODE_TTL_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonWithCors(corsOrigin: string) {
  return function json(res: ServerResponse, code: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data),
      // bearer-token auth in a header, no cookies — a permissive origin
      // grants nothing by itself (same stance as the match server)
      'access-control-allow-origin': corsOrigin,
    });
    res.end(data);
  };
}

async function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req){
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const sanitizeHandle = (localPart: string): string =>
  localPart.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'coach';

const HEX_COLOR = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/;
const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const cleanName = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, '').trim();

export async function startLobbyServer(options: LobbyServerOptions): Promise<LobbyServer> {
  const secret = options.secret ?? randomBytes(24).toString('base64url');
  const store = options.store ?? new LobbyStore(options.storeRoot);
  const corsOrigin = options.corsOrigin ?? '*';
  const json = jsonWithCors(corsOrigin);
  const presenceTtl = options.presenceTtlMs ?? 12_000;
  const matchActiveMs = options.matchActiveMs ?? 10 * 60 * 1000;
  const challengeTtl = options.challengeTtlMs ?? 2 * 60 * 1000;
  const authInterval = options.authRequestIntervalMs ?? 5_000;
  const resultAfter = options.resultCheckAfterMs ?? 3 * 60 * 1000;
  const resultEvery = options.resultCheckEveryMs ?? 20_000;
  const matchUrl = options.matchServer.url.replace(/\/+$/, '');
  const publicMatchUrl = (options.matchServer.publicUrl ?? matchUrl).replace(/\/+$/, '');

  const loginCodes = new Map<string, LoginCode>();
  // D2: one-shot wallet challenges keyed by lowercase address
  const walletChallenges = new Map<string, { nonce: string; message: string; expiresAt: number; lastRequestAt: number }>();
  // presence: lastSeen drives the TTL (ghost users age out, nothing to
  // clean up); joinedAt is the current lobby VISIT — returning after a TTL
  // gap starts a new visit, so "joined 2m ago" never lies after a lunch break
  const presence = new Map<string, { lastSeen: number; joinedAt: number }>();
  const challenges = new Map<string, Challenge>();
  // idempotency memory: a settled challenge id keeps answering with its
  // outcome for a grace window, so a double-click, a retried request, or a
  // reconnect replay converges instead of erroring or double-creating
  const settledChallenges = new Map<string, { outcome: 'accepted' | 'declined'; matchId?: string; at: number }>();
  const SETTLED_TTL_MS = 5 * 60 * 1000;
  const resultChecks = new Map<string, number>();   // matchId → last poll ms
  const challengeLimit = options.challengeLimit ?? { count: 8, windowMs: 10 * 60 * 1000 };
  const challengeTimes = new Map<string, number[]>();  // accountId → creation times

  const touchPresence = (accountId: string): void => {
    const now = Date.now();
    const p = presence.get(accountId);
    presence.set(accountId, {
      lastSeen: now,
      joinedAt: p && p.lastSeen > now - presenceTtl ? p.joinedAt : now,
    });
  };

  const online = (accountId: string): boolean =>
    (presence.get(accountId)?.lastSeen ?? 0) > Date.now() - presenceTtl;

  /** How long an accepted match counts as "preparing" (both clients are
   *  navigating/connecting) before it reads as fully in play. */
  const PREPARING_MS = 45_000;

  /** The lobby presence state machine, derived — no writes, no sweeps:
   *  match (fresh → preparing_match, else in_match) beats challenged beats
   *  available; silence past the TTL is disconnected regardless of nothing
   *  else, EXCEPT a live match (a playing coach's lobby tab is closed). */
  function statusOf(accountId: string): 'available' | 'challenged' | 'preparing_match' | 'in_match' | 'disconnected' {
    const match = activeMatchFor(accountId);
    if (match)
      return Date.now() - Date.parse(match.createdAt) < PREPARING_MS ? 'preparing_match' : 'in_match';
    if (!online(accountId)) return 'disconnected';
    for (const c of challenges.values())
      if (c.from === accountId || c.to === accountId) return 'challenged';
    return 'available';
  }

  /** a match with a known result is over — players are free, no LEAVE needed */
  function activeMatchFor(accountId: string): MatchRecord | null {
    const cutoff = Date.now() - matchActiveMs;
    return store.matchesFor(accountId).find(m =>
      !m.result && !m.left[accountId] && Date.parse(m.createdAt) > cutoff) ?? null;
  }

  /** Fetch-and-cache the signed result once the match server has one. The
   *  lobby reads with the spectator token it minted the record with; a 404
   *  simply means the match is still playing. Throttled per match. */
  async function ensureResult(record: MatchRecord): Promise<void> {
    if (record.result) return;
    if (Date.now() - Date.parse(record.createdAt) < resultAfter) return;
    const last = resultChecks.get(record.matchId) ?? 0;
    if (Date.now() - last < resultEvery) return;
    resultChecks.set(record.matchId, Date.now());
    try {
      const res = await fetch(`${matchUrl}/matches/${record.matchId}/result`, {
        headers: { authorization: `Bearer ${record.spectatorToken}` },
      });
      if (res.status !== 200) return;
      const result = await res.json() as {
        finalScore: [number, number]; teams: [string, string]; finalStateHash: string;
      };
      record.result = {
        finalScore: result.finalScore,
        teams: result.teams,
        finalStateHash: result.finalStateHash,
        finishedAt: new Date().toISOString(),
      };
      store.saveMatch(record);
      resultChecks.delete(record.matchId);
    } catch { /* match server unreachable — retried on a later poll */ }
  }

  function outcomeFor(record: MatchRecord, accountId: string): { my: number; opp: number; outcome: 'W' | 'D' | 'L' } | null {
    const mine = record.players[accountId];
    if (!record.result || !mine) return null;
    const idx = record.result.teams[0] === mine.teamId ? 0 : 1;
    const my = record.result.finalScore[idx]!;
    const opp = record.result.finalScore[1 - idx]!;
    return { my, opp, outcome: my > opp ? 'W' : my < opp ? 'L' : 'D' };
  }

  function recordTally(accountId: string): { w: number; d: number; l: number } {
    const tally = { w: 0, d: 0, l: 0 };
    for (const m of store.matchesFor(accountId)){
      const o = outcomeFor(m, accountId);
      if (o) tally[o.outcome === 'W' ? 'w' : o.outcome === 'D' ? 'd' : 'l']++;
    }
    return tally;
  }

  function sweepChallenges(): void {
    const cutoff = Date.now() - challengeTtl;
    for (const [id, c] of challenges) if (c.createdAt < cutoff) challenges.delete(id);
    const settledCutoff = Date.now() - SETTLED_TTL_MS;
    for (const [id, s] of settledChallenges) if (s.at < settledCutoff) settledChallenges.delete(id);
  }

  function authed(req: IncomingMessage): Account | null {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) return null;
    const payload = verifySession(auth.slice(7), secret);
    const account = payload ? store.getAccount(payload.accountId) : null;
    if (account) touchPresence(account.accountId);
    return account;
  }

  const publicAccount = (a: Account) =>
    ({
      accountId: a.accountId, handle: a.handle, teamName: a.teamName,
      // both are public information by nature (the chain is public)
      ...(a.wallet ? { wallet: a.wallet } : {}),
      ...(a.chainTeam ? { chainTeamId: a.chainTeam.teamId } : {}),
    });

  function joinInfo(record: MatchRecord, accountId: string){
    const mine = record.players[accountId]!;
    return {
      matchId: record.matchId,
      matchUrl: record.matchUrl,
      teamId: mine.teamId,
      token: mine.token,
      spectatorToken: record.spectatorToken,
      createdAt: record.createdAt,
    };
  }

  function challengeView(c: Challenge){
    const from = store.getAccount(c.from);
    const to = store.getAccount(c.to);
    return {
      id: c.id,
      from: from ? publicAccount(from) : { accountId: c.from, handle: '?', teamName: '?' },
      to: to ? publicAccount(to) : { accountId: c.to, handle: '?', teamName: '?' },
      createdAt: new Date(c.createdAt).toISOString(),
      // lifecycle: created → delivered (the target's poll picked it up) →
      // accepted / declined / expired. The terminal states live in
      // settledChallenges / the expiry sweep; a live view carries the rest.
      status: c.deliveredAt !== undefined ? 'delivered' as const : 'created' as const,
      ...(c.deliveredAt !== undefined ? { deliveredAt: new Date(c.deliveredAt).toISOString() } : {}),
      expiresAt: new Date(c.createdAt + challengeTtl).toISOString(),
      rematch: c.rematchOf !== undefined,
    };
  }

  /** Presentation aggregate for opponent scouting: mean of the XI's rating
   *  means, 0-100. Derived from the same buildTeam that will build the
   *  manifest — what you scout is what you face. */
  function teamOverall(account: Account): number {
    const players = buildTeam(account).players.slice(0, 11);
    const sum = players.reduce((acc, p) => {
      const r = Object.values(p.ratings);
      return acc + r.reduce((a, b) => a + b, 0) / r.length;
    }, 0);
    return Math.round(sum / players.length);
  }

  /** The normalized lobby identity (workstream charter): stable fields the
   *  UI can rely on regardless of auth method. displayName is the handle
   *  until the ENS workstream provides names — same field, richer source. */
  function participantView(a: Account){
    const team = buildTeam(a);
    return {
      ...publicAccount(a),
      walletAddress: a.wallet ?? null,
      displayName: a.handle,
      squadId: team.teamId,
      squadName: a.teamName,
      teamOverall: teamOverall(a),
      status: statusOf(a.accountId),
      joinedAt: presence.get(a.accountId)
        ? new Date(presence.get(a.accountId)!.joinedAt).toISOString() : null,
      record: recordTally(a.accountId),
      // back-compat booleans (pre-charter clients read these)
      online: online(a.accountId),
      inMatch: activeMatchFor(a.accountId) !== null,
    };
  }

  async function lobbyState(me: Account){
    sweepChallenges();
    // full-time detection rides the poll: check my current match (throttled)
    // so players free up automatically shortly after the final whistle
    const current = activeMatchFor(me.accountId);
    if (current) await ensureResult(current);
    const mine = [...challenges.values()];
    // delivery stamp: the moment the TARGET's poll first carries a
    // challenge, it is delivered — the challenger's view flips from
    // 'created' to 'delivered' ("seen") on their next poll
    for (const c of mine)
      if (c.to === me.accountId && c.deliveredAt === undefined) c.deliveredAt = Date.now();
    const match = activeMatchFor(me.accountId);
    return {
      me: {
        ...participantView(me),
        email: me.email,
      },
      players: store.listAccounts()
        .filter(a => a.accountId !== me.accountId)
        .map(participantView),
      challenges: {
        incoming: mine.filter(c => c.to === me.accountId).map(challengeView),
        outgoing: mine.filter(c => c.from === me.accountId).map(challengeView),
      },
      match: match ? {
        ...joinInfo(match, me.accountId),
        status: Date.now() - Date.parse(match.createdAt) < PREPARING_MS ? 'preparing' : 'live',
      } : null,
    };
  }

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'OPTIONS'){
        res.writeHead(204, {
          'access-control-allow-origin': corsOrigin,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '86400',
        });
        return res.end();
      }

      if (req.method === 'GET' && url.pathname === '/health'){
        return json(res, 200, {
          ok: true,
          accounts: store.accountCount,
          online: store.listAccounts().filter(a => online(a.accountId)).length,
          uptimeSeconds: Math.round(process.uptime()),
        });
      }

      // The frontend's getPlayer(tokenId) — one normalized structure from
      // ONE eth_call (docs/PLAYER_DATA_MODEL.md). Public on purpose: it
      // serves chain state, which is public by nature, and needs no session.
      const playerMatch = req.method === 'GET' && url.pathname.match(/^\/players\/(\d{1,20})$/);
      if (playerMatch){
        if (!options.chainReader)
          return json(res, 501, { error: 'chain reads are not configured on this lobby' });
        try {
          return json(res, 200, { player: await options.chainReader.readPlayer(BigInt(playerMatch[1]!)) });
        } catch (err) {
          if (err instanceof ChainReadError) return json(res, err.status, { error: err.message });
          return json(res, 502, { error: 'chain read failed — try again shortly' });
        }
      }

      if (req.method === 'POST' && url.pathname === '/auth/request'){
        let email: unknown;
        try { email = (JSON.parse(await readBody(req)) as { email?: unknown }).email; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 254)
          return json(res, 400, { error: 'a valid email is required' });
        if (!options.devAuth && !options.deliverCode)
          return json(res, 501, { error: 'login delivery is not configured' });
        const key = email.toLowerCase();
        const existing = loginCodes.get(key);
        if (existing && Date.now() - existing.lastRequestAt < authInterval)
          return json(res, 429, { error: 'code already sent — wait a few seconds' });
        const code = randomBytes(4).toString('hex');
        loginCodes.set(key, { code, expiresAt: Date.now() + LOGIN_CODE_TTL_MS, lastRequestAt: Date.now() });
        // the code rides the response for local dev and for the acceptance
        // scripts presenting the server-held test key — and a code that is
        // being HANDED BACK is never also emailed (acceptance must not
        // depend on SES health, burn sending quota, or mail ghost inboxes)
        const reveal = options.devAuth === true
          || (options.testLoginKey !== undefined && req.headers['x-fobal-test-key'] === options.testLoginKey);
        if (!reveal && options.deliverCode){
          try { await options.deliverCode(key, code); }
          catch {
            // failed send must not leave a live code (or a rate-limit lock)
            loginCodes.delete(key);
            return json(res, 502, { error: 'could not send the login code — try again shortly' });
          }
        }
        return json(res, 200, reveal ? { ok: true, devCode: code } : { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/auth/verify'){
        let body: { email?: unknown; code?: unknown };
        try { body = JSON.parse(await readBody(req)) as typeof body; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof body.email !== 'string' || typeof body.code !== 'string')
          return json(res, 400, { error: 'email and code are required' });
        const key = body.email.toLowerCase();
        const pending = loginCodes.get(key);
        if (!pending || pending.code !== body.code || pending.expiresAt < Date.now())
          return json(res, 401, { error: 'invalid or expired code' });
        loginCodes.delete(key);          // single use
        let account = store.getAccountByEmail(key);
        if (!account){
          const accountId = `acc-${randomBytes(4).toString('hex')}`;
          const handle = sanitizeHandle(key.split('@')[0] ?? '');
          account = {
            accountId, email: key, handle,
            teamKey: `${handle}-${accountId.slice(4)}`,
            teamName: `${handle.toUpperCase()} FC`.slice(0, 32),
            createdAt: new Date().toISOString(),
          };
          store.saveAccount(account);
        }
        touchPresence(account.accountId);
        return json(res, 200, { token: signSession(account.accountId, secret), account: publicAccount(account) });
      }

      // D2 — wallet auth, step 1: hand out a one-shot challenge to sign.
      // Needs no configuration: recovery is offline, no chain involved.
      if (req.method === 'POST' && url.pathname === '/auth/wallet'){
        let address: unknown;
        try { address = (JSON.parse(await readBody(req)) as { address?: unknown }).address; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof address !== 'string' || !ADDRESS_RE.test(address))
          return json(res, 400, { error: 'a 0x wallet address is required' });
        const key = address.toLowerCase();
        const existing = walletChallenges.get(key);
        if (existing && Date.now() - existing.lastRequestAt < authInterval)
          return json(res, 429, { error: 'challenge already issued — wait a few seconds' });
        const nonce = randomBytes(16).toString('hex');
        const message = challengeMessage(key, nonce, new Date().toISOString());
        walletChallenges.set(key, {
          nonce, message,
          expiresAt: Date.now() + WALLET_CHALLENGE_TTL_MS,
          lastRequestAt: Date.now(),
        });
        return json(res, 200, { message });
      }

      // D2 — wallet auth, step 2: verify the signature, mint the same
      // session an email login gets. Accounts are keyed by address; the
      // email field carries the address (wallets have no inbox).
      if (req.method === 'POST' && url.pathname === '/auth/wallet/verify'){
        let body: { address?: unknown; signature?: unknown };
        try { body = JSON.parse(await readBody(req)) as typeof body; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof body.address !== 'string' || !ADDRESS_RE.test(body.address)
          || typeof body.signature !== 'string')
          return json(res, 400, { error: 'address and signature are required' });
        const key = body.address.toLowerCase();
        const challenge = walletChallenges.get(key);
        if (!challenge || challenge.expiresAt < Date.now())
          return json(res, 401, { error: 'no live challenge for this address — request one first' });
        const signer = recoverPersonalSigner(challenge.message, body.signature);
        if (signer !== key)
          return json(res, 401, { error: 'signature does not match the wallet' });
        walletChallenges.delete(key);          // single use
        let account = store.getAccountByWallet(key);
        if (!account){
          const accountId = `acc-${randomBytes(4).toString('hex')}`;
          const handle = `w${key.slice(2, 8)}`;
          account = {
            accountId, email: key, wallet: key, handle,
            teamKey: `${handle}-${accountId.slice(4)}`,
            teamName: `${handle.toUpperCase()} FC`.slice(0, 32),
            createdAt: new Date().toISOString(),
          };
          store.saveAccount(account);
        }
        touchPresence(account.accountId);
        return json(res, 200, { token: signSession(account.accountId, secret), account: publicAccount(account) });
      }

      // everything below requires a session
      const me = authed(req);
      if (!me) return json(res, 401, { error: 'session token required' });

      if (req.method === 'GET' && url.pathname === '/lobby')
        return json(res, 200, await lobbyState(me));

      if (req.method === 'GET' && url.pathname === '/history'){
        const mine = store.matchesFor(me.accountId).slice(0, 20);
        for (const record of mine) await ensureResult(record);
        return json(res, 200, {
          matches: mine.map(record => {
            const oppId = Object.keys(record.players).find(id => id !== me.accountId);
            const opp = oppId ? store.getAccount(oppId) : null;
            const o = outcomeFor(record, me.accountId);
            return {
              matchId: record.matchId,
              createdAt: record.createdAt,
              finishedAt: record.result?.finishedAt ?? null,
              opponent: opp ? publicAccount(opp) : null,
              outcome: o?.outcome ?? null,
              score: o ? [o.my, o.opp] : null,
              // replay theater coordinates: the spectator token is shareable
              // by design, and GET /replay serves finished matches from the
              // store long after the room is gone
              matchUrl: record.matchUrl,
              spectatorToken: record.spectatorToken,
            };
          }),
        });
      }

      if (req.method === 'GET' && url.pathname === '/squad'){
        const base = buildTeam(me, { customized: false });
        const final = buildTeam(me);
        return json(res, 200, {
          teamName: me.teamName,
          colors: me.squad?.colors ?? null,
          players: final.players.map((p, i) => ({
            playerId: p.playerId,
            name: p.name,
            defaultName: base.players[i]!.name,
            role: p.role,
            shirtNumber: p.shirtNumber,
          })),
        });
      }

      if (req.method === 'POST' && url.pathname === '/squad'){
        let body: { colors?: unknown; players?: unknown };
        try { body = JSON.parse(await readBody(req)) as typeof body; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        const squad: SquadCustomization = { ...(me.squad ?? {}) };

        if (body.colors !== undefined){
          const colors = body.colors as { primary?: unknown; secondary?: unknown };
          const next: { primary?: string; secondary?: string } = {};
          for (const key of ['primary', 'secondary'] as const){
            const v = colors?.[key];
            if (v === undefined || v === null || v === '') continue;
            if (typeof v !== 'string' || !HEX_COLOR.test(v))
              return json(res, 400, { error: `${key} must be a hex color like #d8342c` });
            next[key] = v.toLowerCase();
          }
          if (next.primary || next.secondary) squad.colors = next;
          else delete squad.colors;
        }

        if (body.players !== undefined){
          if (!Array.isArray(body.players)) return json(res, 400, { error: 'players must be an array' });
          const base = buildTeam(me, { customized: false });
          const defaults = new Map(base.players.map(p => [p.playerId, p.name]));
          const names = { ...(squad.playerNames ?? {}) };
          for (const entry of body.players as Array<{ playerId?: unknown; name?: unknown }>){
            if (typeof entry?.playerId !== 'string' || !defaults.has(entry.playerId))
              return json(res, 400, { error: `unknown playerId ${String(entry?.playerId)}` });
            if (typeof entry.name !== 'string') return json(res, 400, { error: 'name must be a string' });
            const name = cleanName(entry.name);
            if (name.length < 2 || name.length > 24)
              return json(res, 400, { error: 'player names must be 2–24 characters' });
            if (!nameAllowed(name))
              return json(res, 400, { error: 'that player name is not allowed' });
            // saving the default back clears the override — the store stays lean
            if (name === defaults.get(entry.playerId)) delete names[entry.playerId];
            else names[entry.playerId] = name;
          }
          if (Object.keys(names).length) squad.playerNames = names;
          else delete squad.playerNames;
        }

        const updated: Account = { ...me, squad: (squad.colors || squad.playerNames) ? squad : undefined };
        // the manifest contract is the last word — never store a squad the
        // match server would reject at challenge time
        const check = TeamSnapshot.safeParse(buildTeam(updated));
        if (!check.success)
          return json(res, 400, { error: `squad rejected: ${check.error.issues[0]?.message ?? 'invalid'}` });
        store.saveAccount(updated);
        const final = buildTeam(updated);
        const base = buildTeam(updated, { customized: false });
        return json(res, 200, {
          teamName: updated.teamName,
          colors: updated.squad?.colors ?? null,
          players: final.players.map((p, i) => ({
            playerId: p.playerId,
            name: p.name,
            defaultName: base.players[i]!.name,
            role: p.role,
            shirtNumber: p.shirtNumber,
          })),
        });
      }

      // D1 — link the wallet's on-chain team: read the registry at one
      // pinned block, validate through the protocol schema, store the
      // resulting squad. From here on every manifest uses the NFTs.
      if (req.method === 'POST' && url.pathname === '/squad/chain'){
        if (!me.wallet)
          return json(res, 403, { error: 'chain squads need a wallet login (POST /auth/wallet)' });
        if (!options.chainReader)
          return json(res, 501, { error: 'chain reads are not configured on this lobby' });
        let teamId: unknown;
        try { teamId = (JSON.parse(await readBody(req)) as { teamId?: unknown }).teamId; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof teamId !== 'number' || !Number.isInteger(teamId) || teamId <= 0)
          return json(res, 400, { error: 'teamId must be a positive integer' });
        try {
          const team = await options.chainReader.readTeam(me.wallet, teamId);
          store.saveAccount({ ...me, chainTeam: team });
          return json(res, 200, { team });
        } catch (err) {
          if (err instanceof ChainReadError) return json(res, err.status, { error: err.message });
          return json(res, 502, { error: 'chain read failed — try again shortly' });
        }
      }

      // M5 — mint your team: the idempotent step machine. Each call returns
      // the NEXT prepared transaction ({to, data} — the browser wallet just
      // sends it) until the wallet owns team + 11 NFTs + declared roster;
      // then it's done and /squad/chain adopts the squad. The permit is
      // signed HERE; the player's wallet pays gas and owns everything.
      if (req.method === 'POST' && url.pathname === '/mint/prepare'){
        if (!me.wallet)
          return json(res, 403, { error: 'minting needs a wallet login (POST /auth/wallet)' });
        if (!options.mintService)
          return json(res, 501, { error: 'minting is not configured on this lobby' });
        let body: { teamName?: unknown; seeds?: unknown; progress?: unknown };
        try { body = JSON.parse(await readBody(req, 64 * 1024)) as typeof body; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof body.teamName !== 'string' || !Array.isArray(body.seeds))
          return json(res, 400, { error: 'teamName and seeds are required' });
        const progress = typeof body.progress === 'object' && body.progress !== null
          ? body.progress as MintProgress : undefined;
        try {
          const plan = await options.mintService.prepare(
            me.wallet, body.teamName, body.seeds as PlayerSeedInput[], progress);
          return json(res, 200, plan);
        } catch (err) {
          if (err instanceof MintError) return json(res, err.status, { error: err.message });
          return json(res, 502, { error: 'mint preparation failed — try again shortly' });
        }
      }

      // unlink: back to the generated squad
      if (req.method === 'DELETE' && url.pathname === '/squad/chain'){
        const { chainTeam: _dropped, ...rest } = me;
        store.saveAccount(rest);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/account/team'){
        let teamName: unknown;
        try { teamName = (JSON.parse(await readBody(req)) as { teamName?: unknown }).teamName; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof teamName !== 'string') return json(res, 400, { error: 'teamName is required' });
        const clean = teamName.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        if (clean.length < 2 || clean.length > 32)
          return json(res, 400, { error: 'teamName must be 2–32 characters' });
        if (!nameAllowed(clean))
          return json(res, 400, { error: 'that name is not allowed' });
        store.saveAccount({ ...me, teamName: clean });
        return json(res, 200, { account: publicAccount({ ...me, teamName: clean }) });
      }

      if (req.method === 'POST' && url.pathname === '/challenges'){
        sweepChallenges();
        let to: unknown, rematchOf: unknown;
        try {
          const body = JSON.parse(await readBody(req)) as { to?: unknown; rematchOf?: unknown };
          to = body.to;
          rematchOf = body.rematchOf;
        }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof to !== 'string' || to === me.accountId)
          return json(res, 400, { error: 'challenge someone else' });
        const target = store.getAccount(to);
        if (!target) return json(res, 404, { error: 'unknown player' });
        if (!online(to)) return json(res, 409, { error: `${target.handle} is offline` });
        if (activeMatchFor(me.accountId) || activeMatchFor(to))
          return json(res, 409, { error: 'one of you is already in a match' });
        for (const c of challenges.values()){
          // idempotent re-issue: challenging the same player again returns
          // the SAME pending challenge (double-click, retry, second tab —
          // they all converge on one id instead of stacking or erroring)
          if (c.from === me.accountId && c.to === to)
            return json(res, 200, { challenge: challengeView(c) });
          if (c.from === to && c.to === me.accountId)
            return json(res, 409, { error: `${target.handle} already challenged YOU — accept it instead` });
        }
        // challenge-spam guard: creations per account per rolling window —
        // declining and re-challenging in good faith never gets near it
        const times = (challengeTimes.get(me.accountId) ?? []).filter(t => t > Date.now() - challengeLimit.windowMs);
        if (times.length >= challengeLimit.count){
          challengeTimes.set(me.accountId, times);
          return json(res, 429, { error: 'easy, coach — too many challenges; try again in a few minutes' });
        }
        // rematch is just a challenge wearing history: the reference must be a
        // match the two of you actually played (it only decorates the invite)
        if (rematchOf !== undefined){
          const played = typeof rematchOf === 'string'
            && store.matchesFor(me.accountId).some(m => m.matchId === rematchOf && m.players[to] !== undefined);
          if (!played) return json(res, 400, { error: 'rematchOf must be a match you both played' });
        }
        const challenge: Challenge = {
          id: `ch-${randomBytes(4).toString('hex')}`,
          from: me.accountId, to, createdAt: Date.now(),
          ...(typeof rematchOf === 'string' ? { rematchOf } : {}),
        };
        challenges.set(challenge.id, challenge);
        challengeTimes.set(me.accountId, [...times, Date.now()]);
        return json(res, 201, { challenge: challengeView(challenge) });
      }

      if (req.method === 'POST' && parts[0] === 'challenges' && parts.length === 3){
        sweepChallenges();
        const challenge = challenges.get(parts[1]!);
        if (!challenge){
          // idempotency memory: a just-settled id answers with its outcome —
          // a double-click on ACCEPT returns the SAME match instead of 404,
          // and a retried DECLINE stays a no-op
          const settled = settledChallenges.get(parts[1]!);
          if (settled?.outcome === 'accepted' && parts[2] === 'accept'){
            const record = settled.matchId ? store.matchesFor(me.accountId).find(m => m.matchId === settled.matchId) : undefined;
            if (record) return json(res, 200, { match: joinInfo(record, me.accountId) });
          }
          if (settled?.outcome === 'declined' && parts[2] === 'decline')
            return json(res, 200, { ok: true });
          return json(res, 404, { error: 'unknown or expired challenge' });
        }

        if (parts[2] === 'decline'){
          if (challenge.to !== me.accountId && challenge.from !== me.accountId)
            return json(res, 403, { error: 'not your challenge' });
          challenges.delete(challenge.id);
          settledChallenges.set(challenge.id, { outcome: 'declined', at: Date.now() });
          return json(res, 200, { ok: true });
        }

        if (parts[2] === 'accept'){
          if (challenge.to !== me.accountId) return json(res, 403, { error: 'only the challenged player accepts' });
          const challenger = store.getAccount(challenge.from);
          if (!challenger){ challenges.delete(challenge.id); return json(res, 404, { error: 'challenger vanished' }); }
          if (activeMatchFor(me.accountId) || activeMatchFor(challenger.accountId))
            return json(res, 409, { error: 'one of you is already in a match' });

          const matchId = `lm-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
          const seed = randomInt(0, 0x100000000);
          const manifest = buildManifest(matchId, seed, challenger, me);
          let created: { matchId: string; tokens: Record<string, string>; spectatorToken: string };
          try {
            const upstream = await fetch(`${matchUrl}/matches`, {
              method: 'POST',
              headers: { authorization: `Bearer ${options.matchServer.createKey}`, 'content-type': 'application/json' },
              body: JSON.stringify(manifest),
            });
            const body = await upstream.json() as typeof created & { error?: string; code?: string };
            // M2 backpressure: capacity is temporary — surface it plainly
            // and KEEP the challenge so accepting again just works
            if (upstream.status === 503 || body.code === 'server_full')
              return json(res, 503, { error: 'the match servers are full — try again in a minute' });
            if (upstream.status !== 201)
              return json(res, 502, { error: `match server rejected the match: ${body.error ?? upstream.status}` });
            created = body;
          } catch {
            return json(res, 502, { error: 'match server unreachable' });
          }

          challenges.delete(challenge.id);
          settledChallenges.set(challenge.id, { outcome: 'accepted', matchId: created.matchId, at: Date.now() });
          const [homeTeam, awayTeam] = manifest.teams;
          const record: MatchRecord = {
            matchId: created.matchId,
            matchUrl: publicMatchUrl,
            createdAt: new Date().toISOString(),
            spectatorToken: created.spectatorToken,
            players: {
              [challenger.accountId]: { teamId: homeTeam.teamId, token: created.tokens[homeTeam.teamId]! },
              [me.accountId]: { teamId: awayTeam.teamId, token: created.tokens[awayTeam.teamId]! },
            },
            left: {},
          };
          store.saveMatch(record);
          return json(res, 201, { match: joinInfo(record, me.accountId) });
        }
      }

      if (req.method === 'POST' && parts[0] === 'matches' && parts[2] === 'leave'){
        const record = store.matchesFor(me.accountId).find(m => m.matchId === parts[1]);
        if (!record) return json(res, 404, { error: 'unknown match' });
        record.left[me.accountId] = true;
        store.saveMatch(record);
        return json(res, 200, { ok: true });
      }

      json(res, 404, { error: 'not found' });
    } catch (err){
      json(res, 500, { error: (err as Error).message });
    }
  });

  await new Promise<void>(resolve => httpServer.listen(options.port ?? 0, resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    httpServer, port, secret, store,
    close: () => new Promise<void>(resolve => { httpServer.close(() => resolve()); }),
  };
}
