// Shared helpers for the characterization suite.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { goldenSource } from './harness/boot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function fnv1a(s){
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function sourceHash(){
  return fnv1a(goldenSource());
}

export function loadGoldens(){
  return JSON.parse(readFileSync(join(HERE, 'goldens.json'), 'utf8'));
}

// Deterministic squad/environment fingerprint for a booted game.
export function squadFingerprint(handle){
  const g = handle.game;
  const players = t => t.players.slice(0, 3).map(p =>
    [p.name, p.role, p.nat, p.age, Object.values(p.a).map(v => v.toFixed(6)).join(',')].join(':'));
  return fnv1a(JSON.stringify({
    env: [g.grassKey, g.weatherKey],
    ref: g.ref.profile ? [g.ref.profile.name, g.ref.profile.strictness.toFixed(6)] : null,
    home: players(g.teams[0]), away: players(g.teams[1]),
    names: [g.teams[0].name, g.teams[1].name],
  }));
}

// State-machine transitions over N ticks: [{ t, s }, ...]
export function stateTimeline(handle, ticks){
  const out = [{ t: handle.game.simTick, s: handle.game.match.state }];
  for (let i = 0; i < ticks; i++){
    handle.game.step();
    const s = handle.game.match.state;
    if (s !== out[out.length - 1].s) out.push({ t: handle.game.simTick, s });
  }
  return out;
}

// Step tick-by-tick until predicate; returns tick reached or -1 on cap.
export function stepUntil(handle, pred, cap = 210 * 60){
  while (handle.game.simTick < cap){
    handle.game.step();
    if (pred(handle.game)) return handle.game.simTick;
  }
  return -1;
}

export function evalInSandbox(handle, code){
  return vm.runInContext(code, handle.sandbox);
}

// Diff of team tactics vs a baseline: { key: newValue } for changed keys only.
export function tacticsDiff(base, now){
  const out = {};
  for (const k of Object.keys(now)){
    const a = base[k], b = now[k];
    if (typeof b === 'number' ? Math.abs((a ?? 0) - b) > 1e-9 : a !== b)
      out[k] = typeof b === 'number' ? +b.toFixed(4) : b;
  }
  return out;
}
