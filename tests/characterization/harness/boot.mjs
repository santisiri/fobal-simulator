// Boots the golden index.html game script inside a hermetic Node vm context
// and exposes the headless QA API for characterization tests.
import vm from 'node:vm';
import { extractInlineScript } from '../../../tools/extract-inline-script.mjs';
import { makeSandbox, seededRandom } from './sandbox.mjs';

let cachedSource = null;
export function goldenSource(){
  if (!cachedSource) cachedSource = extractInlineScript();
  return cachedSource;
}

export function bootGolden({ seed, env, cosmeticSeed = 0xF0BA1 } = {}){
  const sandbox = makeSandbox({ cosmeticSeed });
  vm.createContext(sandbox);
  // Pin cosmetic randomness inside the context (its Math is context-local).
  vm.runInContext('Math.random = __seededRandom;', Object.assign(sandbox, { __seededRandom: seededRandom(cosmeticSeed) }));
  vm.runInContext(goldenSource(), sandbox, { filename: 'golden-engine.js' });
  const game = sandbox.game;
  if (!game) throw new Error('golden script booted but window.game is missing');
  if (env) sandbox.__setEnv(env.grass, env.weather);
  if (seed !== undefined) sandbox.__reset(seed);
  return {
    sandbox,
    game,
    reset: s => sandbox.__reset(s),
    simulate: s => sandbox.__simulate(s),
    stats: () => sandbox.__stats(),
    coach: t => sandbox.__coach(t),
    tactics: s => sandbox.__tactics(s),
    setEnv: (g, w) => sandbox.__setEnv(g, w),
    present: on => sandbox.__present(on),
    exportScript: () => sandbox.__exportScript(),
    loadScript: (doc, opts) => sandbox.__loadScript(doc, opts),
    validateScript: src => sandbox.__validateScript(src),
    step(n = 1){ for (let i = 0; i < n; i++) game.step(); },
  };
}

// Canonical hash over official sim state. FNV-1a 32-bit over a stable string:
// tick, score, clock, RNG cursor, ball kinematics, and every player's
// position/velocity/stamina. Cosmetic state (camera, crowd, animT) is
// deliberately excluded — that is the official/presentation split.
export function stateHash(game){
  const parts = [game.simTick, game.match.score[0], game.match.score[1], game.match.state,
    game.match.tMatch.toFixed(6), JSON.stringify(game.sandboxRngState ?? null)];
  const b = game.ball;
  parts.push(b.x, b.y, b.z, b.vx, b.vy, b.vz, b.spin, b.spinZ, b.inNet ? 1 : 0);
  for (const t of game.teams)
    for (const p of t.players)
      parts.push(p.pid, p.pos.x, p.pos.y, p.vel.x, p.vel.y, p.stamina, p.action, p.facing);
  const s = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// The RNG global lives inside the vm context; expose its cursor for hashing.
export function rngState(handle){
  return vm.runInContext('RNG.state()', handle.sandbox);
}

export function fullHash(handle){
  const g = handle.game;
  g.sandboxRngState = rngState(handle);
  const h = stateHash(g);
  delete g.sandboxRngState;
  return h;
}
