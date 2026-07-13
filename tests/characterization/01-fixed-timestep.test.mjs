// Characterization: simulation advances only through fixed 1/60s ticks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootGolden, fullHash } from './harness/boot.mjs';
import { evalInSandbox, loadGoldens, sourceHash } from './util.mjs';

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

test('in open play the clock advances exactly TIME_SCALE match-seconds per real second', () => {
  // the golden pin above lands in kickoff choreography where the clock is
  // parked — this asserts the actual fixed-timestep property in a PLAYING run
  const h = bootGolden({ seed: 42 });
  const TIME_SCALE = evalInSandbox(h, 'TIME_SCALE'); // (90*60)/CFG.MATCH_REAL_SECONDS
  assert.ok(TIME_SCALE > 0);
  let measured = false;
  for (let guard = 0; guard < 30 && !measured; guard++){
    while (h.game.match.state !== 'PLAYING') h.game.step();
    const t0 = h.game.match.tMatch;
    let clean = true;
    for (let i = 0; i < 60; i++){
      h.game.step();
      if (h.game.match.state !== 'PLAYING'){ clean = false; break; }
    }
    if (!clean) continue; // a restart interrupted the window; find another
    const dt = h.game.match.tMatch - t0;
    assert.ok(Math.abs(dt - TIME_SCALE) < 1e-6, `Δclock ${dt} ≠ TIME_SCALE ${TIME_SCALE}`);
    measured = true;
  }
  assert.ok(measured, 'found a clean 60-tick PLAYING window');
});

test('chunked stepping equals monolithic stepping', () => {
  const a = bootGolden({ seed: 42 });
  a.step(300);
  const b = bootGolden({ seed: 42 });
  for (let i = 0; i < 30; i++) b.step(10);
  assert.equal(fullHash(a), fullHash(b));
});
