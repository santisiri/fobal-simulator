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
// KECCAK, not a convenience hash: byte-identical output is impossible
// unless JS and Solidity derive lanes the same way. The Solidity is
//   s0   = keccak256(abi.encodePacked(DOMAIN, dna, appearance))
//   lane = uint256(keccak256(abi.encodePacked(s0, TAG)))
// and this is the same computation over the same bytes.
//
// The seed excludes tokenId on purpose: the same (dna, appearance) must
// render the same player forever, wherever it is read from — which is also
// why a token can be re-rendered by a new renderer without re-identifying.
import { keccak_256 } from '@noble/hashes/sha3';

export const DOMAIN = keccak_256(new TextEncoder().encode('fobal.art.v2'));

const u256 = (v) => {
  const out = new Uint8Array(32);
  let x = BigInt(v);
  for (let i = 31; i >= 0 && x > 0n; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
};
const hexToBytes32 = (hex) => u256(BigInt(hex));
const cat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const toBig = (bytes) => bytes.reduce((a, b) => (a << 8n) | BigInt(b), 0n);

/** s0 for a player. `dna` is a 0x-prefixed 32-byte hex string and
 *  `appearance` a uint256 — exactly what FobalPlayer.playerView returns. */
export function seedOf(dna, appearance) {
  return keccak_256(cat(DOMAIN, hexToBytes32(dna), u256(appearance)));
}

const TAG = new TextEncoder();
const lane = (s0, tag) => toBig(keccak_256(cat(s0, TAG.encode(tag))));

/** Selection walks the SAME cumulative-4096 table the Solidity composer
 *  will walk (spec/weights.js), so JS and chain cannot disagree about which
 *  part a seed picks. Defining the weights in two places is precisely the
 *  drift this slice exists to remove. */
const cdfPick = (s0, tag, cls) => pickFromCum(CUM[cls], Number(lane(s0, tag) % BigInt(DENOM)));

export { assertWeights };

// ------------------------------------------------------------- traits
export function traitsOf(s0) {
  const t = {
    head:      cdfPick(s0, 'HEAD', 'head'),
    skin:      cdfPick(s0, 'SKIN', 'skin'),
    eyes:      cdfPick(s0, 'EYES', 'eyes'),
    brows:     cdfPick(s0, 'BROWS', 'brows'),
    nose:      cdfPick(s0, 'NOSE', 'nose'),
    mouth:     cdfPick(s0, 'MOUTH', 'mouth'),
    hair:      cdfPick(s0, 'HAIR', 'hair'),
    hairColor: cdfPick(s0, 'HAIRC', 'hairColor'),
    beard:     cdfPick(s0, 'BEARD', 'beard'),
    headwear:  cdfPick(s0, 'HEADWEAR', 'headwear'),
    bg:        cdfPick(s0, 'BG', 'bg'),
    accent:    cdfPick(s0, 'ACCENT', 'accent'),
    iris:      cdfPick(s0, 'IRIS', 'iris'),
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

/** P3 renders players as FREE AGENTS: the kit is derived from the seed, so
 *  the renderer needs no team lookup at all and can be proven standalone.
 *  P4 replaces this with a registry read; the face is untouched either way,
 *  which is the whole point of keeping the two composers separate. */
export function freeAgentKit(s0) {
  return {
    primary: ACCENT[Number(lane(s0, 'KIT1') % 8n)],
    secondary: ACCENT[Number(lane(s0, 'KIT2') % 8n)],
    accent: ACCENT[Number(lane(s0, 'KIT3') % 8n)],
    pattern: Number(lane(s0, 'KITP') % 7n),
  };
}

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
const emit = (rects, pal) => rects.map(([x, y, w, h, slot]) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#${pal[slot]}"/>`).join('');

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

/** @param dna 0x-prefixed 32-byte hex, @param appearance uint256 — the two
 *  immutable identity fields FobalPlayer stores at mint. */
export function renderPlayer({ dna, appearance, kit, position = 2 }) {
  const s0 = seedOf(dna, appearance);
  const t = traitsOf(s0);
  kit = kit ?? freeAgentKit(s0);
  const gkKit = { primary: 'e0c04a', secondary: '1b1b1f', accent: '1b1b1f', pattern: 0 };
  const worn = position === 0 ? gkKit : kit;
  const pal = resolvePalette(t, worn);
  const layers = [
    // every rect is emitted in the same uniform shape, including this one:
    // an attribute the reference omits is an attribute Solidity has to guess
    `<rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" fill="#${BG[t.bg]}"/>`,
    emit(kitRects(worn, SLOT.ACCENT), pal),
    emit([[13, 21, 6, 3, SLOT.SHADE]], pal),                        // neck
    emit(faceRects(t), pal),
    emit(BEARDS[t.beard].rects, pal),
    emit(HAIR[t.hair].rects, pal),
    emit(HEADWEAR[t.headwear].rects, pal),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" `
    + `shape-rendering="crispEdges" width="100%" height="100%">${layers.join('')}</svg>`;
}

export { HEADS, EYES, BROWS, NOSES, MOUTHS, BEARDS, HAIR, HEADWEAR };
