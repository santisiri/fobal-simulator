// HTTP + WebSocket front door.
//
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

export interface MatchServerOptions {
  port?: number;                 // 0 → ephemeral
  secret?: string;               // token HMAC secret
  createKey?: string;            // bearer key for match creation
  storeRoot: string;
  keys?: SigningKeys;
  roomDefaults?: { deltaEvery?: number; snapshotEvery?: number; internalEvery?: number; commandDelay?: number; tacticalPerMinute?: number };
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

function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
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
  const store = new MatchStore(options.storeRoot);
  const rooms = new Map<string, MatchRoom>();
  let nextClientId = 1;

  const roomOptions = { store, keys, ...(options.roomDefaults ?? {}) };

  function createMatch(rawManifest: unknown){
    const manifest = MatchManifest.parse(rawManifest);
    if (rooms.has(manifest.matchId) || store.exists(manifest.matchId))
      throw new Error(`match ${manifest.matchId} already exists`);
    const room = MatchRoom.create(manifest, roomOptions);
    rooms.set(manifest.matchId, room);
    const tokens: Record<string, string> = {};
    for (const team of manifest.teams)
      tokens[team.teamId] = signToken({ matchId: manifest.matchId, role: 'controller', teamId: team.teamId }, secret);
    const spectatorToken = signToken({ matchId: manifest.matchId, role: 'spectator' }, secret);
    return { matchId: manifest.matchId, tokens, spectatorToken };
  }

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

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

      if (req.method === 'GET' && parts[0] === 'matches' && parts[2] === 'replays' && parts[3] === 'goals'){
        const matchId = parts[1]!;
        const result = rooms.get(matchId)?.result() ?? store.loadResult(matchId);
        if (!result) return json(res, 404, { error: 'match not finished' });
        const clips = extractGoalClips(
          store.loadManifest(matchId), store.loadCommands(matchId), result.goals, store.loadEvents(matchId));
        return json(res, 200, { matchId, clips });
      }

      json(res, 404, { error: 'not found' });
    } catch (err){
      json(res, 500, { error: (err as Error).message });
    }
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (socket: WebSocket) => {
    const clientId = nextClientId++;
    let room: MatchRoom | null = null;
    let client: RoomClient | null = null;

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

    socket.on('close', () => { if (room) room.detach(clientId); });
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
