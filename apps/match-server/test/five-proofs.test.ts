// The five proofs required by the platform migration:
//   1. local and server execution produce the same result
//   2. replaying the command log produces the same final hash
//   3. two connected clients receive the same score and event order
//   4. malformed commands do not alter or crash the simulation
//   5. reconnecting produces no state divergence
//
// Proofs 3 and 5 drive the REAL browser client logic (MatchConnection from
// @fobal/match-client) against the real server over real WebSockets.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { MatchEngine } from '@fobal/engine';
import type { AcceptedCommand, Command, MatchResult, ReplayFile } from '@fobal/protocol';
import { sampleManifest } from '@fobal/protocol/samples';
// @ts-expect-error plain-JS browser module, typechecked loosely on purpose
import { MatchConnection } from '../../match-client/src/net.js';
import { startMatchServer } from '../src/index.js';

const server = await startMatchServer({ storeRoot: mkdtempSync(join(tmpdir(), 'fobal-proofs-')) });
afterAll(() => server.close());

const WS_URL = `ws://127.0.0.1:${server.port}`;

function wsClient(matchId: string, token: string, opts: Record<string, unknown> = {}){
  return new MatchConnection({
    url: WS_URL, matchId, token,
    socketFactory: (url: string) => new WebSocket(url),
    ...opts,
  }).connect();
}

function waitFor(pred: () => boolean, ms = 30000, label: string | (() => string) = 'condition'): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (pred()) return resolve();
      if (Date.now() - start > ms)
        return reject(new Error(`timeout waiting for ${typeof label === 'function' ? label() : label}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

const CONTROLLER_COMMANDS: Command[] = [
  { kind: 'tactical', commandId: 'p1-press', teamId: 'team-rhinos', payload: { type: 'patch', patch: { pressing: 0.9, attackSide: 'left' } } },
  { kind: 'tactical', commandId: 'p1-coach', teamId: 'team-rhinos', payload: { type: 'coach_text', text: 'attack the wings' } },
];

describe('proofs 1 + 2: local ≡ server ≡ replayed command log', () => {
  test('server match, local re-execution and replay-file re-execution all agree', async () => {
    const manifest = sampleManifest({ matchId: 'proof-12' });
    const created = server.createMatch(manifest);
    const room = server.rooms.get('proof-12')!;

    const acks: Array<{ commandId: string; seq: number; effectiveTick: number }> = [];
    const controller = wsClient('proof-12', created.tokens['team-rhinos']!, {
      hooks: { onAck: (a: never) => acks.push(a) },
    });
    await waitFor(() => controller.status === 'live', 15000, 'controller live');
    for (const c of CONTROLLER_COMMANDS) controller.sendCommand(c);
    await waitFor(() => acks.length === 2, 15000, 'command acks');

    const serverResult: MatchResult = await room.runTurbo();
    controller.close();

    // Proof 1 — a LOCAL engine fed the same accepted commands (reconstructed
    // from the acks, not from server files) produces the same result.
    const acceptedLocally: AcceptedCommand[] = CONTROLLER_COMMANDS.map((command) => {
      const ack = acks.find(a => a.commandId === command.commandId)!;
      return { seq: ack.seq, effectiveTick: ack.effectiveTick, receivedAtTick: 0, command };
    });
    const local = MatchEngine.create(manifest);
    for (const c of acceptedLocally) expect(local.submit(c).accepted).toBe(true);
    local.runToFullTime();
    expect(local.finalStateHash()).toBe(serverResult.finalStateHash);
    expect(local.result().finalScore).toEqual(serverResult.finalScore);
    expect(local.result().finalTick).toBe(serverResult.finalTick);

    // Proof 2 — the persisted replay file (manifest + command log) replays to
    // the same final hash, and the file itself validates.
    // GETs are gated: no token → 401, any valid token for THIS match → 200
    const unauth = await fetch(`http://127.0.0.1:${server.port}/matches/proof-12/replay`);
    expect(unauth.status).toBe(401);
    const replayRes = await fetch(`http://127.0.0.1:${server.port}/matches/proof-12/replay`, {
      headers: { authorization: `Bearer ${created.spectatorToken}` },
    });
    expect(replayRes.status).toBe(200);
    const replay = await replayRes.json() as ReplayFile;
    expect(replay.kind).toBe('fobal-replay');
    expect(replay.commands.length).toBe(2);
    const replayed = MatchEngine.replay(replay.manifest, replay.commands);
    expect(replayed.finalStateHash()).toBe(replay.finalStateHash);
    expect(replayed.finalStateHash()).toBe(serverResult.finalStateHash);
    expect(replayed.result().commandLogHash).toBe(serverResult.commandLogHash);
  }, 120_000);
});

describe('proof 3: two clients, one truth', () => {
  test('both spectators see the same score and the same event order', async () => {
    const manifest = sampleManifest({ matchId: 'proof-3' });
    const created = server.createMatch(manifest);
    const room = server.rooms.get('proof-3')!;

    const a = wsClient('proof-3', created.spectatorToken);
    const b = wsClient('proof-3', created.spectatorToken);
    await waitFor(() => a.status === 'live' && b.status === 'live', 30000,
      () => `both live (a=${a.status} retries=${a.retries}, b=${b.status} retries=${b.retries})`);

    await room.runTurbo();
    await waitFor(() => a.result && b.result, 15000, 'both results');
    a.close(); b.close();

    expect(a.result.finalScore).toEqual(b.result.finalScore);
    expect(a.result.finalStateHash).toBe(b.result.finalStateHash);
    const seqA = a.events.map((e: { seq: number }) => e.seq);
    const seqB = b.events.map((e: { seq: number }) => e.seq);
    expect(seqA).toEqual(seqB);
    expect(a.events.map((e: { type: string }) => e.type)).toEqual(b.events.map((e: { type: string }) => e.type));
    // and the event stream is strictly ordered
    expect([...seqA].sort((x, y) => x - y)).toEqual(seqA);
  }, 120_000);
});

describe('proof 4: malformed commands are inert', () => {
  test('an attacked match stays bit-identical to a clean one and the server keeps serving', async () => {
    const clean = server.createMatch(sampleManifest({ matchId: 'proof-4-clean' }));
    const attacked = server.createMatch(sampleManifest({ matchId: 'proof-4-attacked' }));
    const cleanRoom = server.rooms.get('proof-4-clean')!;
    const attackedRoom = server.rooms.get('proof-4-attacked')!;

    const rejections: unknown[] = [];
    const spectator = wsClient('proof-4-attacked', attacked.spectatorToken, {
      hooks: { onRejected: (r: never) => rejections.push(r) },
    });
    const controller = wsClient('proof-4-attacked', attacked.tokens['team-rhinos']!, {
      hooks: { onRejected: (r: never) => rejections.push(r) },
    });
    await waitFor(() => spectator.status === 'live' && controller.status === 'live', 15000, 'clients live');

    // raw garbage straight down the pipe
    spectator.socket.send('}}}}not json at all');
    spectator.socket.send(JSON.stringify({ type: 'teleport', x: 1, y: 2 }));
    // schema-breaking and permission-breaking commands
    spectator.sendCommand({ kind: 'tactical', commandId: 'x1', teamId: 'team-rhinos', payload: { type: 'patch', patch: { pressing: 0.9 } } }); // spectator: unauthorized
    controller.sendCommand({ kind: 'tactical', commandId: 'x2', teamId: 'team-comets', payload: { type: 'patch', patch: { pressing: 0.9 } } }); // wrong team
    controller.sendCommand({ kind: 'tactical', commandId: 'x3', teamId: 'team-rhinos', payload: { type: 'patch', patch: { pressing: 7 } } });   // out of range
    controller.sendCommand({ kind: 'substitution', commandId: 'x4', teamId: 'team-rhinos', playerOut: 'ghost', playerIn: 'rhinos-player-13' }); // unknown player
    controller.sendCommand({ kind: 'tactical', commandId: 'x5', teamId: 'team-rhinos', payload: { type: 'patch', patch: { score: [9, 0] } } }); // no such field
    await waitFor(() => rejections.length >= 4, 15000, 'rejections');

    // both rooms advance identically
    cleanRoom.advance(1800);
    attackedRoom.advance(1800);
    expect(attackedRoom.stateHash()).toBe(cleanRoom.stateHash());

    // note: x5 has its unknown "score" key stripped by the schema, so it is a
    // legal empty patch — it may ack, but it cannot alter the simulation,
    // which is exactly what the hash equality above proves.

    // the server is still healthy for everyone
    spectator.requestSnapshot();
    await waitFor(() => spectator.lastFrame && spectator.lastFrame.tick >= 1800, 15000, 'post-attack snapshot');
    spectator.close(); controller.close();
  }, 120_000);
});

describe('proof 5: reconnection converges', () => {
  test('a client that drops and resumes ends bit-identical to one that never left', async () => {
    const manifest = sampleManifest({ matchId: 'proof-5' });
    const created = server.createMatch(manifest);
    const room = server.rooms.get('proof-5')!;

    const stayer = wsClient('proof-5', created.spectatorToken);
    const dropper = wsClient('proof-5', created.spectatorToken);
    await waitFor(() => stayer.status === 'live' && dropper.status === 'live', 15000, 'both live');

    room.advance(1200);
    await waitFor(() => dropper.events.length > 0, 15000, 'some events seen');

    // hard drop (not a user close): the raw socket dies mid-match
    dropper.socket.close();
    await waitFor(() => dropper.status === 'reconnecting', 15000, 'dropper reconnecting');
    room.advance(2400);                        // the dropper misses all of this live
    await waitFor(() => dropper.status === 'live', 20000, 'dropper back');

    room.advance(1200);                        // both watch the same continuation
    await room.runTurbo();
    await waitFor(() => stayer.result && dropper.result, 20000, 'both results');
    stayer.close(); dropper.close();

    // no divergence: same events in the same order, same final truth
    expect(dropper.events.map((e: { seq: number }) => e.seq)).toEqual(stayer.events.map((e: { seq: number }) => e.seq));
    expect(dropper.result.finalStateHash).toBe(stayer.result.finalStateHash);
    expect(dropper.result.finalScore).toEqual(stayer.result.finalScore);
    expect(dropper.lastFrame!.score).toEqual(stayer.lastFrame!.score);
  }, 120_000);
});
