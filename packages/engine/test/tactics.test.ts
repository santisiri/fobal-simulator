// Workstream G — tactical execution scenarios. Every test is a controlled
// experiment: same manifest, same seed, one commanded difference — and the
// assertions are about BEHAVIOR (realized positions, distances, stamina),
// not about internal wiring. The core claims under test:
//
//   1. commands change behavior          (intent is honored)
//   2. attributes bound the change       (capability is respected)
//   3. everything stays deterministic    (replay/resume-identical)
//
// The runs are seeded, so measured quantities are exactly reproducible;
// the inequalities asserted here are properties of those specific runs.
import { describe, expect, test } from 'vitest';
import { MatchEngine } from '../src/index.js';
import { sampleManifest } from '@fobal/protocol/samples';
import type { Command, MatchManifest } from '@fobal/protocol';

// sample squads (ROLES_XI): 01 GK, 02-03 CB, 04 LB, 05 RB, 06-07 CM,
// 08 LM, 09 RM, 10-11 ST — stable ids we can address by football role
const P = (team: 'rhinos' | 'comets', n: number) =>
  `${team}-player-${String(n).padStart(2, '0')}`;
const HOME = 'team-rhinos', AWAY = 'team-comets';

let seqCounter = 0;
function send(engine: MatchEngine, command: Command, tick: number): void {
  const outcome = engine.submit({
    seq: ++seqCounter, effectiveTick: tick, receivedAtTick: tick, command,
  });
  if (!outcome.accepted) throw new Error(`command rejected: ${outcome.reason}`);
}

const instruction = (
  playerId: string, kind: Command extends infer _ ? string : never, extra: Record<string, unknown> = {},
): Command => ({
  kind: 'player_instruction',
  commandId: `gi-${++seqCounter}`,
  teamId: HOME,
  playerId,
  instruction: kind,
  ...extra,
} as Command);

function manifest(overrides: Partial<MatchManifest> = {}): MatchManifest {
  return sampleManifest({ matchId: `tac-${Math.abs(seqCounter)}`, seed: 4242, ...overrides });
}

/** run in steps, sampling one player's world position every `every` ticks */
function meanPosition(engine: MatchEngine, playerId: string, ticks: number, every = 30):
  { x: number; y: number } {
  let sx = 0, sy = 0, n = 0;
  for (let t = 0; t < ticks; t += every) {
    engine.run(every);
    const p = engine.snapshot().players.find(q => q.playerId === playerId)!;
    sx += p.position.x; sy += p.position.y; n++;
  }
  return { x: sx / n, y: sy / n };
}

function meanTeamStamina(engine: MatchEngine, prefix: string): number {
  const players = engine.snapshot().players.filter(p => p.playerId.startsWith(prefix) && p.onPitch);
  return players.reduce((a, p) => a + p.stamina, 0) / players.length;
}

const PITCH_CENTER_Y = 34;   // CFG.PITCH_W / 2 in golden world units

describe('workstream G — tactical execution', () => {
  test('press_high raises the DEFENSIVE ENGAGEMENT LINE (out of possession)', () => {
    // the honest metric: how far from its own goal the back line defends
    // when the OTHER team has the ball — sampled during defensive phases
    // only, so possession chaos cannot masquerade as tactics
    const defLineHeight = (seed: number, press: boolean): number => {
      const engine = MatchEngine.create(manifest({ seed }));
      const game = (engine as any).handle.game;
      const t0 = game.teams[0];
      if (press) send(engine, {
        kind: 'tactical', commandId: `press-${seed}`, teamId: HOME,
        payload: { type: 'patch', patch: { pressing: 0.95, defLine: 0.92, defAggression: 0.9, pressAfterLoss: 0.95 } },
      }, 30);
      let sum = 0, n = 0;
      for (let t = 0; t < 3000; t += 30) {
        engine.run(30);
        if (game.possessionTeam() !== t0)
          for (const p of t0.players) if (p.line === 'DEF') { sum += Math.abs(p.pos.x - t0.ownGoalX()); n++; }
      }
      return sum / n;
    };
    for (const seed of [1, 2]) {
      const base = defLineHeight(seed, false);
      const pressed = defLineHeight(seed, true);
      expect(pressed).toBeGreaterThan(base + 4);   // measured Δ: +9.7, +7.7
    }
  }, 300_000);

  test('stay_wide vs baseline: the instructed midfielder lives nearer his touchline', () => {
    const base = MatchEngine.create(manifest());
    const wide = MatchEngine.create(manifest());
    send(wide, instruction(P('rhinos', 6), 'stay_wide'), 30);
    const cm = P('rhinos', 6);
    const spreadBase = Math.abs(meanPosition(base, cm, 3000).y - PITCH_CENTER_Y);
    const spreadWide = Math.abs(meanPosition(wide, cm, 3000).y - PITCH_CENTER_Y);
    expect(spreadWide).toBeGreaterThan(spreadBase + 2);
  }, 180_000);

  test('push_forward / drop_back shift realized depth (multi-seed mean — a defender\'s depth is line- and flow-coupled, single seeds are chaotic)', () => {
    let pushDelta = 0, dropDelta = 0;
    const SEEDS = [1, 2, 3];
    for (const seed of SEEDS) {
      const base = MatchEngine.create(manifest({ seed }));
      const coached = MatchEngine.create(manifest({ seed }));
      send(coached, instruction(P('rhinos', 2), 'push_forward'), 30);
      send(coached, instruction(P('rhinos', 10), 'drop_back'), 30);
      const b2 = meanPosition(base, P('rhinos', 2), 2400).x;
      const b10 = meanPosition(base, P('rhinos', 10), 2400).x;
      const c2 = meanPosition(coached, P('rhinos', 2), 2400).x;
      const c10 = meanPosition(coached, P('rhinos', 10), 2400).x;
      pushDelta += (c2 - b2) / SEEDS.length;
      dropDelta += (c10 - b10) / SEEDS.length;
    }
    expect(pushDelta).toBeGreaterThan(1.5);    // measured avg: +4.3
    expect(dropDelta).toBeLessThan(-1.5);
  }, 600_000);

  test('overlap: intent honored for both, but PACE bounds the execution', () => {
    const fastManifest = manifest();
    const slowManifest = manifest();
    const dope = (m: MatchManifest, pace: number) => {
      const lb = m.teams[0].players.find(p => p.playerId === P('rhinos', 4))!;
      lb.ratings.pace = pace; lb.ratings.accel = pace; lb.ratings.stamina = 90;
    };
    dope(fastManifest, 95);
    dope(slowManifest, 25);

    // INTENT — the wide component of the overlap is chaos-resistant: both
    // fullbacks hug the touchline harder than their own baseline
    const widthOf = (m: MatchManifest, instruct: boolean): number => {
      const engine = MatchEngine.create(m);
      if (instruct) send(engine, instruction(P('rhinos', 4), 'overlap'), 30);
      return Math.abs(meanPosition(engine, P('rhinos', 4), 2400).y - PITCH_CENTER_Y);
    };
    expect(widthOf(fastManifest, true)).toBeGreaterThan(widthOf(fastManifest, false) + 2);
    expect(widthOf(slowManifest, true)).toBeGreaterThan(widthOf(slowManifest, false) + 2);

    // CAPABILITY — under the SAME instruction, pace decides how much pitch
    // the runner actually eats: ground covered, sampled at 5-tick grain
    const groundCovered = (m: MatchManifest): number => {
      const engine = MatchEngine.create(m);
      send(engine, instruction(P('rhinos', 4), 'overlap'), 30);
      const game = (engine as any).handle.game;
      const lb = game.teams[0].players.find((p: any) => p.slot.role === 'LB');
      let dist = 0, lx = lb.pos.x, ly = lb.pos.y;
      for (let t = 0; t < 2400; t += 5) {
        engine.run(5);
        dist += Math.hypot(lb.pos.x - lx, lb.pos.y - ly);
        lx = lb.pos.x; ly = lb.pos.y;
      }
      return dist;
    };
    const fastGround = groundCovered(fastManifest);
    const slowGround = groundCovered(slowManifest);
    // measured ratios: 1.13× (seed 4242) to 1.31× (seed 7) — the gap is
    // real on every seed; the threshold stays under the weakest observation
    expect(fastGround).toBeGreaterThan(slowGround * 1.08);
  }, 600_000);

  test('a high press punishes a low-stamina squad harder (attribute interaction)', () => {
    const doped = (stamina: number): MatchManifest => {
      const m = manifest();
      for (const p of m.teams[0].players) if (p.role !== 'GK') p.ratings.stamina = stamina;
      return m;
    };
    const press: Command = {
      kind: 'tactical', commandId: 'press-2', teamId: HOME,
      payload: { type: 'patch', patch: { pressing: 0.95, defAggression: 0.9, pressAfterLoss: 0.95 } },
    };
    const fit = MatchEngine.create(doped(95));
    const tired = MatchEngine.create(doped(15));
    send(fit, press, 30);
    send(tired, press, 30);
    fit.run(4200);
    tired.run(4200);
    expect(meanTeamStamina(tired, 'rhinos-')).toBeLessThan(meanTeamStamina(fit, 'rhinos-') - 0.05);
  }, 180_000);

  test('mark_opponent: the marker shadows his target', () => {
    const distance = (engine: MatchEngine, a: string, b: string, ticks: number): number => {
      let sum = 0, n = 0;
      for (let t = 0; t < ticks; t += 30) {
        engine.run(30);
        const s = engine.snapshot();
        const pa = s.players.find(p => p.playerId === a)!;
        const pb = s.players.find(p => p.playerId === b)!;
        sum += Math.hypot(pa.position.x - pb.position.x, pa.position.y - pb.position.y);
        n++;
      }
      return sum / n;
    };
    // the marker is a CM — the midfield destroyer role. A DEF-line marker
    // subordinates marking to back-line duty (golden's positional priority
    // chain), which is football truth, not a bug: your center-back does not
    // abandon the line to chase a roamer. Documented in TACTICAL_EXECUTION.
    const base = MatchEngine.create(manifest());
    const marking = MatchEngine.create(manifest());
    send(marking, instruction(P('rhinos', 7), 'mark_opponent', { targetPlayerId: P('comets', 10) }), 30);
    const dBase = distance(base, P('rhinos', 7), P('comets', 10), 3000);
    const dMark = distance(marking, P('rhinos', 7), P('comets', 10), 3000);
    expect(dMark).toBeLessThan(dBase - 6);        // measured: 18.1 → 8.0
    // the assignment is world-visible in the snapshot
    const team = marking.snapshot().teams.find(t => t.teamId === HOME)!;
    expect(team.instructions).toEqual([expect.objectContaining({
      playerId: P('rhinos', 7), instruction: 'mark_opponent', targetPlayerId: P('comets', 10),
    })]);
    expect(team.tactics.markTarget).toBe(P('comets', 10));
  }, 180_000);

  test('ttl expiry restores the station; supersede replaces without compounding', () => {
    const engine = MatchEngine.create(manifest());
    const game = (engine as any).handle.game;
    const lb = game.teams[0].players.find((p: any) => p.pid && p.slot.role === 'LB');
    const baseSlot = { x: lb.slot.x, y: lb.slot.y };

    send(engine, instruction(P('rhinos', 4), 'overlap', { ttlTicks: 300 }), 30);
    engine.run(60);
    expect(lb.slot.x).toBeGreaterThan(baseSlot.x);          // station moved
    engine.run(400);                                         // past expiry
    expect(lb.slot).toMatchObject(baseSlot);                 // station restored
    expect(engine.tacticsReport().teams[0]!.instructions).toHaveLength(0);

    // supersede: wide then central — geometry always derives from base
    send(engine, instruction(P('rhinos', 4), 'stay_wide'), engine.currentTick + 1);
    engine.run(10);
    const wideY = lb.slot.y;
    send(engine, instruction(P('rhinos', 4), 'stay_central'), engine.currentTick + 1);
    engine.run(10);
    expect(Math.abs(lb.slot.y - 0.5)).toBeLessThanOrEqual(Math.abs(baseSlot.y - 0.5));
    expect(lb.slot.y).not.toBe(wideY);
    expect(engine.tacticsReport().teams[0]!.instructions).toHaveLength(1);

    // clear returns to the formation station exactly
    send(engine, instruction(P('rhinos', 4), 'clear'), engine.currentTick + 1);
    engine.run(5);
    expect(lb.slot).toMatchObject(baseSlot);
    expect(engine.tacticsReport().teams[0]!.instructions).toHaveLength(0);

    // underlap = overlap's mirror: forward, but into the half-space
    send(engine, instruction(P('rhinos', 4), 'underlap'), engine.currentTick + 1);
    engine.run(5);
    expect(lb.slot.x).toBeGreaterThan(baseSlot.x);
    expect(Math.abs(lb.slot.y - 0.5)).toBeLessThan(Math.abs(baseSlot.y - 0.5));
    send(engine, instruction(P('rhinos', 4), 'clear'), engine.currentTick + 1);
    engine.run(5);
    expect(lb.slot).toMatchObject(baseSlot);
  }, 120_000);

  test('a formation change clears spatial instructions (marks survive)', () => {
    const engine = MatchEngine.create(manifest());
    send(engine, instruction(P('rhinos', 6), 'stay_wide'), 30);
    send(engine, instruction(P('rhinos', 2), 'mark_opponent', { targetPlayerId: P('comets', 11) }), 30);
    engine.run(60);
    expect(engine.tacticsReport().teams[0]!.instructions).toHaveLength(2);
    send(engine, {
      kind: 'tactical', commandId: 'shape-1', teamId: HOME,
      payload: { type: 'patch', patch: { formation: '433' } },
    }, engine.currentTick + 1);
    engine.run(10);
    const after = engine.tacticsReport().teams[0]!.instructions;
    expect(after).toHaveLength(1);
    expect(after[0]!.instruction).toBe('mark_opponent');
  }, 120_000);

  test('validation: canonical ids, team membership, GK and target rules', () => {
    const engine = MatchEngine.create(manifest());
    const reject = (command: Command) =>
      engine.submit({ seq: ++seqCounter, effectiveTick: 30, receivedAtTick: 30, command });

    expect(reject(instruction('nobody-99', 'stay_wide')).reason).toMatch(/unknown player/);
    expect(reject(instruction(P('comets', 6), 'stay_wide')).reason).toMatch(/not on the pitch for/);
    expect(reject(instruction(P('rhinos', 1), 'push_forward')).reason).toMatch(/goalkeeper/);
    expect(reject(instruction(P('rhinos', 2), 'mark_opponent')).reason).toMatch(/needs a targetPlayerId/);
    expect(reject(instruction(P('rhinos', 10), 'mark_opponent', { targetPlayerId: P('comets', 10) }))
      .reason).toMatch(/only midfielders and defenders/);
    expect(reject(instruction(P('rhinos', 2), 'mark_opponent', { targetPlayerId: P('rhinos', 3) }))
      .reason).toMatch(/not on the opposing XI/);
    expect(reject(instruction(P('rhinos', 2), 'stay_wide', { targetPlayerId: P('comets', 10) }))
      .reason).toMatch(/takes no targetPlayerId/);
  }, 60_000);

  test('determinism: instructed matches replay AND resume bit-exactly', () => {
    const commands: Array<{ command: Command; tick: number }> = [
      { command: instruction(P('rhinos', 4), 'overlap', { ttlTicks: 600 }), tick: 120 },
      { command: instruction(P('rhinos', 6), 'stay_wide'), tick: 300 },
      { command: { kind: 'tactical', commandId: 'd-press', teamId: HOME,
        payload: { type: 'patch', patch: { pressing: 0.9 } } }, tick: 450 },
      { command: instruction(P('rhinos', 2), 'mark_opponent', { targetPlayerId: P('comets', 10) }), tick: 600 },
    ];
    const live = MatchEngine.create(manifest({ matchId: 'tac-det' }));
    const applied: any[] = [];
    let seq = 0;
    for (const { command, tick } of commands) {
      const accepted = { seq: ++seq, effectiveTick: tick, receivedAtTick: tick, command };
      expect(live.submit(accepted).accepted).toBe(true);
      applied.push(accepted);
    }
    live.run(1500);
    const captured = live.captureInternalState();
    expect(captured.instructions!.length).toBeGreaterThan(0);   // the book rides the capture
    live.runToFullTime();
    const liveHash = live.snapshot().stateHash;

    // replay from the log alone
    const replayed = MatchEngine.replay(manifest({ matchId: 'tac-det' }), applied);
    expect(replayed.snapshot().stateHash).toBe(liveHash);

    // crash-resume mid-instruction
    const resumed = MatchEngine.create(manifest({ matchId: 'tac-det' }));
    resumed.restoreInternalState(captured, applied);
    resumed.runToFullTime();
    expect(resumed.snapshot().stateHash).toBe(liveHash);
  }, 600_000);
});
