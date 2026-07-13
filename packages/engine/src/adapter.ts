// PlayerSnapshot-to-engine adapter: imposes a frozen MatchManifest onto a
// freshly reset golden core. Runs entirely BEFORE tick 0 and consumes no
// simulation randomness, so the same manifest always produces the same
// starting state. External ids are bound here and only here.
import type { MatchManifest, PlayerSnapshot, TacticalPatch, TeamSnapshot } from '@fobal/protocol';
import { IdMap } from './ids.js';
import { ratingsToAttributes } from './normalize.js';
import type { GoldenHandle } from './goldenRuntime.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const LINE_OF_ROLE: Record<string, string> = {
  GK: 'GK', CB: 'DEF', LB: 'DEF', RB: 'DEF',
  CM: 'MID', LM: 'MID', RM: 'MID', LW: 'ATT', RW: 'ATT', ST: 'ATT',
};

function isoToFlagEmoji(iso2: string): string {
  const a = iso2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(a)) return '🏳️';
  return String.fromCodePoint(0x1f1e6 + a.charCodeAt(0) - 65, 0x1f1e6 + a.charCodeAt(1) - 65);
}

/**
 * Deterministically assigns manifest starters to the golden formation's
 * slots: exact role match first, then same line, then whatever remains —
 * always scanning in manifest order so the result is reproducible.
 */
export function assignSlots(slotRoles: string[], starters: PlayerSnapshot[]): number[] {
  const taken = new Array<boolean>(starters.length).fill(false);
  const assignment = new Array<number>(slotRoles.length).fill(-1);
  const pickWhere = (slotIdx: number, pred: (p: PlayerSnapshot) => boolean): boolean => {
    for (let j = 0; j < starters.length; j++){
      if (!taken[j] && pred(starters[j]!)){ taken[j] = true; assignment[slotIdx] = j; return true; }
    }
    return false;
  };
  for (let pass = 0; pass < 3; pass++){
    for (let i = 0; i < slotRoles.length; i++){
      if (assignment[i] !== -1) continue;
      const role = slotRoles[i]!;
      if (pass === 0) pickWhere(i, p => p.role === role);
      else if (pass === 1) pickWhere(i, p => LINE_OF_ROLE[p.role] === LINE_OF_ROLE[role]);
      else pickWhere(i, () => true);
    }
  }
  return assignment;
}

function imposePlayer(internal: any, spec: PlayerSnapshot): void {
  internal.name = spec.name;
  internal.num = spec.shirtNumber;
  internal.a = { ...internal.a, ...ratingsToAttributes(spec.ratings) };
  if (spec.age !== undefined) internal.age = spec.age;
  if (spec.nationality !== undefined){
    internal.nat = spec.nationality.toUpperCase();
    internal.flag = isoToFlagEmoji(spec.nationality);
  }
  if (spec.heightCm !== undefined) internal.heightCm = spec.heightCm;
  if (spec.weightKg !== undefined) internal.weightKg = spec.weightKg;
}

function imposeTeam(handle: GoldenHandle, teamIdx: 0 | 1, spec: TeamSnapshot, ids: IdMap): void {
  const game = handle.game;
  const team = game.teams[teamIdx];
  ids.bindTeam(spec.teamId, teamIdx);
  team.name = spec.name.toUpperCase();

  const starters = spec.players.slice(0, 11);
  const benchSpec = spec.players.slice(11);

  const slotRoles: string[] = team.players.map((p: any) => p.role);
  const assignment = assignSlots(slotRoles, starters);
  team.players.forEach((p: any, i: number) => {
    const spec = starters[assignment[i]!]!;
    imposePlayer(p, spec);
    ids.bindPlayer(spec.playerId, p.pid);
  });
  // the GK slot is authoritative for the keeper reference
  team.gk = team.players.find((p: any) => p.isGK) ?? team.players[0];

  // The manifest defines who exists: golden-generated bench players beyond
  // the manifest bench are removed so no unofficial player can ever enter.
  const bench: any[] = team.bench ?? [];
  if (benchSpec.length > bench.length)
    throw new Error(`team ${spec.teamId}: manifest bench of ${benchSpec.length} exceeds the engine's ${bench.length} bench slots`);
  const keep = Math.min(bench.length, benchSpec.length);
  for (let i = 0; i < keep; i++){
    const bp = bench[i], bs = benchSpec[i]!;
    imposePlayer(bp, bs);
    // a bench player's own slot role gates GK like-for-like substitutions —
    // align it (and the derived flags) with the manifest role
    if (bp.slot) bp.slot.role = bs.role;
    bp.role = bs.role;
    bp.line = LINE_OF_ROLE[bs.role] ?? bp.line;
    bp.isGK = bs.role === 'GK';
    ids.bindPlayer(bs.playerId, bp.pid);
  }
  if (bench.length > benchSpec.length) bench.length = benchSpec.length;
  // (a manifest bench longer than the golden bench is trimmed to fit — the
  //  golden core allocates a fixed bench; extra entries are validated but idle)
}

export interface AdaptedMatch { ids: IdMap }

export function imposeManifest(handle: GoldenHandle, manifest: MatchManifest): AdaptedMatch {
  const game = handle.game;
  // 1. pin environment (official when supplied; otherwise seed-derived).
  // Unknown keys must fail loudly — __setEnv silently ignores them, which
  // would make two servers disagree about what the manifest meant.
  if (manifest.environment?.grass || manifest.environment?.weather){
    const known = handle.evalIn('JSON.stringify({ g: Object.keys(GRASS_TYPES), w: Object.keys(WEATHER_TYPES) })');
    const { g, w } = JSON.parse(known) as { g: string[]; w: string[] };
    if (manifest.environment.grass && !g.includes(manifest.environment.grass))
      throw new Error(`unknown environment.grass "${manifest.environment.grass}" (known: ${g.join(', ')})`);
    if (manifest.environment.weather && !w.includes(manifest.environment.weather))
      throw new Error(`unknown environment.weather "${manifest.environment.weather}" (known: ${w.join(', ')})`);
    handle.sandbox.__setEnv(manifest.environment.grass, manifest.environment.weather);
  }
  // 2. deterministic reset from the manifest seed
  handle.reset(manifest.seed);
  // 3. presentation rules. The cinematic goal replay is ALWAYS disabled in
  // the authoritative engine: it rewinds simTick and re-simulates the buildup,
  // which would corrupt command scheduling, broadcast state and recovery
  // snapshots mid-excursion. rules.autoGoalReplays is a client-side
  // presentation hint; official goal replays come from the recorded command
  // log (see apps/match-server/src/replays.ts).
  handle.sandbox.__present(manifest.rules.ceremonies);
  game.goalReplay.cfg.enabled = false;
  // 4. impose squads + bind external ids
  const ids = new IdMap();
  imposeTeam(handle, 0, manifest.teams[0], ids);
  imposeTeam(handle, 1, manifest.teams[1], ids);
  // 5. team tactics through the one legal funnel
  for (const idx of [0, 1] as const){
    const spec = manifest.teams[idx];
    const script: Record<string, unknown> = {};
    if (spec.formation) script.formation = spec.formation;
    if (spec.tactics) Object.assign(script, translateTactics(spec.tactics, ids));
    if (Object.keys(script).length)
      handle.evalIn('TacticalEngine') .apply(game, game.teams[idx], script, 'manifest');
  }
  return { ids };
}

/** Translate a protocol tactics patch to the internal script vocabulary
 *  (identical keys except markTarget, which carries an external id). */
export function translateTactics(patch: TacticalPatch, ids: IdMap): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch };
  if ('markTarget' in patch)
    out.markTarget = patch.markTarget === null ? null : ids.pid(patch.markTarget!);
  return out;
}
