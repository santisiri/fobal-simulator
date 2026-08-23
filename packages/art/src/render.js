// FOBAL art — trait engine + compositor (the reference renderer).
//
// Structured exactly as the Solidity is, so the two can be asserted
// byte-identical: derive lanes from one seed, resolve a TraitVector through
// weighted CDFs and a constraint pass, resolve a palette, then splice
// authored rects in a fixed layer order — TRANSLATED onto the anchors of the
// chosen head, which is what makes head choice restructure the whole face.
import { SKIN, HAIR as HAIR_COL, BG, ACCENT, INK, EYE_WHITE, IRIS, KEEPER_KIT } from '../spec/palettes.js';
import {
  CANVAS, SLOT, ANCHOR, anchorsOf, EYE_W, EAR_W,
  HEADS, SHADING, EARS, EYES, BROWS, NOSES, MOUTHS, BEARDS, HAIR, HEADWEAR, NECKS, BUILDS, COLLARS,
} from '../spec/parts.js';
import { CUM, DENOM, MOUTH_ELIG, MOUTH_CUM, pickFromCum, assertWeights } from '../spec/weights.js';
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
  const wc = anchorsOf(t.head).widthClass;
  const eligible = mouthEligible(wc);
  t.mouth = eligible[pickFromCum(mouthCum(wc), Number(lane(s0, 'MOUTH') % BigInt(DENOM)))];

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
 *  eligible set and the lane picks within it — by RARITY, not uniformly, so
 *  the mouth weights are actually wired to something. Never a reroll: the same
 *  seed on a narrower head lands on a defined narrower mouth, not a different
 *  draw. Both tables are generated (spec/weights.js). */
export const mouthEligible = (widthClass) => MOUTH_ELIG[widthClass];
export const mouthCum = (widthClass) => MOUTH_CUM[widthClass];

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

/** @param position 0 = goalkeeper. A CLUB kit always wins over this — the
 *  keeper colours are a fallback for a player nobody has registered, not an
 *  override that repaints a club's own registered keeper strip. */
export function freeAgentKit(s0, position = 2) {
  if (position === 0) return { ...KEEPER_KIT };
  return {
    primary: ACCENT[Number(lane(s0, 'KIT1') % 8n)],
    secondary: ACCENT[Number(lane(s0, 'KIT2') % 8n)],
    accent: ACCENT[Number(lane(s0, 'KIT3') % 8n)],
    pattern: Number(lane(s0, 'KITP') % 7n),
  };
}

/** Patterns sized for EIGHT rows: 3px stripes and 2px hoops, never 1px
 *  alternation, which is noise at 48px.
 *
 *  Counts and offsets are DERIVED FROM THE TORSO WIDTH, not fixed. Four
 *  stripes at a 6px pitch assume a wide torso; on the Slim build the fourth
 *  landed three pixels clear of the shoulder, as a detached block of kit
 *  colour floating on the background. The byte-parity harness could not see
 *  it, because both renderers were equally wrong — which is why
 *  assertKitFits() below enumerates all 28 (build, pattern) pairs instead. */
function kitPattern(kit, x0, w) {
  const y = 25, out = [];
  const half = w >> 1;
  switch (kit.pattern) {
    case 1: out.push([x0, y, 3, 7, SLOT.KIT2], [x0 + w - 3, y, 3, 7, SLOT.KIT2]); break;
    case 2: {
      // as many WHOLE 3px stripes at a 6px pitch as the torso holds, centred
      const n = Math.floor(w / 6), off = (w - (6 * n - 3)) >> 1;
      for (let i = 0; i < n; i++) out.push([x0 + off + i * 6, y, 3, 7, SLOT.KIT2]);
      break;
    }
    case 3: out.push([x0, y + 1, w, 2, SLOT.KIT2], [x0, y + 5, w, 2, SLOT.KIT2]); break;
    case 4: out.push([x0 + half, y, w - half, 7, SLOT.KIT2]); break;
    case 5: {
      // the sash spans 12 columns of travel plus its own 5px width; start it
      // so the LAST row still lands on the shirt
      const start = w >= 17 ? (w - 17) >> 1 : 0;
      for (let i = 0; i < 7; i++) out.push([x0 + start + i * 2, y + i, 5, 1, SLOT.KIT2]);
      break;
    }
    case 6: for (let i = 0; i < 4; i++) out.push([x0 + half - 4 + i, y + 1 + i, 4, 1, SLOT.KIT2],
      [x0 + half + i, y + 1 + i, 4, 1, SLOT.KIT2]); break;
  }
  return out;
}

/** GATE. A head's shading mask must never paint outside that head. Sizing the
 *  under-chin shadow from its own guess at the jaw taper put two skin-shade
 *  pixels on the background below the sharpest jaw, so the chin appeared to
 *  flare outward instead of tapering. Both now read one jaw formula. */
export function assertShadingInsideHead() {
  const bad = [];
  for (let h = 0; h < HEADS.length; h++) {
    const inHead = new Set();
    for (const [x, y, w, ht] of HEADS[h].rects) {
      for (let j = y; j < y + ht; j++) for (let i = x; i < x + w; i++) inHead.add(j * 64 + i);
    }
    for (const [x, y, w, ht] of SHADING[h].rects) {
      for (let j = y; j < y + ht; j++) for (let i = x; i < x + w; i++) {
        if (!inHead.has(j * 64 + i)) bad.push(`${HEADS[h].name}: shading pixel (${i},${j}) is outside the skull`);
      }
    }
  }
  return { pass: bad.length === 0, bad };
}

/** GATE. Every pattern, on every build, must paint inside its own torso —
 *  exhaustive over all 28 pairs, so it is a proof rather than a sample. */
export function assertKitFits() {
  const bad = [];
  BUILDS.forEach((b, bi) => {
    const [tx, , tw] = b.rects[1];
    for (let pattern = 0; pattern < KIT_PATTERNS.length; pattern++) {
      for (const [x, , w] of kitPattern({ pattern }, tx, tw)) {
        if (x < tx || x + w > tx + tw) {
          bad.push(`${b.name} + ${KIT_PATTERNS[pattern]}: rect x${x}..${x + w - 1} leaves torso ${tx}..${tx + tw - 1}`);
        }
      }
    }
  });
  return { pass: bad.length === 0, bad };
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
    case 'top':      return emit(clampToSkull(rects, a, cfg.clamp), pal, a.noseX, a.top);
    default:         return emit(rects, pal);
  }
}

/** Right-hand parts are the LEFT art reflected inside a box of the class's
 *  own width — so an angled brow pair converges and the right ear faces out,
 *  from one stored copy. */
const mirror = (rects, boxW) => rects.map(([x, y, w, h, s]) => [boxW - x - w, y, w, h, s]);

/** Item 11 — hair follows head geometry. Caps are authored against the
 *  WIDEST skull; on a narrow one the overhang would be a quarter of the head.
 *
 *  The rule is not "clip everything to the skull". Hair that SITS ON the head
 *  is sized to it; hair that HANGS BESIDE it — a ponytail, dreadlocks, a scrum
 *  cap's ear flaps — is meant to be outside the outline, and clipping it
 *  deleted those parts entirely on the narrow skull. Ponytail collapsed onto
 *  Short, and Scrum Cap onto Keeper Cap, at a silhouette distance of zero.
 *
 *  So: a rect is clipped only if it OVERLAPS the skull. One that lies wholly
 *  outside is left alone, and lands flush against the clipped cap. Rects that
 *  clip to nothing are dropped, so a zero-width rect never reaches the SVG. */
export function clampToSkull(rects, a, margin) {
  if (!margin) return rects;
  const skullLo = a.headX - a.noseX, skullHi = a.headX + a.headW - a.noseX;
  const lo = skullLo - margin, hi = skullHi + margin;
  const out = [];
  for (const [x, y, w, h, s] of rects) {
    if (x + w <= skullLo || x >= skullHi) { out.push([x, y, w, h, s]); continue; }  // hangs free
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
  kit = kit ?? freeAgentKit(s0, position);
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

// ==================================================== SQUAD CONFUSABILITY
// A squad is eleven players in ONE kit, so team colour does nothing to tell
// them apart. This lives beside the renderer rather than in a tool because
// the SQUAD BUILDER needs it before it picks a dna, and a second copy of the
// rule would be a second thing to keep in step.

/** rows above the collar; everything below is kit, identical across a squad */
export const FACE_ROWS = 23;
const RECT_RE = /<rect x="(-?\d+)" y="(-?\d+)" width="(\d+)" height="(\d+)" fill="#(\w+)"\/>/g;

export function rasterOf(svg) {
  const px = new Array(1024).fill('');
  for (const m of svg.matchAll(RECT_RE)) {
    const [, x, y, w, h, c] = m;
    for (let j = +y; j < +y + +h; j++) {
      for (let i = +x; i < +x + +w; i++) {
        if (i >= 0 && i < 32 && j >= 0 && j < 32) px[j * 32 + i] = c;
      }
    }
  }
  return px;
}

/** Structure with COLOUR REMOVED: render the face through a sentinel palette
 *  so each pixel carries the slot that painted it. Comparing ink alone was
 *  tried and was wrong — ink covers the outline and features but not hair or
 *  beard, the two biggest structural cues here. */
const SENTINEL = Array.from({ length: 12 }, (_, i) => 'ff00' + i.toString(16).padStart(2, '0'));
export function structureRaster({ dna, appearance }) {
  return rasterOf('<svg>' + faceLayers(traitsOf(seedOf(dna, appearance)), SENTINEL) + '</svg>');
}

const differing = (a, b) => {
  let d = 0;
  for (let k = 0; k < FACE_ROWS * CANVAS; k++) if (a[k] !== b[k]) d++;
  return d;
};

/** Thresholds from the measured distribution: colour median 277, structure
 *  median 89, each cut to roughly a third. A pair counts only when it is
 *  close on BOTH — either alone flags pairs that are plainly distinct. */
export const CONFUSABLE_COLOUR = 220;
export const CONFUSABLE_STRUCTURE = 40;

export function comparePlayers(a, b, kitA, kitB, posA = 2, posB = 2) {
  const colour = differing(
    rasterOf(renderPlayer({ ...a, kit: kitA, position: posA })),
    rasterOf(renderPlayer({ ...b, kit: kitB, position: posB })),
  );
  const structure = differing(structureRaster(a), structureRaster(b));
  return { colour, structure, confusable: colour < CONFUSABLE_COLOUR && structure < CONFUSABLE_STRUCTURE };
}

/** Every confusable pair in a lineup. `kitAt(i)` supplies the shirt, which
 *  differs for the goalkeeper. */
export function confusablePairs(ids, kitAt, positions) {
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const r = comparePlayers(ids[i], ids[j], kitAt(i), kitAt(j), positions[i], positions[j]);
      if (r.confusable) out.push({ i, j, ...r });
    }
  }
  return out;
}

/** THE MINT-TIME CHECK. Walks the lineup and, whenever a player is confusable
 *  with a teammate already placed, asks for the next candidate identity for
 *  that slot until one is clear.
 *
 *  Deterministic, not random: `rederive(index, salt)` must be a pure function,
 *  so the same club always produces the same squad and anyone can reproduce
 *  it. Re-derives the LATER player so earlier shirt numbers stay stable.
 *
 *  This belongs here and not in the renderer's output path: the renderer sees
 *  one token at a time, from an immutable hash, and cannot know about
 *  teammates. Only whoever CHOOSES the dna can fix a clash, and after the mint
 *  nobody can. */
export function dedupeSquad(ids, kitAt, positions, rederive, maxSalt = 64) {
  const out = ids.slice();
  const salts = new Array(ids.length).fill(0);
  for (let i = 1; i < out.length; i++) {
    for (let salt = 1; salt <= maxSalt; salt++) {
      let clash = false;
      for (let j = 0; j < i && !clash; j++) {
        if (comparePlayers(out[i], out[j], kitAt(i), kitAt(j), positions[i], positions[j]).confusable) clash = true;
      }
      if (!clash) break;
      out[i] = rederive(i, salt);
      salts[i] = salt;
    }
  }
  return { ids: out, salts, rerolled: salts.filter((s) => s > 0).length };
}
