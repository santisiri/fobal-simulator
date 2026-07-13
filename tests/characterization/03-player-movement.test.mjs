// Characterization: player kinematics over the opening of a match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootGolden, fullHash } from './harness/boot.mjs';
import { loadGoldens } from './util.mjs';

const G = loadGoldens();

test('22 players move deterministically (pinned hash at tick 300 and 600)', () => {
  const h = bootGolden({ seed: 42 });
  h.step(300);
  assert.equal(fullHash(h), G.seed42.hash300);
  h.step(300);
  assert.equal(fullHash(h), G.seed42.hash600);
});

test('players stay on (or immediately around) the pitch', () => {
  const h = bootGolden({ seed: 42 });
  h.step(1800);
  for (const t of h.game.teams)
    for (const p of t.players){
      assert.ok(p.pos.x > -6 && p.pos.x < 111, `${p.pid} x=${p.pos.x}`);
      assert.ok(p.pos.y > -6 && p.pos.y < 74, `${p.pid} y=${p.pos.y}`);
    }
});

test('play produces real displacement and goalkeepers hold their areas', () => {
  const h = bootGolden({ seed: 42 });
  const start = new Map();
  for (const t of h.game.teams) for (const p of t.players) start.set(p.pid, { ...p.pos });
  h.step(1800);
  let moved = 0;
  for (const t of h.game.teams)
    for (const p of t.players){
      const s = start.get(p.pid);
      moved += Math.hypot(p.pos.x - s.x, p.pos.y - s.y);
    }
  assert.ok(moved > 100, `total displacement ${moved.toFixed(1)}m should exceed 100m`);
  for (const t of h.game.teams){
    const ownGoalX = t.attackDir > 0 ? 0 : 105;
    assert.ok(Math.abs(t.gk.pos.x - ownGoalX) < 40, `GK ${t.gk.pid} strayed ${t.gk.pos.x}`);
  }
});
