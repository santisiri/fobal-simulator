import { describe, expect, test } from 'vitest';
import type { AcceptedCommand } from '@fobal/protocol';
import { sampleManifest } from '@fobal/protocol/samples';
import { MatchEngine } from '../src/index.js';

const COMMANDS: AcceptedCommand[] = [
  {
    seq: 0, effectiveTick: 300, receivedAtTick: 250,
    command: {
      kind: 'tactical', commandId: 'c-press', teamId: 'team-rhinos',
      payload: { type: 'patch', patch: { pressing: 0.92, attackSide: 'left' } },
    },
  },
  {
    seq: 1, effectiveTick: 900, receivedAtTick: 800,
    command: {
      kind: 'tactical', commandId: 'c-coach', teamId: 'team-comets',
      payload: { type: 'coach_text', text: 'park the bus and waste time' },
    },
  },
];

function runWithCommands(ticks: number): MatchEngine {
  const engine = MatchEngine.create(sampleManifest());
  for (const c of COMMANDS) engine.submit(c);
  engine.run(ticks);
  return engine;
}

describe('engine determinism', () => {
  test('same manifest + same command log ⇒ identical state hash', () => {
    const a = runWithCommands(1800);
    const b = runWithCommands(1800);
    expect(a.finalStateHash()).toBe(b.finalStateHash());
    expect(a.commandLogHash()).toBe(b.commandLogHash());
  });

  test('commands take effect exactly at their effective tick', () => {
    const engine = MatchEngine.create(sampleManifest());
    engine.submit(COMMANDS[0]!);
    engine.run(299);
    expect(engine.snapshot().teams[0].tactics.pressing).not.toBe(0.92);
    engine.run(2); // tick 300 applies, then advances
    expect(engine.snapshot().teams[0].tactics.pressing).toBe(0.92);
    expect(engine.snapshot().teams[0].tactics.attackSide).toBe('left');
  });

  test('submission time does not matter — only the effective tick does', () => {
    const early = MatchEngine.create(sampleManifest());
    early.submit(COMMANDS[0]!);          // submitted before tick 0
    early.run(600);

    const late = MatchEngine.create(sampleManifest());
    late.run(250);                        // submitted mid-flight at tick 250
    late.submit(COMMANDS[0]!);
    late.run(350);

    expect(early.currentTick).toBe(late.currentTick);
    expect(early.finalStateHash()).toBe(late.finalStateHash());
  });

  test('replaying the command log reproduces the full-time result bit-exactly', () => {
    const live = MatchEngine.create(sampleManifest());
    for (const c of COMMANDS) live.submit(c);
    live.runToFullTime();
    const liveResult = live.result();

    const replayed = MatchEngine.replay(sampleManifest(), COMMANDS);
    const replayResult = replayed.result();

    expect(replayResult.finalStateHash).toBe(liveResult.finalStateHash);
    expect(replayResult.finalScore).toEqual(liveResult.finalScore);
    expect(replayResult.finalTick).toBe(liveResult.finalTick);
    expect(replayResult.commandLogHash).toBe(liveResult.commandLogHash);
    expect(replayResult.goals).toEqual(liveResult.goals);
  }, 120_000);

  test('a full official match reaches FULLTIME at 90:00', () => {
    const engine = MatchEngine.create(sampleManifest());
    engine.runToFullTime();
    expect(engine.matchState).toBe('FULLTIME');
    expect(engine.snapshot().clock).toBe('90:00');
    const result = engine.result();
    expect(result.stats[0].passAtt).toBeGreaterThan(20);
    expect(result.stats[1].passAtt).toBeGreaterThan(20);
  }, 120_000);
});
