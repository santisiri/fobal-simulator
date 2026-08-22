// FOBAL art — the authored part atlas, 32x32 bust.
//
// Every part is DATA: [x, y, w, h, paletteSlot] rects. What changed from the
// first version is WHERE those coordinates live:
//
//   HEADS, NECKS, BUILDS, COLLARS  absolute — they define the frame
//   everything else                LOCAL, translated onto a per-head anchor
//
// So choosing a head no longer just changes an outline: it moves the eyes,
// the brow line, the nose, the mouth, the ears and the beard with it. That
// costs ZERO extra atlas bytes, because each part is still stored once.
//
// PALETTE SLOTS:
//   0 ink  1 skin  2 skinShade  3 skinLight  4 hair  5 hairDark
//   6 eyeWhite  7 iris  8 accent  9 kitPrimary  10 kitSecondary  11 kitAccent
import { HEAD_SPECS, anchorsOf, EYE_W, EAR_W, CX, HEAD_TOP } from './anchors.js';

export const SLOT = { INK: 0, SKIN: 1, SHADE: 2, LIGHT: 3, HAIR: 4, HAIRD: 5,
  WHITE: 6, IRIS: 7, ACCENT: 8, KIT1: 9, KIT2: 10, KIT3: 11 };
export const CANVAS = 32;
export { anchorsOf, HEAD_SPECS, EYE_W, EAR_W };

/** Which anchor a class attaches to, and whether it is drawn on both sides.
 *  Generated into the Solidity constants, so the composer needs no per-part
 *  metadata in the blob itself. */
export const ANCHOR = {
  HEADS:    { at: 'absolute', mirror: false },
  SHADING:  { at: 'absolute', mirror: false },
  EARS:     { at: 'ears',     mirror: true  },
  EYES:     { at: 'eyes',     mirror: true  },
  BROWS:    { at: 'brows',    mirror: true  },
  NOSES:    { at: 'nose',     mirror: false },
  MOUTHS:   { at: 'mouth',    mirror: false },
  BEARDS:   { at: 'chin',     mirror: false },
  HAIR:     { at: 'top',      mirror: false, clamp: 2 },
  HEADWEAR: { at: 'top',      mirror: false, clamp: 2 },
  NECKS:    { at: 'absolute', mirror: false },
  BUILDS:   { at: 'absolute', mirror: false },
  COLLARS:  { at: 'absolute', mirror: false },
};

const r = (x, y, w, h, pal) => [x, y, w, h, pal];

// ============================================================ HEADS
// Absolute. Six structurally different skulls: width AND chin height AND jaw
// taper all move, so the silhouette differs before any feature is drawn.
const JAW_ROWS = 4;
/** How far row `i` of the jaw is pulled in on each side. The shading mask
 *  MUST use this too: computing the under-chin shadow from its own
 *  approximation put two skin-shade pixels outside the Tapered silhouette. */
const jawInsetAt = (spec, i) => Math.round((i + 1) * spec.jaw);
const jawWidthAt = (spec, w, i) => Math.max(2, w - jawInsetAt(spec, i) * 2);

const buildHead = (spec) => {
  const a = anchorsOf(HEAD_SPECS.indexOf(spec));
  const out = [];
  const x = a.headX, w = a.headW, top = HEAD_TOP, chin = a.chinY;
  const jawRows = JAW_ROWS;
  const flatH = chin - top - jawRows;
  out.push(r(x - 1, top - 1, w + 2, flatH + 1, SLOT.INK));      // skull outline
  out.push(r(x, top, w, flatH, SLOT.SKIN));
  for (let i = 0; i < jawRows; i++) {                            // tapering jaw
    const inset = jawInsetAt(spec, i);
    const jw = jawWidthAt(spec, w, i);
    out.push(r(x + inset - 1, top + flatH + i, jw + 2, 1, SLOT.INK));
    if (i < jawRows - 1) out.push(r(x + inset, top + flatH + i, jw, 1, SLOT.SKIN));
  }
  return out;
};
export const HEADS = HEAD_SPECS.map(s => ({ name: s.name, rects: buildHead(s) }));

// ============================================================ SHADING
// One mask per head, indexed BY HEAD — not chosen independently. Three tonal
// planes (lit forehead, shaded side, jaw/under-chin) turn a flat silhouette
// into something sculpted, which is the cheapest quality per byte available
// at this resolution.
const buildShading = (spec) => {
  const a = anchorsOf(HEAD_SPECS.indexOf(spec));
  const x = a.headX, w = a.headW, top = HEAD_TOP, chin = a.chinY;
  const out = [];
  out.push(r(x + 1, top, w - 2, 1, SLOT.LIGHT));                 // forehead plane
  out.push(r(x + w - 2, top + 1, 2, chin - top - 5, SLOT.SHADE)); // side plane
  out.push(r(x, top + 1, 1, 3, SLOT.SHADE));                     // left temple
  // Cheek hollows follow the jaw taper. At 2x3 they read as tear tracks at
  // 48px; 2x2, tucked inside the taper, reads as bone.
  const cheekY = a.eyeY + 3, cheekInset = Math.round(spec.jaw) + 1;
  out.push(r(x + cheekInset, cheekY, 2, 2, SLOT.SHADE));
  out.push(r(x + w - cheekInset - 2, cheekY, 2, 2, SLOT.SHADE));
  // The under-chin shadow belongs on the last SKIN row. Painting it on
  // chin-1 erased the ink chin outline, and sizing it from its own guess at
  // the taper pushed it OUTSIDE the silhouette on the sharpest jaw.
  const lastSkin = JAW_ROWS - 2;
  const inset = jawInsetAt(spec, lastSkin);
  const jw = jawWidthAt(spec, w, lastSkin);
  if (jw > 2) out.push(r(x + inset + 1, chin - 2, jw - 2, 1, SLOT.SHADE));
  return out;
};
export const SHADING = HEAD_SPECS.map(s => ({ name: s.name + ' shading', rects: buildShading(s) }));

// ============================================================ EARS  (local, mirrored)
// origin = (earLeftX, earY) in a 4-wide mirror box: local x=3 lands on the
// skull's first skin column, so the art at x<3 is what PROTRUDES — 1px, 2px
// and 3px respectively. Bodied in SKIN with an ink rim; an all-ink ear reads
// as a black blob at 48px, which is what the first pass shipped.
export const EARS = [
  { name: 'Small',     rects: [r(2, 1, 2, 2, SLOT.SKIN), r(1, 1, 1, 2, SLOT.INK), r(2, 2, 1, 1, SLOT.SHADE)] },
  { name: 'Normal',    rects: [r(2, 0, 2, 4, SLOT.SKIN), r(1, 1, 1, 3, SLOT.INK), r(2, 0, 2, 1, SLOT.INK), r(2, 1, 1, 2, SLOT.SHADE)] },
  { name: 'Protruding',rects: [r(1, 0, 3, 5, SLOT.SKIN), r(0, 1, 1, 3, SLOT.INK), r(1, 0, 3, 1, SLOT.INK),
                               r(1, 4, 3, 1, SLOT.INK), r(1, 1, 1, 3, SLOT.SHADE)] },
];

// ============================================================ EYES  (local, mirrored)
// origin = eye top-left. SIX structures that differ in shape, not in colour:
// ten near-identical marks were decorative, these change the face.
export const EYES = [
  { name: 'Neutral',  rects: [r(0, 0, 4, 2, SLOT.WHITE), r(1, 0, 2, 2, SLOT.IRIS), r(0, -1, 4, 1, SLOT.INK)] },
  { name: 'Deep-set', rects: [r(0, 0, 4, 2, SLOT.WHITE), r(1, 0, 2, 2, SLOT.IRIS), r(0, -1, 4, 1, SLOT.SHADE), r(0, -2, 4, 1, SLOT.SHADE)] },
  { name: 'Wide',     rects: [r(0, -1, 4, 3, SLOT.WHITE), r(1, 0, 2, 2, SLOT.IRIS), r(0, -2, 4, 1, SLOT.INK)] },
  { name: 'Narrow',   rects: [r(0, 0, 4, 1, SLOT.WHITE), r(1, 0, 2, 1, SLOT.IRIS), r(0, -1, 4, 1, SLOT.INK)] },
  { name: 'Heavy Lid',rects: [r(0, 1, 4, 1, SLOT.WHITE), r(1, 1, 2, 1, SLOT.IRIS), r(0, -1, 4, 2, SLOT.INK)] },
  { name: 'Round',    rects: [r(0, -1, 4, 3, SLOT.WHITE), r(1, -1, 2, 3, SLOT.IRIS), r(0, -2, 4, 1, SLOT.INK)] },
];

// ============================================================ BROWS (local, mirrored)
// origin = (eyeX, browY). Six, each a different expression lever.
// x=0 is the OUTER end of each brow and x=3 the inner (nose) end; the right
// brow is the mirror, so an angled pair actually converges.
export const BROWS = [
  { name: 'Flat',       rects: [r(0, 0, 4, 1, SLOT.HAIR)] },
  { name: 'Heavy',      rects: [r(0, -1, 4, 2, SLOT.HAIR)] },
  { name: 'Raised',     rects: [r(0, -1, 4, 1, SLOT.HAIR)] },
  { name: 'Angry',      rects: [r(0, 0, 2, 1, SLOT.HAIR), r(2, 1, 2, 1, SLOT.HAIR)] },
  { name: 'Arched',     rects: [r(0, 1, 1, 1, SLOT.HAIR), r(1, 0, 3, 1, SLOT.HAIR)] },
  { name: 'Thick Low',  rects: [r(0, 0, 4, 1, SLOT.HAIR), r(1, 1, 3, 1, SLOT.HAIR)] },
];

// ============================================================ NOSES (local)
// origin = (CX, noseY), x relative to centre. Structures, not marks: a bridge,
// a side shadow and a tip, so the nose reads as geometry rather than a speck.
export const NOSES = [
  { name: 'Straight',  rects: [r(-1, 0, 1, 3, SLOT.SHADE), r(-1, 3, 2, 1, SLOT.SHADE)] },
  { name: 'Short',     rects: [r(-1, 1, 1, 2, SLOT.SHADE), r(-1, 3, 2, 1, SLOT.SHADE)] },
  { name: 'Long',      rects: [r(-1, -1, 1, 5, SLOT.SHADE), r(-1, 4, 2, 1, SLOT.SHADE)] },
  { name: 'Broad Tip', rects: [r(-1, 0, 1, 3, SLOT.SHADE), r(-2, 3, 4, 1, SLOT.SHADE), r(-1, 2, 1, 1, SLOT.LIGHT)] },
  { name: 'Narrow',    rects: [r(0, 0, 1, 3, SLOT.SHADE), r(0, 3, 1, 1, SLOT.SHADE)] },
  { name: 'Hooked',    rects: [r(-1, 0, 1, 2, SLOT.SHADE), r(-1, 2, 2, 2, SLOT.SHADE)] },
  { name: 'Flat',      rects: [r(-2, 2, 4, 1, SLOT.SHADE), r(-1, 1, 1, 1, SLOT.SHADE)] },
];

// ============================================================ MOUTHS (local)
// origin = (CX, mouthY), x relative to centre. 3-6px wide; the widest are
// restricted to wide heads by the compatibility pass.
//
// The width is DERIVED from the rects, never declared. Slight and Downturned
// were hand-labelled 5 while spanning 6 columns, so the rule that keeps a wide
// mouth off a narrow skull was being handed the wrong number by its own
// metadata. Their corner pixels now sit inside the mouth line, which is what
// the label always claimed.
const MOUTH_SHAPES = [
  { name: 'Neutral',    rects: [r(-2, 0, 4, 1, SLOT.INK)] },
  { name: 'Stern',      rects: [r(-3, 0, 6, 1, SLOT.INK)] },
  { name: 'Slight',     rects: [r(-2, 0, 5, 1, SLOT.INK), r(-2, -1, 1, 1, SLOT.INK), r(2, -1, 1, 1, SLOT.INK)] },
  { name: 'Wide Smile', rects: [r(-3, 0, 6, 1, SLOT.INK), r(-2, 1, 4, 1, SLOT.INK), r(-2, 0, 4, 1, SLOT.WHITE)] },
  { name: 'Open',       rects: [r(-2, -1, 4, 3, SLOT.INK), r(-1, 0, 2, 1, SLOT.WHITE)] },
  { name: 'Downturned', rects: [r(-2, 0, 5, 1, SLOT.INK), r(-2, 1, 1, 1, SLOT.INK), r(2, 1, 1, 1, SLOT.INK)] },
  { name: 'Compressed', rects: [r(-1, 0, 3, 1, SLOT.INK), r(-1, -1, 3, 1, SLOT.SHADE)] },
];
/** the true horizontal footprint of a part, in local columns */
export const footprint = (rects) =>
  Math.max(...rects.map((q) => q[0] + q[2])) - Math.min(...rects.map((q) => q[0]));
export const MOUTHS = MOUTH_SHAPES.map((m) => ({ ...m, w: footprint(m.rects) }));

// ============================================================ BEARDS (local)
// origin = (CX, chinY). The big ones EXTEND PAST the chin, changing the
// lower-face silhouette instead of just darkening pixels inside it.
// The mouth is ALWAYS at local y = -3 (mouthY is derived as chinY - 3), so
// every beard here leaves row -3 open across the centre and builds volume
// around it: cheek panels, an upper lip, an under-lip block, and a chin mass
// that extends past the jaw on the big ones.
export const BEARDS = [
  { name: 'None',       rects: [] },
  { name: 'Stubble',    rects: [r(-6, -5, 2, 4, SLOT.HAIRD), r(4, -5, 2, 4, SLOT.HAIRD), r(-5, -2, 10, 2, SLOT.HAIRD)] },
  { name: 'Moustache',  rects: [r(-3, -4, 6, 1, SLOT.HAIR), r(-4, -4, 1, 2, SLOT.HAIR), r(3, -4, 1, 2, SLOT.HAIR)] },
  { name: 'Goatee',     rects: [r(-3, -4, 6, 1, SLOT.HAIR), r(-2, -2, 4, 3, SLOT.HAIR)] },
  { name: 'Chinstrap',  rects: [r(-7, -6, 2, 7, SLOT.HAIR), r(5, -6, 2, 7, SLOT.HAIR), r(-5, 0, 10, 1, SLOT.HAIR)] },
  { name: 'Short Beard',rects: [r(-3, -4, 6, 1, SLOT.HAIR), r(-7, -5, 2, 5, SLOT.HAIR), r(5, -5, 2, 5, SLOT.HAIR),
                                r(-5, -2, 10, 2, SLOT.HAIR), r(-4, 0, 8, 1, SLOT.HAIR)] },
  { name: 'Full Beard', rects: [r(-3, -4, 6, 1, SLOT.HAIR), r(-7, -6, 2, 6, SLOT.HAIR), r(5, -6, 2, 6, SLOT.HAIR),
                                r(-6, -2, 12, 2, SLOT.HAIR), r(-5, 0, 10, 1, SLOT.HAIR),
                                r(-4, 1, 8, 1, SLOT.HAIR), r(-3, 2, 6, 1, SLOT.HAIRD)] },
  { name: 'Long Beard', rects: [r(-3, -4, 6, 1, SLOT.HAIR), r(-7, -6, 2, 6, SLOT.HAIR), r(5, -6, 2, 6, SLOT.HAIR),
                                r(-6, -2, 12, 2, SLOT.HAIR), r(-5, 0, 10, 2, SLOT.HAIR),
                                r(-4, 2, 8, 2, SLOT.HAIR), r(-3, 4, 6, 1, SLOT.HAIR), r(-2, 5, 4, 1, SLOT.HAIRD)] },
];

// ============================================================ HAIR (local)
// origin = (CX, HEAD_TOP), x relative to centre. Authored against the WIDEST
// skull so a narrow head gets overhang (reads as volume) rather than a bald
// patch at the temples.
const cap = (h, extra = []) => [r(-9, -1, 18, h, SLOT.HAIR), ...extra];
export const HAIR = [
  { name: 'Bald',        rects: [] },
  { name: 'Buzz',        rects: cap(3) },
  { name: 'Short',       rects: [...cap(4), r(-9, 3, 2, 3, SLOT.HAIR), r(7, 3, 2, 3, SLOT.HAIR)] },
  { name: 'Side Part',   rects: [...cap(4), r(-9, -1, 7, 6, SLOT.HAIR), r(-2, 3, 1, 1, SLOT.HAIRD)] },
  { name: 'Swept',       rects: [...cap(4), r(3, -3, 7, 4, SLOT.HAIR)] },
  { name: 'Quiff',       rects: [...cap(3), r(-4, -5, 8, 4, SLOT.HAIR)] },
  { name: 'Messy',       rects: [...cap(4), r(-7, -4, 3, 3, SLOT.HAIR), r(-1, -5, 4, 4, SLOT.HAIR), r(5, -3, 3, 3, SLOT.HAIR)] },
  { name: 'Curly',       rects: [...cap(5), r(-10, 1, 3, 5, SLOT.HAIR), r(7, 1, 3, 5, SLOT.HAIR), r(-5, -3, 10, 3, SLOT.HAIR)] },
  { name: 'Afro',        rects: [r(-11, -5, 22, 10, SLOT.HAIR), r(-12, -1, 3, 7, SLOT.HAIR), r(9, -1, 3, 7, SLOT.HAIR)] },
  { name: 'High Top',    rects: [...cap(3), r(-6, -8, 12, 7, SLOT.HAIR)] },
  { name: 'Flat Top',    rects: [...cap(3), r(-8, -6, 16, 5, SLOT.HAIR)] },
  { name: 'Mohawk',      rects: [r(-2, -7, 5, 9, SLOT.HAIR), r(-8, -1, 16, 2, SLOT.HAIRD)] },
  { name: 'Dreads',      rects: [...cap(4), ...[-10, -8, 6, 8].map((x, i) => r(x, 3, 2, 7 + (i % 2) * 4, SLOT.HAIR))] },
  { name: 'Braids',      rects: [...cap(4), ...[-9, -6, 4, 7].map(x => r(x, 3, 2, 4, SLOT.HAIRD)), r(-9, 7, 2, 5, SLOT.HAIR), r(7, 7, 2, 5, SLOT.HAIR)] },
  { name: 'Cornrows',    rects: [r(-9, -1, 18, 6, SLOT.HAIRD), ...[0, 1, 2, 3, 4, 5].map(i => r(-9 + i * 3, -1, 2, 6, SLOT.HAIR))] },
  { name: 'Long',        rects: [...cap(4), r(-10, 3, 3, 13, SLOT.HAIR), r(7, 3, 3, 13, SLOT.HAIR)] },
  { name: 'Ponytail',    rects: [...cap(4), r(8, 2, 3, 9, SLOT.HAIR), r(9, 9, 3, 5, SLOT.HAIR)] },
  { name: 'Topknot',     rects: [...cap(4), r(-2, -5, 5, 4, SLOT.HAIR)] },
  { name: 'Undercut',    rects: [r(-7, -4, 14, 7, SLOT.HAIR), r(-9, 3, 18, 2, SLOT.HAIRD)] },
  { name: 'Receding',    rects: [r(-6, -1, 12, 3, SLOT.HAIR), r(-9, 1, 3, 4, SLOT.HAIR), r(6, 1, 3, 4, SLOT.HAIR)] },
  { name: 'Wavy',        rects: [...cap(4), r(-9, -3, 6, 2, SLOT.HAIR), r(-4, -4, 7, 2, SLOT.HAIR), r(2, -3, 7, 2, SLOT.HAIR)] },
];

// ============================================================ HEADWEAR (local)
// Culled to what says FOOTBALL. A bucket hat and a beanie made the collection
// read as a generic avatar set; the player should be recognisable from head,
// hair and build, with headwear as an occasional accent.
// A slab across the forehead is a hat in no sport. Each of these carries the
// ONE feature that names it: the keeper's peak, the scrum cap's ear flaps and
// stitch line, the bandana's trailing knot.
export const HEADWEAR = [
  { name: 'None',       rects: [], tags: [] },
  { name: 'Headband',   rects: [r(-9, 2, 18, 2, SLOT.ACCENT), r(-9, 3, 18, 1, SLOT.KIT3),
                                r(6, 1, 3, 4, SLOT.ACCENT)], tags: ['band'] },
  { name: 'Sweatband',  rects: [r(-9, 1, 18, 3, SLOT.ACCENT), r(-9, 2, 18, 1, SLOT.KIT1),
                                r(-2, 1, 4, 1, SLOT.KIT1)], tags: ['band'] },
  { name: 'Keeper Cap', rects: [r(-8, -3, 16, 4, SLOT.KIT2), r(-8, -3, 16, 1, SLOT.KIT3),
                                r(-10, 1, 20, 1, SLOT.KIT2), r(-9, 2, 18, 1, SLOT.KIT2),
                                r(-9, 3, 18, 1, SLOT.SHADE)], tags: ['covers'] },
  { name: 'Scrum Cap',  rects: [r(-8, -3, 16, 7, SLOT.ACCENT), r(-8, 0, 16, 1, SLOT.KIT1),
                                r(-10, 1, 2, 6, SLOT.ACCENT), r(8, 1, 2, 6, SLOT.ACCENT),
                                r(-10, 6, 2, 1, SLOT.INK), r(8, 6, 2, 1, SLOT.INK)], tags: ['covers'] },
  { name: 'Bandana',    rects: [r(-9, -1, 18, 4, SLOT.ACCENT), r(-9, 2, 18, 1, SLOT.KIT3),
                                r(7, 2, 3, 3, SLOT.ACCENT), r(9, 4, 2, 3, SLOT.ACCENT)], tags: ['covers'] },
];

// ============================================================ NECKS (absolute)
// Necks start at 19, not 21. A head's last painted row is chinY - 1, and the
// Round skull's chin is 20 — so a neck starting at 21 left row 20 as raw
// background and the head floated detached from the body. Necks are drawn
// BEFORE the head, so the extra rows are simply covered on the taller skulls.
export const NECKS = [
  { name: 'Narrow', rects: [r(14, 19, 4, 6, SLOT.SHADE), r(15, 20, 2, 5, SLOT.SKIN)] },
  { name: 'Normal', rects: [r(13, 19, 6, 6, SLOT.SHADE), r(14, 20, 4, 5, SLOT.SKIN)] },
  { name: 'Thick',  rects: [r(12, 19, 8, 6, SLOT.SHADE), r(13, 20, 6, 5, SLOT.SKIN)] },
];

// ============================================================ BUILDS (absolute)
// Shoulder masks the kit fills. The silhouette differs before a single kit
// colour is chosen, which is worth more than another ten hairstyles.
export const BUILDS = [
  { name: 'Slim',      rects: [r(6, 24, 20, 1, SLOT.INK), r(7, 25, 18, 7, SLOT.KIT1)] },
  { name: 'Normal',    rects: [r(4, 24, 24, 1, SLOT.INK), r(5, 25, 22, 7, SLOT.KIT1)] },
  { name: 'Broad',     rects: [r(2, 24, 28, 1, SLOT.INK), r(3, 25, 26, 7, SLOT.KIT1)] },
  { name: 'Very Broad',rects: [r(1, 23, 30, 1, SLOT.INK), r(2, 24, 28, 8, SLOT.KIT1)] },
];

// ============================================================ COLLARS (absolute)
// High leverage: they sit next to the face and separate neck from shirt.
export const COLLARS = [
  { name: 'Crew',      rects: [r(12, 24, 8, 2, SLOT.ACCENT), r(13, 24, 6, 1, SLOT.INK)] },
  { name: 'V-Neck',    rects: [r(12, 24, 8, 1, SLOT.ACCENT), r(13, 25, 6, 1, SLOT.ACCENT), r(14, 26, 4, 1, SLOT.INK)] },
  { name: 'Contrast V',rects: [r(11, 24, 10, 1, SLOT.KIT3), r(13, 25, 6, 2, SLOT.KIT3), r(14, 25, 4, 1, SLOT.INK)] },
  { name: 'Polo',      rects: [r(11, 24, 10, 2, SLOT.KIT3), r(13, 24, 6, 1, SLOT.INK), r(11, 26, 2, 1, SLOT.KIT3), r(19, 26, 2, 1, SLOT.KIT3)] },
];

export const CLASSES = { HEADS, SHADING, EARS, EYES, BROWS, NOSES, MOUTHS, BEARDS, HAIR, HEADWEAR, NECKS, BUILDS, COLLARS };
