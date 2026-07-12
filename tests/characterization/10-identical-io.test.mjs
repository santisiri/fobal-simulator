// Characterization: identical seed + identical inputs ⇒ identical output.
// Inputs are fed through the real Input surface (key map + release values),
// the same one live play and strict replay use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootGolden, fullHash } from './harness/boot.mjs';

function runWithInputs(seed, plan){
  const h = bootGolden({ seed });
  const g = h.game;
  g.humanMode = true;
  g.selected = g.teams[0].players[9];
  for (let t = 0; t < plan.ticks; t++){
    for (const a of plan.actions){
      if (t === a.at){
        if (a.down) g.input.down[a.down] = true;
        if (a.up){ g.input.down[a.up] = false; }
        if (a.passReleased !== undefined) g.input.passReleased = a.passReleased;
      }
    }
    g.step();
  }
  return fullHash(h);
}

const PLAN_A = { ticks: 1200, actions: [
  { at: 60, down: 'ArrowRight' }, { at: 240, down: 'ArrowUp' },
  { at: 420, up: 'ArrowRight' }, { at: 480, up: 'ArrowUp' },
  { at: 500, passReleased: 0.62 },
  { at: 700, down: 'ArrowDown' }, { at: 900, up: 'ArrowDown' },
]};
const PLAN_B = { ticks: 1200, actions: [
  { at: 60, down: 'ArrowLeft' }, { at: 500, up: 'ArrowLeft' },
  { at: 520, passReleased: 0.95 },
]};

test('identical seed + identical input plan ⇒ identical final state', () => {
  const a1 = runWithInputs(8, PLAN_A);
  const a2 = runWithInputs(8, PLAN_A);
  assert.equal(a1, a2);
});

test('the inputs actually matter: a different plan diverges', () => {
  const a = runWithInputs(8, PLAN_A);
  const b = runWithInputs(8, PLAN_B);
  assert.notEqual(a, b);
});

test('same inputs on a different seed diverge (seed matters too)', () => {
  const a = runWithInputs(8, PLAN_A);
  const c = runWithInputs(9, PLAN_A);
  assert.notEqual(a, c);
});
