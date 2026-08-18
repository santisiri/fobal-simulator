// Solves the palettes instead of guessing them.
//
// Two different jobs, two different gates — conflating them is why the first
// hand-picked attempt failed:
//   RAMPS (skin, hair) are ordered families. What must be separable is
//   ADJACENT steps; distant pairs are separable for free. An all-pairs gate
//   on a 10-step ramp is unsatisfiable (10 steps x dE22 needs 200 L*).
//   CATEGORICAL sets (background, accent) have no order, so every pair must
//   clear the bar — and that is achievable only by spending HUE, not just
//   lightness.
//
// Method: farthest-point (max-min dispersion) sampling over a constrained
// candidate space, which maximises the minimum pairwise distance — exactly
// the quantity the sibling effect is sensitive to.
import { hexToLab, dE76 } from '../spec/palettes.js';

const hex = (r, g, b) => [r, g, b].map(v =>
  Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// ---- Lab -> sRGB (the inverse of palettes.js hexToLab)
function labToHex(L, a, bb) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
  const inv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const [x, y, z] = [inv(fx) * 0.95047, inv(fy), inv(fz) * 1.08883];
  let r = x * 3.2406 + y * -1.5372 + z * -0.4986;
  let g = x * -0.9689 + y * 1.8758 + z * 0.0415;
  let b2 = x * 0.0557 + y * -0.2040 + z * 1.0570;
  const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);
  return hex(gam(r) * 255, gam(g) * 255, gam(b2) * 255);
}
const inGamut = (L, a, b) => {
  const h = labToHex(L, a, b);
  const back = hexToLab(h);
  return Math.abs(back[0] - L) < 1.5 && Math.abs(back[1] - a) < 1.5 && Math.abs(back[2] - b) < 1.5;
};

/** even-in-Lab ramp between two anchors, staying on a plausible locus */
function ramp(n, from, to) {
  const A = hexToLab(from), B = hexToLab(to);
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return labToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  });
}

/** max-min dispersion pick of n colours from a candidate list */
function disperse(candidates, n, seedIdx = 0) {
  const chosen = [candidates[seedIdx]];
  while (chosen.length < n) {
    let best = null, bestD = -1;
    for (const c of candidates) {
      if (chosen.includes(c)) continue;
      const d = Math.min(...chosen.map(x => dE76(x, c)));
      if (d > bestD) { bestD = d; best = c; }
    }
    chosen.push(best);
  }
  return chosen;
}

const minAdjacent = (cols) => Math.min(...cols.slice(1).map((c, i) => dE76(cols[i], c)));
const minPair = (cols) => {
  let m = Infinity;
  for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) m = Math.min(m, dE76(cols[i], cols[j]));
  return m;
};
const span = (cols) => { const l = cols.map(c => hexToLab(c)[0]); return Math.max(...l) - Math.min(...l); };

// ---------------------------------------------------------------- SKIN ramp
// A real skin locus: warm hue, chroma peaking in the mid tones, L* 88 -> 22.
const SKIN = Array.from({ length: 8 }, (_, i) => {
  const t = i / 7;
  const L = 91 - t * 71;                                  // 91 .. 20
  const chroma = 14 + Math.sin(t * Math.PI) * 12;         // peaks mid-ramp
  const hue = 52 - t * 8;                                 // warm, slightly redder when deep
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  return labToHex(L, a, b);
});

// ---------------------------------------------------------------- HAIR
// Semi-categorical: a dark->light ramp PLUS two hue outliers (ginger, steel)
// that must each stand clear of the ramp.
const HAIR_RAMP = ramp(7, '141010', 'e6d9b8');
const HAIR = [...HAIR_RAMP, 'b8481f', '9aa3ab'];

// ------------------------------------------------------- BG (categorical)
// Muted but hue-spread: chroma capped so the player still pops, L* 12..72.
const bgCandidates = [];
for (let L = 11; L <= 64; L += 2)
  for (let hueDeg = 0; hueDeg < 360; hueDeg += 12)
    for (const chroma of [8, 14, 20]) {
      const a = chroma * Math.cos((hueDeg * Math.PI) / 180);
      const b = chroma * Math.sin((hueDeg * Math.PI) / 180);
      if (inGamut(L, a, b)) bgCandidates.push(labToHex(L, a, b));
    }
const BG = disperse(bgCandidates, 8, 0);

// ---------------------------------------------- ACCENT (categorical, vivid)
// curated: these are football colours, then VERIFIED against the gate —
// max-min dispersion over the full gamut returns neon, which is separable
// but wrong for a kit accent.
const ACCENT = ['e8e2d4', '1b1b1f', 'd8342c', 'e0a02a', '2f8f4e', '2f6fd0', '8a5cf6', 'e8712f'];

const show = (name, cols, kind, need) => {
  const m = kind === 'ramp' ? minAdjacent(cols) : minPair(cols);
  console.log(`\n${name} (${kind}, n=${cols.length}) min${kind === 'ramp' ? 'Adjacent' : 'Pair'}dE=${m.toFixed(1)} `
    + `L*span=${span(cols).toFixed(0)} need>=${need} → ${m >= need ? 'PASS' : 'FAIL'}`);
  console.log('  ' + JSON.stringify(cols));
};
show('SKIN', SKIN, 'ramp', 10);
console.log('  (skin shades/lights are derived per tone at render time)');
show('HAIR', HAIR, 'ramp', 8);
show('BG', BG, 'categorical', 18);
show('ACCENT', ACCENT, 'categorical', 18);
