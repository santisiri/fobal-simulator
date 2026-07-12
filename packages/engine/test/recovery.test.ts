// restore → continue must equal an uninterrupted run (the invariant the
// server's crash-recovery leans on).
import { describe, expect, test } from 'vitest';
import type { AcceptedCommand } from '@fobal/protocol';
import { sampleManifest } from '@fobal/protocol/samples';
import { MatchEngine } from '../src/index.js';

const LOG: AcceptedCommand[] = [
  {
    seq: 0, effectiveTick: 300, receivedAtTick: 280,
    command: {
      kind: 'tactical', commandId: 'r-1', teamId: 'team-rhinos',
      payload: { type: 'patch', patch: { pressing: 0.85, tempo: 0.8 } },
    },
  },
  {
    seq: 1, effectiveTick: 1500, receivedAtTick: 1400,
    command: {
      kind: 'substitution', commandId: 'r-2', teamId: 'team-comets',
      playerOut: 'comets-player-10', playerIn: 'comets-player-15',
    },
  },
];

describe('internal snapshot recovery', () => {
  test('capture at tick 900, restore on a fresh engine, continue — bit-identical', () => {
    const live = MatchEngine.create(sampleManifest());
    for (const c of LOG) live.submit(c);
    live.run(900);
    const captured = live.captureInternalState();
    expect(captured.tick).toBe(900);
    expect(captured.appliedThroughSeq).toBe(0);       // only the tactical patch has fired

    const resumed = MatchEngine.create(sampleManifest());
    resumed.restoreInternalState(captured, LOG);
    expect(resumed.currentTick).toBe(900);
    expect(resumed.finalStateHash()).toBe(live.finalStateHash());

    live.run(1200);                                    // crosses the pending sub at 1500
    resumed.run(1200);
    expect(resumed.finalStateHash()).toBe(live.finalStateHash());
    expect(resumed.snapshot().teams[1].subsUsed).toBe(1);

    // event sequence continues without collisions after the restore point
    const seqs = resumed.events().map(e => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Math.min(...seqs)).toBeGreaterThanOrEqual(captured.eventSeq);
  });
});
