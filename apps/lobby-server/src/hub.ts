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
//   POST /challenges                  {to} challenge a player
//   POST /challenges/:id/accept       creates the authoritative match
//   POST /challenges/:id/decline      decline (or cancel your own)
//   POST /matches/:id/leave           back to the lobby
//
// Trust boundary: the lobby holds the match-server create key SERVER-SIDE
// and never serves it. Players receive only role-scoped match tokens; the
// match server remains the sole author of match state and signed results.
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { signSession, verifySession } from './sessions.js';
import { Account, LobbyStore, MatchRecord } from './store.js';
import { buildManifest } from './teams.js';

export interface LobbyServerOptions {
  port?: number;                    // 0 → ephemeral
  secret?: string;                  // session HMAC secret
  /** root for the file-backed store; omitted → memory-only (tests) */
  storeRoot?: string;
  /** where and how to create authoritative matches */
  matchServer: {
    url: string;                    // lobby → match server (may be internal)
    createKey: string;
    publicUrl?: string;             // browser → match server (default: url)
  };
  /** return login codes in the response instead of delivering them (DEV ONLY;
   *  real delivery — SES — is a Phase B follow-up, seam: deliverCode) */
  devAuth?: boolean;
  deliverCode?: (email: string, code: string) => void | Promise<void>;
  corsOrigin?: string;              // default '*'
  presenceTtlMs?: number;           // default 12s (client polls every ~2s)
  matchActiveMs?: number;           // default 10min (matches run ~3.5min)
  challengeTtlMs?: number;          // default 2min
  authRequestIntervalMs?: number;   // default 5s per email
}

export interface LobbyServer {
  httpServer: Server;
  port: number;
  secret: string;
  store: LobbyStore;
  close(): Promise<void>;
}

interface Challenge { id: string; from: string; to: string; createdAt: number; }
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

export async function startLobbyServer(options: LobbyServerOptions): Promise<LobbyServer> {
  const secret = options.secret ?? randomBytes(24).toString('base64url');
  const store = new LobbyStore(options.storeRoot);
  const corsOrigin = options.corsOrigin ?? '*';
  const json = jsonWithCors(corsOrigin);
  const presenceTtl = options.presenceTtlMs ?? 12_000;
  const matchActiveMs = options.matchActiveMs ?? 10 * 60 * 1000;
  const challengeTtl = options.challengeTtlMs ?? 2 * 60 * 1000;
  const authInterval = options.authRequestIntervalMs ?? 5_000;
  const matchUrl = options.matchServer.url.replace(/\/+$/, '');
  const publicMatchUrl = (options.matchServer.publicUrl ?? matchUrl).replace(/\/+$/, '');

  const loginCodes = new Map<string, LoginCode>();
  const presence = new Map<string, number>();
  const challenges = new Map<string, Challenge>();

  const online = (accountId: string): boolean =>
    (presence.get(accountId) ?? 0) > Date.now() - presenceTtl;

  function activeMatchFor(accountId: string): MatchRecord | null {
    const cutoff = Date.now() - matchActiveMs;
    return store.matchesFor(accountId).find(m =>
      !m.left[accountId] && Date.parse(m.createdAt) > cutoff) ?? null;
  }

  function sweepChallenges(): void {
    const cutoff = Date.now() - challengeTtl;
    for (const [id, c] of challenges) if (c.createdAt < cutoff) challenges.delete(id);
  }

  function authed(req: IncomingMessage): Account | null {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) return null;
    const payload = verifySession(auth.slice(7), secret);
    const account = payload ? store.getAccount(payload.accountId) : null;
    if (account) presence.set(account.accountId, Date.now());
    return account;
  }

  const publicAccount = (a: Account) =>
    ({ accountId: a.accountId, handle: a.handle, teamName: a.teamName });

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
    };
  }

  function lobbyState(me: Account){
    sweepChallenges();
    const mine = [...challenges.values()];
    const match = activeMatchFor(me.accountId);
    return {
      me: { ...publicAccount(me), email: me.email },
      players: store.listAccounts()
        .filter(a => a.accountId !== me.accountId)
        .map(a => ({
          ...publicAccount(a),
          online: online(a.accountId),
          inMatch: activeMatchFor(a.accountId) !== null,
        })),
      challenges: {
        incoming: mine.filter(c => c.to === me.accountId).map(challengeView),
        outgoing: mine.filter(c => c.from === me.accountId).map(challengeView),
      },
      match: match ? joinInfo(match, me.accountId) : null,
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

      if (req.method === 'POST' && url.pathname === '/auth/request'){
        let email: unknown;
        try { email = (JSON.parse(await readBody(req)) as { email?: unknown }).email; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 254)
          return json(res, 400, { error: 'a valid email is required' });
        const key = email.toLowerCase();
        const existing = loginCodes.get(key);
        if (existing && Date.now() - existing.lastRequestAt < authInterval)
          return json(res, 429, { error: 'code already sent — wait a few seconds' });
        const code = randomBytes(4).toString('hex');
        loginCodes.set(key, { code, expiresAt: Date.now() + LOGIN_CODE_TTL_MS, lastRequestAt: Date.now() });
        await options.deliverCode?.(key, code);
        // dev transport: the code rides the response; production delivery
        // (SES) plugs into deliverCode and this branch stays off
        return json(res, 200, options.devAuth ? { ok: true, devCode: code } : { ok: true });
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
        presence.set(account.accountId, Date.now());
        return json(res, 200, { token: signSession(account.accountId, secret), account: publicAccount(account) });
      }

      // everything below requires a session
      const me = authed(req);
      if (!me) return json(res, 401, { error: 'session token required' });

      if (req.method === 'GET' && url.pathname === '/lobby')
        return json(res, 200, lobbyState(me));

      if (req.method === 'POST' && url.pathname === '/account/team'){
        let teamName: unknown;
        try { teamName = (JSON.parse(await readBody(req)) as { teamName?: unknown }).teamName; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof teamName !== 'string') return json(res, 400, { error: 'teamName is required' });
        const clean = teamName.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        if (clean.length < 2 || clean.length > 32)
          return json(res, 400, { error: 'teamName must be 2–32 characters' });
        store.saveAccount({ ...me, teamName: clean });
        return json(res, 200, { account: publicAccount({ ...me, teamName: clean }) });
      }

      if (req.method === 'POST' && url.pathname === '/challenges'){
        sweepChallenges();
        let to: unknown;
        try { to = (JSON.parse(await readBody(req)) as { to?: unknown }).to; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof to !== 'string' || to === me.accountId)
          return json(res, 400, { error: 'challenge someone else' });
        const target = store.getAccount(to);
        if (!target) return json(res, 404, { error: 'unknown player' });
        if (!online(to)) return json(res, 409, { error: `${target.handle} is offline` });
        if (activeMatchFor(me.accountId) || activeMatchFor(to))
          return json(res, 409, { error: 'one of you is already in a match' });
        for (const c of challenges.values())
          if ((c.from === me.accountId && c.to === to) || (c.from === to && c.to === me.accountId))
            return json(res, 409, { error: 'a challenge between you is already pending' });
        const challenge: Challenge = {
          id: `ch-${randomBytes(4).toString('hex')}`,
          from: me.accountId, to, createdAt: Date.now(),
        };
        challenges.set(challenge.id, challenge);
        return json(res, 201, { challenge: challengeView(challenge) });
      }

      if (req.method === 'POST' && parts[0] === 'challenges' && parts.length === 3){
        sweepChallenges();
        const challenge = challenges.get(parts[1]!);
        if (!challenge) return json(res, 404, { error: 'unknown or expired challenge' });

        if (parts[2] === 'decline'){
          if (challenge.to !== me.accountId && challenge.from !== me.accountId)
            return json(res, 403, { error: 'not your challenge' });
          challenges.delete(challenge.id);
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
            const body = await upstream.json() as typeof created & { error?: string };
            if (upstream.status !== 201)
              return json(res, 502, { error: `match server rejected the match: ${body.error ?? upstream.status}` });
            created = body;
          } catch {
            return json(res, 502, { error: 'match server unreachable' });
          }

          challenges.delete(challenge.id);
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
