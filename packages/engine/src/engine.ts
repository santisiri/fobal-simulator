// MatchEngine — the authoritative, headless match runtime.
//
// - accepts a frozen MatchManifest (validated, deep-frozen at construction)
// - advances in fixed 1/60s ticks, never on wall-clock
// - all randomness flows through the golden core's seeded RNG
// - exogenous input enters ONLY as AcceptedCommands applied at their
//   effective tick, so `manifest + ordered command log` reproduces the match
// - emits protocol MatchEvents, StateSnapshots and StateDeltas with external
//   ids exclusively, and produces a deterministic final-state hash
import {
  AcceptedCommand, Command, MatchEvent, MatchManifest, MatchResult, MatchStateName,
  PROTOCOL_VERSION, StateDelta, StateSnapshot, TacticalState,
} from '@fobal/protocol';
import { canonicalJson, fnv1a } from '@fobal/protocol';
import { bootGoldenCore, GoldenHandle, officialHash } from './goldenRuntime.js';
import { imposeManifest, translateTactics } from './adapter.js';
import { IdMap } from './ids.js';
import { EventTap, formatClock } from './events.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SubmitOutcome { accepted: boolean; reason?: string }

export interface CapturedState {
  tick: number;
  state: unknown;
  appliedThroughSeq: number;
  eventSeq: number;
  goals?: unknown[];
  events?: unknown[];
}

interface GoalRecord { tick: number; clock: string; teamIdx: 0 | 1; playerId: string | null }

const MAX_MATCH_TICKS = 60 * 60 * 8; // hard cap: no golden match approaches this

export class MatchEngine {
  readonly manifest: MatchManifest | null;
  private handle: GoldenHandle;
  private ids: IdMap;
  private tap: EventTap;
  private pending: AcceptedCommand[] = [];
  private appliedCommands: AcceptedCommand[] = [];
  private goals: GoalRecord[] = [];
  private lastScore: [number, number] = [0, 0];
  private lastState: string;
  private deltaCache = new Map<string, { x: number; y: number; facing: number; action: string; stamina: number; onPitch: boolean }>();

  private constructor(handle: GoldenHandle, ids: IdMap, manifest: MatchManifest | null){
    this.handle = handle;
    this.ids = ids;
    this.manifest = manifest;
    this.tap = new EventTap(handle, ids);
    this.tap.install();
    this.lastState = handle.game.match.state;
  }

  /** Official constructor: a validated manifest fully determines the match. */
  static create(rawManifest: unknown): MatchEngine {
    const manifest = MatchManifest.parse(rawManifest);
    deepFreeze(manifest);
    const handle = bootGoldenCore({ cosmeticSeed: manifest.seed ^ 0x5eed });
    const { ids } = imposeManifest(handle, manifest);
    return new MatchEngine(handle, ids, manifest);
  }

  /**
   * Parity/dev mode: pure golden match from a bare seed — squads and
   * environment exactly as the demo generates them, external ids equal to
   * internal pids. Used to prove the wrapped core is bit-identical to the
   * golden reference. Official servers always use create(manifest).
   */
  static createFromSeed(seed: number): MatchEngine {
    const handle = bootGoldenCore({ cosmeticSeed: 0xf0ba1 });
    handle.reset(seed);
    const ids = new IdMap();
    ids.bindTeam('home', 0); ids.bindTeam('away', 1);
    for (const idx of [0, 1] as const)
      for (const p of [...handle.game.teams[idx].players, ...(handle.game.teams[idx].bench ?? [])])
        ids.bindPlayer(p.pid, p.pid);
    return new MatchEngine(handle, ids, null);
  }

  get currentTick(): number { return this.handle.game.simTick; }
  get matchState(): MatchStateName { return this.handle.game.match.state; }
  get score(): [number, number] { return [this.handle.game.match.score[0], this.handle.game.match.score[1]]; }
  isOver(): boolean { return this.matchState === 'FULLTIME'; }

  /**
   * Queue an accepted command. The server (or local session) is responsible
   * for sequencing; the engine enforces application order (effectiveTick,
   * then seq) and validates references against the manifest.
   */
  submit(cmd: AcceptedCommand): SubmitOutcome {
    const parsed = AcceptedCommand.safeParse(cmd);
    if (!parsed.success) return { accepted: false, reason: 'malformed command' };
    const c = parsed.data;
    if (this.isOver()) return { accepted: false, reason: 'match is over' };
    if (c.effectiveTick < this.currentTick)
      return { accepted: false, reason: `effectiveTick ${c.effectiveTick} is in the past (now ${this.currentTick})` };
    const check = this.validateCommand(c.command);
    if (!check.accepted) return check;
    this.pending.push(c);
    this.pending.sort((a, b) => a.effectiveTick - b.effectiveTick || a.seq - b.seq);
    return { accepted: true };
  }

  /** Validation without queueing — lets callers persist-before-apply. */
  validate(cmd: AcceptedCommand): SubmitOutcome {
    const parsed = AcceptedCommand.safeParse(cmd);
    if (!parsed.success) return { accepted: false, reason: 'malformed command' };
    if (this.isOver()) return { accepted: false, reason: 'match is over' };
    if (parsed.data.effectiveTick < this.currentTick)
      return { accepted: false, reason: `effectiveTick ${parsed.data.effectiveTick} is in the past (now ${this.currentTick})` };
    return this.validateCommand(parsed.data.command);
  }

  private validateCommand(command: Command): SubmitOutcome {
    let teamIdx: 0 | 1;
    try { teamIdx = this.ids.teamIndex(command.teamId); }
    catch { return { accepted: false, reason: `unknown teamId ${command.teamId}` }; }
    if (command.kind === 'substitution'){
      if (!this.ids.hasExternal(command.playerOut) || !this.ids.hasExternal(command.playerIn))
        return { accepted: false, reason: 'unknown player in substitution' };
      const team = this.handle.game.teams[teamIdx];
      const onPitch = team.players.some((p: any) => p.pid === this.ids.pid(command.playerOut));
      const onBench = (team.bench ?? []).some((p: any) => p.pid === this.ids.pid(command.playerIn));
      if (!onPitch) return { accepted: false, reason: `${command.playerOut} is not on the pitch for ${command.teamId}` };
      if (!onBench) return { accepted: false, reason: `${command.playerIn} is not on ${command.teamId}'s bench` };
    }
    if (command.kind === 'tactical' && command.payload.type === 'patch' && command.payload.patch.markTarget){
      if (!this.ids.hasExternal(command.payload.patch.markTarget))
        return { accepted: false, reason: 'unknown markTarget player' };
    }
    return { accepted: true };
  }

  /** Advance exactly one fixed tick, applying commands due at this tick first. */
  tick(): void {
    const game = this.handle.game;
    while (this.pending.length && this.pending[0]!.effectiveTick <= game.simTick){
      const cmd = this.pending.shift()!;
      this.applyNow(cmd);
      this.appliedCommands.push(cmd);
    }
    game.step();
    this.observeTransitions();
  }

  run(ticks: number): void { for (let i = 0; i < ticks && !this.isOver(); i++) this.tick(); }

  runToFullTime(): void {
    let guard = 0;
    while (!this.isOver() && guard++ < MAX_MATCH_TICKS) this.tick();
    if (!this.isOver()) throw new Error('match failed to reach FULLTIME within the tick cap');
  }

  private applyNow(cmd: AcceptedCommand): void {
    const game = this.handle.game;
    const command = cmd.command;
    const teamIdx = this.ids.teamIndex(command.teamId);
    const team = game.teams[teamIdx];
    if (command.kind === 'tactical'){
      const TacticalEngine = this.handle.evalIn('TacticalEngine');
      if (command.payload.type === 'patch'){
        TacticalEngine.apply(game, team, translateTactics(command.payload.patch, this.ids), 'command');
      } else {
        const parseCoach = this.handle.evalIn('parseCoach');
        const { script, msgs } = parseCoach(command.payload.text, team);
        if (msgs.length) TacticalEngine.apply(game, team, script, msgs.join(' · '));
        else this.tap.emitSynthetic('other', { commandId: command.commandId, coachText: 'not understood' });
      }
    } else if (command.kind === 'substitution'){
      const out = this.findByPid(team, this.ids.pid(command.playerOut));
      const sub = this.findByPid(team, this.ids.pid(command.playerIn));
      const ok = out && sub ? game.performSub(team, out, sub) : false;
      if (!ok) this.tap.emitSynthetic('other', { commandId: command.commandId, substitution: 'not applicable' });
    }
  }

  private findByPid(team: any, pid: string): any {
    return [...team.players, ...(team.bench ?? [])].find((p: any) => p.pid === pid) ?? null;
  }

  private observeTransitions(): void {
    const game = this.handle.game;
    // never observe inside a replay excursion: the cinematic rollback (only
    // reachable in seed/parity mode) rewinds and re-plays the score
    if (game.replayMode) return;
    const state = game.match.state;
    if (state !== this.lastState){
      if (state === 'HALFTIME') this.tap.emitSynthetic('halftime');
      if (state === 'FULLTIME') this.tap.emitSynthetic('fulltime');
      this.lastState = state;
    }
    const score = game.match.score;
    for (const idx of [0, 1] as const){
      if (score[idx] > this.lastScore[idx]){
        const goalEv = [...this.tap.events].reverse().find(e => e.type === 'goal' && e.tick >= game.simTick - 3);
        this.goals.push({
          tick: game.simTick,
          clock: formatClock(game.match.tMatch),
          teamIdx: idx,
          playerId: goalEv?.playerId ?? null,
        });
      }
      this.lastScore[idx] = score[idx];
    }
  }

  // ---- protocol-shaped views -------------------------------------------

  events(sinceSeq = 0): MatchEvent[] { return this.tap.eventsSince(sinceSeq); }

  private playersRuntime(): StateSnapshot['players'] {
    const game = this.handle.game;
    const out: StateSnapshot['players'] = [];
    for (const idx of [0, 1] as const){
      const team = game.teams[idx];
      const groups: Array<[any[], boolean]> = [
        [team.players, true], [team.bench ?? [], false], [team.offList ?? [], false],
      ];
      for (const [group, onPitch] of groups){
        for (const p of group){
          const ext = this.ids.externalOrNull(p.pid);
          if (!ext) continue; // never leak an unbound internal entity
          out.push({
            playerId: ext,
            position: { x: p.pos.x, y: p.pos.y },
            velocity: { x: p.vel.x, y: p.vel.y },
            facing: p.facing ?? 0,
            stamina: clamp01(p.stamina ?? 1),
            action: String(p.action ?? 'idle'),
            onPitch,
            yellow: Math.min(2, p.stats?.yellow ?? 0),
            red: (p.stats?.red ?? 0) > 0,
          });
        }
      }
    }
    return out;
  }

  private teamRuntime(idx: 0 | 1): StateSnapshot['teams'][number] {
    const game = this.handle.game;
    const t = game.teams[idx];
    const T = t.tactics;
    const tactics = TacticalState.parse({
      formation: t.assignedFormation ?? T.formation ?? '442',
      width: clamp01(T.width), scheme: T.scheme, trap: clamp01(T.trap ?? 0),
      tempo: clamp01(T.tempo), crossing: clamp01(T.crossing), shootTendency: clamp01(T.shootTendency),
      overlap: clamp01(T.overlap), counter: clamp01(T.counter), timeWaste: clamp01(T.timeWaste),
      pressAfterLoss: clamp01(T.pressAfterLoss), defAggression: clamp01(T.defAggression),
      gkLong: clamp01(T.gkLong), attackSide: T.attackSide ?? 'both',
      markTarget: this.ids.externalOrNull(T.markTarget),
      mentality: clamp01(T.mentality), defLine: clamp01(T.defLine), pressing: clamp01(T.pressing),
      risk: clamp01(T.risk), compactness: clamp01(T.compactness), style: T.style ?? 'direct',
    });
    return {
      teamId: this.ids.teamExternal(idx),
      tactics,
      stats: {
        shots: t.shots, onTarget: t.onTarget, passAtt: t.passAtt, passCmp: t.passCmp,
        possessionSeconds: t.possT, fouls: t.fouls,
      },
      subsUsed: t.subsUsed,
    };
  }

  snapshot(): StateSnapshot {
    const game = this.handle.game;
    return StateSnapshot.parse({
      tick: game.simTick,
      clock: formatClock(game.match.tMatch),
      matchState: game.match.state,
      score: [game.match.score[0], game.match.score[1]],
      half: game.match.half,
      ball: {
        position: { x: game.ball.x, y: game.ball.y, z: game.ball.z },
        velocity: { x: game.ball.vx, y: game.ball.vy, z: game.ball.vz },
      },
      players: this.playersRuntime(),
      teams: [this.teamRuntime(0), this.teamRuntime(1)],
      stateHash: this.finalStateHash(),
    });
  }

  /** Sparse delta since the previous drain (first call is a full baseline). */
  drainDelta(): StateDelta {
    const game = this.handle.game;
    const players: NonNullable<StateDelta['players']> = [];
    for (const p of this.playersRuntime()){
      const prev = this.deltaCache.get(p.playerId);
      const cur = { x: p.position.x, y: p.position.y, facing: p.facing, action: p.action, stamina: p.stamina, onPitch: p.onPitch };
      if (!prev || Math.hypot(prev.x - cur.x, prev.y - cur.y) > 0.01 || prev.action !== cur.action
        || Math.abs(prev.stamina - cur.stamina) > 0.005 || prev.facing !== cur.facing || prev.onPitch !== cur.onPitch){
        players.push({
          playerId: p.playerId, position: p.position, facing: p.facing,
          action: p.action, stamina: p.stamina, onPitch: p.onPitch,
        });
        this.deltaCache.set(p.playerId, cur);
      }
    }
    return StateDelta.parse({
      tick: game.simTick,
      matchState: game.match.state,
      score: [game.match.score[0], game.match.score[1]],
      clock: formatClock(game.match.tMatch),
      ball: {
        position: { x: game.ball.x, y: game.ball.y, z: game.ball.z },
        velocity: { x: game.ball.vx, y: game.ball.vy, z: game.ball.vz },
      },
      ...(players.length ? { players } : {}),
    });
  }

  finalStateHash(): string { return officialHash(this.handle); }

  commandLogHash(): string {
    return fnv1a(canonicalJson(this.appliedCommands.concat(this.pending)));
  }

  /** Unsigned result — the server signs it. Requires FULLTIME. */
  result(): MatchResult {
    if (!this.isOver()) throw new Error('result() requires FULLTIME');
    const game = this.handle.game;
    const cards = this.tap.events
      .filter(e => e.type === 'card' && e.playerId)
      .map(e => ({
        tick: e.tick,
        teamId: e.teamId ?? this.ids.teamExternal(0),
        playerId: e.playerId!,
        card: (e.data?.card === 'red2' ? 'second_yellow' : e.data?.card === 'red' ? 'red' : 'yellow') as 'yellow' | 'second_yellow' | 'red',
      }));
    return MatchResult.parse({
      protocolVersion: PROTOCOL_VERSION,
      matchId: this.manifest?.matchId ?? `seed-${game.matchSeed >>> 0}`,
      seed: this.manifest?.seed ?? game.matchSeed >>> 0,
      finalScore: [game.match.score[0], game.match.score[1]],
      teams: [this.ids.teamExternal(0), this.ids.teamExternal(1)],
      goals: this.goals.map(g => ({
        tick: g.tick, clock: g.clock, teamId: this.ids.teamExternal(g.teamIdx), playerId: g.playerId,
      })),
      stats: [this.teamRuntime(0).stats, this.teamRuntime(1).stats],
      cards,
      finalTick: game.simTick,
      finalStateHash: this.finalStateHash(),
      commandLogHash: this.commandLogHash(),
    });
  }

  // ---- internal snapshot recovery (server crash-resume) -----------------

  /**
   * Complete golden-core state capture (JSON-safe). Together with the
   * manifest and the applied-command log this allows O(1) mid-match
   * recovery; replaying the command log from tick 0 is the always-available
   * fallback.
   */
  captureInternalState(): CapturedState {
    // a capture taken mid-excursion would persist the rolled-back timeline
    // as authoritative (unreachable in official mode — defense in depth)
    if (this.handle.game.replayMode)
      throw new Error('cannot capture internal state during a replay excursion');
    // serialize inside the vm so every object stays same-realm
    const state = JSON.parse(this.handle.evalIn('JSON.stringify(SnapshotManager.capture(game))'));
    const applied = this.appliedCommands;
    return {
      tick: this.currentTick,
      state,
      appliedThroughSeq: applied.length ? applied[applied.length - 1]!.seq : -1,
      eventSeq: this.tap.nextSeq(),
      // result bookkeeping lives host-side and must survive recovery, or a
      // resumed match signs a result missing pre-crash goals and cards
      goals: JSON.parse(JSON.stringify(this.goals)),
      events: JSON.parse(JSON.stringify(this.tap.events)),
    };
  }

  /**
   * Restore a captured internal state onto a fresh engine built from the
   * SAME manifest. Commands with seq <= appliedThroughSeq are recorded as
   * applied (their effects live inside the snapshot); later ones queue.
   */
  restoreInternalState(captured: CapturedState, commandLog: AcceptedCommand[]): void {
    const restoreJson = this.handle.evalIn('(json => SnapshotManager.restore(game, JSON.parse(json)))');
    restoreJson(JSON.stringify(captured.state));
    this.pending = [];
    this.appliedCommands = commandLog.filter(c => c.seq <= captured.appliedThroughSeq);
    for (const c of commandLog.filter(c => c.seq > captured.appliedThroughSeq)){
      const outcome = this.submit(c);
      if (!outcome.accepted) throw new Error(`restore: command seq ${c.seq} rejected: ${outcome.reason}`);
    }
    this.lastState = this.handle.game.match.state;
    this.lastScore = [this.handle.game.match.score[0], this.handle.game.match.score[1]];
    this.deltaCache.clear();
    this.goals = (captured.goals ?? []) as GoalRecord[];
    this.tap.restore(captured.eventSeq, (captured.events ?? []) as MatchEvent[]);
  }

  /** Reproduce a match from its manifest + ordered command log. */
  static replay(manifest: unknown, commands: AcceptedCommand[]): MatchEngine {
    const engine = MatchEngine.create(manifest);
    for (const cmd of [...commands].sort((a, b) => a.seq - b.seq)){
      const outcome = engine.submit(cmd);
      if (!outcome.accepted) throw new Error(`replay: command seq ${cmd.seq} rejected: ${outcome.reason}`);
    }
    engine.runToFullTime();
    return engine;
  }
}

function clamp01(v: number): number { return Math.min(1, Math.max(0, v ?? 0)); }

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object'){
    Object.freeze(obj);
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
  }
  return obj;
}
