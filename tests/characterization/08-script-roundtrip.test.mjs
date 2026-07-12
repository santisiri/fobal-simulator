// Characterization: record → export → validate → strict import reproduces the
// run bit-exactly with zero resyncs; malformed scripts are rejected harmlessly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootGolden, fullHash } from './harness/boot.mjs';
import { loadGoldens } from './util.mjs';

const G = loadGoldens();

test('export produces a versioned script document', () => {
  const h = bootGolden({ seed: 5 });
  h.step(120);
  const doc = h.exportScript();
  assert.equal(doc.kind, G.script.kind);
  assert.equal(doc.version, G.script.version);
  for (const k of ['metadata', 'match', 'teams', 'initialState', 'timeline', 'events', 'snapshots', 'finalState'])
    assert.ok(k in doc, `script has ${k}`);
  assert.equal(doc.match.seed, 5);
});

test('strict replay of a recording (with an exogenous tactic) is bit-exact, 0 resyncs', () => {
  const rec = bootGolden({ seed: 5 });
  rec.step(400);
  rec.tactics({ pressing: 0.9, shootTendency: 1.5 });
  rec.step(1400);
  const recHash = fullHash(rec);
  const doc = JSON.parse(JSON.stringify(rec.exportScript()));

  const val = rec.validateScript(JSON.stringify(doc));
  // JSON round-trip: vm-context objects have a foreign Object.prototype
  assert.deepEqual(JSON.parse(JSON.stringify(val)), { ok: true, errors: [], warnings: [] });

  const rep = bootGolden({});
  const res = rep.loadScript(doc, { mode: 'strict' });
  assert.equal(res.ok, true);
  while (rep.game.simTick < doc.finalState.tick) rep.game.step();
  assert.equal(rep.game.scriptRunner.resyncs, 0, 'no drift resyncs');
  assert.ok(rep.game.scriptRunner.driftChecks > 0, 'drift watchdog actually ran');
  assert.equal(fullHash(rep), recHash, 'replay is bit-exact');
});

test('malformed scripts are rejected without touching the simulation', () => {
  const h = bootGolden({ seed: 9 });
  h.step(200);
  const before = fullHash(h);

  assert.equal(h.validateScript('this is not json').ok, false);
  assert.equal(h.validateScript('{"kind":"wrong"}').ok, false);
  const bad = h.loadScript('{"kind":"wrong","version":"1.0"}', { mode: 'strict' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);

  assert.equal(fullHash(h), before, 'rejected loads leave the match untouched');
  h.step(60); // and the sim still runs
  assert.equal(h.game.simTick, 260);
});
