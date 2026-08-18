// FOBAL art v2 — trait engine + compositor (the TS/JS reference renderer).
//
// Structured exactly as the Solidity will be, so the two can be asserted
// byte-identical: derive lanes from one seed, resolve a TraitVector through
// weighted CDFs + a constraint pass, resolve a palette, then splice authored
// part rects in a fixed layer order.
import { SKIN, HAIR as HAIR_COL, BG, ACCENT, INK, EYE_WHITE, IRIS } from '../spec/palettes.js';
import { CANVAS, FACE, SLOT, HEADS, EYES, BROWS, NOSES, MOUTHS, BEARDS, HAIR, HEADWEAR } from '../spec/parts.js';
import { CUM, DENOM, pickFromCum, assertWeights } from '../spec/weights.js';

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

/** Selection walks the SAME cumulative-4096 table the Solidity composer
 *  will walk (spec/weights.js), so JS and chain cannot disagree about which
 *  part a seed picks. Defining the weights in two places is precisely the
 *  drift this slice exists to remove. */
const cdfPick = (seed, tag, cls) => pickFromCum(CUM[cls], lane(seed, tag) % DENOM);

export { assertWeights };

// ------------------------------------------------------------- traits
export function traitsOf(seed) {
  const t = {
    head:      cdfPick(seed, 'HEAD', 'head'),
    skin:      cdfPick(seed, 'SKIN', 'skin'),
    eyes:      cdfPick(seed, 'EYES', 'eyes'),
    brows:     cdfPick(seed, 'BROWS', 'brows'),
    nose:      cdfPick(seed, 'NOSE', 'nose'),
    mouth:     cdfPick(seed, 'MOUTH', 'mouth'),
    hair:      cdfPick(seed, 'HAIR', 'hair'),
    hairColor: cdfPick(seed, 'HAIRC', 'hairColor'),
    beard:     cdfPick(seed, 'BEARD', 'beard'),
    headwear:  cdfPick(seed, 'HEADWEAR', 'headwear'),
    bg:        cdfPick(seed, 'BG', 'bg'),
    accent:    cdfPick(seed, 'ACCENT', 'accent'),
    iris:      cdfPick(seed, 'IRIS', 'iris'),
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
