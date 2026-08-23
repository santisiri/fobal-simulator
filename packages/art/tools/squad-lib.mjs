// A squad is the hardest case the product actually shows: ELEVEN players,
// side by side, in ONE kit. Team colour does no work at all, so every bit of
// telling-apart has to come from the player. The 100-player sheets never test
// this — they measure a population, not a lineup.
//
// The metric is deliberately blunt: rasterise each player to 32x32, throw away
// the kit rows (identical across a squad by definition), and count differing
// pixels between every pair of teammates. The number that matters is the
// WORST pair in a squad, because that is the pair a viewer confuses.
// the RENDERER's implementations, not copies. This tool grew its own raster,
// distance and slot-mapping code, and a second copy of a rule is a second
// thing to keep in step.
import {
  renderPlayer, rasterOf, structureRaster, comparePlayers, confusablePairs as pairsOf,
  dedupeSquad, FACE_ROWS, CONFUSABLE_COLOUR, CONFUSABLE_STRUCTURE,
} from '../src/render.js';
import { keccak_256 } from '@noble/hashes/sha3';

export { FACE_ROWS, CONFUSABLE_COLOUR, CONFUSABLE_STRUCTURE, dedupeSquad };
export const raster = rasterOf;
export const slotRaster = (id) => structureRaster(id);

const differing = (a, b) => {
  let d = 0;
  for (let k = 0; k < FACE_ROWS * 32; k++) if (a[k] !== b[k]) d++;
  return d;
};
export const faceDistance = differing;
export const structureDistance = differing;

/** The app's own derivation, copied so the audit measures what SHIPS.
 *  A 32-bit hash repeated eight times to fill 256 bits, with appearance taken
 *  from the low word of that same value. */
export function appSquadIds(clubName, size = 11, salt = 0) {
  const out = [];
  for (let i = 0; i < size; i++) {
    const tag = salt === 0 ? `${clubName}:${i}:fobal` : `${clubName}:${i}:fobal#${salt}`;
    const dna = '0x' + [...tag]
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
export const confusablePairs = (ids, kit) =>
  pairsOf(ids, (i) => kitFor(kit, i), POSITIONS);

/** what the squad builder should mint: the same lineup with any clash
 *  deterministically re-derived */
export function cleanSquad(clubName, kit) {
  const ids = appSquadIds(clubName);
  return dedupeSquad(ids, (i) => kitFor(kit, i), POSITIONS,
    (i, salt) => appSquadIds(clubName, POSITIONS.length, salt)[i]);
}

/** the fixed panel the gate measures, so the rate is comparable run to run */
export const GATE_CLUBS = Array.from({ length: 400 }, (_, i) => `Club ${i}`);

/** GATE. Two numbers, because they answer different questions.
 *
 *  RAW is the rate before the mint-time check — a property of the trait space,
 *  so it is held to a ceiling rather than to zero. If a change to the art makes
 *  squads meaningfully worse, this is what notices.
 *
 *  CLEANED is the rate after the check. That one must be exactly zero, because
 *  it is the whole point of having the check: a squad the builder is willing
 *  to sign must not contain a pair a viewer could confuse. */
export function assertSquadsLegible(clubNames = GATE_CLUBS, maxRawRate = 0.015, derive = appSquadIds) {
  let raw = 0, cleaned = 0, rerolled = 0, deepestSalt = 0;
  const examples = [], survivors = [];
  clubNames.forEach((name, i) => {
    const kit = CLUBS[i % CLUBS.length];
    const found = confusablePairs(derive(name), kit);
    if (found.length) {
      raw++;
      if (examples.length < 5) {
        const f = found[0];
        examples.push(`${name}: shirts ${f.i + 1} and ${f.j + 1} (colour ${f.colour}, structure ${f.structure})`);
      }
    }
    const clean = cleanSquad(name, kit);
    rerolled += clean.rerolled;
    deepestSalt = Math.max(deepestSalt, ...clean.salts);
    const left = confusablePairs(clean.ids, kit);
    if (left.length) {
      cleaned++;
      if (survivors.length < 5) survivors.push(`${name}: shirts ${left[0].i + 1} and ${left[0].j + 1}`);
    }
  });
  const rawRate = raw / clubNames.length;
  const bad = [];
  if (rawRate > maxRawRate) {
    bad.push(`${raw}/${clubNames.length} squads (${(rawRate * 100).toFixed(2)}%) contain a confusable pair`
      + ` before the mint-time check, over the ${(maxRawRate * 100).toFixed(1)}% ceiling`);
  }
  if (cleaned > 0) {
    bad.push(`the mint-time check let ${cleaned} squad(s) through: ${survivors.join('; ')}`);
  }
  return {
    pass: bad.length === 0, bad, examples, survivors,
    rate: rawRate, squadsWithPair: raw, squads: clubNames.length,
    cleanedWithPair: cleaned, rerolled, deepestSalt, players: clubNames.length * POSITIONS.length,
  };
}
