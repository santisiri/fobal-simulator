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
// Command lifetime semantics (v1): every compiled tactical intent is
// PERSISTENT-UNTIL-REPLACED — it patches the team's tactical state, and the
// next order touching the same fields overwrites it (no accumulation, no
// contradiction pile-up: last order wins per field). Substitutions are
// INSTANT. Timed instructions ("for the next five minutes") are a
// documented non-goal until the engine can expire state.
import { z } from 'zod';
import { Formation, Role } from './core.js';
import { TacticalPatch, TeamSnapshot } from './match.js';

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

/** Player intents that bind to the engine's per-player instruction state
 *  (G3, tactics.ts). The mapping is spatial truth, not synonyms: an intent
 *  the wire cannot express stays RESERVED and rejects honestly — the
 *  vocabulary grows only as fast as the simulation can honor it. */
const PLAYER_BINDINGS: Partial<Record<PlayerIntent, {
  instruction: 'stay_wide' | 'stay_central' | 'push_forward' | 'drop_back' | 'overlap' | 'hold_position';
  ack: string;
  /** short-lived runs expire on their own (600 ticks ≈ 10 real seconds) */
  ttlTicks?: number;
}>> = {
  stay_wide: { instruction: 'stay_wide', ack: 'WIDE' },
  cut_inside: { instruction: 'stay_central', ack: 'INSIDE' },
  overlap: { instruction: 'overlap', ack: 'OVERLAP', ttlTicks: 600 },
  hold_position: { instruction: 'hold_position', ack: 'HOLD' },
  make_forward_runs: { instruction: 'push_forward', ack: 'PUSH ON' },
  come_short: { instruction: 'drop_back', ack: 'COME SHORT' },
};

/** Reserved player intents: named in the taxonomy, validated, honestly
 *  rejected until the engine grows the state they need. */
const RESERVED_REASON = 'not on the pitch yet — the squad cannot take that order';

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
            instruction: 'stay_wide' | 'stay_central' | 'push_forward' | 'drop_back' | 'overlap' | 'hold_position';
            ttlTicks?: number } }
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
      return {
        ok: true,
        ack: `MARK #${target.shirtNumber} ${target.name.split(/\s+/).pop()!.toUpperCase()} ✓`,
        wire: { kind: 'tactical', payload: { type: 'patch', patch: { markTarget: target.playerId, scheme: 'man' } } },
      };
    }
    // spatial instructions address YOUR OWN players — resolve first so a
    // typo surfaces as a name problem, not a side problem
    if (cmd.target!.side !== 'own')
      return { ok: false, reason: 'you can only instruct your own players — marking is the exception' };
    const target = resolvePlayerRef(cmd.target!, ctx);
    if (!target.ok) return { ok: false, reason: target.reason };
    const surname = target.name.split(/\s+/).pop()!;

    const binding = PLAYER_BINDINGS[cmd.intent as PlayerIntent];
    if (!binding)
      return { ok: false, reason: `${surname}: ${RESERVED_REASON}` };

    // the engine refuses non-clear instructions for the keeper — say it
    // here, at ask time, instead of surfacing a server rejection later
    const role = ctx.own.players.find(p => p.playerId === target.playerId)?.role;
    if (role === 'GK')
      return { ok: false, reason: `${surname} is your keeper — he holds his line` };

    return {
      ok: true,
      ack: `${surname.toUpperCase()} ${binding.ack} ✓`,
      wire: {
        kind: 'player_instruction',
        playerId: target.playerId,
        instruction: binding.instruction,
        ...(binding.ttlTicks ? { ttlTicks: binding.ttlTicks } : {}),
      },
    };
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
