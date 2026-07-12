// Hermetic runtime for the golden simulation core.
//
// Strangler-fig strategy (see docs/architecture-current.md §13): the
// authoritative engine executes the SAME simulation code as the golden
// index.html demo — extracted at load time and booted inside a node:vm
// context with inert browser stubs. Nothing here requires a DOM, Canvas,
// window, audio, localStorage or browser input; the stubs exist only so the
// golden script's presentation plumbing can no-op safely. Future PRs peel
// subsystems out of the golden script into modules; the characterization
// suite and the parity tests in this package guard every step.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fnv1a } from '@fobal/protocol';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let cachedSource: string | null = null;
export function goldenSource(htmlPath = join(REPO_ROOT, 'index.html')): string {
  if (cachedSource) return cachedSource;
  const html = readFileSync(htmlPath, 'utf8');
  const open = html.lastIndexOf('<script>');
  if (open === -1) throw new Error('no inline <script> found in ' + htmlPath);
  const start = open + '<script>'.length;
  const end = html.indexOf('</script>', start);
  const src = html.slice(start, end);
  if (!src.includes('window.__simulate')) throw new Error('golden script is missing the headless API');
  cachedSource = src;
  return src;
}

function noop(): void {}

function makeContext2D(canvas: Record<string, unknown>): unknown {
  const store: Record<string, unknown> = { canvas };
  const factories: Record<string, (...args: unknown[]) => unknown> = {
    measureText: t => ({ width: String(t ?? '').length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createConicGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({ setTransform: noop }),
    getImageData: (_x, _y, w, h) => ({ width: (w as number) || 1, height: (h as number) || 1, data: new Uint8ClampedArray(Math.max(1, ((w as number) || 1) * ((h as number) || 1)) * 4) }),
    createImageData: (w, h) => ({ width: (w as number) || 1, height: (h as number) || 1, data: new Uint8ClampedArray(Math.max(1, ((w as number) || 1) * ((h as number) || 1)) * 4) }),
    getLineDash: () => [],
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false,
    isPointInStroke: () => false,
  };
  return new Proxy(store, {
    get(t, prop){
      if (prop in t) return t[prop as string];
      if (typeof prop === 'string' && prop in factories) return factories[prop];
      if (typeof prop === 'symbol') return undefined;
      return noop;
    },
    set(t, prop, v){ t[prop as string] = v; return true; },
  });
}

function makeCanvas(w = 1280, h = 800): Record<string, unknown> {
  const canvas: Record<string, unknown> = {
    width: w, height: h, style: {},
    addEventListener: noop, removeEventListener: noop,
    setPointerCapture: noop, releasePointerCapture: noop,
    getBoundingClientRect(){ return { left: 0, top: 0, width: canvas.width, height: canvas.height, x: 0, y: 0 }; },
    toDataURL: () => 'data:image/png;base64,',
    toBlob: (cb: (b: null) => void) => cb && cb(null),
    click: noop, remove: noop,
  };
  canvas.getContext = () => {
    if (!canvas._ctx) canvas._ctx = makeContext2D(canvas);
    return canvas._ctx;
  };
  return canvas;
}

function makeElement(tag: string): Record<string, unknown> {
  if (tag === 'canvas') return makeCanvas(300, 150);
  return {
    tagName: String(tag).toUpperCase(), style: {}, value: '', files: null,
    setAttribute: noop, getAttribute: () => null,
    addEventListener: noop, removeEventListener: noop,
    appendChild: noop, removeChild: noop, remove: noop, click: noop,
  };
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return function(){
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface GoldenHandle {
  sandbox: any;
  game: any;
  step(n?: number): void;
  reset(seed: number): void;
  evalIn(code: string): any;
}

export function bootGoldenCore({ cosmeticSeed = 0xf0ba1 }: { cosmeticSeed?: number } = {}): GoldenHandle {
  const gameCanvas = makeCanvas(1280, 800);
  const storage = new Map<string, string>();
  const rafQueue: unknown[] = [];
  let clock = 0;
  const sandbox: any = {
    document: {
      getElementById: (id: string) => (id === 'game' ? gameCanvas : null),
      createElement: makeElement,
      body: { appendChild: noop, removeChild: noop },
      addEventListener: noop, removeEventListener: noop,
      documentElement: { style: {} }, hidden: false,
    },
    navigator: { userAgent: 'fobal-engine', maxTouchPoints: 0, language: 'en-US' },
    location: { href: 'engine://local', search: '', hash: '', protocol: 'engine:' },
    requestAnimationFrame: (cb: unknown) => { rafQueue.push(cb); return rafQueue.length; },
    cancelAnimationFrame: noop,
    performance: { now: () => (clock += 16.666) },
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
    addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    localStorage: {
      getItem: (k: string) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k: string, v: string) => { storage.set(String(k), String(v)); },
      removeItem: (k: string) => { storage.delete(k); },
      clear: () => storage.clear(),
    },
    prompt: () => null, alert: noop, confirm: () => true,
    Image: class { onload: null = null; _src = ''; set src(v: string){ this._src = v; } get src(){ return this._src; } },
    FileReader: class { readAsText(){} },
    Blob: class { constructor(public parts: unknown, public opts: unknown){} },
    URL: { createObjectURL: () => 'blob:engine', revokeObjectURL: noop },
    fetch: () => Promise.reject(new Error('network disabled inside the engine')),
    console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.__seededRandom = seededRandom(cosmeticSeed);
  vm.runInContext('Math.random = __seededRandom;', sandbox);
  vm.runInContext(goldenSource(), sandbox, { filename: 'golden-engine.js' });
  const game = sandbox.game;
  if (!game) throw new Error('golden core booted but game global is missing');
  return {
    sandbox,
    game,
    step(n = 1){ for (let i = 0; i < n; i++) game.step(); },
    reset(seed: number){ sandbox.__reset(seed); },
    evalIn(code: string){ return vm.runInContext(code, sandbox); },
  };
}

/**
 * Official state hash. MUST stay byte-compatible with
 * tests/characterization/harness/boot.mjs#stateHash — the parity tests compare
 * engine hashes against goldens captured through that independent harness.
 */
export function officialHash(handle: GoldenHandle): string {
  const game = handle.game;
  const rng = handle.evalIn('RNG.state()');
  const parts: unknown[] = [game.simTick, game.match.score[0], game.match.score[1], game.match.state,
    game.match.tMatch.toFixed(6), JSON.stringify(rng)];
  const b = game.ball;
  parts.push(b.x, b.y, b.z, b.vx, b.vy, b.vz, b.spin, b.spinZ, b.inNet ? 1 : 0);
  for (const t of game.teams)
    for (const p of t.players)
      parts.push(p.pid, p.pos.x, p.pos.y, p.vel.x, p.vel.y, p.stamina, p.action, p.facing);
  return fnv1a(parts.join('|'));
}
