// Characterization: one seed derives everything official; cosmetics are isolated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootGolden, fullHash } from './harness/boot.mjs';
import { loadGoldens, squadFingerprint, evalInSandbox } from './util.mjs';

const G = loadGoldens();

test('same seed derives identical squads, environment and referee', () => {
  assert.equal(squadFingerprint(bootGolden({ seed: 42 })), G.squads.seed42);
  assert.equal(squadFingerprint(bootGolden({ seed: 42 })), G.squads.seed42);
});

test('different seeds derive different matches', () => {
  assert.equal(squadFingerprint(bootGolden({ seed: 1 })), G.squads.seed1);
  assert.equal(squadFingerprint(bootGolden({ seed: 2 })), G.squads.seed2);
  assert.notEqual(G.squads.seed1, G.squads.seed2);
});

test('RNG state capture/restore replays the identical sequence', () => {
  const h = bootGolden({ seed: 42 });
  const seq = evalInSandbox(h, `(() => {
    const st = RNG.state();
    const a = [srand(), srand(), srand(), srand(), srand()];
    RNG.restore(st);
    const b = [srand(), srand(), srand(), srand(), srand()];
    RNG.restore(st); // leave the game unperturbed
    return JSON.stringify([a, b]);
  })()`);
  const [a, b] = JSON.parse(seq);
  assert.deepEqual(a, b);
});

test('cosmetic randomness (Math.random) never touches official state', () => {
  const a = bootGolden({ seed: 42, cosmeticSeed: 1111 });
  const b = bootGolden({ seed: 42, cosmeticSeed: 999999 });
  a.step(300); b.step(300);
  assert.equal(fullHash(a), fullHash(b));
  assert.equal(fullHash(a), G.seed42.hash300);
});
