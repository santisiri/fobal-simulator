// M1.2 — the full-match replay stream. The server (vm) is the only
// legitimate re-simulator: the endpoint re-executes manifest + command log
// once, records 10Hz protocol-shaped frames, caches them, and the recording
// must agree with the signed result.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { sampleManifest } from '@fobal/protocol/samples';
import { startMatchServer } from '../src/index.js';
import type { ReplayStreamFrame } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-stream-'));

interface StreamResponse {
  matchId: string;
  stride: number;
  frames: ReplayStreamFrame[];
  events: Array<{ type: string; tick: number }>;
  result: { finalScore: [number, number]; finalTick: number };
  manifest: { teams: Array<{ teamId: string }> };
}

describe('replay stream endpoint', () => {
  test('a finished match streams as cached 10Hz frames that agree with the signed result', async () => {
    const server = await startMatchServer({ port: 0, storeRoot: tmp(), createKey: 'st-ck', autoDrive: false });
    try {
      const created = server.createMatch(sampleManifest({ matchId: 'stream-1' }));
      const room = server.rooms.get('stream-1')!;
      // a command in the log makes the re-simulation non-trivial
      room.submitCommand(
        { id: 99, role: 'controller', teamId: 'team-rhinos', send: () => {} },
        { kind: 'tactical', commandId: 'st-cmd', teamId: 'team-rhinos',
          payload: { type: 'patch', patch: { pressing: 0.9, formation: '433' } } },
      );
      const result = await room.runTurbo();

      const url = `http://127.0.0.1:${server.port}/matches/stream-1/replays/stream`;
      expect((await fetch(url)).status).toBe(401);

      const first = await fetch(url, { headers: { authorization: `Bearer ${created.spectatorToken}` } });
      expect(first.status).toBe(200);
      const stream = await first.json() as StreamResponse;

      expect(stream.stride).toBe(6);
      expect(stream.frames.length).toBeGreaterThan(1000);          // ~10Hz over a full match
      const last = stream.frames[stream.frames.length - 1]!;
      expect(last.matchState).toBe('FULLTIME');
      expect(last.score).toEqual(result.finalScore);               // the recording agrees with the signature
      expect(last.tick).toBe(result.finalTick);
      // frames speak EXTERNAL ids and carry what the puppet applies
      expect(stream.frames[0]!.players.length).toBeGreaterThanOrEqual(22);
      expect(stream.frames[0]!.players[0]!.playerId).toMatch(/^(rhinos|comets)-player-/);
      expect(stream.frames[10]!.players[0]!.position.x).toBeTypeOf('number');
      expect(stream.events.some(e => e.type === 'fulltime')).toBe(true);

      // second read is served from the cache, byte-identical
      const second = await fetch(url, { headers: { authorization: `Bearer ${created.spectatorToken}` } });
      expect(await second.text()).toBe(JSON.stringify(stream));
    } finally { await server.close(); }
  }, 120_000);
});
