// FOBAL art v2 — the authored part atlas, 32x32 bust.
//
// Every part is DATA: a list of [x, y, w, h, paletteSlot] rects. The helpers
// below are authoring convenience only — what ships is the emitted arrays,
// which tools/gen-art.mjs serialises into SSTORE2 blobs and the Solidity
// composer replays verbatim. Nothing here is computed at render time beyond
// substituting a palette slot for a hex value, so the TS reference renderer
// and the Solidity renderer can be asserted byte-identical.
//
// PALETTE SLOTS (the "sentinels"):
//   0 ink   1 skin   2 skinShade   3 skinLight   4 hair   5 hairDark
//   6 eyeWhite   7 iris   8 accent   9 kitPrimary  10 kitSecondary  11 kitAccent
export const SLOT = { INK: 0, SKIN: 1, SHADE: 2, LIGHT: 3, HAIR: 4, HAIRD: 5,
  WHITE: 6, IRIS: 7, ACCENT: 8, KIT1: 9, KIT2: 10, KIT3: 11 };

// -------------------------------------------------------------- geometry
// One canonical face box. Everything anchors to it, which is what keeps
// features from colliding across head widths.
export const CANVAS = 32;
export const FACE = { cx: 16, top: 4, bottom: 21, browY: 11, eyeY: 12, noseY: 15, mouthY: 18 };

const rect = (x, y, w, h, pal) => [x, y, w, h, pal];

/** HEADS — 6 silhouettes from width x jaw. The art critic's reallocation:
 *  head shape is the worst variety-per-byte in the system, so it gets a
 *  small, cheap, purely-geometric family and the budget goes to hair. */
const headShape = (w, taper) => {
  const x = FACE.cx - (w >> 1), h = FACE.bottom - FACE.top;
  const out = [];
  out.push(rect(x - 1, FACE.top - 1, w + 2, h - 3, SLOT.INK));       // skull outline
  out.push(rect(x, FACE.top, w, h - 4, SLOT.SKIN));                  // skull
  for (let i = 0; i < 4; i++) {                                       // jaw rows
    const inset = Math.round((i + 1) * taper);
    out.push(rect(x + inset - 1, FACE.top + h - 4 + i, w - inset * 2 + 2, 1, SLOT.INK));
    if (i < 3) out.push(rect(x + inset, FACE.top + h - 4 + i, w - inset * 2, 1, SLOT.SKIN));
  }
  out.push(rect(x, FACE.top, w, 1, SLOT.LIGHT));                      // forehead light
  out.push(rect(x + w - 2, FACE.top + 1, 2, h - 6, SLOT.SHADE));      // right plane
  out.push(rect(x - 2, FACE.top + 7, 2, 4, SLOT.INK));                // ears
  out.push(rect(x + w, FACE.top + 7, 2, 4, SLOT.INK));
  out.push(rect(x - 2, FACE.top + 8, 1, 2, SLOT.SKIN));
  out.push(rect(x + w + 1, FACE.top + 8, 1, 2, SLOT.SHADE));
  return { rects: out, w, x };
};
export const HEADS = [
  { name: 'Narrow',  ...headShape(12, 1.0) },
  { name: 'Oval',    ...headShape(14, 1.0) },
  { name: 'Round',   ...headShape(14, 0.4) },
  { name: 'Square',  ...headShape(16, 0.3) },
  { name: 'Broad',   ...headShape(16, 1.0) },
  { name: 'Angular', ...headShape(14, 1.6) },
];

// ------------------------------------------------------------------ EYES
const eyePair = (build) => {
  const out = [];
  for (const side of [-1, 1]) {
    const x = side < 0 ? FACE.cx - 6 : FACE.cx + 2;
    out.push(...build(x, FACE.eyeY, side));
  }
  return out;
};
export const EYES = [
  { name: 'Neutral',    rects: eyePair((x, y) => [rect(x, y, 4, 2, SLOT.WHITE), rect(x + 1, y, 2, 2, SLOT.IRIS)]) },
  { name: 'Narrow',     rects: eyePair((x, y) => [rect(x, y + 1, 4, 1, SLOT.WHITE), rect(x + 1, y + 1, 2, 1, SLOT.IRIS)]) },
  { name: 'Wide',       rects: eyePair((x, y) => [rect(x, y - 1, 4, 3, SLOT.WHITE), rect(x + 1, y, 2, 2, SLOT.IRIS)]) },
  { name: 'Sleepy',     rects: eyePair((x, y) => [rect(x, y + 1, 4, 1, SLOT.INK)]) },
  { name: 'Focused',    rects: eyePair((x, y, s) => [rect(x, y, 4, 2, SLOT.WHITE), rect(s < 0 ? x + 2 : x, y, 2, 2, SLOT.IRIS)]) },
  { name: 'Smiling',    rects: eyePair((x, y) => [rect(x, y + 1, 4, 1, SLOT.INK), rect(x, y, 4, 1, SLOT.SHADE)]) },
  { name: 'Intense',    rects: eyePair((x, y) => [rect(x, y, 4, 2, SLOT.WHITE), rect(x + 1, y, 2, 2, SLOT.IRIS), rect(x, y - 1, 4, 1, SLOT.INK)]) },
  { name: 'Deep-set',   rects: eyePair((x, y) => [rect(x, y, 4, 2, SLOT.SHADE), rect(x + 1, y, 2, 2, SLOT.IRIS)]) },
  { name: 'Close-set',  rects: [rect(FACE.cx - 5, FACE.eyeY, 4, 2, SLOT.WHITE), rect(FACE.cx - 4, FACE.eyeY, 2, 2, SLOT.IRIS),
    rect(FACE.cx + 1, FACE.eyeY, 4, 2, SLOT.WHITE), rect(FACE.cx + 2, FACE.eyeY, 2, 2, SLOT.IRIS)] },
  { name: 'Wide-set',   rects: [rect(FACE.cx - 7, FACE.eyeY, 4, 2, SLOT.WHITE), rect(FACE.cx - 6, FACE.eyeY, 2, 2, SLOT.IRIS),
    rect(FACE.cx + 3, FACE.eyeY, 4, 2, SLOT.WHITE), rect(FACE.cx + 4, FACE.eyeY, 2, 2, SLOT.IRIS)] },
];

// ---------------------------------------------------------------- BROWS
const browPair = (build) => {
  const out = [];
  for (const side of [-1, 1]) {
    const x = side < 0 ? FACE.cx - 6 : FACE.cx + 2;
    out.push(...build(x, FACE.browY, side));
  }
  return out;
};
export const BROWS = [
  { name: 'Straight',   rects: browPair((x, y) => [rect(x, y, 4, 1, SLOT.HAIR)]) },
  { name: 'Thick',      rects: browPair((x, y) => [rect(x, y - 1, 4, 2, SLOT.HAIR)]) },
  { name: 'Arched',     rects: browPair((x, y, s) => [rect(s < 0 ? x : x + 2, y - 1, 2, 1, SLOT.HAIR), rect(s < 0 ? x + 2 : x, y, 2, 1, SLOT.HAIR)]) },
  { name: 'Angry',      rects: browPair((x, y, s) => [rect(s < 0 ? x + 2 : x, y - 1, 2, 1, SLOT.HAIR), rect(s < 0 ? x : x + 2, y, 2, 1, SLOT.HAIR)]) },
  { name: 'Raised',     rects: browPair((x, y) => [rect(x, y - 2, 4, 1, SLOT.HAIR)]) },
  { name: 'Thin',       rects: browPair((x, y) => [rect(x + 1, y, 3, 1, SLOT.HAIR)]) },
  { name: 'Furrowed',   rects: browPair((x, y, s) => [rect(x, y, 4, 1, SLOT.HAIR), rect(s < 0 ? x + 3 : x, y + 1, 1, 1, SLOT.HAIR)]) },
  { name: 'Slit',       rects: [...browPair((x, y) => [rect(x, y - 1, 4, 2, SLOT.HAIR)]), rect(FACE.cx - 5, FACE.browY - 1, 1, 2, SLOT.SKIN)] },
];

// ---------------------------------------------------------------- NOSES
export const NOSES = [
  { name: 'Small',  rects: [rect(FACE.cx - 1, FACE.noseY, 2, 2, SLOT.SHADE)] },
  { name: 'Broad',  rects: [rect(FACE.cx - 2, FACE.noseY + 1, 4, 1, SLOT.SHADE), rect(FACE.cx - 1, FACE.noseY, 2, 1, SLOT.SHADE)] },
  { name: 'Long',   rects: [rect(FACE.cx - 1, FACE.noseY - 1, 2, 3, SLOT.SHADE)] },
];

// --------------------------------------------------------------- MOUTHS
const M = FACE.mouthY;
export const MOUTHS = [
  { name: 'Neutral',      rects: [rect(FACE.cx - 2, M, 4, 1, SLOT.INK)] },
  { name: 'Slight Smile', rects: [rect(FACE.cx - 2, M, 4, 1, SLOT.INK), rect(FACE.cx - 3, M - 1, 1, 1, SLOT.INK), rect(FACE.cx + 2, M - 1, 1, 1, SLOT.INK)] },
  { name: 'Broad Smile',  rects: [rect(FACE.cx - 3, M, 6, 2, SLOT.INK), rect(FACE.cx - 2, M, 4, 1, SLOT.WHITE)] },
  { name: 'Smirk',        rects: [rect(FACE.cx - 2, M, 4, 1, SLOT.INK), rect(FACE.cx + 2, M - 1, 1, 1, SLOT.INK)] },
  { name: 'Open',         rects: [rect(FACE.cx - 2, M - 1, 4, 3, SLOT.INK), rect(FACE.cx - 1, M, 2, 1, SLOT.WHITE)] },
  { name: 'Stern',        rects: [rect(FACE.cx - 3, M, 6, 1, SLOT.INK)] },
  { name: 'Gritted',      rects: [rect(FACE.cx - 3, M, 6, 2, SLOT.INK), rect(FACE.cx - 2, M, 4, 1, SLOT.WHITE), rect(FACE.cx, M, 1, 1, SLOT.INK)] },
  { name: 'Tired',        rects: [rect(FACE.cx - 2, M + 1, 4, 1, SLOT.INK), rect(FACE.cx - 3, M, 1, 1, SLOT.INK)] },
  { name: 'Shouting',     rects: [rect(FACE.cx - 2, M - 1, 5, 4, SLOT.INK), rect(FACE.cx - 1, M, 3, 2, SLOT.WHITE)] },
  { name: 'Pursed',       rects: [rect(FACE.cx - 1, M, 3, 1, SLOT.INK)] },
];

// ----------------------------------------------------------- FACIAL HAIR
const jawTop = FACE.bottom - 6;
export const BEARDS = [
  { name: 'None', rects: [] },
  { name: 'Stubble',    rects: [rect(FACE.cx - 6, jawTop + 1, 12, 5, SLOT.HAIRD)], opacity: 0.4 },
  { name: 'Moustache',  rects: [rect(FACE.cx - 3, M - 2, 6, 1, SLOT.HAIR)] },
  { name: 'Goatee',     rects: [rect(FACE.cx - 2, M + 2, 4, 2, SLOT.HAIR)] },
  { name: 'Chinstrap',  rects: [rect(FACE.cx - 7, jawTop, 2, 6, SLOT.HAIR), rect(FACE.cx + 5, jawTop, 2, 6, SLOT.HAIR), rect(FACE.cx - 5, FACE.bottom - 2, 10, 2, SLOT.HAIR)] },
  { name: 'Short Beard',rects: [rect(FACE.cx - 6, jawTop + 1, 12, 5, SLOT.HAIR), rect(FACE.cx - 3, M - 2, 6, 1, SLOT.HAIR)] },
  { name: 'Full Beard', rects: [rect(FACE.cx - 7, jawTop - 1, 14, 8, SLOT.HAIR), rect(FACE.cx - 3, M - 2, 6, 1, SLOT.HAIR), rect(FACE.cx - 2, M, 4, 1, SLOT.INK)] },
  { name: 'Long Beard', rects: [rect(FACE.cx - 7, jawTop - 1, 14, 9, SLOT.HAIR), rect(FACE.cx - 4, FACE.bottom + 2, 8, 3, SLOT.HAIR), rect(FACE.cx - 3, M - 2, 6, 1, SLOT.HAIR)] },
];

// ------------------------------------------------------------------ HAIR
// The single strongest identity channel, so it gets the largest family and
// the widest silhouette range — including styles that break the head outline.
const T = FACE.top;
const cap = (h, extra = []) => [rect(FACE.cx - 8, T - 1, 16, h, SLOT.HAIR), ...extra];
export const HAIR = [
  { name: 'Bald',        rects: [] },
  { name: 'Shaved',      rects: [rect(FACE.cx - 7, T - 1, 14, 3, SLOT.HAIRD)], opacity: 0.55 },
  { name: 'Buzz',        rects: cap(3) },
  { name: 'Crop',        rects: cap(4) },
  { name: 'Short',       rects: [...cap(4), rect(FACE.cx - 8, T + 3, 2, 3, SLOT.HAIR), rect(FACE.cx + 6, T + 3, 2, 3, SLOT.HAIR)] },
  { name: 'Side Part',   rects: [...cap(4), rect(FACE.cx - 8, T - 1, 7, 6, SLOT.HAIR)] },
  { name: 'Swept',       rects: [...cap(4), rect(FACE.cx + 3, T - 3, 6, 4, SLOT.HAIR)] },
  { name: 'Quiff',       rects: [...cap(3), rect(FACE.cx - 4, T - 5, 8, 4, SLOT.HAIR)] },
  { name: 'Messy',       rects: [...cap(4), rect(FACE.cx - 6, T - 4, 3, 3, SLOT.HAIR), rect(FACE.cx, T - 5, 4, 4, SLOT.HAIR), rect(FACE.cx + 5, T - 3, 3, 3, SLOT.HAIR)] },
  { name: 'Curly',       rects: [...cap(5), rect(FACE.cx - 9, T + 1, 3, 5, SLOT.HAIR), rect(FACE.cx + 6, T + 1, 3, 5, SLOT.HAIR), rect(FACE.cx - 5, T - 3, 10, 3, SLOT.HAIR)] },
  { name: 'Afro',        rects: [rect(FACE.cx - 10, T - 5, 20, 10, SLOT.HAIR), rect(FACE.cx - 11, T - 1, 3, 7, SLOT.HAIR), rect(FACE.cx + 8, T - 1, 3, 7, SLOT.HAIR)] },
  { name: 'High Top',    rects: [...cap(3), rect(FACE.cx - 6, T - 8, 12, 7, SLOT.HAIR)] },
  { name: 'Flat Top',    rects: [...cap(3), rect(FACE.cx - 7, T - 6, 14, 5, SLOT.HAIR)] },
  { name: 'Mohawk',      rects: [rect(FACE.cx - 2, T - 7, 5, 9, SLOT.HAIR), rect(FACE.cx - 7, T - 1, 14, 2, SLOT.HAIRD)] },
  { name: 'Dreads',      rects: [...cap(4), ...[0, 1, 2, 3, 4].map(i => rect(FACE.cx - 8 + i * 4, T + 3, 2, 8 + (i % 3) * 3, SLOT.HAIR))] },
  { name: 'Braids',      rects: [...cap(4), ...[0, 1, 2, 3].map(i => rect(FACE.cx - 7 + i * 4, T + 3, 2, 5, SLOT.HAIRD))] },
  { name: 'Cornrows',    rects: [...[0, 1, 2, 3, 4].map(i => rect(FACE.cx - 8 + i * 3, T - 1, 2, 6, SLOT.HAIR))] },
  { name: 'Long',        rects: [...cap(4), rect(FACE.cx - 9, T + 3, 3, 12, SLOT.HAIR), rect(FACE.cx + 6, T + 3, 3, 12, SLOT.HAIR)] },
  { name: 'Ponytail',    rects: [...cap(4), rect(FACE.cx + 7, T + 3, 3, 7, SLOT.HAIR), rect(FACE.cx + 8, T + 8, 2, 4, SLOT.HAIR)] },
  { name: 'Topknot',     rects: [...cap(4), rect(FACE.cx - 2, T - 5, 5, 4, SLOT.HAIR)] },
  { name: 'Undercut',    rects: [rect(FACE.cx - 8, T - 1, 16, 4, SLOT.HAIR), rect(FACE.cx - 8, T + 3, 16, 2, SLOT.HAIRD)] },
  { name: 'Receding',    rects: [rect(FACE.cx - 6, T - 1, 12, 3, SLOT.HAIR), rect(FACE.cx - 8, T + 1, 3, 4, SLOT.HAIR), rect(FACE.cx + 5, T + 1, 3, 4, SLOT.HAIR)] },
  { name: 'Widow Peak',  rects: [...cap(3), rect(FACE.cx - 1, T + 2, 2, 2, SLOT.HAIR)] },
  { name: 'Wavy',        rects: [...cap(4), rect(FACE.cx - 8, T - 3, 5, 3, SLOT.HAIR), rect(FACE.cx + 1, T - 3, 5, 3, SLOT.HAIR)] },
];

// -------------------------------------------------------------- HEADWEAR
// Silhouette-breaking, and deliberately a large family: the art critic's
// measurement says headwear buys more perceived diversity per byte than any
// facial feature.
export const HEADWEAR = [
  { name: 'None',        rects: [], tags: [] },
  { name: 'Headband',    rects: [rect(FACE.cx - 8, T + 2, 16, 2, SLOT.ACCENT)], tags: ['band'] },
  { name: 'Sweatband',   rects: [rect(FACE.cx - 8, T + 1, 16, 3, SLOT.ACCENT), rect(FACE.cx - 8, T + 2, 16, 1, SLOT.KIT1)], tags: ['band'] },
  { name: 'Cap',         rects: [rect(FACE.cx - 8, T - 3, 16, 5, SLOT.KIT1), rect(FACE.cx - 9, T + 1, 18, 2, SLOT.KIT1), rect(FACE.cx - 9, T + 3, 18, 1, SLOT.INK)], tags: ['covers'] },
  { name: 'Beanie',      rects: [rect(FACE.cx - 8, T - 4, 16, 7, SLOT.ACCENT), rect(FACE.cx - 8, T + 1, 16, 2, SLOT.KIT2)], tags: ['covers'] },
  { name: 'Keeper Cap',  rects: [rect(FACE.cx - 8, T - 3, 16, 4, SLOT.KIT2), rect(FACE.cx - 10, T + 1, 20, 2, SLOT.KIT2)], tags: ['covers'] },
  { name: 'Bucket Hat',  rects: [rect(FACE.cx - 7, T - 4, 14, 5, SLOT.ACCENT), rect(FACE.cx - 10, T + 1, 20, 2, SLOT.ACCENT)], tags: ['covers'] },
  { name: 'Scrum Cap',   rects: [rect(FACE.cx - 8, T - 3, 16, 8, SLOT.ACCENT), rect(FACE.cx - 8, T + 5, 2, 4, SLOT.ACCENT), rect(FACE.cx + 6, T + 5, 2, 4, SLOT.ACCENT)], tags: ['covers'] },
  { name: 'Visor',       rects: [rect(FACE.cx - 9, T + 1, 18, 2, SLOT.ACCENT), rect(FACE.cx - 9, T + 3, 18, 1, SLOT.INK)], tags: ['band'] },
  { name: 'Bandana',     rects: [rect(FACE.cx - 8, T - 1, 16, 4, SLOT.ACCENT), rect(FACE.cx + 5, T + 2, 4, 5, SLOT.ACCENT)], tags: ['covers'] },
];

export const CLASSES = { HEADS, EYES, BROWS, NOSES, MOUTHS, BEARDS, HAIR, HEADWEAR };
