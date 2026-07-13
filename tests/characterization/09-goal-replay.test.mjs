// Characterization: the automatic broadcast goal replay engages after a goal,
// re-simulates deterministically, and hands back to live play unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootGolden, fullHash } from './harness/boot.mjs';
import { loadGoldens, stepUntil } from './util.mjs';

const G = loadGoldens();

test('goal replay auto-plays after the goal and returns to live play', () => {
  const h = bootGolden({ seed: G.goal.seed });
  stepUntil(h, g => g.match.score[0] + g.match.score[1] > 0);
  const g = h.game;
  const scoreAtGoal = [...g.match.score];
  let sawReplay = false, backLive = false;
  for (let i = 0; i < 1500; i++){
    g.step();
    if (g.goalReplay.playing) sawReplay = true;
    if (sawReplay && !g.goalReplay.playing){ backLive = true; break; }
  }
  assert.ok(sawReplay, 'automatic replay engaged');
  assert.ok(backLive, 'replay finished and returned to live');
  assert.deepEqual([...g.match.score], scoreAtGoal, 'the replay never re-scores');
  assert.equal(g.replayMode, false, 'live mode restored');
});

test('the goal + automatic replay + restart sequence is fully deterministic', () => {
  const run = () => {
    const h = bootGolden({ seed: G.goal.seed });
    stepUntil(h, g => g.match.score[0] + g.match.score[1] > 0);
    h.step(1500);
    return fullHash(h);
  };
  const once = run();
  assert.equal(once, G.goal.hashAfterReplay, 'pinned against golden');
  assert.equal(run(), once, 'and reproducible across boots');
});
