// Workstream G — the football command layer (docs/AI_GAMEPLAY.md).
//
// GameCommand is the CANONICAL, provider-independent representation of a
// manager's tactical intent: what any interpreter (LLM, keyword parser, a
// debug console, a future gesture system) must produce, and the ONLY thing
// the pipeline downstream of interpretation ever sees. Three rules:
//
//   1. CLOSED VOCABULARY. Intents are enums. An interpreter cannot express
//      anything the taxonomy does not name; the vocabulary grows only as
//      fast as the simulation can honor it.
//   2. REFERENCES, NEVER IDS. Interpreters emit human references (surname,
//      shirt number, side); resolvePlayerRef maps them to canonical
//      manifest playerIds deterministically. An invented player cannot
//      survive — there is no id field for a model to hallucinate into.
//   3. COMPILED, NEVER APPLIED. compileGameCommand lowers an order onto the
//      EXISTING wire commands (TacticalPatch / substitution). The engine's
//      authority is untouched: orders that reach the simulation are exactly
//      the commands it already validates, sequences, logs, and replays.
//      Intents the simulation cannot express yet are REJECTED with the real
//      reason — never silently approximated.
//
// Command lifetime semantics: team intents are PERSISTENT-UNTIL-REPLACED —
// they patch the team's tactical state, and the next order touching the same
// fields overwrites it (no accumulation, no contradiction pile-up: last order
// wins per field). Substitutions are INSTANT. Player instructions are one per
// player (a new one replaces the old) and may be TIMED: a spoken duration
// ("overlap for ten minutes") compiles to the engine's ttlTicks, after which
// the player's station restores itself.
import { z } from 'zod';
import { Formation, Role } from './core.js';
import { PlayerInstructionKind, TacticalPatch, TeamSnapshot } from './match.js';

// ---------------------------------------------------------------------------
// taxonomy — every intent maps to a REAL simulator capability (see the
// compile table below) or is explicitly reserved
// ---------------------------------------------------------------------------

export const TeamIntent = z.enum([
  'press_high', 'press_medium', 'drop_deep', 'push_higher',
  'increase_tempo', 'decrease_tempo',
  'play_direct', 'play_short', 'retain_possession', 'counterattack',
  'attack_left', 'attack_right', 'attack_center',
  'increase_width', 'decrease_width',
  'waste_time', 'all_out_attack', 'park_the_bus',
  'shoot_on_sight', 'work_it_into_the_box', 'cross_more',
]);
export type TeamIntent = z.infer<typeof TeamIntent>;

export const PlayerIntent = z.enum([
  // binds today (the engine's man-marking assignment):
  'mark_player',
  // reserved: named in the taxonomy, validated, honestly rejected until the
  // engine grows per-player instruction state (G3):
  'stay_wide', 'cut_inside', 'overlap', 'underlap', 'hold_position',
  'make_forward_runs', 'come_short', 'press_player',
  'shoot_more', 'dribble_more',
]);
export type PlayerIntent = z.infer<typeof PlayerIntent>;

export const MatchIntent = z.enum(['change_formation', 'substitution']);
export type MatchIntent = z.infer<typeof MatchIntent>;

/** A human reference to a player — what interpreters emit INSTEAD of ids.
 *  side is from the speaking manager's perspective. */
export const PlayerRef = z.object({
  side: z.enum(['own', 'opponent']),
  name: z.string().min(1).max(48).optional(),
  shirtNumber: z.number().int().min(1).max(99).optional(),
}).refine(r => r.name !== undefined || r.shirtNumber !== undefined,
  'a player reference needs a name or a shirt number');
export type PlayerRef = z.infer<typeof PlayerRef>;

export const GameCommand = z.object({
  version: z.literal(1),
  scope: z.enum(['team', 'player', 'match']),
  intent: z.string().min(1).max(40),
  /** player scope: who the instruction is about */
  target: PlayerRef.optional(),
  /** change_formation */
  formation: Formation.optional(),
  /** substitution */
  sub: z.object({ out: PlayerRef, in: PlayerRef }).optional(),
  /** optional strength 0..1 for intents that scale (pressing, tempo, …) */
  intensity: z.number().min(0).max(1).optional(),
  /** G5 — "for the next ten minutes": MATCH minutes (what a manager means
   *  when he shouts a duration), compiled to the engine's ttlTicks. Player
   *  scope only: the engine expires per-player instructions, not team
   *  tactics (those persist until replaced). */
  durationMinutes: z.number().int().min(1).max(45).optional(),
  /** G5 — the second reference: WHO carries out a job aimed at `target`.
   *  "Kovač, mark their nine" → assignee=Kovač (own), target=their 9. */
  assignee: PlayerRef.optional(),
}).superRefine((cmd, ctx) => {
  const table: Record<string, z.ZodEnum<[string, ...string[]]>> = {
    team: TeamIntent, player: PlayerIntent, match: MatchIntent,
  };
  if (!table[cmd.scope]!.safeParse(cmd.intent).success)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown ${cmd.scope} intent ${cmd.intent}` });
  if (cmd.scope === 'player' && !cmd.target)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'player-scope commands need a target' });
  if (cmd.intent === 'change_formation' && !cmd.formation)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'change_formation needs a formation' });
  if (cmd.intent === 'substitution' && !cmd.sub)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'substitution needs sub.out and sub.in' });
  if (cmd.durationMinutes !== undefined && cmd.scope !== 'player')
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: 'durations apply to player instructions; team tactics persist until replaced' });
  if (cmd.assignee !== undefined && cmd.intent !== 'mark_player')
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'assignee is only meaningful for mark_player' });
});
export type GameCommand = z.infer<typeof GameCommand>;

// ---------------------------------------------------------------------------
// deterministic player resolution — surname, shirt number, diacritics,
// ambiguity. NO fuzzy scoring: exact-normalized token match, then substring,
// then ambiguity is an ERROR that names the candidates ("Moretti or Costa?").
// ---------------------------------------------------------------------------

const normalize = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export interface ResolveContext {
  /** [own, opponent] from the speaking manager's perspective */
  own: TeamSnapshot;
  opponent: TeamSnapshot;
}

export type Resolution =
  | { ok: true; playerId: string; name: string; shirtNumber: number }
  | { ok: false; reason: string };

export function resolvePlayerRef(ref: PlayerRef, ctx: ResolveContext): Resolution {
  const team = ref.side === 'own' ? ctx.own : ctx.opponent;
  if (ref.shirtNumber !== undefined){
    const hit = team.players.find(p => p.shirtNumber === ref.shirtNumber);
    return hit
      ? { ok: true, playerId: hit.playerId, name: hit.name, shirtNumber: hit.shirtNumber }
      : { ok: false, reason: `no number ${ref.shirtNumber} in ${ref.side === 'own' ? 'your team' : 'their team'}` };
  }
  const wanted = normalize(ref.name!);
  // pass 1: exact token match (surname is usually the last token)
  let hits = team.players.filter(p => normalize(p.name).split(/\s+/).includes(wanted));
  // pass 2: substring
  if (hits.length === 0) hits = team.players.filter(p => normalize(p.name).includes(wanted));
  if (hits.length === 1){
    const p = hits[0]!;
    return { ok: true, playerId: p.playerId, name: p.name, shirtNumber: p.shirtNumber };
  }
  if (hits.length === 0) return { ok: false, reason: `no player called "${ref.name}" on that side` };
  // ambiguity is a QUESTION, kept terse for live play
  const names = hits.slice(0, 3).map(p => p.name.split(/\s+/).pop()).join(' or ');
  return { ok: false, reason: `${names}?` };
}

// ---------------------------------------------------------------------------
// the compile table — intent → the tactical surface the engine ALREADY has.
// Absolute values by design: "press high" means the same thing in every
// match (comparative language like "press a bit harder" flows through the
// interpreter's free-form patch instead, which is relative to current).
// ---------------------------------------------------------------------------

const t = (patch: TacticalPatch, ack: string) => ({ kind: 'patch' as const, patch, ack });
const scaled = (field: keyof TacticalPatch, base: number, ack: string) =>
  (intensity?: number) => t({ [field]: intensity ?? base } as TacticalPatch, ack);

const TEAM_EFFECTS: Record<TeamIntent, (intensity?: number) => { kind: 'patch'; patch: TacticalPatch; ack: string }> = {
  press_high: scaled('pressing', 0.85, 'PRESS HIGH'),
  press_medium: () => t({ pressing: 0.5 }, 'PRESS MEDIUM'),
  drop_deep: () => t({ defLine: 0.2, compactness: 0.75 }, 'DROP DEEP'),
  push_higher: () => t({ defLine: 0.8 }, 'PUSH HIGHER'),
  increase_tempo: scaled('tempo', 0.85, 'TEMPO UP'),
  decrease_tempo: () => t({ tempo: 0.25 }, 'SLOW IT DOWN'),
  play_direct: () => t({ style: 'direct' }, 'PLAY DIRECT'),
  play_short: () => t({ style: 'possession' }, 'PLAY SHORT'),
  retain_possession: () => t({ style: 'possession', risk: 0.25, tempo: 0.35 }, 'KEEP THE BALL'),
  counterattack: () => t({ style: 'counter', counter: 0.9 }, 'HIT THEM ON THE COUNTER'),
  attack_left: () => t({ attackSide: 'left' }, 'ATTACK LEFT'),
  attack_right: () => t({ attackSide: 'right' }, 'ATTACK RIGHT'),
  attack_center: () => t({ attackSide: 'both', width: 0.35 }, 'THROUGH THE MIDDLE'),
  increase_width: scaled('width', 0.85, 'STRETCH THE PITCH'),
  decrease_width: () => t({ width: 0.25 }, 'NARROW UP'),
  waste_time: () => t({ timeWaste: 0.9, tempo: 0.2 }, 'KILL THE CLOCK'),
  all_out_attack: () => t({ mentality: 0.95, defLine: 0.85, risk: 0.9 }, 'ALL-OUT ATTACK'),
  park_the_bus: () => t({ mentality: 0.1, defLine: 0.12, compactness: 0.9, timeWaste: 0.7 }, 'PARK THE BUS'),
  shoot_on_sight: () => t({ shootTendency: 0.9 }, 'SHOOT ON SIGHT'),
  work_it_into_the_box: () => t({ shootTendency: 0.2, crossing: 0.35 }, 'WORK IT IN'),
  cross_more: () => t({ crossing: 0.85, width: 0.75 }, 'GET CROSSES IN'),
};

/** G3 bridge: spatial player intents lower onto the engine's
 *  PlayerInstruction layer (packages/engine/src/tactics.ts — station
 *  biasing; one active instruction per player, replacement semantics,
 *  attributes decide every actual step). The instruction is addressed to
 *  YOUR player; the engine re-validates XI membership and refuses
 *  goalkeepers. */
const SPATIAL_BINDINGS: Partial<Record<PlayerIntent, { kind: PlayerInstructionKind; ack: string; ttlTicks?: number }>> = {
  stay_wide: { kind: 'stay_wide', ack: 'STAY WIDE' },
  cut_inside: { kind: 'stay_central', ack: 'CUT INSIDE' },
  overlap: { kind: 'overlap', ack: 'OVERLAP' },
  underlap: { kind: 'underlap', ack: 'UNDERLAP' },
  hold_position: { kind: 'hold_position', ack: 'HOLD POSITION' },
  // a run is a spell, not a lifestyle: 900 ticks (~15s of sim), then the
  // station restores itself — say it again for another burst
  make_forward_runs: { kind: 'push_forward', ack: 'PUSH FORWARD', ttlTicks: 900 },
  come_short: { kind: 'drop_back', ack: 'COME SHORT' },
};

/** G5 — spoken durations. A manager shouting "for ten minutes" means MATCH
 *  minutes; the engine expires instructions in ticks. The golden clock runs
 *  TIME_SCALE = 30 match-seconds per real second and the engine steps at
 *  60 ticks per real second, so one match minute = 60/30 * 60 = 120 ticks.
 *  Clamped into the protocol's own ttl range (30..18000). */
const TICKS_PER_MATCH_MINUTE = 120;
const ttlFromMinutes = (minutes: number): number =>
  Math.min(18000, Math.max(30, Math.round(minutes * TICKS_PER_MATCH_MINUTE)));

/** Still reserved — each with ITS OWN honest reason (a generic "not
 *  supported" teaches the manager nothing). */
const RESERVED_REASONS: Partial<Record<PlayerIntent, string>> = {
  press_player: "the engine cannot single out a presser yet — try 'mark their number' or press as a team",
  shoot_more: 'per-player shooting tendency is not tunable yet — shoot_on_sight sets it for the team',
  dribble_more: 'per-player dribbling tendency is not tunable yet',
};

// ---------------------------------------------------------------------------
// compileGameCommand — the simulation integration boundary
// ---------------------------------------------------------------------------

export interface CompileContext extends ResolveContext {
  /** own teamId — stamped into wire commands */
  teamId: string;
}

export type CompiledOrder =
  | { ok: true; ack: string;
      wire:
        | { kind: 'tactical'; payload: { type: 'patch'; patch: TacticalPatch } }
        | { kind: 'substitution'; playerOut: string; playerIn: string }
        | { kind: 'player_instruction'; playerId: string;
            instruction: PlayerInstructionKind; targetPlayerId?: string; ttlTicks?: number } }
  | { ok: false; reason: string };

export function compileGameCommand(cmd: GameCommand, ctx: CompileContext): CompiledOrder {
  if (cmd.scope === 'team'){
    const effect = TEAM_EFFECTS[cmd.intent as TeamIntent](cmd.intensity);
    return { ok: true, ack: `${effect.ack} ✓`, wire: { kind: 'tactical', payload: { type: 'patch', patch: effect.patch } } };
  }

  if (cmd.scope === 'player'){
    if (cmd.intent === 'mark_player'){
      if (cmd.target!.side !== 'opponent')
        return { ok: false, reason: 'marking targets an OPPONENT — say their number or name' };
      const target = resolvePlayerRef(cmd.target!, ctx);
      if (!target.ok) return { ok: false, reason: target.reason };
      const targetSurname = target.name.split(/\s+/).pop()!.toUpperCase();

      // G5 — two references: "Kovač, mark their nine" names the MARKER too,
      // so the job becomes a per-player assignment the instruction book
      // records (who is shadowing whom), not just a team-level target.
      if (cmd.assignee){
        if (cmd.assignee.side !== 'own')
          return { ok: false, reason: 'the marker is one of YOUR players — name your own' };
        const marker = resolvePlayerRef(cmd.assignee, ctx);
        if (!marker.ok) return { ok: false, reason: `marker: ${marker.reason}` };
        const markerSurname = marker.name.split(/\s+/).pop()!.toUpperCase();
        // mirror the engine's marking rules as a FAST front door (it stays
        // the authority): the keeper never leaves his post, and golden's
        // marking branch only engages midfielders and defenders — a forward
        // would claim the assignment and dead-lock it
        const markerRole = ctx.own.players.find(p => p.playerId === marker.playerId)?.role;
        if (markerRole === 'GK')
          return { ok: false, reason: `${markerSurname}: the goalkeeper keeps his post` };
        if (markerRole === 'ST' || markerRole === 'LW' || markerRole === 'RW')
          return { ok: false, reason: `${markerSurname} plays too high to man-mark — give it to a midfielder or defender` };
        const ttlTicks = cmd.durationMinutes !== undefined ? ttlFromMinutes(cmd.durationMinutes) : undefined;
        return {
          ok: true,
          ack: `${markerSurname} → MARK #${target.shirtNumber} ${targetSurname}`
            + (cmd.durationMinutes ? ` ${cmd.durationMinutes}'` : '') + ' ✓',
          wire: {
            kind: 'player_instruction', playerId: marker.playerId,
            instruction: 'mark_opponent', targetPlayerId: target.playerId,
            ...(ttlTicks !== undefined ? { ttlTicks } : {}),
          },
        };
      }

      // one reference: the whole team shadows him (the engine's team-level
      // marking machine) — unchanged behavior
      return {
        ok: true,
        ack: `MARK #${target.shirtNumber} ${targetSurname} ✓`,
        wire: { kind: 'tactical', payload: { type: 'patch', patch: { markTarget: target.playerId, scheme: 'man' } } },
      };
    }
    const binding = SPATIAL_BINDINGS[cmd.intent as PlayerIntent];
    if (binding){
      // spatial instructions address YOUR player
      if (cmd.target!.side !== 'own')
        return { ok: false, reason: 'spatial orders are for YOUR players — name one of your own' };
      const target = resolvePlayerRef(cmd.target!, ctx);
      if (!target.ok) return { ok: false, reason: target.reason };
      // mirror the engine's goalkeeper rule with a friendlier front door
      // (the engine still enforces it — this answers before a round trip)
      const role = ctx.own.players.find(p => p.playerId === target.playerId)?.role;
      if (role === 'GK')
        return { ok: false, reason: `${target.name.split(/\s+/).pop()}: the goalkeeper keeps his post` };
      // G5: a spoken duration WINS over the binding's default spell length
      const ttlTicks = cmd.durationMinutes !== undefined
        ? ttlFromMinutes(cmd.durationMinutes)
        : binding.ttlTicks;
      return {
        ok: true,
        ack: `${target.name.split(/\s+/).pop()!.toUpperCase()} → ${binding.ack}`
          + (cmd.durationMinutes ? ` ${cmd.durationMinutes}'` : '') + ' ✓',
        wire: {
          kind: 'player_instruction', playerId: target.playerId, instruction: binding.kind,
          ...(ttlTicks !== undefined ? { ttlTicks } : {}),
        },
      };
    }

    // reserved player instructions: resolve the target anyway so name errors
    // surface now (a typo should not masquerade as "unsupported")
    const target = resolvePlayerRef(cmd.target!, ctx);
    if (!target.ok) return { ok: false, reason: target.reason };
    const reason = RESERVED_REASONS[cmd.intent as PlayerIntent] ?? 'not on the pitch yet';
    return { ok: false, reason: `${target.name.split(/\s+/).pop()}: ${reason}` };
  }

  // match scope
  if (cmd.intent === 'change_formation')
    return { ok: true, ack: `FORMATION → ${cmd.formation!.split('').join('-')}`,
      wire: { kind: 'tactical', payload: { type: 'patch', patch: { formation: cmd.formation! } } } };

  // substitution: both refs resolve on OUR side; the engine remains the
  // authority on bench membership, sub limits, and match state
  const out = resolvePlayerRef({ ...cmd.sub!.out, side: 'own' }, ctx);
  if (!out.ok) return { ok: false, reason: `off: ${out.reason}` };
  const on = resolvePlayerRef({ ...cmd.sub!.in, side: 'own' }, ctx);
  if (!on.ok) return { ok: false, reason: `on: ${on.reason}` };
  return {
    ok: true,
    ack: `SUB ${out.name.split(/\s+/).pop()!.toUpperCase()} → ${on.name.split(/\s+/).pop()!.toUpperCase()}`,
    wire: { kind: 'substitution', playerOut: out.playerId, playerIn: on.playerId },
  };
}

// ---------------------------------------------------------------------------
// compact interpreter context (STEP 6: never dump full sim state)
// ---------------------------------------------------------------------------

/** The roster digest an interpreter needs to resolve references — name,
 *  shirt, role. ~15 short rows per side; nothing else. */
export const rosterDigest = (team: TeamSnapshot): Array<{ shirt: number; name: string; role: Role }> =>
  team.players.map(p => ({ shirt: p.shirtNumber, name: p.name, role: p.role }));
