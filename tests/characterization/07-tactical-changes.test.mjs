// Characterization: tactics have pinned defaults, coach phrases map to pinned
// changes, and tactical changes observably alter the simulation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootGolden, fullHash } from './harness/boot.mjs';
import { loadGoldens, tacticsDiff } from './util.mjs';

const G = loadGoldens();

test('tactics defaults are pinned', () => {
  const h = bootGolden({ seed: 1 });
  const now = Object.fromEntries(Object.entries(h.game.teams[0].tactics)
    .map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v]));
  assert.deepEqual(now, G.tacticsDefaults);
});

test('natural-language coach phrases produce their pinned tactics changes', () => {
  for (const [phrase, expected] of Object.entries(G.coach)){
    const h = bootGolden({ seed: 1 });
    const before = { ...h.game.teams[0].tactics };
    const msgs = h.coach(phrase);
    assert.equal(msgs.length > 0, expected.understood, `"${phrase}" understood`);
    assert.deepEqual(tacticsDiff(before, h.game.teams[0].tactics), expected.changes, `"${phrase}" changes`);
  }
});

test('a tactical change observably diverges the simulation (and is itself deterministic)', () => {
  const run = withTactics => {
    const h = bootGolden({ seed: 3 });
    h.step(300);
    if (withTactics) h.tactics({ pressing: 0.95, defAggression: 0.9, shootTendency: 1.5 });
    h.step(1500);
    return fullHash(h);
  };
  const neutral = run(false);
  const pressed1 = run(true);
  const pressed2 = run(true);
  assert.notEqual(neutral, pressed1, 'tactics must change what happens on the pitch');
  assert.equal(pressed1, pressed2, 'the changed run is still deterministic');
});
