// HTTP + WebSocket front door.
//
//   GET  /health                   unauthenticated liveness (ALB/ECS checks)
//   POST /matches                  (Bearer createKey) manifest → tokens
//   GET  /matches/:id/result       signed final result
//   GET  /matches/:id/replay       ReplayFile (manifest + command log + events)
//   GET  /matches/:id/replays/goals  dense re-simulated goal clips
//   WS   /                         hello{token} → welcome → snapshots/deltas/events
//
// The server never trusts a client with state: the only writable surface is
// the Command union, validated, permission-checked, rate-limited, sequenced
// and applied by the engine at its effective tick.
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  MatchManifest, parseClientMessage, PROTOCOL_VERSION, ReplayFile, ServerMessage,
} from '@fobal/protocol';
import { MatchRoom, RoomClient } from './room.js';
import { MatchStore } from './store.js';
import { generateSigningKeys, SigningKeys } from './signing.js';
import { signToken, verifyToken } from './tokens.js';
import { extractGoalClips } from './replays.js';
import { CoachInterpreterOptions, createCoachInterpreter } from './coach.js';

export interface MatchServerOptions {
  port?: number;                 // 0 → ephemeral
  secret?: string;               // token HMAC secret
  createKey?: string;            // bearer key for match creation
  /** root directory for the default file-backed store */
  storeRoot?: string;
  /** pre-built store (e.g. MirroredMatchStore) — overrides storeRoot */
  store?: MatchStore;
  keys?: SigningKeys;
  roomDefaults?: { deltaEvery?: number; snapshotEvery?: number; internalEvery?: number; commandDelay?: number; tacticalPerMinute?: number };
  /** drive matches in real time automatically (created + resumed on boot);
   *  tests leave this off and pace rooms explicitly */
  autoDrive?: boolean;
  /** ms an unauthenticated socket may live before being terminated */
  helloTimeoutMs?: number;
  /** Access-Control-Allow-Origin for the HTTP endpoints (default '*') */
  corsOrigin?: string;
  /** LLM tactical interpreter (C2); absent → the endpoint answers 501 and
   *  clients fall back to the golden parseCoach path */
  coach?: CoachInterpreterOptions;
}

export interface MatchServer {
  httpServer: Server;
  port: number;
  secret: string;
  createKey: string;
  store: MatchStore;
  rooms: Map<string, MatchRoom>;
  createMatch(manifest: unknown): { matchId: string; tokens: Record<string, string>; spectatorToken: string };
  close(): Promise<void>;
}

function jsonWithCors(corsOrigin: string) {
  return function json(res: ServerResponse, code: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data),
      // browser clients live on another origin (played locally or hosted at
      // play.*); every GET is token-gated and auth travels in a header, not
      // a cookie, so a permissive origin grants nothing by itself
      'access-control-allow-origin': corsOrigin,
    });
    res.end(data);
  };
}

function parseClockMinutes(clock: string): number {
  const m = /^(\d+):/.exec(clock);
  return m ? Number(m[1]) : 0;
}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req){
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startMatchServer(options: MatchServerOptions): Promise<MatchServer> {
  const secret = options.secret ?? randomBytes(24).toString('base64url');
  const createKey = options.createKey ?? randomBytes(24).toString('base64url');
  const keys = options.keys ?? generateSigningKeys();
  if (!options.store && options.storeRoot === undefined)
    throw new Error('startMatchServer requires either store or storeRoot');
  const store = options.store ?? new MatchStore(options.storeRoot!);
  const corsOrigin = options.corsOrigin ?? '*';
  const json = jsonWithCors(corsOrigin);
  const interpretCoach = createCoachInterpreter(options.coach ?? {});
  const rooms = new Map<string, MatchRoom>();
  const clipsCache = new Map<string, unknown>();
  let nextClientId = 1;

  const roomOptions = {
    store, keys, ...(options.roomDefaults ?? {}),
    // finished matches are served from the store; keeping the room (a whole
    // vm sandbox + event history) alive would leak per match
    onFinalized: (room: MatchRoom) => { room.stop(); rooms.delete(room.matchId); },
  };

  function createMatch(rawManifest: unknown){
    const manifest = MatchManifest.parse(rawManifest);
    if (rooms.has(manifest.matchId) || store.exists(manifest.matchId))
      throw new Error(`match ${manifest.matchId} already exists`);
    const room = MatchRoom.create(manifest, roomOptions);
    rooms.set(manifest.matchId, room);
    if (options.autoDrive) room.startRealtime();
    const tokens: Record<string, string> = {};
    for (const team of manifest.teams)
      tokens[team.teamId] = signToken({ matchId: manifest.matchId, role: 'controller', teamId: team.teamId }, secret);
    const spectatorToken = signToken({ matchId: manifest.matchId, role: 'spectator' }, secret);
    return { matchId: manifest.matchId, tokens, spectatorToken };
  }

  // crash recovery on boot: resume every unfinished persisted match
  if (options.autoDrive){
    for (const matchId of store.listMatches()){
      if (store.loadResult(matchId) || rooms.has(matchId)) continue;
      const room = MatchRoom.resume(matchId, roomOptions);
      rooms.set(matchId, room);
      room.startRealtime();
    }
  }

  /** GETs are gated by any valid token for the match (spectator suffices). */
  function authorizedFor(req: IncomingMessage, matchId: string): boolean {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) return false;
    const payload = verifyToken(auth.slice(7), secret);
    return payload !== null && payload.matchId === matchId;
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

      // unauthenticated on purpose: the ALB/ECS health checks carry no token,
      // and nothing here leaks match data
      if (req.method === 'GET' && url.pathname === '/health'){
        return json(res, 200, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          activeRooms: rooms.size,
          uptimeSeconds: Math.round(process.uptime()),
        });
      }

      if (req.method === 'POST' && url.pathname === '/matches'){
        const auth = req.headers.authorization ?? '';
        if (auth !== `Bearer ${createKey}`) return json(res, 401, { error: 'missing or invalid create key' });
        let manifest: unknown;
        try { manifest = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        try {
          const created = createMatch(manifest);
          return json(res, 201, created);
        } catch (err){
          return json(res, 400, { error: (err as Error).message });
        }
      }

      if (req.method === 'GET' && parts[0] === 'matches' && parts.length === 3){
        const matchId = parts[1]!;
        if (!store.exists(matchId) && !rooms.has(matchId)) return json(res, 404, { error: 'unknown match' });
        if (!authorizedFor(req, matchId)) return json(res, 401, { error: 'match token required' });
        if (parts[2] === 'result'){
          const result = rooms.get(matchId)?.result() ?? store.loadResult(matchId);
          return result ? json(res, 200, result) : json(res, 404, { error: 'match not finished' });
        }
        if (parts[2] === 'replay'){
          const result = rooms.get(matchId)?.result() ?? store.loadResult(matchId);
          if (!result) return json(res, 404, { error: 'match not finished' });
          const replay: ReplayFile = ReplayFile.parse({
            protocolVersion: PROTOCOL_VERSION,
            kind: 'fobal-replay',
            manifest: store.loadManifest(matchId),
            commands: store.loadCommands(matchId),
            events: store.loadEvents(matchId),
            finalStateHash: result.finalStateHash,
            result,
          });
          return json(res, 200, replay);
        }
      }

      // C2 — POST /matches/:id/coach/interpret (controller token required).
      // Returns {patch?, coachText?, say} — the CLIENT sends the resulting
      // command over its own authorized WebSocket; this endpoint never
      // touches the match.
      if (req.method === 'POST' && parts[0] === 'matches' && parts[2] === 'coach' && parts[3] === 'interpret'){
        const matchId = parts[1]!;
        if (!interpretCoach) return json(res, 501, { error: 'coach interpreter not configured' });
        const auth = req.headers.authorization ?? '';
        const payload = auth.startsWith('Bearer ') ? verifyToken(auth.slice(7), secret) : null;
        if (!payload || payload.matchId !== matchId) return json(res, 401, { error: 'match token required' });
        if (payload.role !== 'controller' || !payload.teamId)
          return json(res, 403, { error: 'controller token required' });
        const room = rooms.get(matchId);
        if (!room) return json(res, 404, { error: 'no active match with that id' });
        let text: unknown;
        try { text = (JSON.parse(await readBody(req, 16 * 1024)) as { text?: unknown }).text; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof text !== 'string' || !text.trim() || text.length > 500)
          return json(res, 400, { error: 'text must be a non-empty string of at most 500 chars' });
        const snap = room.snapshot();
        const mine = snap.teams.findIndex(t => t.teamId === payload.teamId);
        const opp = snap.teams[1 - mine];
        const result = await interpretCoach(text.trim(), {
          teamName: room.manifest.teams[mine]?.name ?? payload.teamId,
          scoreLine: `${snap.score[0]}-${snap.score[1]}`,
          minute: Math.min(90, Math.floor(parseClockMinutes(snap.clock)) + 1),
          currentTactics: (snap.teams[mine]?.tactics ?? {}) as Record<string, unknown>,
          opponent: { formation: opp?.tactics.formation, style: opp?.tactics.style, pressing: opp?.tactics.pressing },
        });
        return json(res, 200, result);
      }

      if (req.method === 'GET' && parts[0] === 'matches' && parts[2] === 'replays' && parts[3] === 'goals'){
        const matchId = parts[1]!;
        if (!store.exists(matchId) && !rooms.has(matchId)) return json(res, 404, { error: 'unknown match' });
        if (!authorizedFor(req, matchId)) return json(res, 401, { error: 'match token required' });
        const result = rooms.get(matchId)?.result() ?? store.loadResult(matchId);
        if (!result) return json(res, 404, { error: 'match not finished' });
        // clip extraction re-simulates the match — compute once, then serve
        // from cache/disk (an unbounded per-request re-sim is a DoS surface)
        let clips = clipsCache.get(matchId) ?? store.loadClips(matchId);
        if (!clips){
          clips = extractGoalClips(
            store.loadManifest(matchId), store.loadCommands(matchId), result.goals, store.loadEvents(matchId));
          store.saveClips(matchId, clips);
        }
        clipsCache.set(matchId, clips);
        return json(res, 200, { matchId, clips });
      }

      json(res, 404, { error: 'not found' });
    } catch (err){
      json(res, 500, { error: (err as Error).message });
    }
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: 256 * 1024 });
  wss.on('connection', (socket: WebSocket) => {
    const clientId = nextClientId++;
    let room: MatchRoom | null = null;
    let client: RoomClient | null = null;

    // an unauthenticated socket may not squat: hello or be terminated
    const helloTimer = setTimeout(() => {
      if (!client) socket.terminate();
    }, options.helloTimeoutMs ?? 10_000);
    helloTimer.unref?.();

    const send = (message: ServerMessage): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    socket.on('message', (raw) => {
      try {
        const parsed = parseClientMessage(typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8'));
        if (!parsed.ok){
          send({ type: 'command_rejected', code: 'malformed', message: parsed.error });
          return;
        }
        const msg = parsed.value;
        if (msg.type === 'hello'){
          if (room){
            send({ type: 'error', code: 'already_joined', message: 'this connection already joined a match' });
            return;
          }
          const payload = verifyToken(msg.token, secret);
          if (!payload || payload.matchId !== msg.matchId){
            send({ type: 'error', code: 'unauthorized', message: 'invalid token for this match' });
            socket.close();
            return;
          }
          const target = rooms.get(msg.matchId);
          if (!target){
            send({ type: 'error', code: 'unknown_match', message: 'no active match with that id' });
            socket.close();
            return;
          }
          room = target;
          client = { id: clientId, role: payload.role, teamId: payload.teamId ?? null, send };
          clearTimeout(helloTimer);
          room.attach(client, msg.resumeFromSeq);
          return;
        }
        if (!room || !client){
          send({ type: 'error', code: 'not_joined', message: 'send hello first' });
          return;
        }
        if (msg.type === 'command') room.submitCommand(client, msg.command);
        else if (msg.type === 'request_snapshot') room.sendSnapshotTo(clientId);
        else if (msg.type === 'ping') send({ type: 'pong', t: msg.t });
      } catch (err){
        // a client must never be able to crash the match loop
        send({ type: 'error', code: 'internal', message: (err as Error).message });
      }
    });

    socket.on('close', () => { clearTimeout(helloTimer); if (room) room.detach(clientId); });
    socket.on('error', () => { /* close follows */ });
  });

  await new Promise<void>(resolve => httpServer.listen(options.port ?? 0, resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    httpServer, port, secret, createKey, store, rooms, createMatch,
    close: () => new Promise<void>((resolve) => {
      for (const room of rooms.values()) room.stop();
      wss.close();
      httpServer.close(() => resolve());
      // terminate lingering sockets so tests exit promptly
      for (const ws of wss.clients) ws.terminate();
    }),
  };
}
