import { describe, expect, test } from 'vitest';
import type { AcceptedCommand } from '@fobal/protocol';
import { sampleManifest } from '@fobal/protocol/samples';
import { MatchEngine } from '../src/index.js';

const acc = (seq: number, effectiveTick: number, command: AcceptedCommand['command']): AcceptedCommand =>
  ({ seq, effectiveTick, receivedAtTick: Math.max(0, effectiveTick - 30), command });

describe('command validation', () => {
  test('unknown team, unknown players, retroactive ticks and malformed shapes are rejected', () => {
    const engine = MatchEngine.create(sampleManifest());
    engine.run(120);

    expect(engine.submit(acc(0, 300, {
      kind: 'tactical', commandId: 'x1', teamId: 'team-nobody',
      payload: { type: 'patch', patch: { pressing: 0.9 } },
    })).accepted).toBe(false);

    expect(engine.submit(acc(1, 300, {
      kind: 'substitution', commandId: 'x2', teamId: 'team-rhinos',
      playerOut: 'ghost-1', playerIn: 'rhinos-player-13',
    })).accepted).toBe(false);

    expect(engine.submit(acc(2, 60, {   // tick 60 already passed
      kind: 'tactical', commandId: 'x3', teamId: 'team-rhinos',
      payload: { type: 'patch', patch: { pressing: 0.9 } },
    })).accepted).toBe(false);

    expect(engine.submit({ nonsense: true } as unknown as AcceptedCommand).accepted).toBe(false);

    // a patch that fails schema range (pressing > 1) never reaches the sim
    expect(engine.submit(acc(3, 300, {
      kind: 'tactical', commandId: 'x4', teamId: 'team-rhinos',
      payload: { type: 'patch', patch: { pressing: 1.7 } as never },
    })).accepted).toBe(false);
  });

  test('rejected commands leave the simulation bit-identical', () => {
    const clean = MatchEngine.create(sampleManifest());
    clean.run(600);

    const attacked = MatchEngine.create(sampleManifest());
    attacked.run(120);
    for (const bad of [
      acc(0, 60, { kind: 'tactical', commandId: 'b1', teamId: 'team-rhinos', payload: { type: 'patch', patch: { pressing: 0.9 } } }),
      acc(1, 300, { kind: 'substitution', commandId: 'b2', teamId: 'team-rhinos', playerOut: 'ghost', playerIn: 'also-ghost' }),
      { seq: -1, effectiveTick: -5, receivedAtTick: -1, command: null } as unknown as AcceptedCommand,
    ]) attacked.submit(bad);
    attacked.run(480);

    expect(attacked.finalStateHash()).toBe(clean.finalStateHash());
  });
});

describe('command application', () => {
  test('coach text is parsed and applied at its effective tick', () => {
    const engine = MatchEngine.create(sampleManifest());
    engine.submit(acc(0, 240, {
      kind: 'tactical', commandId: 'c1', teamId: 'team-rhinos',
      payload: { type: 'coach_text', text: 'press high' },
    }));
    engine.run(239);
    const before = engine.snapshot().teams[0].tactics.pressing;
    engine.run(2);
    const after = engine.snapshot().teams[0].tactics.pressing;
    expect(after).not.toBe(before);
    expect(after).toBeGreaterThan(0.8);
    expect(engine.events().some(e => e.type === 'tactic_change')).toBe(true);
  });

  test('a valid substitution swaps the players and emits an event', () => {
    const engine = MatchEngine.create(sampleManifest());
    engine.submit(acc(0, 1200, {
      kind: 'substitution', commandId: 's1', teamId: 'team-rhinos',
      playerOut: 'rhinos-player-10', playerIn: 'rhinos-player-15', // ST out, ST in
    }));
    engine.run(1260);
    const byId = new Map(engine.snapshot().players.map(p => [p.playerId, p]));
    expect(byId.get('rhinos-player-10')!.onPitch).toBe(false);
    expect(byId.get('rhinos-player-15')!.onPitch).toBe(true);
    expect(engine.events().some(e => e.type === 'substitution')).toBe(true);
    expect(engine.snapshot().teams[0].subsUsed).toBe(1);
  });

  test('an outfielder cannot replace the goalkeeper (like-for-like rule)', () => {
    const engine = MatchEngine.create(sampleManifest());
    engine.submit(acc(0, 600, {
      kind: 'substitution', commandId: 's2', teamId: 'team-rhinos',
      playerOut: 'rhinos-player-01',   // GK
      playerIn: 'rhinos-player-15',    // ST
    }));
    engine.run(700);
    const byId = new Map(engine.snapshot().players.map(p => [p.playerId, p]));
    expect(byId.get('rhinos-player-01')!.onPitch).toBe(true); // keeper stayed on
    expect(engine.snapshot().teams[0].subsUsed).toBe(0);
  });
});

describe('deltas', () => {
  test('drainDelta reports movement sparsely and settles when nothing happens', () => {
    const engine = MatchEngine.create(sampleManifest());
    engine.run(60);
    const first = engine.drainDelta();       // baseline: everyone is new
    expect(first.players!.length).toBeGreaterThan(0);
    engine.run(60);
    const second = engine.drainDelta();      // play moved people
    expect(second.players!.length).toBeGreaterThan(0);
    const third = engine.drainDelta();       // no ticks since → nothing to say
    expect(third.players ?? []).toHaveLength(0);
  });
});
