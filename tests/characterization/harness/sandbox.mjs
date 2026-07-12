// Browser-API stubs sufficient to boot the golden game script in pure Node.
// Everything here is render/UI plumbing: the simulation itself never touches
// the DOM (that separation is the determinism contract documented in
// docs/architecture-current.md), so these stubs only need to survive being
// called, not to produce real pixels.

function noop(){}

// Canvas 2D context stub: property writes are stored (code reads back things
// like fillStyle/globalAlpha), known factory methods return usable dummies,
// every other method is a no-op.
export function makeContext2D(canvas){
  const store = { canvas };
  const factories = {
    measureText: t => ({ width: String(t ?? '').length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createConicGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({ setTransform: noop }),
    getImageData: (x, y, w, h) => ({ width: w || 1, height: h || 1, data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1)) * 4) }),
    createImageData: (w, h) => ({ width: w || 1, height: h || 1, data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1)) * 4) }),
    getLineDash: () => [],
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false,
    isPointInStroke: () => false,
  };
  return new Proxy(store, {
    get(t, prop){
      if (prop in t) return t[prop];
      if (prop in factories) return factories[prop];
      if (typeof prop === 'symbol') return undefined;
      return noop;
    },
    set(t, prop, v){ t[prop] = v; return true; },
  });
}

export function makeCanvas(w = 300, h = 150){
  const canvas = {
    width: w, height: h,
    style: {},
    getContext(){ if (!this._ctx) this._ctx = makeContext2D(this); return this._ctx; },
    addEventListener: noop, removeEventListener: noop,
    setPointerCapture: noop, releasePointerCapture: noop,
    getBoundingClientRect(){ return { left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height, x: 0, y: 0 }; },
    toDataURL(){ return 'data:image/png;base64,'; },
    toBlob(cb){ cb && cb(null); },
    click: noop, remove: noop,
  };
  return canvas;
}

function makeElement(tag){
  if (tag === 'canvas') return makeCanvas();
  return {
    tagName: String(tag).toUpperCase(),
    style: {}, value: '', files: null,
    setAttribute: noop, getAttribute: () => null,
    addEventListener: noop, removeEventListener: noop,
    appendChild: noop, removeChild: noop, remove: noop, click: noop,
  };
}

export function makeLocalStorage(){
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(k); },
    clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null,
    get length(){ return m.size; },
  };
}

// mulberry32 — deterministic Math.random replacement. Math.random is
// cosmetic-only in the game, but pinning it removes an entire class of
// nondeterminism from harness runs at zero cost.
export function seededRandom(seed = 0xF0BA1){
  let s = seed >>> 0;
  return function(){
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Builds the vm sandbox that plays the role of `window`. The game script
// assigns its public API onto `window.*`, and `window === globalThis` in the
// context, so the caller reads e.g. sandbox.__reset after boot.
export function makeSandbox({ cosmeticSeed = 0xF0BA1, now } = {}){
  const gameCanvas = makeCanvas(1280, 800);
  gameCanvas.id = 'game';
  const rafQueue = [];
  let clock = 0;
  const sandbox = {
    // --- DOM ---
    document: {
      getElementById: id => (id === 'game' ? gameCanvas : null),
      createElement: makeElement,
      body: { appendChild: noop, removeChild: noop },
      addEventListener: noop, removeEventListener: noop,
      documentElement: { style: {} },
      hidden: false,
    },
    navigator: { userAgent: 'fobal-headless-harness', maxTouchPoints: 0, language: 'en-US' },
    location: { href: 'http://localhost/', search: '', hash: '', protocol: 'http:' },
    // --- timing: rAF callbacks are queued and never run; the harness drives
    // game.step() directly, so the render loop must stay parked. ---
    requestAnimationFrame: cb => { rafQueue.push(cb); return rafQueue.length; },
    cancelAnimationFrame: noop,
    performance: { now: now || (() => (clock += 16.666)) },
    setTimeout: (cb) => 0,          // UI-only usage (URL revocation); never run
    clearTimeout: noop,
    setInterval: () => 0, clearInterval: noop,
    // --- misc browser surface ---
    devicePixelRatio: 1,
    innerWidth: 1280, innerHeight: 800,
    addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    localStorage: makeLocalStorage(),
    prompt: () => null, alert: noop, confirm: () => true,
    Image: class Image { constructor(){ this.onload = null; this._src = ''; } set src(v){ this._src = v; } get src(){ return this._src; } },
    FileReader: class FileReader { readAsText(){} },
    Blob: class Blob { constructor(parts, opts){ this.parts = parts; this.type = opts && opts.type; } },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: noop },
    fetch: () => Promise.reject(new Error('network disabled in harness')),
    console,
    __rafQueue: rafQueue,
    __gameCanvas: gameCanvas,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  // Deterministic cosmetics: the game's sim uses its own seeded RNG (srand);
  // Math.random is only allowed in presentation code. Pin it anyway.
  sandbox.__cosmeticSeed = cosmeticSeed;
  return sandbox;
}
