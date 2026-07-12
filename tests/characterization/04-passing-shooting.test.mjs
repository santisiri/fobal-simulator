// Characterization: pass/shot statistics and the single-credit attribution invariant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootGolden } from './harness/boot.mjs';
import { loadGoldens } from './util.mjs';

const G = loadGoldens();

test('pass and shot statistics are pinned for seed 5 over 3600 ticks', () => {
  const h = bootGolden({ seed: G.passShoot.seed });
  h.step(G.passShoot.ticks);
  for (const [i, key] of [[0, 'home'], [1, 'away']]){
    const t = h.game.teams[i];
    assert.deepEqual(
      { passAtt: t.passAtt, passCmp: t.passCmp, shots: t.shots, onTarget: t.onTarget },
      G.passShoot[key], key);
  }
  assert.ok(h.game.teams[0].passAtt + h.game.teams[1].passAtt > 10, 'a real match has passes');
});

test('team.passCmp === Σ player passCmp (single-credit invariant)', () => {
  const h = bootGolden({ seed: G.passShoot.seed });
  h.step(G.passShoot.ticks);
  for (const t of h.game.teams){
    const sum = t.players.concat(t.bench || []).concat(t.offList || [])
      .reduce((a, p) => a + (p.stats ? p.stats.passCmp || 0 : 0), 0);
    assert.equal(t.passCmp, sum, `${t.name} attribution`);
    assert.ok(t.passCmp <= t.passAtt, 'completions cannot exceed attempts');
    assert.ok(t.onTarget <= t.shots, 'on-target cannot exceed shots');
  }
});
