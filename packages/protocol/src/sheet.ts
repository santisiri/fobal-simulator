// Workstream H — the TEAM SHEET: the eleven you pick and the shape you set,
// persisted between matches (docs/CLUB_AND_MARKET.md).
//
// Until now the eleven that walked out were simply the first eleven in
// roster order, and every team played 4-4-2 with engine-default tactics —
// the squad you would have chosen did not exist anywhere. This is that
// object, and two properties make it worth having:
//
//   1. `tactics` is a TacticalPatch — the SAME shape the engine already
//      honors (adapter.ts applies manifest formation + tactics at kickoff)
//      and the same shape a spoken order compiles to mid-match. What you
//      set in the squad room and what you shout at the touchline are one
//      vocabulary, not two.
//   2. Applying a sheet RE-VALIDATES through TeamSnapshot. A sheet can
//      never produce a manifest the match server would reject: the schema
//      is the gate, exactly as it is for /squad and for chain squads.
//
// Deliberately NOT here yet: per-player instructions. They live on the
// runtime snapshot (ActiveInstruction), not the manifest, so honoring them
// at kickoff is engine-adapter work — a later slice. A field that stored
// them and silently did nothing would be worse than no field.
import { z } from 'zod';
import { Formation, PlayerId } from './core.js';
import { TacticalPatch, TeamSnapshot } from './match.js';

export const TeamSheet = z.object({
  version: z.literal(1),
  /** the starting eleven, in slot order — slot 0 is the goalkeeper */
  lineup: z.array(PlayerId).length(11),
  /** substitutes, in the order you would use them (engine capacity is 5) */
  bench: z.array(PlayerId).max(5),
  /** shape; omitted keeps whatever the squad already declares */
  formation: Formation.optional(),
  /** starting tactics — only the fields the manager actually chose */
  tactics: TacticalPatch.optional(),
});
export type TeamSheet = z.infer<typeof TeamSheet>;

export type SheetApplication =
  | { ok: true; team: TeamSnapshot }
  | { ok: false; reason: string };

/** The sheet a squad plays TODAY with no sheet saved: the first eleven,
 *  the next five on the bench. The squad room opens on this, so the editor
 *  starts from the truth instead of from an empty form. */
export function defaultSheetFor(team: TeamSnapshot): TeamSheet {
  return {
    version: 1,
    lineup: team.players.slice(0, 11).map(p => p.playerId),
    bench: team.players.slice(11, 16).map(p => p.playerId),
    ...(team.formation ? { formation: team.formation } : {}),
    ...(team.tactics ? { tactics: team.tactics } : {}),
  };
}

/** Apply a sheet to the squad it was written for.
 *
 *  The result is the matchday squad in engine order — the eleven first,
 *  then the bench — so the engine's "first eleven start" rule delivers the
 *  team the manager actually picked. Players left out do not travel.
 *
 *  Every failure names the player and says what to do, because these
 *  surface to a manager mid-selection (and because a sheet goes stale the
 *  moment a player is sold — see buildTeam's fallback). */
export function applyTeamSheet(team: TeamSnapshot, sheet: TeamSheet): SheetApplication {
  const squad = new Map(team.players.map(p => [p.playerId, p]));
  const picked = [...sheet.lineup, ...sheet.bench];

  const seen = new Set<string>();
  for (const id of picked){
    if (seen.has(id)){
      const name = squad.get(id)?.name ?? id;
      return { ok: false, reason: `${name} is picked twice` };
    }
    seen.add(id);
    if (!squad.has(id))
      return { ok: false, reason: `${id} is not in your squad any more — pick a replacement` };
  }

  const lineup = sheet.lineup.map(id => squad.get(id)!);
  if (!lineup.some(p => p.role === 'GK'))
    return { ok: false, reason: 'your eleven needs a goalkeeper' };
  if (lineup[0]!.role !== 'GK')
    return { ok: false, reason: 'the goalkeeper belongs in the first slot' };

  const candidate = {
    ...team,
    ...(sheet.formation ? { formation: sheet.formation } : {}),
    ...(sheet.tactics ? { tactics: { ...team.tactics, ...sheet.tactics } } : {}),
    players: [...lineup, ...sheet.bench.map(id => squad.get(id)!)],
  };

  // the schema is the gate: a sheet can never build a manifest the match
  // server would refuse (duplicate shirts, GK-less XI, squad size, …)
  const parsed = TeamSnapshot.safeParse(candidate);
  if (!parsed.success)
    return { ok: false, reason: parsed.error.issues[0]?.message ?? 'that eleven is not a legal squad' };
  return { ok: true, team: parsed.data };
}
