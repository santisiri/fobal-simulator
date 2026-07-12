// Characterization: simulation advances only through fixed 1/60s ticks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootGolden, fullHash } from './harness/boot.mjs';
import { loadGoldens, sourceHash } from './util.mjs';

const G = loadGoldens();

test('goldens match the current index.html script', () => {
  assert.equal(sourceHash(), G.sourceHash,
    'index.html changed: regenerate goldens deliberately (node tools/update-goldens.mjs) and document the behavior change');
});

test('sim time is parked until step() is called (rAF never drives it)', () => {
  const h = bootGolden({ seed: 42 });
  assert.equal(h.game.simTick, 0);
  assert.ok(h.sandbox.__rafQueue.length >= 1, 'the render loop registered itself');
});

test('60 ticks advance exactly one sim second of match clock', () => {
  const h = bootGolden({ seed: 42 });
  h.step(60);
  assert.equal(h.game.simTick, G.fixedTimestep.simTickAfter60);
  assert.equal(h.game.match.tMatch, G.fixedTimestep.tMatchAfter60);
});

test('chunked stepping equals monolithic stepping', () => {
  const a = bootGolden({ seed: 42 });
  a.step(300);
  const b = bootGolden({ seed: 42 });
  for (let i = 0; i < 30; i++) b.step(10);
  assert.equal(fullHash(a), fullHash(b));
});
