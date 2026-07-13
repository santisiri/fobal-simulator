// Interpolation buffer for authoritative server updates.
//
// The server streams deltas at ~10Hz and snapshots every few seconds; the
// client renders at 60fps by keeping a short buffer of timestamped states and
// lerping between the two frames that straddle (renderTime = now - delay).
// Pure logic — no DOM, no sockets — so it is unit-tested in Node.

/** Linear interpolation. */
export function lerp(a, b, t){ return a + (b - a) * t; }

/**
 * One authoritative frame: a full or partially-updated view of the match.
 * Frames are built by MatchConnection from snapshots (authoritative reset)
 * and deltas (sparse patches on the previous frame).
 */
export function buildFrame(prev, patch){
  const players = new Map(prev ? prev.players : []);
  if (patch.players){
    for (const p of patch.players){
      const before = players.get(p.playerId) ?? {
        position: { x: 0, y: 0 }, facing: 0, action: 'idle', stamina: 1, onPitch: true,
      };
      players.set(p.playerId, {
        position: p.position ?? before.position,
        facing: p.facing ?? before.facing,
        action: p.action ?? before.action,
        stamina: p.stamina ?? before.stamina,
        onPitch: p.onPitch ?? before.onPitch,
      });
    }
  }
  return {
    tick: patch.tick,
    matchState: patch.matchState ?? (prev ? prev.matchState : 'KICKOFF'),
    score: patch.score ?? (prev ? prev.score : [0, 0]),
    clock: patch.clock ?? (prev ? prev.clock : '0:00'),
    ball: patch.ball
      ? { position: patch.ball.position, velocity: patch.ball.velocity ?? (prev ? prev.ball.velocity : { x: 0, y: 0, z: 0 }) }
      : (prev ? prev.ball : { position: { x: 52.5, y: 34, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }),
    players,
  };
}

/** A snapshot is already a complete frame — normalize its player list. */
export function frameFromSnapshot(snapshot){
  return {
    tick: snapshot.tick,
    matchState: snapshot.matchState,
    score: snapshot.score,
    clock: snapshot.clock,
    ball: snapshot.ball,
    players: new Map(snapshot.players.map(p => [p.playerId, {
      position: p.position, facing: p.facing, action: p.action,
      stamina: p.stamina, onPitch: p.onPitch,
    }])),
  };
}

export class InterpolationBuffer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.delayTicks] render this many ticks behind the newest
   *        authoritative frame (jitter absorption); 8 ticks ≈ 133ms
   * @param {number} [opts.capacity] frames kept
   */
  constructor({ delayTicks = 8, capacity = 90 } = {}){
    this.delayTicks = delayTicks;
    this.capacity = capacity;
    /** @type {any[]} ordered by tick asc */
    this.frames = [];
    this.newestArrivalMs = 0;   // wall-clock arrival of the newest frame
  }

  /** Insert an authoritative frame (out-of-order frames are sorted in). */
  push(frame){
    if (!this.frames.length || frame.tick >= this.newestTick())
      this.newestArrivalMs = Date.now();
    // a frame for an earlier tick than the newest is stale unless it fills a gap
    const i = this.frames.findIndex(f => f.tick >= frame.tick);
    if (i === -1) this.frames.push(frame);
    else if (this.frames[i].tick === frame.tick) this.frames[i] = frame;
    else this.frames.splice(i, 0, frame);
    if (this.frames.length > this.capacity) this.frames.splice(0, this.frames.length - this.capacity);
  }

  /** Authoritative reset (reconnect/seek): drop everything older. */
  reset(frame){
    this.frames = [frame];
    this.newestArrivalMs = Date.now();
  }

  newestTick(){ return this.frames.length ? this.frames[this.frames.length - 1].tick : -1; }

  /**
   * The frame to draw for the current moment: interpolated between the two
   * frames straddling the render tick. Positions and the ball lerp; discrete
   * fields (score, state, actions) snap to the earlier frame until the
   * boundary passes.
   *
   * Pass `nowMs` (e.g. performance.now-aligned Date.now()) from a render loop
   * to advance time CONTINUOUSLY between network updates — without it the
   * sample is a pure function of the buffer and only moves when frames
   * arrive, which stutters at 60fps against a 10Hz delta stream.
   */
  sample(nowMs){
    if (!this.frames.length) return null;
    let target = this.newestTick() - this.delayTicks;
    if (nowMs !== undefined && this.newestArrivalMs){
      const elapsedTicks = ((nowMs - this.newestArrivalMs) / 1000) * 60;
      // advance smoothly but never past the newest authoritative frame
      target = Math.min(this.newestTick(), target + Math.max(0, elapsedTicks));
    }
    let a = this.frames[0], b = this.frames[0];
    for (const f of this.frames){
      if (f.tick <= target) a = f;
      b = f;
      if (f.tick > target) break;
    }
    if (a === b || b.tick <= a.tick) return { ...a, interpolated: false };
    const t = Math.min(1, Math.max(0, (target - a.tick) / (b.tick - a.tick)));
    const players = new Map();
    for (const [id, pa] of a.players){
      const pb = b.players.get(id) ?? pa;
      players.set(id, {
        ...pa,
        position: { x: lerp(pa.position.x, pb.position.x, t), y: lerp(pa.position.y, pb.position.y, t) },
        facing: pb.facing,
      });
    }
    return {
      tick: Math.round(lerp(a.tick, b.tick, t)),
      matchState: a.matchState, score: a.score, clock: a.clock,
      ball: {
        position: {
          x: lerp(a.ball.position.x, b.ball.position.x, t),
          y: lerp(a.ball.position.y, b.ball.position.y, t),
          z: lerp(a.ball.position.z, b.ball.position.z, t),
        },
        velocity: b.ball.velocity,
      },
      players,
      interpolated: true,
    };
  }
}
