// The gate the kit bug walked past. A byte-parity harness compares JS to
// Solidity, so a mistake made identically in both is invisible to it: four
// stripes at a fixed pitch painted a 3x7 block of kit colour three pixels
// clear of the Slim build's shoulder, and every test passed.
//
// This asserts a property of the IMAGE instead: a player is one connected
// figure. Any painted pixel not 4-connected to the main mass is paint
// floating on the background, whichever renderer produced it.
import { renderPlayer, KIT_PATTERNS } from '../src/render.js';
import { BG } from '../spec/palettes.js';
import { keccak_256 } from '@noble/hashes/sha3';

const RE = /<rect x="(-?\d+)" y="(-?\d+)" width="(\d+)" height="(\d+)" fill="#(\w+)"\/>/g;

/** every pixel whose colour is not the background rect's */
function figureOf(svg) {
  const px = new Array(1024).fill(null);
  for (const m of svg.matchAll(RE)) {
    const [, x, y, w, h, c] = m;
    for (let j = +y; j < +y + +h; j++) for (let i = +x; i < +x + +w; i++)
      if (i >= 0 && i < 32 && j >= 0 && j < 32) px[j * 32 + i] = c;
  }
  const bg = px[0];
  return px.map((c) => (c !== null && c !== bg ? 1 : 0));
}

/** pixels not reachable from the largest 4-connected component */
export function detached(svg) {
  const f = figureOf(svg);
  const seen = new Uint8Array(1024);
  let best = [];
  for (let s = 0; s < 1024; s++) {
    if (!f[s] || seen[s]) continue;
    const stack = [s], comp = [];
    seen[s] = 1;
    while (stack.length) {
      const k = stack.pop();
      comp.push(k);
      const x = k % 32, y = (k / 32) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
        const n = ny * 32 + nx;
        if (f[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  const total = f.reduce((a, b) => a + b, 0);
  const orphan = total - best.length;
  return { orphan, total };
}

const idOf = (tag) => {
  const b = keccak_256(new TextEncoder().encode(tag));
  const dna = '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return { dna, appearance: (BigInt(dna) >> 96n) & 0xffffffffn };
};

/** Every pattern crossed with a broad seed sample, so a build/pattern pair
 *  that only a rare identity reaches is still covered. */
export function assertConnected(n = 400) {
  const bad = [];
  for (let i = 0; i < n; i++) {
    const id = idOf(`conn-${i}`);
    for (let pattern = 0; pattern < KIT_PATTERNS.length; pattern++) {
      const kit = { primary: '2f6fd0', secondary: 'f2f4f8', accent: 'e0b024', pattern };
      const { orphan } = detached(renderPlayer({ ...id, kit }));
      if (orphan > 0) bad.push(`seed ${i} + ${KIT_PATTERNS[pattern]}: ${orphan} detached px`);
    }
    const { orphan } = detached(renderPlayer(id));           // free agent
    if (orphan > 0) bad.push(`seed ${i} free agent: ${orphan} detached px`);
  }
  return { pass: bad.length === 0, bad, checked: n * (KIT_PATTERNS.length + 1) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = assertConnected(Number(process.argv[2] ?? 400));
  console.log(`connectivity: ${r.pass ? 'PASS' : 'FAIL'} over ${r.checked} renders`);
  const uniq = [...new Set(r.bad.map((b) => b.replace(/^seed \d+ /, '')))];
  uniq.slice(0, 12).forEach((b) => console.log('  ' + b));
  if (uniq.length > 12) console.log(`  … ${uniq.length - 12} more distinct`);
  process.exit(r.pass ? 0 : 1);
}
