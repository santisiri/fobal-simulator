import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Command } from '@fobal/protocol';
import { sampleManifest } from '@fobal/protocol/samples';
import { MatchRoom, MatchStore, generateSigningKeys, extractGoalClips, verifyResult } from '../src/index.js';

const keys = generateSigningKeys();

function roomPair(id: string){
  const store = new MatchStore(mkdtempSync(join(tmpdir(), 'fobal-rec-')));
  const room = MatchRoom.create(sampleManifest({ matchId: id }), { store, keys, internalEvery: 600 });
  return { store, room };
}

const fakeClient = (sink: unknown[] = []) => ({
  id: 999, role: 'controller' as const, teamId: 'team-rhinos',
  send: (m: unknown) => sink.push(m),
});

const PATCH: Command = {
  kind: 'tactical', commandId: 'rec-1', teamId: 'team-rhinos',
  payload: { type: 'patch', patch: { pressing: 0.88 } },
};

describe('server crash recovery', () => {
  test('resume-from-snapshot continues bit-identically — full RESULT, not just hash', async () => {
    const { store, room } = roomPair('rec-1');
    const sink: unknown[] = [];
    const client = fakeClient(sink);
    room.attach(client);
    room.submitCommand(client, PATCH);
    room.advance(1500);                        // internal snapshots at 600-tick cadence

    const twinStore = new MatchStore(mkdtempSync(join(tmpdir(), 'fobal-rec-twin-')));
    const twin = MatchRoom.create(sampleManifest({ matchId: 'rec-1' }), { store: twinStore, keys });
    const twinClient = fakeClient();
    twin.attach(twinClient);
    twin.submitCommand(twinClient, PATCH);
    const twinResult = await twin.runTurbo();

    room.stop();                               // "crash"
    const resumed = MatchRoom.resume('rec-1', { store, keys });
    expect(resumed.currentTick).toBeGreaterThan(0);
    const resumedResult = await resumed.runTurbo();

    // the SIGNED result must be byte-identical: a hash-only comparison would
    // hide missing pre-crash goals/cards (result bookkeeping is host-side)
    expect(JSON.stringify(resumedResult)).toBe(JSON.stringify(twinResult));
    expect(resumedResult.goals.length).toBe(resumedResult.finalScore[0] + resumedResult.finalScore[1]);
  }, 240_000);

  test('with no internal snapshot, recovery replays the command log deterministically', () => {
    const { store, room } = roomPair('rec-2');
    const client = fakeClient();
    room.attach(client);
    room.submitCommand(client, { ...PATCH, commandId: 'rec-2-cmd' });
    room.advance(400);                         // below internalEvery: no snapshot persisted
    const liveHash = room.stateHash();
    room.stop();

    const resumed = MatchRoom.resume('rec-2', { store, keys });
    resumed.advance(400 - resumed.currentTick);
    expect(resumed.stateHash()).toBe(liveHash);
  }, 120_000);
});

describe('goal replays from recorded data', () => {
  test('every goal in a finished match yields a dense, in-window clip', async () => {
    // seed 10 produces at least one goal (characterization-pinned); sample
    // squads differ, so find a seed that scores within a full match
    const store = new MatchStore(mkdtempSync(join(tmpdir(), 'fobal-clip-')));
    let result = null; let manifest = null;
    for (const seed of [10, 5, 42, 7, 99]){
      manifest = sampleManifest({ matchId: `clip-${seed}`, seed });
      const room = MatchRoom.create(manifest, { store, keys });
      result = await room.runTurbo();
      if (result.goals.length > 0) break;
    }
    expect(result!.goals.length).toBeGreaterThan(0);
    expect(verifyResult(result!)).toBe(true);

    const clips = extractGoalClips(manifest!, store.loadCommands(result!.matchId), result!.goals,
      store.loadEvents(result!.matchId));
    expect(clips.length).toBe(result!.goals.length);
    for (const clip of clips){
      expect(clip.frames.length).toBeGreaterThan(100);            // ~11s at 30fps
      expect(clip.frames[0]!.tick).toBeGreaterThanOrEqual(clip.fromTick);
      expect(clip.frames.at(-1)!.tick).toBeLessThanOrEqual(clip.toTick);
      for (const frame of clip.frames){
        expect(frame.players.length).toBeGreaterThanOrEqual(20);  // both teams present
        expect(frame.ball.x).toBeGreaterThanOrEqual(-5);
        expect(frame.ball.x).toBeLessThanOrEqual(110);
      }
      // the goal event itself is inside the clip's event window
      expect(clip.events.some(e => e.type === 'goal' && Math.abs(e.tick - clip.goalTick) <= 3)).toBe(true);
    }
  }, 240_000);

  test('result processing is idempotent: finalize twice, one byte-identical result', async () => {
    const store = new MatchStore(mkdtempSync(join(tmpdir(), 'fobal-idem-')));
    const room = MatchRoom.create(sampleManifest({ matchId: 'idem-1' }), { store, keys });
    const first = await room.runTurbo();
    const second = room.finalize();
    const third = store.loadResult('idem-1');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    expect(verifyResult(first)).toBe(true);
  }, 120_000);
});
