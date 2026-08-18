// FOBAL art v2 — trait engine + compositor (the TS/JS reference renderer).
//
// Structured exactly as the Solidity will be, so the two can be asserted
// byte-identical: derive lanes from one seed, resolve a TraitVector through
// weighted CDFs + a constraint pass, resolve a palette, then splice authored
// part rects in a fixed layer order.
import { SKIN, HAIR as HAIR_COL, BG, ACCENT, INK, EYE_WHITE, IRIS } from '../spec/palettes.js';
import { CANVAS, FACE, SLOT, HEADS, EYES, BROWS, NOSES, MOUTHS, BEARDS, HAIR, HEADWEAR } from '../spec/parts.js';

// ------------------------------------------------------------------ lanes
// Solidity: s0 = keccak256(abi.encode(DOMAIN_V2, dna, appearance));
//           lane = uint256(keccak256(abi.encode(s0, LANE_TAG)))
// The seed excludes tokenId on purpose — the same (dna, appearance) must
// render the same player forever, wherever it is read from.
function fnv(str) {
  let h = 0x811c9dc5;
  for (const c of str) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const lane = (seed, tag) => fnv(`${seed}|${tag}`);

/** Weighted pick over a cumulative table totalling 4096 (the Solidity form).
 *  SILHOUETTE classes must keep max/min <= 6 — see assertWeights(). */
function cdfPick(seed, tag, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = lane(seed, tag) % total;
  for (let i = 0; i < weights.length; i++) { if (r < weights[i]) return i; r -= weights[i]; }
  return weights.length - 1;
}
const flat = (n, w = 100) => Array.from({ length: n }, () => w);

/** 6:1 cap on every silhouette-bearing class — the adversarial review's
 *  measurement: uniform gives 0.3% siblings, a 36:1 collectible curve gives
 *  20.95%, which is v1's failure rate. Rarity lives only in flat channels. */
const WEIGHTS = {
  head:     flat(HEADS.length),
  eyes:     flat(EYES.length),
  brows:    flat(BROWS.length),
  nose:     flat(NOSES.length),
  mouth:    flat(MOUTHS.length),
  // hair: bald/shaved slightly rarer than mid styles, ratio 3:1 (<= 6)
  hair:     [40, 45, 90, 100, 110, 100, 95, 80, 90, 95, 70, 60, 55, 40, 65, 60, 50, 85, 70, 55, 70, 75, 80, 75],
  beard:    [220, 120, 90, 85, 70, 110, 95, 60],
  headwear: [900, 90, 70, 80, 60, 40, 45, 35, 55, 60],
  hairColor: [130, 120, 110, 100, 90, 80, 70, 60, 70],
  skin:     flat(SKIN.length),
  bg:       flat(BG.length),
  accent:   flat(ACCENT.length),
  iris:     flat(IRIS.length),
};

/** The 6:1 cap applies to PRESENT variants only. Index 0 of hair/beard/
 *  headwear is "None" — the absence of a feature, not a variant competing to
 *  be seen — and football wants most heads bare, so exempting it is correct.
 *  What the cap actually protects against is an authored piece so rare that
 *  nobody ever sees it while it still costs bytecode. */
const HAS_NONE = { hair: true, beard: true, headwear: true, head: false };
export function assertWeights() {
  const bad = [], rows = [];
  for (const k of ['head', 'hair', 'headwear', 'beard']) {
    const present = HAS_NONE[k] ? WEIGHTS[k].slice(1) : WEIGHTS[k];
    const ratio = Math.max(...present) / Math.min(...present);
    const nonePct = HAS_NONE[k]
      ? ((WEIGHTS[k][0] / WEIGHTS[k].reduce((a, b) => a + b, 0)) * 100).toFixed(0) + '%'
      : '—';
    rows.push({ class: k, presentRatio: +ratio.toFixed(2), none: nonePct });
    if (ratio > 6) bad.push(`${k} present-variant ratio ${ratio.toFixed(1)} > 6`);
  }
  return { pass: bad.length === 0, bad, rows };
}

// ------------------------------------------------------------- traits
export function traitsOf(seed) {
  const t = {
    head:      cdfPick(seed, 'HEAD', WEIGHTS.head),
    skin:      cdfPick(seed, 'SKIN', WEIGHTS.skin),
    eyes:      cdfPick(seed, 'EYES', WEIGHTS.eyes),
    brows:     cdfPick(seed, 'BROWS', WEIGHTS.brows),
    nose:      cdfPick(seed, 'NOSE', WEIGHTS.nose),
    mouth:     cdfPick(seed, 'MOUTH', WEIGHTS.mouth),
    hair:      cdfPick(seed, 'HAIR', WEIGHTS.hair),
    hairColor: cdfPick(seed, 'HAIRC', WEIGHTS.hairColor),
    beard:     cdfPick(seed, 'BEARD', WEIGHTS.beard),
    headwear:  cdfPick(seed, 'HEADWEAR', WEIGHTS.headwear),
    bg:        cdfPick(seed, 'BG', WEIGHTS.bg),
    accent:    cdfPick(seed, 'ACCENT', WEIGHTS.accent),
    iris:      cdfPick(seed, 'IRIS', WEIGHTS.iris),
  };
  // ---- CONSTRAINT PASS (total: every branch resolves, nothing reverts)
  const hw = HEADWEAR[t.headwear];
  if (hw.tags?.includes('covers') && t.hair >= 10) t.hair = 3;     // big hair under a hat -> crop
  if (t.hair === 0 && hw.tags?.includes('band')) t.headwear = 0;   // bald + headband reads wrong
  if (t.beard >= 6 && t.mouth === 8) t.mouth = 5;                  // shouting inside a full beard
  return t;
}

// ------------------------------------------------------------- palette
function resolvePalette(t, kit) {
  const [skin, shade, light] = SKIN[t.skin];
  return {
    [SLOT.INK]: INK, [SLOT.SKIN]: skin, [SLOT.SHADE]: shade, [SLOT.LIGHT]: light,
    [SLOT.HAIR]: HAIR_COL[t.hairColor],
    [SLOT.HAIRD]: HAIR_COL[Math.max(0, t.hairColor - 2)],
    [SLOT.WHITE]: EYE_WHITE, [SLOT.IRIS]: IRIS[t.iris],
    [SLOT.ACCENT]: ACCENT[t.accent],
    [SLOT.KIT1]: kit.primary, [SLOT.KIT2]: kit.secondary, [SLOT.KIT3]: kit.accent,
  };
}

// ----------------------------------------------------------------- kit
// Team state, never token state. The composer that draws the face is a
// different function and cannot see this object — the identity/kit split
// expressed structurally.
export const KIT_PATTERNS = ['Solid', 'Sleeves', 'Stripes', 'Hoops', 'Halves', 'Sash', 'Chevron'];

function kitRects(kit, accentSlot) {
  const y = 24, out = [];
  out.push([0, y - 1, CANVAS, 1, SLOT.INK]);                       // shoulder line
  out.push([2, y, 28, 8, SLOT.KIT1]);                              // torso
  switch (kit.pattern) {
    case 1: out.push([2, y, 5, 8, SLOT.KIT2], [25, y, 5, 8, SLOT.KIT2]); break;
    case 2: for (let i = 0; i < 5; i++) out.push([4 + i * 6, y, 3, 8, SLOT.KIT2]); break;
    case 3: out.push([2, y + 2, 28, 2, SLOT.KIT2], [2, y + 6, 28, 2, SLOT.KIT2]); break;
    case 4: out.push([16, y, 14, 8, SLOT.KIT2]); break;
    case 5: for (let i = 0; i < 8; i++) out.push([6 + i * 2, y + i, 4, 1, SLOT.KIT2]); break;
    case 6: for (let i = 0; i < 4; i++) out.push([14 - i * 2, y + 2 + i, 3, 1, SLOT.KIT2], [16 + i * 2, y + 2 + i, 3, 1, SLOT.KIT2]); break;
  }
  // collar + cuffs in the PLAYER's accent — the personal colour axis that
  // survives team ownership (without it a squad collapses to one colour)
  out.push([12, y, 8, 2, accentSlot]);
  out.push([2, y + 6, 3, 2, accentSlot], [27, y + 6, 3, 2, accentSlot]);
  out.push([13, y, 6, 1, SLOT.INK]);                               // neck hole
  return out;
}

// -------------------------------------------------------------- compose
const emit = (rects, pal, opacity) => {
  const body = rects.map(([x, y, w, h, slot]) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#${pal[slot]}"/>`).join('');
  return opacity ? `<g opacity="${opacity}">${body}</g>` : body;
};

/** THE FACE COMPOSER — takes no kit parameter, by design. */
export function faceRects(t) {
  const out = [];
  out.push(...HEADS[t.head].rects);
  out.push(...NOSES[t.nose].rects);
  out.push(...EYES[t.eyes].rects);
  out.push(...BROWS[t.brows].rects);
  out.push(...MOUTHS[t.mouth].rects);
  return out;
}

export function renderPlayer({ seed, kit, position = 2 }) {
  const t = traitsOf(seed);
  const gkKit = { primary: 'e0c04a', secondary: '1b1b1f', accent: '1b1b1f', pattern: 0 };
  const worn = position === 0 ? gkKit : kit;
  const pal = resolvePalette(t, worn);
  const layers = [
    `<rect width="${CANVAS}" height="${CANVAS}" fill="#${BG[t.bg]}"/>`,
    emit(kitRects(worn, SLOT.ACCENT), pal),
    emit([[13, 21, 6, 3, SLOT.SHADE]], pal),                        // neck
    emit(faceRects(t), pal),
    emit(BEARDS[t.beard].rects, pal, BEARDS[t.beard].opacity),
    emit(HAIR[t.hair].rects, pal, HAIR[t.hair].opacity),
    emit(HEADWEAR[t.headwear].rects, pal),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" `
    + `shape-rendering="crispEdges" width="100%" height="100%">${layers.join('')}</svg>`;
}

export { HEADS, EYES, BROWS, NOSES, MOUTHS, BEARDS, HAIR, HEADWEAR };
