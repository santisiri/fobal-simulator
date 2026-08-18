// FOBAL art v2 — palettes, and the perceptual gate they must pass.
//
// v1's palettes were the single largest cause of the sibling effect: eight
// backgrounds that spanned only 7 points of L* (14-21) read as ONE colour at
// thumbnail size, and the background owns ~65% of the canvas. Colour is the
// cheapest diversity in the system — it costs zero bytecode, because a
// palette index is already in the seed — so these tables are gated by a
// measured perceptual test rather than by taste.
//
// THE GATE (validatePalettes below). Two kinds of palette, two different
// tests — conflating them is why the first hand-picked attempt failed:
//   RAMPS (skin, hair) are ordered families, so only ADJACENT steps must
//     separate. An all-pairs gate on an 8-step ramp is unsatisfiable: it
//     would need an L* span of 150+ on a 100-point axis.
//       SKIN  adjacent dE76 >= 10, L* span >= 55
//       HAIR  adjacent dE76 >= 8,  L* span >= 55
//   CATEGORICAL sets (background, accent) are unordered, so EVERY pair must
//     clear the bar — achievable only by spending hue, not just lightness.
//       BG      pairwise dE76 >= 18, L* span >= 40
//       ACCENT  pairwise dE76 >= 18, L* span >= 55
// Thresholds are dE76 because that is the metric the 330x-collapse
// measurement used; dE2000 is implemented below for information.

/** Skin: the solved base ramp. Each tone derives its own [base, shade,
 *  light] triplet (see SKIN, under), so a face has planes instead of
 *  reading as a flat silhouette. */
// SOLVED (tools/solve-palettes.mjs): 8 tones on a skin locus, even in Lab,
// adjacent dE76 = 10.2, L* span 71. Shade/light are derived per tone.
export const SKIN_BASE = [
  'fedfd1', 'eac0ae', 'd3a28d', 'ba8671', '9e6c59', '805444', '613f32', '432a23',
];
const mix = (hex, target, amt) => {
  const n = parseInt(hex, 16), t = parseInt(target, 16);
  const ch = (sh) => {
    const a = (n >> sh) & 255, b = (t >> sh) & 255;
    return Math.round(a + (b - a) * amt).toString(16).padStart(2, '0');
  };
  return ch(16) + ch(8) + ch(0);
};
export const SKIN = SKIN_BASE.map(base => [base, mix(base, '2a1408', 0.3), mix(base, 'fff6ec', 0.35)]);

/** Hair mass is the strongest silhouette signal in the system, so its colour
 *  ramp is wide on purpose — including two greys and a ginger that read
 *  instantly against every background. */
// SOLVED: dark->light ramp (adjacent dE76 = 13.8) plus two hue outliers.
export const HAIR = [
  '141010', '312d29', '514b42', '746c5e', '988f7b', 'beb399', 'e6d9b8', 'b8481f', '9aa3ab',
];

/** Backgrounds: muted, but spanning both hue and a wide L* ramp so a grid of
 *  players never reads as one colour field. */
// SOLVED by max-min dispersion over a chroma-capped, L*11-64 candidate
// space: min PAIRWISE dE76 = 26.7. Background owns ~65% of the canvas at
// thumbnail size, so this is the single most valuable palette in the system.
export const BG = [
  '281a1e', '6da398', '9c6d73', '335b75', '4c5636', '9296ba', '9d9370', '002312',
];

/** The per-player accent that SURVIVES the team kit (collar, cuffs, an
 *  undershirt sliver). Restores the high-contrast personal colour channel
 *  that v1 had in its shirt palette and that team ownership would otherwise
 *  collapse to cardinality 1 across a squad. */
export const ACCENT = [
  'e8e2d4', '1b1b1f', 'd8342c', 'e0a02a',
  '2f8f4e', '2f6fd0', '8a5cf6', 'e8712f',
];

export const INK = '0f0b09';        // outline / silhouette ink
export const EYE_WHITE = 'f4f1ea';
export const IRIS = ['3b2a1c', '2a3d52', '3d5240', '5a4632'];

// ------------------------------------------------------------ colour maths
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export function hexToLab(hex) {
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => srgbToLin(v / 255));
  // sRGB D65 -> XYZ
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export const dE76 = (a, b) => {
  const [l1, a1, b1] = hexToLab(a), [l2, a2, b2] = hexToLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

/** CIE dE2000 — reported for information; the gates use dE76 (above). */
export function dE2000(hexA, hexB) {
  const [L1, a1, b1] = hexToLab(hexA), [L2, a2, b2] = hexToLab(hexB);
  const avgL = (L1 + L2) / 2;
  const c1 = Math.hypot(a1, b1), c2 = Math.hypot(a2, b2), avgC = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(Math.pow(avgC, 7) / (Math.pow(avgC, 7) + Math.pow(25, 7))));
  const a1p = a1 * (1 + g), a2p = a2 * (1 + g);
  const c1p = Math.hypot(a1p, b1), c2p = Math.hypot(a2p, b2), avgCp = (c1p + c2p) / 2;
  const deg = (r) => (r * 180) / Math.PI, rad = (d) => (d * Math.PI) / 180;
  let h1p = deg(Math.atan2(b1, a1p)); if (h1p < 0) h1p += 360;
  let h2p = deg(Math.atan2(b2, a2p)); if (h2p < 0) h2p += 360;
  const avgHp = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2;
  const t = 1 - 0.17 * Math.cos(rad(avgHp - 30)) + 0.24 * Math.cos(rad(2 * avgHp))
    + 0.32 * Math.cos(rad(3 * avgHp + 6)) - 0.2 * Math.cos(rad(4 * avgHp - 63));
  let dhp = h2p - h1p;
  if (Math.abs(dhp) > 180) dhp += dhp > 0 ? -360 : 360;
  const dLp = L2 - L1, dCp = c2p - c1p;
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(rad(dhp) / 2);
  const sl = 1 + (0.015 * Math.pow(avgL - 50, 2)) / Math.sqrt(20 + Math.pow(avgL - 50, 2));
  const sc = 1 + 0.045 * avgCp, sh = 1 + 0.015 * avgCp * t;
  const rt = -2 * Math.sqrt(Math.pow(avgCp, 7) / (Math.pow(avgCp, 7) + Math.pow(25, 7)))
    * Math.sin(rad(60 * Math.exp(-Math.pow((avgHp - 275) / 25, 2))));
  return Math.sqrt(Math.pow(dLp / sl, 2) + Math.pow(dCp / sc, 2) + Math.pow(dHp / sh, 2)
    + rt * (dCp / sc) * (dHp / sh));
}

/** The gate. Returns {pass, report} — run by tools/validate-palettes.mjs and
 *  by the P0 CI check, so a palette can never silently regress. */
export function validatePalettes() {
  const rows = [];
  // RAMPS are ordered families: only adjacent steps must separate (an
  // all-pairs gate on an 8-step ramp would need an impossible 150+ L* span).
  // CATEGORICAL sets are unordered, so every pair must clear the bar.
  const check = (name, colors, minDe, minSpan, kind = 'categorical') => {
    let worst = Infinity, worstPair = '';
    const pairs = kind === 'ramp'
      ? colors.slice(1).map((c, i) => [colors[i], c])
      : colors.flatMap((c, i) => colors.slice(i + 1).map(d => [c, d]));
    for (const [x, y] of pairs) {
      const d = dE76(x, y);
      if (d < worst) { worst = d; worstPair = `${x}/${y}`; }
    }
    const ls = colors.map(c => hexToLab(c)[0]);
    const span = Math.max(...ls) - Math.min(...ls);
    const pass = worst >= minDe && span >= minSpan;
    rows.push({ name, n: colors.length, minDe76: +worst.toFixed(1), worstPair,
      lStar: `${Math.min(...ls).toFixed(0)}..${Math.max(...ls).toFixed(0)}`,
      span: +span.toFixed(0), need: `dE>=${minDe} span>=${minSpan}`, pass });
    return pass;
  };
  const ok = [
    check('BG', BG, 18, 40),
    check('SKIN', SKIN_BASE, 10, 55, 'ramp'),
    check('HAIR', HAIR, 8, 55, 'ramp'),
    check('ACCENT', ACCENT, 18, 55),
  ].every(Boolean);
  return { pass: ok, report: rows };
}
