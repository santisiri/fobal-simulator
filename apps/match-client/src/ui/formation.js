// Where the eleven stand. Slot layouts for every formation the protocol
// knows, as pitch percentages: x across (0 = left touchline), y as DEPTH
// (0 = your own goal line, 100 = theirs). The room renders attacking
// upward, so it draws each slot at `bottom: y%`.
//
// Slot 0 is always the goalkeeper — the same rule TeamSheet enforces, so a
// sheet built by tapping these slots is legal by construction.
//
// `role` is the slot's football position. It labels the slot and lets the
// room note when a player is filling a position he is not listed for; it
// is a READING aid, not a penalty — the engine positions by slot, and
// nothing here claims otherwise.

export const FORMATION_SLOTS = {
  '442': [
    { role: 'GK', x: 50, y: 7 },
    { role: 'LB', x: 14, y: 26 }, { role: 'CB', x: 38, y: 22 },
    { role: 'CB', x: 62, y: 22 }, { role: 'RB', x: 86, y: 26 },
    { role: 'LM', x: 14, y: 54 }, { role: 'CM', x: 38, y: 50 },
    { role: 'CM', x: 62, y: 50 }, { role: 'RM', x: 86, y: 54 },
    { role: 'ST', x: 38, y: 80 }, { role: 'ST', x: 62, y: 80 },
  ],
  '433': [
    { role: 'GK', x: 50, y: 7 },
    { role: 'LB', x: 14, y: 26 }, { role: 'CB', x: 38, y: 22 },
    { role: 'CB', x: 62, y: 22 }, { role: 'RB', x: 86, y: 26 },
    { role: 'CM', x: 30, y: 50 }, { role: 'CM', x: 50, y: 44 },
    { role: 'CM', x: 70, y: 50 },
    { role: 'LW', x: 16, y: 78 }, { role: 'ST', x: 50, y: 84 },
    { role: 'RW', x: 84, y: 78 },
  ],
  '352': [
    { role: 'GK', x: 50, y: 7 },
    { role: 'CB', x: 30, y: 23 }, { role: 'CB', x: 50, y: 20 },
    { role: 'CB', x: 70, y: 23 },
    { role: 'LM', x: 10, y: 52 }, { role: 'CM', x: 34, y: 50 },
    { role: 'CM', x: 50, y: 46 }, { role: 'CM', x: 66, y: 50 },
    { role: 'RM', x: 90, y: 52 },
    { role: 'ST', x: 38, y: 82 }, { role: 'ST', x: 62, y: 82 },
  ],
};

export const FORMATIONS = Object.keys(FORMATION_SLOTS);

/** Human shape: '442' → '4-4-2' */
export const prettyFormation = f => String(f).split('').join('-');

export function slotsFor(formation) {
  return FORMATION_SLOTS[formation] ?? FORMATION_SLOTS['442'];
}

/** Is this player filling a slot he is not listed for? Reading aid only.
 *  Football, not string equality: a right midfielder at right wing has
 *  shifted one line up the same flank, which is not news. What IS news is
 *  a two-line move (a centre-back at striker), a swapped flank, or anyone
 *  but a keeper in goal. */
const LINE = { GK: 0, CB: 1, LB: 1, RB: 1, CM: 2, LM: 2, RM: 2, ST: 3, LW: 3, RW: 3 };
const FLANK = r => (r.startsWith('L') ? 'L' : r.startsWith('R') ? 'R' : 'C');

export function outOfPosition(playerRole, slotRole) {
  if (playerRole === slotRole) return false;
  if ((playerRole === 'GK') !== (slotRole === 'GK')) return true;
  const lines = Math.abs((LINE[playerRole] ?? 2) - (LINE[slotRole] ?? 2));
  const flanks = [FLANK(playerRole), FLANK(slotRole)];
  const flankClash = flanks[0] !== flanks[1] && !flanks.includes('C');
  return lines > 1 || flankClash;
}
