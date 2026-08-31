// Pure team-sheet operations for the squad room. The invariant everything
// here protects: THE ELEVEN ALWAYS STAYS ELEVEN, and nobody silently
// disappears — placing a player trades places with whoever held the slot.
// (The server's applyTeamSheet is still the gate at save and at kickoff;
// these ops just keep the working copy legal-by-construction.)

/**
 * Place `playerId` into lineup slot `slotIndex`. Returns a NEW sheet.
 *
 * Where the incoming player came from decides where the outgoing one goes:
 *   from the XI     → straight swap of slots
 *   from the bench  → outgoing takes his bench seat (or the seat closes
 *                     when the slot was empty)
 *   from outside    → outgoing drops to the bench if a seat is free,
 *                     otherwise he leaves the sheet (still owned, still
 *                     listed under "not in the squad")
 * @param {{ lineup: (string|null)[], bench: string[] }} sheet
 * @param {number} slotIndex
 * @param {string} playerId
 */
export function placePlayer(sheet, slotIndex, playerId) {
  const lineup = [...sheet.lineup];
  const bench = [...sheet.bench];
  const outgoing = lineup[slotIndex] ?? null;
  if (outgoing === playerId) return { ...sheet, lineup, bench };

  const fromLineup = lineup.indexOf(playerId);
  const fromBench = bench.indexOf(playerId);

  lineup[slotIndex] = playerId;
  if (fromLineup >= 0) {
    lineup[fromLineup] = outgoing;
  } else if (fromBench >= 0) {
    if (outgoing) bench[fromBench] = outgoing;
    else bench.splice(fromBench, 1);
  } else if (outgoing && bench.length < 5) {
    bench.push(outgoing);
  }
  return { ...sheet, lineup, bench };
}

/** The XI as a Set, for cheap membership checks while rendering. */
export const lineupSet = (sheet) => new Set(sheet.lineup.filter(Boolean));

/** Squad rows for the picker: bench first, then the rest, never the XI. */
export function pickerSections(sheet, allIds) {
  const inXi = lineupSet(sheet);
  const onBench = sheet.bench.filter((id) => allIds.has(id));
  const benchSet = new Set(onBench);
  const rest = [...allIds].filter((id) => !inXi.has(id) && !benchSet.has(id));
  return { onBench, rest };
}
