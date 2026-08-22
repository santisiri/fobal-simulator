// FOBAL art — trait engine + compositor (the reference renderer).
//
// Structured exactly as the Solidity is, so the two can be asserted
// byte-identical: derive lanes from one seed, resolve a TraitVector through
// weighted CDFs and a constraint pass, resolve a palette, then splice
// authored rects in a fixed layer order — TRANSLATED onto the anchors of the
// chosen head, which is what makes head choice restructure the whole face.
import { SKIN, HAIR as HAIR_COL, BG, ACCENT, INK, EYE_WHITE, IRIS } from '../spec/palettes.js';
import {
  CANVAS, SLOT, ANCHOR, anchorsOf, EYE_W, EAR_W,
  HEADS, SHADING, EARS, EYES, BROWS, NOSES, MOUTHS, BEARDS, HAIR, HEADWEAR, NECKS, BUILDS, COLLARS,
} from '../spec/parts.js';
import { CUM, DENOM, pickFromCum, assertWeights } from '../spec/weights.js';
import { keccak_256 } from '@noble/hashes/sha3';

// ------------------------------------------------------------------ lanes
export const DOMAIN = keccak_256(new TextEncoder().encode('fobal.art.v2'));
const u256 = (v) => {
  const out = new Uint8Array(32);
  let x = BigInt(v);
  for (let i = 31; i >= 0 && x > 0n; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
};
const cat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const toBig = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);

export function seedOf(dna, appearance) {
  return keccak_256(cat(DOMAIN, u256(BigInt(dna)), u256(appearance)));
}
const TE = new TextEncoder();
const lane = (s0, tag) => toBig(keccak_256(cat(s0, TE.encode(tag))));
const cdfPick = (s0, tag, cls) => pickFromCum(CUM[cls], Number(lane(s0, tag) % BigInt(DENOM)));
export { assertWeights };

// ------------------------------------------------------------- traits
export function traitsOf(s0) {
  const t = {
    head:      cdfPick(s0, 'HEAD', 'head'),
    skin:      cdfPick(s0, 'SKIN', 'skin'),
    ears:      cdfPick(s0, 'EARS', 'ears'),
    eyes:      cdfPick(s0, 'EYES', 'eyes'),
    brows:     cdfPick(s0, 'BROWS', 'brows'),
    nose:      cdfPick(s0, 'NOSE', 'nose'),
    hair:      cdfPick(s0, 'HAIR', 'hair'),
    hairColor: cdfPick(s0, 'HAIRC', 'hairColor'),
    beard:     cdfPick(s0, 'BEARD', 'beard'),
    headwear:  cdfPick(s0, 'HEADWEAR', 'headwear'),
    bg:        cdfPick(s0, 'BG', 'bg'),
    accent:    cdfPick(s0, 'ACCENT', 'accent'),
    iris:      cdfPick(s0, 'IRIS', 'iris'),
    build:     cdfPick(s0, 'BUILD', 'build'),
    collar:    cdfPick(s0, 'COLLAR', 'collar'),
  };

  // ---- GEOMETRY CORRELATIONS (never human-trait correlations).
  // A wide skull can carry a wide mouth; a narrow one cannot. Rather than
  // stretching geometry, the head's width class restricts which mouths are
  // eligible, and the lane chooses within that set — still deterministic.
  const eligible = mouthEligible(anchorsOf(t.head).widthClass);
  t.mouth = eligible[Number(lane(s0, 'MOUTH') % BigInt(eligible.length))];

  // Neck follows shoulders — a slim player with a thick neck reads as a bug,
  // and deriving it costs one fewer lane.
  t.neck = NECK_OF_BUILD[t.build];
  // Shading is indexed BY HEAD: each skull gets its own tonal planes.
  t.shading = t.head;

  // ---- CONSTRAINT PASS (total: every branch resolves, nothing reverts)
  const hw = HEADWEAR[t.headwear];
  const covers = hw.tags?.includes('covers');
  if (covers) t.hair = HEADWEAR_HAIR_FALLBACK[t.hair];   // deterministic, name-keyed
  if (t.hair === 0 && hw.tags?.includes('band')) t.headwear = 0;         // bald + band
  // An open mouth inside a full beard reads as a hole. Fall back to Neutral,
  // NOT Stern: Stern is 6px and would be illegal on a narrow skull, which is
  // how a constraint pass quietly undoes the compatibility rule above it.
  if (t.beard >= 6 && t.mouth === 4) t.mouth = 0;
  if (t.beard >= 6 && t.collar === 3) t.collar = 0;                      // long beard over a polo
  if (t.ears === 2 && covers) t.ears = 1;                                // hat over protruding ears
  return t;
}

/** Item 16 — the compatibility matrix, as data. A wide skull can carry a wide
 *  mouth and a narrow one cannot, so the head's width class RESTRICTS the
 *  eligible set and the lane picks within it. Never a reroll: the same seed on
 *  a narrower head lands on a defined narrower mouth, not on a different draw. */
export function mouthEligible(widthClass) {
  const maxW = widthClass === 0 ? 4 : widthClass === 1 ? 5 : 6;
  const out = [];
  for (let i = 0; i < MOUTHS.length; i++) if (MOUTHS[i].w <= maxW) out.push(i);
  return out;
}

/** Shoulders decide the neck; one fewer lane and no impossible pairings. */
export const NECK_OF_BUILD = [0, 1, 1, 2];

/** Stable fallbacks, not a reroll: a covered head keeps a RELATED silhouette
 *  instead of jumping to an unrelated one. Keyed by NAME and resolved to
 *  indices at load, so cutting a hairstyle can never silently rewire the map
 *  into pointing at whatever slid into that slot. */
export const HEADWEAR_HAIR_FALLBACK = (() => {
  const byName = Object.fromEntries(HAIR.map((h, i) => [h.name, i]));
  const PAIRS = {
    'Afro': 'Curly', 'High Top': 'Buzz', 'Flat Top': 'Buzz', 'Mohawk': 'Buzz',
    'Dreads': 'Braids', 'Long': 'Side Part', 'Ponytail': 'Topknot', 'Wavy': 'Short',
  };
  return HAIR.map((h) => {
    const target = PAIRS[h.name];
    return target === undefined ? byName[h.name] : byName[target];
  });
})();

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

export const KIT_PATTERNS = ['Solid', 'Sleeves', 'Stripes', 'Hoops', 'Halves', 'Sash', 'Chevron'];

export function freeAgentKit(s0) {
  return {
    primary: ACCENT[Number(lane(s0, 'KIT1') % 8n)],
    secondary: ACCENT[Number(lane(s0, 'KIT2') % 8n)],
    accent: ACCENT[Number(lane(s0, 'KIT3') % 8n)],
    pattern: Number(lane(s0, 'KITP') % 7n),
  };
}

/** Patterns sized for EIGHT rows: 3px stripes and 2px hoops, never 1px
 *  alternation, which is noise at 48px. Drawn inside the build's torso box. */
function kitPattern(kit, x0, w) {
  const y = 25, out = [];
  switch (kit.pattern) {
    case 1: out.push([x0, y, 3, 7, SLOT.KIT2], [x0 + w - 3, y, 3, 7, SLOT.KIT2]); break;
    case 2: for (let i = 0; i < 4; i++) out.push([x0 + 2 + i * 6, y, 3, 7, SLOT.KIT2]); break;
    case 3: out.push([x0, y + 1, w, 2, SLOT.KIT2], [x0, y + 5, w, 2, SLOT.KIT2]); break;
    case 4: out.push([x0 + (w >> 1), y, w - (w >> 1), 7, SLOT.KIT2]); break;
    case 5: for (let i = 0; i < 7; i++) out.push([x0 + 3 + i * 2, y + i, 5, 1, SLOT.KIT2]); break;
    case 6: for (let i = 0; i < 4; i++) out.push([x0 + (w >> 1) - 4 + i, y + 1 + i, 4, 1, SLOT.KIT2],
      [x0 + (w >> 1) + i, y + 1 + i, 4, 1, SLOT.KIT2]); break;
  }
  return out;
}

// -------------------------------------------------------------- compose
const emit = (rects, pal, dx = 0, dy = 0) => rects.map(([x, y, w, h, slot]) =>
  `<rect x="${x + dx}" y="${y + dy}" width="${w}" height="${h}" fill="#${pal[slot]}"/>`).join('');

/** Place a class's part using its declared anchor, mirroring where required. */
function place(className, part, a, pal) {
  const cfg = ANCHOR[className];
  const rects = part.rects ?? [];
  if (!rects.length) return '';
  switch (cfg.at) {
    case 'absolute': return emit(rects, pal);
    case 'eyes':     return emit(rects, pal, a.leftEyeX, a.eyeY)
                          + emit(mirror(rects, EYE_W), pal, a.rightEyeX, a.eyeY);
    case 'brows':    return emit(rects, pal, a.leftEyeX, a.browY)
                          + emit(mirror(rects, EYE_W), pal, a.rightEyeX, a.browY);
    case 'ears':     return emit(rects, pal, a.earLeftX, a.earY)
                          + emit(mirror(rects, EAR_W), pal, a.earRightX, a.earY);
    case 'nose':     return emit(rects, pal, a.noseX, a.noseY);
    case 'mouth':    return emit(rects, pal, a.noseX, a.mouthY);
    case 'chin':     return emit(rects, pal, a.noseX, a.chinY);
    case 'top':      return emit(clampToSkull(rects, a), pal, a.noseX, a.top);
    default:         return emit(rects, pal);
  }
}

/** Right-hand parts are the LEFT art reflected inside a box of the class's
 *  own width — so an angled brow pair converges and the right ear faces out,
 *  from one stored copy. */
const mirror = (rects, boxW) => rects.map(([x, y, w, h, s]) => [boxW - x - w, y, w, h, s]);

/** Item 11 — hair follows head geometry. Hair is authored against the WIDEST
 *  skull; on a narrow one the overhang would be 25% of the head. Clipping to
 *  the skull ±2 makes one authored cap fit six heads. Rects that vanish are
 *  dropped, which is why a zero-width rect can never reach the SVG. */
function clampToSkull(rects, a) {
  const lo = a.headX - a.noseX - 2, hi = a.headX + a.headW - a.noseX + 2;   // local space
  const out = [];
  for (const [x, y, w, h, s] of rects) {
    const x0 = x < lo ? lo : x, x1 = x + w > hi ? hi : x + w;
    if (x1 > x0) out.push([x0, y, x1 - x0, h, s]);
  }
  return out;
}

/** THE FACE COMPOSER — takes no kit parameter, by design. */
export function faceLayers(t, pal) {
  const a = anchorsOf(t.head);
  return [
    place('HEADS', HEADS[t.head], a, pal),
    place('SHADING', SHADING[t.shading], a, pal),
    place('EARS', EARS[t.ears], a, pal),
    place('NOSES', NOSES[t.nose], a, pal),
    place('EYES', EYES[t.eyes], a, pal),
    place('BROWS', BROWS[t.brows], a, pal),
    place('MOUTHS', MOUTHS[t.mouth], a, pal),
    place('BEARDS', BEARDS[t.beard], a, pal),
    place('HAIR', HAIR[t.hair], a, pal),
    place('HEADWEAR', HEADWEAR[t.headwear], a, pal),
  ].join('');
}

export function renderPlayer({ dna, appearance, kit, position = 2 }) {
  const s0 = seedOf(dna, appearance);
  const t = traitsOf(s0);
  kit = kit ?? freeAgentKit(s0);
  if (position === 0) kit = { primary: 'e0c04a', secondary: '1b1b1f', accent: '1b1b1f', pattern: 0 };
  const pal = resolvePalette(t, kit);
  const a = anchorsOf(t.head);
  const build = BUILDS[t.build];
  const torso = build.rects[1];               // [x, y, w, h, KIT1]
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" `
    + `shape-rendering="crispEdges" width="100%" height="100%">`
    + `<rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" fill="#${BG[t.bg]}"/>`
    + emit(build.rects, pal)
    + emit(kitPattern(kit, torso[0], torso[2]), pal)
    + emit(NECKS[t.neck].rects, pal)
    + emit(COLLARS[t.collar].rects, pal)
    + faceLayers(t, pal)
    + `</svg>`;
}

export { HEADS, SHADING, EARS, EYES, BROWS, NOSES, MOUTHS, BEARDS, HAIR, HEADWEAR, NECKS, BUILDS, COLLARS, anchorsOf };

/** Debug only (contact sheets): force a head index to prove the anchor system. */
export function renderPlayerWithHead({ dna, appearance, kit }, headIndex) {
  const s0 = seedOf(dna, appearance);
  const t = traitsOf(s0); t.head = headIndex; t.shading = headIndex;
  const pal = resolvePalette(t, kit ?? freeAgentKit(s0));
  const build = BUILDS[t.build], torso = build.rects[1];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" shape-rendering="crispEdges" width="100%" height="100%">`
    + `<rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" fill="#${BG[t.bg]}"/>`
    + emit(build.rects, pal) + emit(kitPattern(kit ?? freeAgentKit(s0), torso[0], torso[2]), pal)
    + emit(NECKS[t.neck].rects, pal) + emit(COLLARS[t.collar].rects, pal)
    + faceLayers(t, pal) + `</svg>`;
}
