// The wrapped headless engine must be BIT-IDENTICAL to the golden demo.
// Goldens were captured through the independent Phase-1 characterization
// harness (tests/characterization) — two code paths, one truth.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { MatchEngine } from '../src/index.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const goldens = JSON.parse(readFileSync(join(REPO, 'tests/characterization/goldens.json'), 'utf8'));

describe('golden parity (seed mode)', () => {
  test('seed 42 matches the characterization hashes at ticks 300 and 600', () => {
    const engine = MatchEngine.createFromSeed(42);
    engine.run(300);
    expect(engine.finalStateHash()).toBe(goldens.seed42.hash300);
    engine.run(300);
    expect(engine.finalStateHash()).toBe(goldens.seed42.hash600);
  });

  test('the seed-10 goal (incl. automatic replay + restart) matches the golden hash', () => {
    const engine = MatchEngine.createFromSeed(10);
    while (engine.score[0] + engine.score[1] === 0 && engine.currentTick < goldens.goal.firstGoalTick + 60)
      engine.tick();
    expect(engine.currentTick).toBe(goldens.goal.firstGoalTick);
    engine.run(1500);
    expect(engine.finalStateHash()).toBe(goldens.goal.hashAfterReplay);
  });

  test('the engine emits the golden goal as a protocol event', () => {
    const engine = MatchEngine.createFromSeed(10);
    engine.run(goldens.goal.firstGoalTick);
    const goals = engine.events().filter(e => e.type === 'goal');
    expect(goals.length).toBe(1);
    expect(goals[0]!.playerId).toBe(goldens.goal.scorer); // seed-mode ids ARE the pids
    expect(engine.score).toEqual(goldens.goal.score);
  });
});
