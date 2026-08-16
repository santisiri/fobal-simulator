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
  compileGameCommand, MatchManifest, parseClientMessage, PROTOCOL_VERSION, ReplayFile,
  rosterDigest, ServerMessage,
} from '@fobal/protocol';
import { MatchRoom, RoomClient } from './room.js';
import { MatchStore } from './store.js';
import { generateSigningKeys, SigningKeys } from './signing.js';
import { signToken, verifyToken } from './tokens.js';
import { extractGoalClips, extractReplayStream } from './replays.js';
import { CoachInterpreterOptions, createCoachInterpreter } from './coach.js';
import { createTranscriber, SttOptions } from './stt.js';
import { noopTelemetry, Telemetry } from './telemetry.js';

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
  /** hosted speech-to-text (M4); absent → /coach/voice answers 501 and
   *  clients fall back to browser speech recognition */
  stt?: SttOptions;
  /** structured logs + metrics; default silent (the CLI always provides one) */
  telemetry?: Telemetry;
  /** browser Origin allowlist for WebSocket upgrades. Unset/empty → allow
   *  all. Requests WITHOUT an Origin header (server-to-server tools, the
   *  acceptance scripts) are always allowed — origin checks defend against
   *  cross-site browser connections, which cannot omit the header. */
  wsOrigins?: string[];
  /** concurrent WS connections allowed per client IP (default 20) */
  maxConnectionsPerIp?: number;
  /** total concurrent WS connections (default 500) */
  maxConnections?: number;
  /** derive client IPs from x-forwarded-for (set ONLY behind the ALB) */
  trustProxy?: boolean;
  /** gauge heartbeat interval; 0 disables (default 30s) */
  heartbeatMs?: number;
  /** concurrent room cap (M2 backpressure): creations beyond it get 503 and
   *  the lobby tells players the servers are full. Default 25 — each room
   *  is a ~7.7MB vm sandbox and the deployed 512MB task OOMs near 30
   *  (docs/SCALE.md); raise via env with bigger tasks. */
  maxRooms?: number;
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

async function readBodyRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req){
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Consume the WHOLE body (up to a hard ceiling), then report the size.
 *  Aborting a request stream mid-read destroys the socket and leaves the
 *  client's fetch in limbo — over-limit bodies must be drained, not
 *  amputated, so the 413 can actually be delivered. */
async function readBodyDrained(req: IncomingMessage, keep: number, hardCeiling: number): Promise<{ buf: Buffer; total: number }> {
  const chunks: Buffer[] = [];
  let kept = 0;
  let total = 0;
  for await (const chunk of req){
    total += (chunk as Buffer).length;
    if (total > hardCeiling) throw new Error('body far too large');
    if (kept < keep){ chunks.push(chunk as Buffer); kept += (chunk as Buffer).length; }
  }
  return { buf: Buffer.concat(chunks), total };
}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return (await readBodyRaw(req, limit)).toString('utf8');
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
  const transcribe = createTranscriber(options.stt ?? {});
  const telemetry = options.telemetry ?? noopTelemetry;
  const wsOrigins = (options.wsOrigins ?? []).map(o => o.toLowerCase());
  const maxPerIp = options.maxConnectionsPerIp ?? 20;
  const maxConnections = options.maxConnections ?? 500;
  const rooms = new Map<string, MatchRoom>();
  const clipsCache = new Map<string, unknown>();
  const connectionsByIp = new Map<string, number>();
  let connectionsOpen = 0;
  let nextClientId = 1;

  function clientIp(req: IncomingMessage): string {
    if (options.trustProxy){
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  const roomOptions = {
    store, keys, telemetry, ...(options.roomDefaults ?? {}),
    // finished matches are served from the store; keeping the room (a whole
    // vm sandbox + event history) alive would leak per match
    onFinalized: (room: MatchRoom) => {
      room.stop();
      rooms.delete(room.matchId);
      telemetry.metric('RoomsActive', rooms.size);
    },
  };

  const maxRooms = options.maxRooms ?? 25;

  function createMatch(rawManifest: unknown){
    const manifest = MatchManifest.parse(rawManifest);
    if (rooms.size >= maxRooms){
      telemetry.warn('room_capacity_rejected', { activeRooms: rooms.size, maxRooms });
      telemetry.metric('RoomCapacityRejected', 1);
      const err = new Error(`server full: ${rooms.size}/${maxRooms} rooms`);
      (err as Error & { code?: string }).code = 'server_full';
      throw err;
    }
    if (rooms.has(manifest.matchId) || store.exists(manifest.matchId))
      throw new Error(`match ${manifest.matchId} already exists`);
    const room = MatchRoom.create(manifest, roomOptions);
    rooms.set(manifest.matchId, room);
    telemetry.log('room_created', { matchId: manifest.matchId, teams: manifest.teams.map(t => t.name) });
    telemetry.metric('RoomCreated', 1);
    telemetry.metric('RoomsActive', rooms.size);
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
          maxRooms,
          rssMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
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
          const e = err as Error & { code?: string };
          return json(res, e.code === 'server_full' ? 503 : 400, { error: e.message, ...(e.code ? { code: e.code } : {}) });
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
        // workstream G observability: the live tactical truth — team
        // tactics, active player instructions, and the provenance of the
        // last tactical/instruction commands from the log. Dev-tool grade,
        // token-gated like every match GET; no low-level AI internals.
        if (parts[2] === 'tactics'){
          const room = rooms.get(matchId);
          if (!room) return json(res, 404, { error: 'match is not live' });
          const provenance = room.appliedCommandLog()
            .filter(c => c.command.kind === 'tactical' || c.command.kind === 'player_instruction')
            .slice(-20)
            .map(c => ({
              seq: c.seq,
              kind: c.command.kind,
              commandId: c.command.commandId,
              teamId: c.command.teamId,
              effectiveTick: c.effectiveTick,
              receivedAtTick: c.receivedAtTick,
            }));
          return json(res, 200, {
            tick: room.currentTick,
            ...room.tacticsReport(),
            recentCommands: provenance,
          });
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

      // shared by /coach/interpret and /coach/voice: run the C2 interpreter
      // with live match context for the CONTROLLER's team. The client sends
      // the resulting command over its own authorized WebSocket; these
      // endpoints never touch the match.
      const interpretFor = async (room: MatchRoom, teamId: string, text: string) => {
        if (!interpretCoach) return { coachText: text, say: null };
        const snap = room.snapshot();
        const mine = snap.teams.findIndex(t => t.teamId === teamId);
        const opp = snap.teams[1 - mine];
        const ownTeam = room.manifest.teams[mine]!;
        const oppTeam = room.manifest.teams[1 - mine]!;
        const result = await interpretCoach(text, {
          teamName: ownTeam.name ?? teamId,
          scoreLine: `${snap.score[0]}-${snap.score[1]}`,
          minute: Math.min(90, Math.floor(parseClockMinutes(snap.clock)) + 1),
          currentTactics: (snap.teams[mine]?.tactics ?? {}) as Record<string, unknown>,
          opponent: { formation: opp?.tactics.formation, style: opp?.tactics.style, pressing: opp?.tactics.pressing },
          roster: { own: rosterDigest(ownTeam), opponent: rosterDigest(oppTeam) },
        });
        // workstream G: resolve + compile taxonomy orders against the
        // manifest, deterministically, server-side. The client receives
        // wire-ready payloads and short acks; it still sends every command
        // over its OWN authorized WebSocket — these endpoints never touch
        // the match, and the room validates everything again on arrival.
        if (!result.orders?.length) return result;
        const ctx = { own: ownTeam, opponent: oppTeam, teamId };
        const compiled: Array<{ intent: string; scope: string; ack: string; wire: unknown }> = [];
        const rejected: Array<{ intent: string; reason: string }> = [];
        for (const order of result.orders){
          const out = compileGameCommand(order, ctx);
          if (out.ok) compiled.push({ intent: order.intent, scope: order.scope, ack: out.ack, wire: out.wire });
          else rejected.push({ intent: order.intent, reason: out.reason });
        }
        const { orders: _raw, ...rest } = result;
        return {
          ...rest,
          ...(compiled.length ? { orders: compiled } : {}),
          ...(rejected.length ? { rejected } : {}),
        };
      };
      type ControllerGate =
        | { error: [number, string]; room?: undefined; teamId?: undefined }
        | { error?: undefined; room: MatchRoom; teamId: string };
      const controllerFor = (matchId: string): ControllerGate => {
        const auth = req.headers.authorization ?? '';
        const payload = auth.startsWith('Bearer ') ? verifyToken(auth.slice(7), secret) : null;
        if (!payload || payload.matchId !== matchId) return { error: [401, 'match token required'] };
        if (payload.role !== 'controller' || !payload.teamId) return { error: [403, 'controller token required'] };
        const room = rooms.get(matchId);
        if (!room) return { error: [404, 'no active match with that id'] };
        return { room, teamId: payload.teamId };
      };

      // M4 — POST /matches/:id/coach/voice: raw audio in (push-to-talk blob),
      // hosted Whisper-class STT, then the SAME interpreter — one round trip
      // for the whole voice→tactics budget. 501 without an STT key → the
      // client falls back to browser speech recognition (C1).
      if (req.method === 'POST' && parts[0] === 'matches' && parts[2] === 'coach' && parts[3] === 'voice'){
        // every early rejection must DRAIN the request first — an unread
        // audio body leaves the client's fetch hanging forever
        const reject = (code: number, error: string) => { req.resume(); return json(res, code, { error }); };
        if (!transcribe) return reject(501, 'voice transcription not configured');
        const gate = controllerFor(parts[1]!);
        if (gate.error) return reject(gate.error[0], gate.error[1]);
        const mimeType = String(req.headers['content-type'] ?? 'audio/webm');
        if (!mimeType.startsWith('audio/')) return reject(400, 'content-type must be audio/*');
        let audio: Buffer;
        try {
          const body = await readBodyDrained(req, 2 * 1024 * 1024, 16 * 1024 * 1024);
          if (body.total > 2 * 1024 * 1024) return json(res, 413, { error: 'audio too large (max 2MB \u2248 60s)' });
          audio = body.buf;
        } catch { return reject(413, 'audio too large (max 2MB \u2248 60s)'); }
        if (audio.length < 200) return json(res, 400, { error: 'audio too short' });
        const sttStart = Date.now();
        let transcript: string;
        try { transcript = await transcribe(audio, mimeType); }
        catch (err){
          telemetry.warn('stt_failed', { matchId: parts[1], error: (err as Error).message });
          telemetry.metric('SttFailed', 1);
          return json(res, 502, { error: 'transcription failed — try again or type it' });
        }
        telemetry.metric('SttMs', Date.now() - sttStart, 'Milliseconds');
        if (!transcript || transcript.length > 500)
          return json(res, 422, { error: 'nothing intelligible heard', transcript: '' });
        const startedAt = Date.now();
        const result = await interpretFor(gate.room, gate.teamId, transcript);
        telemetry.log('coach_voice', {
          matchId: parts[1], teamId: gate.teamId, audioBytes: audio.length,
          transcriptChars: transcript.length, sttMs: startedAt - sttStart, interpretMs: Date.now() - startedAt,
          outcome: result.patch ? 'patch' : result.coachText ? 'coach_text' : 'say_only',
        });
        telemetry.metric('CoachInterpretMs', Date.now() - startedAt, 'Milliseconds');
        // STEP 8: the measured stages ride the response for the client's
        // inspector — the manager-facing end-to-end is stamped client-side
        return json(res, 200, {
          transcript, ...result,
          latency: { sttMs: startedAt - sttStart, interpretMs: Date.now() - startedAt },
        });
      }

      // C2 — POST /matches/:id/coach/interpret (typed text / browser-SR path)
      if (req.method === 'POST' && parts[0] === 'matches' && parts[2] === 'coach' && parts[3] === 'interpret'){
        const matchId = parts[1]!;
        if (!interpretCoach) return json(res, 501, { error: 'coach interpreter not configured' });
        const gate = controllerFor(matchId);
        if (gate.error) return json(res, gate.error[0], { error: gate.error[1] });
        const payload = { teamId: gate.teamId };
        const room = gate.room;
        let text: unknown;
        try { text = (JSON.parse(await readBody(req, 16 * 1024)) as { text?: unknown }).text; }
        catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (typeof text !== 'string' || !text.trim() || text.length > 500)
          return json(res, 400, { error: 'text must be a non-empty string of at most 500 chars' });
        const startedAt = Date.now();
        const result = await interpretFor(room, payload.teamId, text.trim());
        const outcome = result.patch ? 'patch' : result.coachText ? 'coach_text' : 'say_only';
        telemetry.log('coach_interpreted', { matchId, teamId: payload.teamId, outcome, ms: Date.now() - startedAt });
        telemetry.metric('CoachInterpretMs', Date.now() - startedAt, 'Milliseconds');
        return json(res, 200, { ...result, latency: { interpretMs: Date.now() - startedAt } });
      }

      // M1.2 replay theater: the full match as a recorded frame stream. The
      // vm re-simulates ONCE (the only legitimate re-simulator), the result
      // is cached, and clients purely play it back.
      if (req.method === 'GET' && parts[0] === 'matches' && parts[2] === 'replays' && parts[3] === 'stream'){
        const matchId = parts[1]!;
        if (!store.exists(matchId) && !rooms.has(matchId)) return json(res, 404, { error: 'unknown match' });
        if (!authorizedFor(req, matchId)) return json(res, 401, { error: 'match token required' });
        const result = rooms.get(matchId)?.result() ?? store.loadResult(matchId);
        if (!result) return json(res, 404, { error: 'match not finished' });
        let stream = store.loadStream(matchId);
        if (!stream){
          const startedAt = Date.now();
          stream = extractReplayStream(store.loadManifest(matchId), store.loadCommands(matchId));
          store.saveStream(matchId, stream);
          telemetry.log('replay_stream_built', { matchId, ms: Date.now() - startedAt });
        }
        return json(res, 200, {
          matchId,
          manifest: store.loadManifest(matchId),
          events: store.loadEvents(matchId),
          result,
          ...(stream as object),
        });
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

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: 256 * 1024,
    // origin gate at the HTTP upgrade: a browser cannot forge or omit
    // Origin, so an allowlist blocks cross-site pages from even opening a
    // socket; tools (no Origin header) pass — they hold real tokens anyway
    verifyClient: ({ origin }, cb) => {
      if (!wsOrigins.length || !origin || wsOrigins.includes('*') || wsOrigins.includes(origin.toLowerCase()))
        return cb(true);
      telemetry.warn('ws_origin_rejected', { origin });
      telemetry.metric('OriginRejected', 1);
      cb(false, 403, 'origin not allowed');
    },
  });
  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const ip = clientIp(req);
    // connection caps: per-IP against one misbehaving client, global as the
    // process backstop. 1013 = "try again later".
    if ((connectionsByIp.get(ip) ?? 0) >= maxPerIp || connectionsOpen >= maxConnections){
      telemetry.warn('ws_connection_capped', { ip, open: connectionsOpen });
      telemetry.metric('ConnectionCapped', 1);
      socket.close(1013, 'too many connections');
      return;
    }
    connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
    connectionsOpen++;
    telemetry.metric('ConnectionsOpen', connectionsOpen);
    const releaseIp = (): void => {
      const left = (connectionsByIp.get(ip) ?? 1) - 1;
      if (left <= 0) connectionsByIp.delete(ip);
      else connectionsByIp.set(ip, left);
      connectionsOpen--;
      telemetry.metric('ConnectionsOpen', connectionsOpen);
    };
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
            telemetry.warn('hello_rejected', { reason: 'unauthorized', matchId: msg.matchId, ip });
            telemetry.metric('HelloRejected', 1);
            send({ type: 'error', code: 'unauthorized', message: 'invalid token for this match' });
            socket.close();
            return;
          }
          const target = rooms.get(msg.matchId);
          if (!target){
            telemetry.warn('hello_rejected', { reason: 'unknown_match', matchId: msg.matchId, ip });
            telemetry.metric('HelloRejected', 1);
            send({ type: 'error', code: 'unknown_match', message: 'no active match with that id' });
            socket.close();
            return;
          }
          room = target;
          client = { id: clientId, role: payload.role, teamId: payload.teamId ?? null, send };
          clearTimeout(helloTimer);
          telemetry.log('client_joined', { matchId: msg.matchId, role: payload.role, teamId: payload.teamId, ip });
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

    socket.on('close', () => { clearTimeout(helloTimer); releaseIp(); if (room) room.detach(clientId); });
    socket.on('error', () => { /* close follows */ });
  });

  // periodic gauges: cheap, and they make "is it alive / how loaded" a
  // dashboard question instead of an ssh question
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const heartbeat = heartbeatMs > 0
    ? setInterval(() => {
        telemetry.metric('RoomsActive', rooms.size);
        telemetry.metric('ConnectionsOpen', connectionsOpen);
        telemetry.metric('MemoryRssMb', Math.round(process.memoryUsage.rss() / 1024 / 1024));
      }, heartbeatMs)
    : null;
  heartbeat?.unref?.();

  await new Promise<void>(resolve => httpServer.listen(options.port ?? 0, resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    httpServer, port, secret, createKey, store, rooms, createMatch,
    close: () => new Promise<void>((resolve) => {
      if (heartbeat) clearInterval(heartbeat);
      for (const room of rooms.values()) room.stop();
      wss.close();
      httpServer.close(() => resolve());
      // terminate lingering sockets so tests exit promptly
      for (const ws of wss.clients) ws.terminate();
    }),
  };
}
