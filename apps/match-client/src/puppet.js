// GoldenPuppet — Online Mode drawn by the golden game itself (ROADMAP Phase A).
//
// The untouched golden index.html is loaded in an iframe and its simulation
// is frozen with game.simRate = 0: the golden loop's fixed-timestep
// accumulator never fills, so step() never runs, while the stadium, fx and
// renderer stay alive on the render clock (unlike game.paused, this draws no
// overlay). The golden game is then reset from the MANIFEST SEED — squads,
// appearances and stadium regenerate exactly as the server's engine did —
// external ids are bound by mirroring the engine adapter's deterministic
// slot assignment, and every animation frame the interpolated network state
// is written into the golden objects for the golden renderer to draw.
// Same code, same pixels; index.html is never modified.
//
// Deliberately out of scope for the walking skeleton (tracked in ROADMAP):
// substitutions swapping pitch/bench arrays (A3), golden cinematic goal
// replays fed from server clips (A4), event feed/banners driven from the
// protocol event stream (A3).

const LINE_OF_ROLE = {
  GK: 'GK', CB: 'DEF', LB: 'DEF', RB: 'DEF',
  CM: 'MID', LM: 'MID', RM: 'MID', LW: 'ATT', RW: 'ATT', ST: 'ATT',
};

/** Mirror of packages/engine/src/adapter.ts assignSlots — MUST stay
 *  identical so client and server bind the same external id to the same
 *  golden body (appearance parity depends on it). */
export function assignSlots(slotRoles, starters){
  const taken = new Array(starters.length).fill(false);
  const assignment = new Array(slotRoles.length).fill(-1);
  const pickWhere = (slotIdx, pred) => {
    for (let j = 0; j < starters.length; j++){
      if (!taken[j] && pred(starters[j])){ taken[j] = true; assignment[slotIdx] = j; return true; }
    }
    return false;
  };
  for (let pass = 0; pass < 3; pass++){
    for (let i = 0; i < slotRoles.length; i++){
      if (assignment[i] !== -1) continue;
      const role = slotRoles[i];
      if (pass === 0) pickWhere(i, p => p.role === role);
      else if (pass === 1) pickWhere(i, p => LINE_OF_ROLE[p.role] === LINE_OF_ROLE[role]);
      else pickWhere(i, () => true);
    }
  }
  return assignment;
}

function flagEmoji(iso2){
  const a = String(iso2 ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(a)) return '🏳️';
  return String.fromCodePoint(0x1f1e6 + a.charCodeAt(0) - 65, 0x1f1e6 + a.charCodeAt(1) - 65);
}

function imposePlayer(gp, spec){
  gp.name = spec.name;
  gp.num = spec.shirtNumber;
  if (spec.age !== undefined) gp.age = spec.age;
  if (spec.nationality !== undefined){
    gp.nat = spec.nationality.toUpperCase();
    gp.flag = flagEmoji(spec.nationality);
  }
}

function parseClock(clock){
  const m = /^(\d+):(\d\d)$/.exec(clock ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

export class GoldenPuppet {
  constructor(container){
    this.container = container;
    this.iframe = null;
    this.win = null;
    this.byExternal = new Map();   // external playerId → golden player object
    this.lastPos = new Map();      // external playerId → {x, y} for vel/runPhase
    this.raf = 0;
    this.lastT = 0;
  }

  /** Load the golden page and wait for its game to boot. */
  mount(){
    const iframe = document.createElement('iframe');
    iframe.src = '/index.html';
    iframe.title = 'FOBAL online match (golden presentation)';
    iframe.style.cssText = 'width:100%;height:100%;border:0;pointer-events:none;';
    this.container.appendChild(iframe);
    this.iframe = iframe;
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const poll = () => {
        const win = iframe.contentWindow;
        if (win && win.game && win.__reset && win.game.teams?.length === 2){
          this.win = win;
          win.game.simRate = 0;     // freeze ASAP — the golden match must not free-run
          resolve(this);
        } else if (Date.now() > deadline) reject(new Error('golden page did not boot'));
        else setTimeout(poll, 50);
      };
      iframe.addEventListener('load', poll);
      poll();
    });
  }

  /** Reset the golden game from the manifest (mirrors adapter.imposeManifest
   *  order) and bind external ids. Call once, after the welcome. */
  configure(manifest){
    const win = this.win, game = win.game;
    if (manifest.environment?.grass || manifest.environment?.weather)
      win.__setEnv(manifest.environment.grass, manifest.environment.weather);
    win.__reset(manifest.seed);      // same seed ⇒ same squads/stadium as the server engine
    game.simRate = 0;                // re-pin: reset must never resume stepping
    win.__present(manifest.rules?.ceremonies === true);
    game.goalReplay.cfg.enabled = false;  // the authoritative-engine hard rule, client-side too
    this.byExternal.clear();
    for (const idx of [0, 1]){
      const spec = manifest.teams[idx];
      const team = game.teams[idx];
      team.name = spec.name.toUpperCase();
      const starters = spec.players.slice(0, 11);
      const benchSpec = spec.players.slice(11);
      const assignment = assignSlots(team.players.map(p => p.role), starters);
      team.players.forEach((gp, i) => {
        const s = starters[assignment[i]];
        imposePlayer(gp, s);
        this.byExternal.set(s.playerId, gp);
      });
      const bench = team.bench ?? [];
      const keep = Math.min(bench.length, benchSpec.length);
      for (let i = 0; i < keep; i++){
        imposePlayer(bench[i], benchSpec[i]);
        this.byExternal.set(benchSpec[i].playerId, bench[i]);
      }
      if (bench.length > benchSpec.length) bench.length = benchSpec.length;
    }
  }

  /** Drive the golden presentation from the connection's interpolated frames. */
  start(conn){
    this.stop();
    this.conn = conn;
    this.lastT = performance.now();
    const pump = (t) => {
      const dt = Math.min(0.1, (t - this.lastT) / 1000);
      this.lastT = t;
      this.win.game.animT += dt;     // sim is frozen; the animation clock is ours to advance
      const frame = conn.frame(Date.now());
      if (frame) this.apply(frame, dt);
    };
    const loop = (t) => {
      this.raf = requestAnimationFrame(loop);
      pump(t);
    };
    this.raf = requestAnimationFrame(loop);
    // rAF suspends in hidden tabs; a slow timer keeps the golden state
    // tracking the authoritative stream so a returning viewer sees a live
    // HUD instantly instead of a five-minute-old freeze frame
    this.fallback = setInterval(() => {
      if (document.visibilityState === 'hidden') pump(performance.now());
    }, 250);
  }

  stop(){
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.fallback) clearInterval(this.fallback);
    this.fallback = 0;
  }

  apply(frame, dt){
    const game = this.win.game;
    for (const [extId, p] of frame.players){
      const gp = this.byExternal.get(extId);
      if (!gp || p.onPitch === false) continue;   // subs handled in A3
      const prev = this.lastPos.get(extId);
      if (prev && dt > 0){
        const dx = p.position.x - prev.x, dy = p.position.y - prev.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 5){                            // teleports (resets) don't sprint
          gp.vel.x = dx / dt; gp.vel.y = dy / dt;
          gp.runPhase += dist;                    // golden: runPhase += |vel|·dt
        } else { gp.vel.x = 0; gp.vel.y = 0; }
      }
      this.lastPos.set(extId, { x: p.position.x, y: p.position.y });
      gp.pos.x = p.position.x;
      gp.pos.y = p.position.y;
      if (p.facing !== undefined) gp.facing = p.facing;
      if (p.action) gp.action = p.action;
      if (p.stamina !== undefined) gp.stamina = p.stamina;
    }
    const b = frame.ball;
    game.ball.x = b.position.x; game.ball.y = b.position.y; game.ball.z = b.position.z;
    game.ball.vx = b.velocity.x; game.ball.vy = b.velocity.y; game.ball.vz = b.velocity.z;
    game.match.score[0] = frame.score[0];
    game.match.score[1] = frame.score[1];
    game.match.state = frame.matchState;
    game.match.tMatch = parseClock(frame.clock);
  }
}
