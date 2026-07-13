// Characterization: restart choreography — the state machine's exact path is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootGolden } from './harness/boot.mjs';
import { loadGoldens, stateTimeline } from './util.mjs';

const G = loadGoldens();
const DEAD_BALL = ['THROWIN', 'CORNER', 'GOALKICK', 'FREEKICK'];

test('seed 42 walks the exact pinned state-machine path for 60 sim-seconds', () => {
  const h = bootGolden({ seed: 42 });
  assert.deepEqual(stateTimeline(h, 3600), G.seed42.timeline3600);
});

test('every dead-ball restart returns to PLAYING (force timeouts hold)', () => {
  const tl = G.seed42.timeline3600;
  tl.forEach((e, i) => {
    if (DEAD_BALL.includes(e.s) && i < tl.length - 1){ // the window may end mid-restart
      const rest = tl.slice(i + 1);
      assert.ok(rest.some(x => x.s === 'PLAYING'), `${e.s} at tick ${e.t} never resumed`);
    }
  });
  assert.ok(tl.some(e => DEAD_BALL.includes(e.s)), 'the pinned minute contains at least one set piece');
});

test('during a dead-ball phase the ball is pinned to the restart spot', () => {
  const h = bootGolden({ seed: 42 });
  const g = h.game;
  let checked = 0;
  for (let i = 0; i < 3600; i++){
    g.step();
    if (DEAD_BALL.includes(g.match.state) && g.match.restart && g.match.restart.spot && g.match.stateT > 0.5){
      const d = Math.hypot(g.ball.x - g.match.restart.spot.x, g.ball.y - g.match.restart.spot.y);
      assert.ok(d < 2.0, `${g.match.state} tick ${g.simTick}: ball ${d.toFixed(2)}m from spot`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'at least one pinned-ball tick was observed');
});
