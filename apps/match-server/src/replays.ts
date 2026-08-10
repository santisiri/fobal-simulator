// Automatic goal replays generated from recorded data: the persisted manifest
// + accepted-command log deterministically re-simulates the match, and each
// goal window is captured as dense per-tick frames. No video, no
// approximation — the frames come from the same engine that played the match.
import { MatchEngine } from '@fobal/engine';
import type { AcceptedCommand, MatchEvent, MatchManifest } from '@fobal/protocol';

export interface GoalClipFrame {
  tick: number;
  ball: { x: number; y: number; z: number };
  players: Array<{ playerId: string; x: number; y: number }>;
}

export interface GoalClip {
  goalTick: number;
  teamId: string;
  playerId: string | null;
  fromTick: number;
  toTick: number;
  frames: GoalClipFrame[];
  events: MatchEvent[];
}

export interface GoalClipOptions {
  preSeconds?: number;   // buildup shown before the goal
  postSeconds?: number;  // celebration shown after
  stride?: number;       // capture every Nth tick (2 = 30fps)
}

// ---------------------------------------------------------------------------
// Full-match replay stream (M1.2 replay theater). The client must NEVER
// re-simulate — browser and vm runs diverge (the vm pins Math.random to a
// seeded stream before boot; a browser cannot reproduce its position, and
// the live renderer keeps consuming draws between steps). So the SERVER, the
// one legitimate re-simulator, replays manifest + command log through the vm
// engine and records a slim protocol-snapshot-shaped frame every `stride`
// ticks (6 = 10Hz — the live delta rate). Clients play the recording.
// ---------------------------------------------------------------------------

export interface ReplayStreamFrame {
  tick: number;
  clock: string;
  matchState: string;
  score: [number, number];
  ball: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number } };
  players: Array<{
    playerId: string;
    position: { x: number; y: number };
    facing: number;
    action: string;
    onPitch: boolean;
  }>;
}

export interface ReplayStream {
  stride: number;
  frames: ReplayStreamFrame[];
}

export function extractReplayStream(
  manifest: MatchManifest,
  commands: AcceptedCommand[],
  { stride = 6 }: { stride?: number } = {},
): ReplayStream {
  const engine = MatchEngine.create(manifest);
  for (const c of [...commands].sort((a, b) => a.seq - b.seq)){
    const r = engine.submit(c);
    if (!r.accepted) throw new Error(`replay stream re-simulation: command ${c.seq} rejected: ${r.reason}`);
  }
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  const frames: ReplayStreamFrame[] = [];
  const capture = (): void => {
    const s = engine.snapshot();
    frames.push({
      tick: s.tick,
      clock: s.clock,
      matchState: s.matchState,
      score: s.score,
      ball: {
        position: { x: r2(s.ball.position.x), y: r2(s.ball.position.y), z: r2(s.ball.position.z) },
        velocity: { x: r2(s.ball.velocity.x), y: r2(s.ball.velocity.y), z: r2(s.ball.velocity.z) },
      },
      players: s.players.map(p => ({
        playerId: p.playerId,
        position: { x: r2(p.position.x), y: r2(p.position.y) },
        facing: r2(p.facing),
        action: p.action,
        onPitch: p.onPitch,
      })),
    });
  };
  capture();                        // kickoff line-up
  const MAX = 60 * 60 * 60;         // safety cap far above any real match
  let guard = 0;
  while (!engine.isOver() && guard++ < MAX){
    engine.tick();
    if (engine.currentTick % stride === 0) capture();
  }
  if (frames[frames.length - 1]!.tick !== engine.currentTick) capture();   // final whistle state
  return { stride, frames };
}

export function extractGoalClips(
  manifest: MatchManifest,
  commands: AcceptedCommand[],
  goals: Array<{ tick: number; teamId: string; playerId: string | null }>,
  events: MatchEvent[],
  { preSeconds = 8, postSeconds = 3, stride = 2 }: GoalClipOptions = {},
): GoalClip[] {
  if (!goals.length) return [];
  const windows = goals.map(g => ({
    goal: g,
    fromTick: Math.max(0, g.tick - Math.round(preSeconds * 60)),
    toTick: g.tick + Math.round(postSeconds * 60),
  }));
  const lastTick = Math.max(...windows.map(w => w.toTick));

  const engine = MatchEngine.create(manifest);
  for (const c of [...commands].sort((a, b) => a.seq - b.seq)){
    const r = engine.submit(c);
    if (!r.accepted) throw new Error(`goal replay re-simulation: command ${c.seq} rejected: ${r.reason}`);
  }

  const clips: GoalClip[] = windows.map(w => ({
    goalTick: w.goal.tick, teamId: w.goal.teamId, playerId: w.goal.playerId,
    fromTick: w.fromTick, toTick: w.toTick, frames: [],
    events: events.filter(e => e.tick >= w.fromTick && e.tick <= w.toTick),
  }));

  while (engine.currentTick < lastTick && !engine.isOver()){
    engine.tick();
    const tick = engine.currentTick;
    for (const clip of clips){
      if (tick < clip.fromTick || tick > clip.toTick || tick % stride !== 0) continue;
      const snapshot = engine.snapshot();
      clip.frames.push({
        tick,
        ball: { x: snapshot.ball.position.x, y: snapshot.ball.position.y, z: snapshot.ball.position.z },
        players: snapshot.players.filter(p => p.onPitch)
          .map(p => ({ playerId: p.playerId, x: p.position.x, y: p.position.y })),
      });
    }
  }
  return clips;
}
