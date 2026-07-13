// Characterization: goals are detected, scored, credited and recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootGolden } from './harness/boot.mjs';
import { loadGoldens, stepUntil } from './util.mjs';

const G = loadGoldens();

test('the first natural goal of seed 10 lands on its pinned tick', () => {
  const h = bootGolden({ seed: G.goal.seed });
  const tick = stepUntil(h, g => g.match.score[0] + g.match.score[1] > 0);
  assert.equal(tick, G.goal.firstGoalTick);
  assert.equal(h.game.match.state, G.goal.stateAtGoal);
  assert.deepEqual([...h.game.match.score], G.goal.score);
  const doc = h.exportScript();
  const ev = doc.events.filter(e => e.type === 'goal').pop();
  assert.ok(ev, 'goal was recorded as a semantic event');
  assert.equal(ev.actor, G.goal.scorer);
});

test('a ball driven over the goal line between the posts is a goal', () => {
  const h = bootGolden({ seed: 3 });
  stepUntil(h, g => g.match.state === 'PLAYING', 3600); // kickoff choreography pins the ball
  h.step(30);
  const g = h.game;
  const before = g.match.score[0] + g.match.score[1];
  // fire the ball into the west goal's low far corner, with the keeper moved
  // aside — this characterizes line-crossing geometry, not shot-stopping
  const westGK = g.teams.map(t => t.gk).sort((a, b) => a.pos.x - b.pos.x)[0];
  westGK.pos.y = 20; westGK.target = { x: westGK.pos.x, y: 20 };
  g.ball.holder = null; g.ball.controller = null; g.ball.intendedReceiver = null;
  g.ball.x = 1.6; g.ball.y = 36.4; g.ball.z = 0.25;
  g.ball.vx = -26; g.ball.vy = 0; g.ball.vz = 0;
  let sawGoal = false;
  for (let i = 0; i < 90 && !sawGoal; i++){ g.step(); sawGoal = g.match.state === 'GOAL'; }
  assert.ok(sawGoal, 'GOAL state was reached');
  assert.equal(g.match.score[0] + g.match.score[1], before + 1, 'exactly one goal was scored');
});
