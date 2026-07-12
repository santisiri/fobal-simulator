import { z } from 'zod';
import {
  ExternalId, Formation, MatchId, MatchStateName, PlayerId, Role, Seed, Seq,
  TeamId, Tick, Vec2, Vec3, PROTOCOL_VERSION,
} from './core.js';

// ---------------------------------------------------------------------------
// TacticalState — mirrors the golden engine's team.tactics surface exactly
// (see tests/characterization/goldens.json#tacticsDefaults).
// ---------------------------------------------------------------------------
const Unit = z.number().min(0).max(1);
export const TacticalState = z.object({
  formation: Formation,
  width: Unit,
  scheme: z.enum(['zonal', 'man']),
  trap: Unit,
  tempo: Unit,
  crossing: Unit,
  shootTendency: Unit,
  overlap: Unit,
  counter: Unit,
  timeWaste: Unit,
  pressAfterLoss: Unit,
  defAggression: Unit,
  gkLong: Unit,
  attackSide: z.enum(['left', 'right', 'both']),
  markTarget: PlayerId.nullable(),
  mentality: Unit,
  defLine: Unit,
  pressing: Unit,
  risk: Unit,
  compactness: Unit,
  style: z.enum(['direct', 'possession', 'counter', 'mixed']).or(z.string().min(1).max(24)),
});
export type TacticalState = z.infer<typeof TacticalState>;

export const TacticalPatch = TacticalState.partial();
export type TacticalPatch = z.infer<typeof TacticalPatch>;

// ---------------------------------------------------------------------------
// PlayerSnapshot — an official player as supplied by the platform. Ratings are
// EXTERNAL 0–100 integers; the engine adapter normalizes them to its internal
// 0..1 attribute space in exactly one place.
// ---------------------------------------------------------------------------
export const Rating = z.number().int().min(0).max(100);

export const PlayerRatings = z.object({
  pace: Rating, accel: Rating, stamina: Rating, strength: Rating,
  passing: Rating, shooting: Rating, tackling: Rating, dribbling: Rating,
  vision: Rating, positioning: Rating, aggression: Rating, composure: Rating,
  gk: Rating,
});
export type PlayerRatings = z.infer<typeof PlayerRatings>;

export const PlayerSnapshot = z.object({
  playerId: PlayerId,
  name: z.string().min(1).max(48),
  shirtNumber: z.number().int().min(1).max(99),
  role: Role,
  ratings: PlayerRatings,
  nationality: z.string().length(2).optional(),   // ISO 3166-1 alpha-2
  age: z.number().int().min(15).max(50).optional(),
  heightCm: z.number().int().min(150).max(220).optional(),
  weightKg: z.number().int().min(45).max(120).optional(),
  appearance: z.object({
    skin: z.string().max(16).optional(),
    hair: z.string().max(16).optional(),
  }).optional(),
});
export type PlayerSnapshot = z.infer<typeof PlayerSnapshot>;

// ---------------------------------------------------------------------------
// TeamSnapshot — an official team as supplied by the platform.
// ---------------------------------------------------------------------------
export const TeamSnapshot = z.object({
  teamId: TeamId,
  name: z.string().min(1).max(32),
  colors: z.object({
    primary: z.string().max(16).optional(),
    secondary: z.string().max(16).optional(),
  }).optional(),
  formation: Formation.optional(),
  tactics: TacticalPatch.optional(),
  players: z.array(PlayerSnapshot).min(11).max(18),
}).superRefine((team, ctx) => {
  const ids = new Set<string>();
  for (const p of team.players){
    if (ids.has(p.playerId))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate playerId ${p.playerId}` });
    ids.add(p.playerId);
  }
  const numbers = new Set<number>();
  for (const p of team.players){
    if (numbers.has(p.shirtNumber))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate shirt number ${p.shirtNumber}` });
    numbers.add(p.shirtNumber);
  }
  if (!team.players.slice(0, 11).some(p => p.role === 'GK'))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'starting XI needs a GK' });
});
export type TeamSnapshot = z.infer<typeof TeamSnapshot>;

// ---------------------------------------------------------------------------
// MatchManifest — the FROZEN input that fully determines an official match
// (together with the ordered command log).
// ---------------------------------------------------------------------------
export const MatchManifest = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  matchId: MatchId,
  seed: Seed,
  createdAt: z.string().datetime(),
  rules: z.object({
    ceremonies: z.boolean().default(true),
    autoGoalReplays: z.boolean().default(true),
  }).default({ ceremonies: true, autoGoalReplays: true }),
  environment: z.object({
    grass: z.string().max(24).optional(),
    weather: z.string().max(24).optional(),
  }).optional(),                                   // omitted → derived from seed
  teams: z.tuple([TeamSnapshot, TeamSnapshot]),
}).superRefine((m, ctx) => {
  if (m.teams[0].teamId === m.teams[1].teamId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'teams must have distinct ids' });
  const a = new Set(m.teams[0].players.map(p => p.playerId));
  for (const p of m.teams[1].players)
    if (a.has(p.playerId))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `playerId ${p.playerId} appears in both teams` });
});
export type MatchManifest = z.infer<typeof MatchManifest>;

// ---------------------------------------------------------------------------
// Commands — the only way anything exogenous enters an official match.
// Every accepted command is assigned a server sequence number and an
// effective tick; the engine applies it exactly at that tick.
// ---------------------------------------------------------------------------
export const TacticalCommand = z.object({
  kind: z.literal('tactical'),
  commandId: ExternalId,
  teamId: TeamId,
  payload: z.discriminatedUnion('type', [
    z.object({ type: z.literal('patch'), patch: TacticalPatch }),
    z.object({ type: z.literal('coach_text'), text: z.string().min(1).max(280) }),
  ]),
});
export type TacticalCommand = z.infer<typeof TacticalCommand>;

export const SubstitutionCommand = z.object({
  kind: z.literal('substitution'),
  commandId: ExternalId,
  teamId: TeamId,
  playerOut: PlayerId,
  playerIn: PlayerId,
});
export type SubstitutionCommand = z.infer<typeof SubstitutionCommand>;

export const Command = z.discriminatedUnion('kind', [TacticalCommand, SubstitutionCommand]);
export type Command = z.infer<typeof Command>;

/** A command the server accepted: sequenced and scheduled. */
export const AcceptedCommand = z.object({
  seq: Seq,
  effectiveTick: Tick,
  receivedAtTick: Tick,
  command: Command,
});
export type AcceptedCommand = z.infer<typeof AcceptedCommand>;

// ---------------------------------------------------------------------------
// MatchEvent — semantic events emitted by the engine, external ids only.
// ---------------------------------------------------------------------------
export const MatchEventType = z.enum([
  'kickoff', 'goal', 'shot', 'save', 'pass_complete', 'interception', 'tackle',
  'foul', 'card', 'substitution', 'offside', 'restart', 'halftime', 'fulltime',
  'tactic_change', 'header', 'cross', 'gk_catch', 'gk_parry', 'clearance', 'other',
]);
export type MatchEventType = z.infer<typeof MatchEventType>;

export const MatchEvent = z.object({
  seq: Seq,
  tick: Tick,
  clock: z.string().regex(/^\d{1,3}:\d{2}$/),
  type: MatchEventType,
  teamId: TeamId.optional(),
  playerId: PlayerId.optional(),
  targetId: PlayerId.optional(),
  position: Vec2.optional(),
  data: z.record(z.unknown()).optional(),
});
export type MatchEvent = z.infer<typeof MatchEvent>;

// ---------------------------------------------------------------------------
// Runtime state: snapshots and deltas.
// ---------------------------------------------------------------------------
export const PlayerRuntime = z.object({
  playerId: PlayerId,
  position: Vec2,
  velocity: Vec2,
  facing: z.number().finite(),
  stamina: Unit,
  action: z.string().max(24),
  onPitch: z.boolean(),
  yellow: z.number().int().min(0).max(2).default(0),
  red: z.boolean().default(false),
});
export type PlayerRuntime = z.infer<typeof PlayerRuntime>;

export const TeamRuntime = z.object({
  teamId: TeamId,
  tactics: TacticalState,
  stats: z.object({
    shots: z.number().int().min(0),
    onTarget: z.number().int().min(0),
    passAtt: z.number().int().min(0),
    passCmp: z.number().int().min(0),
    possessionSeconds: z.number().min(0),
    fouls: z.number().int().min(0),
  }),
  subsUsed: z.number().int().min(0),
});
export type TeamRuntime = z.infer<typeof TeamRuntime>;

export const StateSnapshot = z.object({
  tick: Tick,
  clock: z.string().regex(/^\d{1,3}:\d{2}$/),
  matchState: MatchStateName,
  score: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  half: z.number().int().min(1).max(2),
  ball: z.object({ position: Vec3, velocity: Vec3 }),
  players: z.array(PlayerRuntime),
  teams: z.tuple([TeamRuntime, TeamRuntime]),
  stateHash: z.string().length(8),
});
export type StateSnapshot = z.infer<typeof StateSnapshot>;

/** Sparse update between snapshots. Anything omitted is unchanged. */
export const StateDelta = z.object({
  tick: Tick,
  matchState: MatchStateName.optional(),
  score: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
  clock: z.string().regex(/^\d{1,3}:\d{2}$/).optional(),
  ball: z.object({ position: Vec3, velocity: Vec3.optional() }).optional(),
  players: z.array(z.object({
    playerId: PlayerId,
    position: Vec2.optional(),
    facing: z.number().finite().optional(),
    action: z.string().max(24).optional(),
    stamina: Unit.optional(),
    onPitch: z.boolean().optional(),
  })).optional(),
});
export type StateDelta = z.infer<typeof StateDelta>;

// ---------------------------------------------------------------------------
// MatchResult — final, signable outcome. `signature` covers the canonical
// JSON of everything except the signature field itself.
// ---------------------------------------------------------------------------
export const MatchResult = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  matchId: MatchId,
  seed: Seed,
  finalScore: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  teams: z.tuple([TeamId, TeamId]),
  goals: z.array(z.object({
    tick: Tick, clock: z.string(), teamId: TeamId, playerId: PlayerId.nullable(),
  })),
  stats: z.tuple([TeamRuntime.shape.stats, TeamRuntime.shape.stats]),
  cards: z.array(z.object({
    tick: Tick, teamId: TeamId, playerId: PlayerId, card: z.enum(['yellow', 'second_yellow', 'red']),
  })),
  finalTick: Tick,
  finalStateHash: z.string().length(8),
  commandLogHash: z.string().length(8),
  signature: z.object({
    algorithm: z.literal('Ed25519'),
    publicKey: z.string(),        // base64
    value: z.string(),            // base64 over canonicalJson(result minus signature)
  }).optional(),
});
export type MatchResult = z.infer<typeof MatchResult>;

// ---------------------------------------------------------------------------
// ReplayFile — manifest + ordered command log reproduces the match; events,
// snapshots and result are included for convenience and cross-checking.
// ---------------------------------------------------------------------------
export const ReplayFile = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  kind: z.literal('fobal-replay'),
  manifest: MatchManifest,
  commands: z.array(AcceptedCommand),
  events: z.array(MatchEvent).optional(),
  snapshots: z.array(StateSnapshot).optional(),
  finalStateHash: z.string().length(8),
  result: MatchResult.optional(),
});
export type ReplayFile = z.infer<typeof ReplayFile>;
