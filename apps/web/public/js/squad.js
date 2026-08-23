import { dedupeSquad, confusablePairs } from './avatar.js';

// Deterministic starter-squad generation for onboarding. Mirrors the shape
// the FobalPlayerGenerator would sign and FobalPlayer would mint: 11 players,
// each with a dna, packed appearance, per-position skills (0-100), a position
// and a name. Same club name → same squad, always — the generation is a pure
// function of the seed, exactly as the on-chain generator is authoritative
// about composition. (Preview mode: the real mint arrives with the Base
// Sepolia deployment; this produces the identical data structure.)

const SKILL_LABELS = [
  'pace', 'finishing', 'passing', 'dribbling', 'defending', 'physical',
  'stamina', 'vision', 'technique', 'aggression', 'composure', 'goalkeeping',
];

// 4-3-3 with pitch coordinates (0..100 across, 0 own-goal-line .. 100 attack)
const FORMATION_433 = [
  { role: 'GK', pos: 0, x: 50, y: 6 },
  { role: 'LB', pos: 1, x: 16, y: 26 }, { role: 'CB', pos: 1, x: 38, y: 20 },
  { role: 'CB', pos: 1, x: 62, y: 20 }, { role: 'RB', pos: 1, x: 84, y: 26 },
  { role: 'CM', pos: 2, x: 30, y: 50 }, { role: 'CM', pos: 2, x: 50, y: 46 },
  { role: 'CM', pos: 2, x: 70, y: 50 },
  { role: 'LW', pos: 3, x: 22, y: 78 }, { role: 'ST', pos: 3, x: 50, y: 84 },
  { role: 'RW', pos: 3, x: 78, y: 78 },
];

const FIRST = ['Leo', 'Diego', 'Marco', 'Kai', 'Rafa', 'Nico', 'Toni', 'Bruno', 'Sami', 'Iker', 'Dani', 'Theo', 'Enzo', 'Luka', 'Youri', 'Ilya', 'Nano', 'Pau'];
const LAST = ['Rossi', 'Vega', 'Okafor', 'Sørensen', 'Haddad', 'Costa', 'Ferro', 'Nakamura', 'Petrov', 'Muñoz', 'Adeyemi', 'Larsson', 'Bianchi', 'Novak', 'Diallo', 'Reyes', 'Kovač', 'Silva'];

// FNV-1a → a deterministic 64-bit-ish stream from a string seed.
function seededRng(seedStr) {
  let h = 0xcbf29ce4n;
  for (const ch of seedStr) h = ((h ^ BigInt(ch.codePointAt(0))) * 0x100000001b3n) & 0xffffffffffffffffn;
  let state = h || 1n;
  return () => {
    state ^= state << 13n & 0xffffffffffffffffn;
    state ^= state >> 7n;
    state ^= state << 17n & 0xffffffffffffffffn;
    return Number(state & 0xffffffn) / 0x1000000; // [0,1)
  };
}

const clampSkill = v => Math.max(20, Math.min(99, Math.round(v)));

// Per-position skill emphasis so squads read plausibly.
function skillsFor(pos, rnd, tier) {
  const base = 46 + tier * 22; // tier 0..1 → weaker/stronger club
  const g = k => clampSkill(base + (rnd() - 0.5) * 26 + k);
  return {
    pace: g(pos >= 2 ? 8 : 0), finishing: g(pos === 3 ? 16 : pos === 0 ? -30 : -8),
    passing: g(pos === 2 ? 12 : 2), dribbling: g(pos >= 2 ? 8 : -4),
    defending: g(pos === 1 ? 16 : pos === 0 ? 6 : -10), physical: g(pos <= 1 ? 8 : 0),
    stamina: g(6), vision: g(pos === 2 ? 12 : 0), technique: g(pos >= 2 ? 8 : 0),
    aggression: g(pos === 1 ? 8 : -4), composure: g(2),
    goalkeeping: pos === 0 ? clampSkill(base + 24 + (rnd() - 0.5) * 16) : clampSkill(8 + rnd() * 10),
  };
}

function packSkills(s) {
  let packed = 0n;
  SKILL_LABELS.forEach((k, i) => { packed |= BigInt(s[k] & 0xff) << BigInt(i * 8); });
  return packed;
}

/** Aggregated 6-stat card face (matches the in-match player card). */
export function ratingFace(s) {
  const avg = (...xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  if (s.goalkeeping > 60) {
    return [['GK', s.goalkeeping], ['REF', avg(s.composure, s.defending)], ['PAS', avg(s.passing, s.vision)],
      ['PAC', avg(s.pace, s.stamina)], ['PHY', s.physical], ['CMP', s.composure]];
  }
  return [['PAC', s.pace], ['SHO', s.finishing], ['PAS', avg(s.passing, s.vision)],
    ['DRI', s.dribbling], ['DEF', avg(s.defending, s.aggression)], ['PHY', avg(s.physical, s.stamina)]];
}

export function overall(s) {
  const face = ratingFace(s);
  return Math.round(face.reduce((a, [, v]) => a + v, 0) / face.length);
}

/**
 * @param {{clubName:string, kit?:object, tier?:number}} opts
 * @returns {{clubName, kit, players: Array}}
 */
export function generateSquad({ clubName, kit, tier = 0.5 }) {
  const rnd = seededRng('fobal:' + clubName.toLowerCase());
  const usedNames = new Set();
  const uniqueName = () => {
    for (let tries = 0; tries < 40; tries++) {
      const n = `${FIRST[Math.floor(rnd() * FIRST.length)]} ${LAST[Math.floor(rnd() * LAST.length)]}`;
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
    return `${FIRST[Math.floor(rnd() * FIRST.length)]} ${LAST[Math.floor(rnd() * LAST.length)]} ${usedNames.size}`;
  };
  // dna is a '0x' hex STRING (JSON-serializable; BigInt(dna) parses it where
  // the avatar renderer needs a bigint). The salt is what lets a clashing
  // player be re-derived deterministically below.
  const dnaFor = (i, salt = 0) => '0x' + [...(salt ? `${clubName}:${i}:fobal#${salt}` : `${clubName}:${i}:fobal`)]
    .reduce((h, c) => ((h * 131 + c.charCodeAt(0)) >>> 0), 7).toString(16).padStart(8, '0').repeat(8);
  const idAt = (i, salt = 0) => {
    const d = dnaFor(i, salt);
    return { dna: d, appearance: BigInt(d) & 0xffffffffn };
  };

  // THE MINT-TIME CHECK. Eleven players in one kit is the only view where
  // team colour does nothing to tell them apart, and about one squad in four
  // hundred came out with a pair a viewer could confuse. The renderer cannot
  // fix that — it sees one token at a time, from a hash, and knows nothing
  // about teammates. Only the code that CHOOSES the dna can, and once minted
  // the dna is immutable, so it has to happen here.
  //
  // Deterministic: same club, same squad, always. It re-derives the LATER
  // player so earlier shirt numbers stay put, and in practice touches about
  // one player in four thousand.
  const gkKit = kit && kit.gk ? kit.gk : kit;
  const kitAt = (i) => (FORMATION_433[i].pos === 0 ? gkKit : kit);
  const positions = FORMATION_433.map((s) => s.pos);
  const { ids: chosen, rerolled } = dedupeSquad(
    FORMATION_433.map((_, i) => idAt(i)), kitAt, positions, (i, salt) => idAt(i, salt),
  );

  const players = FORMATION_433.map((slot, i) => {
    const dna = chosen[i].dna;
    // 32 bits, matching PlayerCodec.APPEARANCE_MASK. This was 24 bits, so
    // trait slots 6 and 7 were always zero and the preview could never show
    // an accessory the chain would mint.
    const appearance = Number(BigInt(dna) & 0xffffffffn);
    const s = skillsFor(slot.pos, rnd, tier);
    const name = uniqueName();
    return {
      id: i + 1, name, role: slot.role, position: slot.pos, x: slot.x, y: slot.y,
      dna, appearance, skills: s, skillsPacked: '0x' + packSkills(s).toString(16),
      overall: overall(s), shirt: i + 1,
    };
  });
  return { clubName, kit, players, rerolled };
}
