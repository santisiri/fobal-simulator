// A squad is the hardest case the product actually shows: ELEVEN players,
// side by side, in ONE kit. Team colour does no work at all, so every bit of
// telling-apart has to come from the player. The 100-player sheets never test
// this — they measure a population, not a lineup.
//
// The metric is deliberately blunt: rasterise each player to 32x32, throw away
// the kit rows (identical across a squad by definition), and count differing
// pixels between every pair of teammates. The number that matters is the
// WORST pair in a squad, because that is the pair a viewer confuses.
import { renderPlayer, faceLayers, traitsOf, seedOf } from '../src/render.js';
import { keccak_256 } from '@noble/hashes/sha3';

const RE = /<rect x="(-?\d+)" y="(-?\d+)" width="(\d+)" height="(\d+)" fill="#(\w+)"\/>/g;
/** rows 0..22 — head, hair, face and neck. Rows 23+ are kit and identical. */
export const FACE_ROWS = 23;

export function raster(svg) {
  const px = new Array(1024).fill('');
  for (const m of svg.matchAll(RE)) {
    const [, x, y, w, h, c] = m;
    for (let j = +y; j < +y + +h; j++) {
      for (let i = +x; i < +x + +w; i++) {
        if (i >= 0 && i < 32 && j >= 0 && j < 32) px[j * 32 + i] = c;
      }
    }
  }
  return px;
}

/** differing pixels above the collar */
export function faceDistance(a, b) {
  let d = 0;
  for (let k = 0; k < FACE_ROWS * 32; k++) if (a[k] !== b[k]) d++;
  return d;
}

/** STRUCTURAL raster: every pixel carries the palette SLOT that painted it,
 *  not the colour. Colour distance alone rewards a different skin tone on an
 *  identical face, which is not what stops a viewer confusing two teammates —
 *  so this strips colour and compares construction.
 *
 *  An earlier attempt compared only INK pixels. That was wrong and said so
 *  loudly: it scored two players 3px apart who differ in hair, brows, nose,
 *  mouth and colouring, because ink covers the outline and features but NOT
 *  hair or beard — the two biggest structural cues in the system. Rendering
 *  through a sentinel palette catches every layer. */
const SENTINEL = Array.from({ length: 12 }, (_, i) => 'ff00' + i.toString(16).padStart(2, '0'));

export function slotRaster(id, position) {
  const t = traitsOf(seedOf(id.dna, id.appearance));
  return raster('<svg>' + faceLayers(t, SENTINEL) + '</svg>');
}

export function structureDistance(a, b) {
  let d = 0;
  for (let k = 0; k < FACE_ROWS * 32; k++) if (a[k] !== b[k]) d++;
  return d;
}

/** The app's own derivation, copied so the audit measures what SHIPS.
 *  A 32-bit hash repeated eight times to fill 256 bits, with appearance taken
 *  from the low word of that same value. */
export function appSquadIds(clubName, size = 11) {
  const out = [];
  for (let i = 0; i < size; i++) {
    const dna = '0x' + [...`${clubName}:${i}:fobal`]
      .reduce((h, c) => ((h * 131 + c.charCodeAt(0)) >>> 0), 7)
      .toString(16).padStart(8, '0').repeat(8);
    out.push({ dna, appearance: BigInt(dna) & 0xffffffffn });
  }
  return out;
}

/** A full-entropy control: what a squad looks like when identities come from
 *  keccak rather than a repeated 32-bit word. */
export function keccakSquadIds(clubName, size = 11) {
  const out = [];
  for (let i = 0; i < size; i++) {
    const b = keccak_256(new TextEncoder().encode(`${clubName}:${i}:fobal`));
    const dna = '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    out.push({ dna, appearance: (BigInt(dna) >> 96n) & 0xffffffffn });
  }
  return out;
}


/** Render a squad in ONE kit and report its worst pair. */
export function auditSquad(ids, kit) {
  const rasters = ids.map((id, i) =>
    raster(renderPlayer({ ...id, kit: kitFor(kit, i), position: POSITIONS[i % POSITIONS.length] })));
  const slots = ids.map((id, i) => slotRaster(id, POSITIONS[i % POSITIONS.length]));
  let worst = Infinity, pair = null, worstInk = Infinity, inkPair = null;
  const dists = [];
  for (let i = 0; i < rasters.length; i++) {
    for (let j = i + 1; j < rasters.length; j++) {
      const d = faceDistance(rasters[i], rasters[j]);
      dists.push(d);
      if (d < worst) { worst = d; pair = [i, j]; }
      const k = structureDistance(slots[i], slots[j]);
      if (k < worstInk) { worstInk = k; inkPair = [i, j]; }
    }
  }
  dists.sort((a, b) => a - b);
  return { worst, pair, worstInk, inkPair, median: dists[dists.length >> 1], pairs: dists.length };
}

export const POSITIONS = [0, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3];

// Each club carries a KEEPER strip as well as an outfield one, because
// FobalKitRegistry.kitFor(teamId, position) is position-aware on chain — a
// sheet that dressed the goalkeeper like the other ten would be showing
// something the contract does not oblige anyone to do, and no football team
// has ever done.
export const CLUBS = [
  { name: 'Sky City FC',   primary: '2f6fd0', secondary: 'f2f4f8', accent: 'f2f4f8', pattern: 2,
    gk: { primary: '2f8f4e', secondary: '1b1b1f', accent: 'f2f4f8', pattern: 0 } },
  { name: 'Red Bulls FC',  primary: 'c8322b', secondary: '1b1b1f', accent: 'f2f4f8', pattern: 1,
    gk: { primary: 'e0a02a', secondary: '1b1b1f', accent: '1b1b1f', pattern: 0 } },
  { name: 'Golden United', primary: 'e0b024', secondary: '1b1b1f', accent: '1b1b1f', pattern: 3,
    gk: { primary: '8a5cf6', secondary: 'f2f4f8', accent: 'f2f4f8', pattern: 0 } },
  { name: 'Violet Town',   primary: '7b46c4', secondary: 'f2f4f8', accent: 'e0b024', pattern: 5,
    gk: { primary: 'e8712f', secondary: '1b1b1f', accent: '1b1b1f', pattern: 0 } },
  { name: 'Pine Rovers',   primary: '1f7a4d', secondary: 'f2f4f8', accent: 'f2f4f8', pattern: 4,
    gk: { primary: 'd8342c', secondary: 'e8e2d4', accent: 'e8e2d4', pattern: 0 } },
  { name: 'Iron Harbour',  primary: '2b3038', secondary: 'e8712f', accent: 'e8712f', pattern: 6,
    gk: { primary: '2f6fd0', secondary: 'e8e2d4', accent: 'e8e2d4', pattern: 0 } },
];

/** what shirt this squad member actually wears — the keeper's is different */
export const kitFor = (club, i) => (POSITIONS[i % POSITIONS.length] === 0 && club.gk ? club.gk : club);

/** A pair is CONFUSABLE only when it is close on BOTH axes. Either alone is
 *  a bad test: two players built identically but coloured differently are
 *  easy to tell apart, and so are two with the same colouring and different
 *  hair. Thresholds come from the measured distribution — colour median 277,
 *  structure median 89 — at roughly a third of each.
 *
 *  Note what this CANNOT be: an invariant. The renderer sees one token at a
 *  time, derived from an immutable hash, and knows nothing about teammates.
 *  The rate is a property of the trait space, so the gate holds the RATE
 *  rather than demanding zero — a change that makes squads meaningfully worse
 *  fails, and pushing it lower needs either more variety or a check at mint
 *  time, which is a product decision and not the renderer's to make. */
export const CONFUSABLE_COLOUR = 220;
export const CONFUSABLE_STRUCTURE = 40;

export function confusablePairs(ids, kit) {
  const colour = ids.map((id, i) =>
    raster(renderPlayer({ ...id, kit: kitFor(kit, i), position: POSITIONS[i % POSITIONS.length] })));
  const structure = ids.map((id, i) => slotRaster(id, POSITIONS[i % POSITIONS.length]));
  const found = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const c = faceDistance(colour[i], colour[j]);
      const st = structureDistance(structure[i], structure[j]);
      if (c < CONFUSABLE_COLOUR && st < CONFUSABLE_STRUCTURE) found.push({ i, j, colour: c, structure: st });
    }
  }
  return found;
}

/** the fixed panel the gate measures, so the rate is comparable run to run */
export const GATE_CLUBS = Array.from({ length: 400 }, (_, i) => `Club ${i}`);

/** GATE. */
export function assertSquadsLegible(clubNames = GATE_CLUBS, maxRate = 0.015, derive = appSquadIds) {
  let squadsWithPair = 0;
  const examples = [];
  clubNames.forEach((name, i) => {
    const found = confusablePairs(derive(name), CLUBS[i % CLUBS.length]);
    if (found.length) {
      squadsWithPair++;
      if (examples.length < 5) {
        const f = found[0];
        examples.push(`${name}: shirts ${f.i + 1} and ${f.j + 1} (colour ${f.colour}, structure ${f.structure})`);
      }
    }
  });
  const rate = squadsWithPair / clubNames.length;
  return {
    pass: rate <= maxRate, rate, squadsWithPair, squads: clubNames.length, examples,
    bad: rate <= maxRate ? []
      : [`${squadsWithPair}/${clubNames.length} squads (${(rate * 100).toFixed(1)}%) contain a`
        + ` confusable pair, over the ${(maxRate * 100).toFixed(1)}% the atlas held when this gate was set`],
  };
}
