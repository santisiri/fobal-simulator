// Per-head face architecture.
//
// v2's mistake: every face was drawn at the SAME coordinates regardless of
// head shape, so choosing a head changed the outline and nothing inside it.
// A wide head and a narrow head had identically-spaced eyes.
//
// Here a head carries an anchor set, and face parts are authored in LOCAL
// space and TRANSLATED onto it. That means head choice moves the whole facial
// architecture — eye spacing, brow line, nose height, mouth line, ear height
// — for ZERO extra atlas bytes, because the parts are stored once and offset
// at render time.
//
// STORED vs DERIVED (item 20): only what cannot be recomputed is stored.
// Seven small integers per head; everything else falls out of them.

export const EYE_W = 4;   // authored eye width, local space
export const EAR_W = 4;   // mirror box for ears; local x=3 sits against the skull
export const CANVAS = 32;
export const CX = 16;          // faces are centred; noseX is therefore never stored

/** w        skull width (even)
 *  bottom   chin row — long vs short faces, not just wide vs narrow
 *  jaw      taper per row toward the chin
 *  eyeY     eye top row
 *  eyeGap   pixels of skin BETWEEN the two eyes (drives spacing)
 *  mouthY   mouth row
 *  earY     ear top row  */
export const HEAD_SPECS = [
  { name: 'Oval',      w: 14, bottom: 21, jaw: 1.0, eyeY: 12, eyeGap: 3 },
  { name: 'Long',      w: 12, bottom: 22, jaw: 0.8, eyeY: 12, eyeGap: 2 },
  { name: 'Round',     w: 15, bottom: 20, jaw: 0.3, eyeY: 12, eyeGap: 4 },
  { name: 'Square',    w: 16, bottom: 21, jaw: 0.2, eyeY: 12, eyeGap: 5 },
  { name: 'Heavy Jaw', w: 16, bottom: 22, jaw: 0.0, eyeY: 11, eyeGap: 5 },
  { name: 'Tapered',   w: 15, bottom: 21, jaw: 1.6, eyeY: 11, eyeGap: 4 },
];

export const HEAD_TOP = 4;

/** Everything a face part needs to place itself. Derived values are computed
 *  identically in Solidity — no stored redundancy, no divergence. */
export function anchorsOf(headIndex) {
  const h = HEAD_SPECS[headIndex];
  const x = CX - (h.w >> 1);
  const gapHalf = h.eyeGap >> 1;
  return {
    name: h.name,
    headX: x,
    headW: h.w,
    top: HEAD_TOP,
    bottom: h.bottom,
    jaw: h.jaw,
    // eyes sit symmetrically about the centre, separated by eyeGap
    leftEyeX: CX - gapHalf - EYE_W,
    rightEyeX: CX + gapHalf + (h.eyeGap & 1),
    eyeY: h.eyeY,
    browY: h.eyeY - 3,                    // derived: leaves one skin row
                                          // between brow and lid, so a heavy brow
                                          // does not fuse into the eye
    noseX: CX,                            // derived: faces are centred
    noseY: h.eyeY + 2,                    // derived
    // DERIVED, not stored: pinning the mouth three rows above the chin is what
    // lets one authored beard fit all six skulls without covering the mouth.
    mouthY: h.bottom - 3,
    chinY: h.bottom,
    earY: h.eyeY,                         // derived: ears align with the eye line
    earLeftX: x - 3,
    earRightX: x + h.w - 1,
    hairlineY: HEAD_TOP,                  // derived
    // a wide head can carry a wider mouth; a narrow one cannot. Used to BIAS
    // variant selection rather than to stretch geometry (item 17: correlate
    // on geometry, never on human traits).
    widthClass: h.w <= 12 ? 0 : h.w <= 14 ? 1 : 2,
  };
}
