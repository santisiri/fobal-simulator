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
