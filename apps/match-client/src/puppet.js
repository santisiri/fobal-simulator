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
    this.externalOf = new Map();   // golden player object → external playerId
    this.teamIdxByExternal = new Map();  // external teamId → 0 | 1
    this.lastPos = new Map();      // external playerId → {x, y} for vel/runPhase
    this.raf = 0;
    this.lastT = 0;
    this.bannerTimer = 0;
    this.performSubDirect = null;  // unwrapped golden performSub (event path)
    this.tape = [];                // rolling recording of applied frames (~14s)
    this.clip = null;              // active instant-replay playback
    this.lastGoalClip = null;      // most recent clip, replayable on demand
    this.clipTimer = 0;
  }

  /** Load the golden page and wait for its game to boot. */
  mount(){
    const iframe = document.createElement('iframe');
    iframe.src = '/index.html';
    iframe.title = 'FOBAL online match (golden presentation)';
    iframe.style.cssText = 'width:100%;height:100%;border:0;pointer-events:none;';
    // replace, never append: a reconnect through the form mounts a fresh
    // puppet, and the previous stage must not linger underneath
    this.container.replaceChildren(iframe);
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
        this.externalOf.set(gp, s.playerId);
      });
      const bench = team.bench ?? [];
      const keep = Math.min(bench.length, benchSpec.length);
      for (let i = 0; i < keep; i++){
        const bp = bench[i], bs = benchSpec[i];
        imposePlayer(bp, bs);
        // mirror the adapter: the bench slot role gates like-for-like GK
        // substitutions inside the golden performSub
        if (bp.slot) bp.slot.role = bs.role;
        bp.role = bs.role;
        bp.line = LINE_OF_ROLE[bs.role] ?? bp.line;
        bp.isGK = bs.role === 'GK';
        this.byExternal.set(bs.playerId, bp);
        this.externalOf.set(bp, bs.playerId);
      }
      if (bench.length > benchSpec.length) bench.length = benchSpec.length;
      this.teamIdxByExternal.set(spec.teamId, idx);
    }
    // the event path must call the REAL performSub even after enableCoaching
    // wraps the public one into a command composer
    this.performSubDirect = game.performSub.bind(game);
    // the golden replay manager's SIM-REWIND must never run (hard rule), but
    // its presentation organs — BroadcastReplayOverlay, ReplayCameraController
    // — are driven by the ClipPlayer below. tick() runs on the render clock
    // and would fight for simRate/end conditions: neutered for good.
    game.goalReplay.tick = () => {};
    // hazard guards for networked viewing: the golden pause overlay and the
    // full game reset must be unreachable (reset would orphan every id
    // binding; note configure's own __reset already ran above)
    Object.defineProperty(game, 'paused', { get: () => false, set: () => {}, configurable: true });
    game.reset = () => {};
  }

  /**
   * Route a protocol MatchEvent into the golden presentation. `live` is
   * false during the join catch-up: the feed and the pitch/bench arrays are
   * reconstructed (substitutions MUST replay or a late joiner renders the
   * wrong XI), but banners/announcements for long-past moments stay quiet.
   */
  handleEvent(e, live){
    const game = this.win.game, match = game.match;
    const p = e.playerId ? this.byExternal.get(e.playerId) : null;
    const teamIdx = e.teamId !== undefined ? this.teamIdxByExternal.get(e.teamId) : undefined;
    const team = teamIdx !== undefined ? game.teams[teamIdx] : (p ? p.team : undefined);
    switch (e.type){
      case 'substitution': {
        // golden performSub does the arrays, choreography, feed line and sub
        // board; its own guards make replayed duplicates a graceful no-op
        const on = p, off = e.targetId ? this.byExternal.get(e.targetId) : null;
        if (team && on && off) this.performSubDirect(team, off, on);
        return;
      }
      case 'goal':
        game.commentate('goal', { p, team, og: e.data?.og });
        if (live){
          game.announce('GOAL!', 3);
          if (game.stadium) game.stadium.react('goal', team);
          // broadcast truck: let the celebration breathe, then roll the tape
          const goalTick = e.tick, scorerId = e.playerId;
          this.clipTimer = setTimeout(() => this.playGoalClip(goalTick, scorerId), 1600);
        }
        return;
      case 'card': {
        const kind = e.data?.card === 'yellow' ? 'yellow' : 'red';
        if (kind === 'red' && p && team){
          // the server removed him from the XI; mirror it or he statues on
          // the pitch (positions stop streaming for off-pitch players).
          // idempotent: replayed events find him already gone.
          const i = team.players.indexOf(p);
          if (i >= 0){ team.players.splice(i, 1); (team.offList ??= []).push(p); }
          game.commentate('red', { p, team, left: team.players.length });
          return;
        }
        game.commentate(kind, { p, team, desc: e.data?.kind ?? 'challenge' });
        return;
      }
      case 'shot': game.commentate('shot', { p, team }); return;
      case 'gk_catch':
      case 'gk_parry':
        game.commentate('save', { p, team });
        if (live) game.announce('SAVE!', 2);
        return;
      case 'foul': game.commentate('foul', { p, v: null, team, desc: e.data?.kind ?? 'foul' }); return;
      case 'offside': game.commentate('offside', { p, team }); return;
      case 'kickoff': game.commentate('kickoff', { half: match.half }); return;
      case 'tactic_change':
        if (e.data?.label) game.commentate('tactic', { team, what: e.data.label });
        return;
      case 'restart':
        // commentaryText knows throwin/corner/goalkick/freekick; unknown
        // kinds return no text and commentate skips them
        if (e.data?.kind) game.commentate(String(e.data.kind).toLowerCase(), { team });
        return;
      case 'halftime': this.showBanner('HALF TIME', live, 6); return;
      case 'fulltime':
        // the room is evicted at FT before any FULLTIME-state delta can
        // arrive — the synthetic event IS the authority, and the golden
        // full-time stat line only draws in this state
        match.state = 'FULLTIME';
        this.showBanner('FULL TIME', live, 0);
        return;
      default: return;
    }
  }

  /**
   * Controller mode (A5): the golden panels become COMMAND COMPOSERS. Local
   * sim mutation is meaningless (the sim is frozen) — instead every golden
   * apply-funnel emits the protocol command and the server's authoritative
   * echo (events, snapshots) closes the loop:
   *  - bench CONFIRM → substitution command (the echoed event shows the
   *    golden sub board via handleEvent)
   *  - coach console Enter → coach_text command (the golden applyCoach seam —
   *    the same one Phase C's voice input will feed)
   *  - tactics panel → diffed on close into a tactical patch command
   * Known limit, tracked in ROADMAP A3: the golden panels hardcode the HOME
   * team's roster/values for display. Commands always target the
   * controller's own team; bench subs are blocked for away controllers
   * until the mirrored-perspective view lands.
   */
  enableCoaching(conn){
    const game = this.win.game;
    const myTeamIdx = this.teamIdxByExternal.get(conn.teamId);
    this.iframe.style.pointerEvents = 'auto';
    const commandId = (tag) => `ui-${tag}-${Date.now()}`;

    // ack/reject feedback through the golden announcer
    const prevAck = conn.hooks.onAck, prevRej = conn.hooks.onRejected;
    conn.hooks.onAck = (m) => { if (prevAck) prevAck(m); game.announce('✓ ORDER RECEIVED', 1.6); };
    conn.hooks.onRejected = (m) => {
      if (prevRej) prevRej(m);
      game.announce('✗ ' + (m.message || m.code || 'rejected').toUpperCase().slice(0, 60), 3);
    };

    // bench panel CONFIRM funnel
    game.performSub = (team, out, sub) => {
      if (myTeamIdx !== 0){ game.announce('BENCH: away-side panel not wired yet', 2.5); return false; }
      const playerOut = this.externalOf.get(out), playerIn = this.externalOf.get(sub);
      if (!playerOut || !playerIn) return false;
      conn.sendCommand({ kind: 'substitution', commandId: commandId('sub'),
        teamId: conn.teamId, playerOut, playerIn });
      game.announce('SUB REQUESTED — awaiting the fourth official', 2.2);
      return true;   // closes the golden confirm sheet
    };

    // coach console funnel — free text goes to the server's parseCoach
    game.applyCoach = () => {
      const text = String(game.coachText || '').trim().slice(0, 280);
      game.closeCoach();
      if (!text) return;
      conn.sendCommand({ kind: 'tactical', commandId: commandId('coach'),
        teamId: conn.teamId, payload: { type: 'coach_text', text } });
      game.announce('COACH ▸ sent to the bench', 1.8);
    };

    // tactics panel: golden sliders mutate locally for instant feel; the
    // NET change is flushed as one protocol patch when the panel closes or
    // switches away
    const TACTIC_NUM = ['width', 'trap', 'tempo', 'crossing', 'shootTendency', 'overlap',
      'counter', 'timeWaste', 'pressAfterLoss', 'defAggression', 'gkLong',
      'mentality', 'defLine', 'pressing', 'risk', 'compactness'];
    const TACTIC_STR = ['scheme', 'attackSide', 'style'];
    const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    const snapshotTactics = () => {
      const team = game.teams[0], T = team.tactics, out = {};
      for (const k of TACTIC_NUM) out[k] = +clamp01(T[k]).toFixed(3);
      for (const k of TACTIC_STR) if (T[k] !== undefined) out[k] = T[k];
      out.formation = team.assignedFormation ?? T.formation;
      out.markTarget = T.markTarget ?? null;
      return out;
    };
    let baseline = null;
    const flushTactics = () => {
      if (!baseline) return;
      const before = baseline, after = snapshotTactics();
      baseline = null;
      const patch = {};
      for (const k of TACTIC_NUM) if (Math.abs(after[k] - before[k]) > 0.001) patch[k] = after[k];
      for (const k of [...TACTIC_STR, 'formation']) if (after[k] !== before[k] && after[k] !== undefined) patch[k] = after[k];
      if (after.markTarget !== before.markTarget){
        // golden stores a pid; the wire wants the external id
        const body = [...this.byExternal.values()].find(p => p.pid === after.markTarget);
        patch.markTarget = body ? this.externalOf.get(body) ?? null : null;
      }
      if (!Object.keys(patch).length) return;
      conn.sendCommand({ kind: 'tactical', commandId: commandId('tac'),
        teamId: conn.teamId, payload: { type: 'patch', patch } });
      game.announce('TACTICS ▸ sent to the bench', 1.8);
    };
    const openPanelDirect = game.openPanel.bind(game);
    const closePanelDirect = game.closePanel.bind(game);
    game.openPanel = (type, extra) => {
      if (type === 'replay'){
        if (this.clip) return;
        if (this.serverClips?.length){
          // post-fulltime: cycle the authoritative goals
          this.serverClipIdx = ((this.serverClipIdx ?? -1) + 1) % this.serverClips.length;
          this.playClip(this.serverClips[this.serverClipIdx]);
        } else if (this.lastGoalClip) this.playClip(this.lastGoalClip);
        else game.announce('NO GOALS TO REPLAY YET', 2.2);
        return;
      }
      if (game.panel?.type === 'tactics') flushTactics();      // switching away
      if (type === 'tactics') baseline = snapshotTactics();
      openPanelDirect(type, extra);
    };
    game.closePanel = () => {
      if (game.panel?.type === 'tactics') flushTactics();
      closePanelDirect();
    };
  }

  /**
   * Instant replay (A4): play the client's own recording of the stream back
   * through the golden broadcast machinery — letterbox + REPLAY badge
   * (BroadcastReplayOverlay engages on gr.playing), cinematic camera cuts
   * (ReplayCameraController driven per frame), golden pacing (quick buildup,
   * slow-motion finish) — as PURE PLAYBACK. The authoritative sim never
   * rewinds; live frames keep buffering and the view snaps back to now with
   * the golden fade when the clip ends. Server-side re-simulated clips
   * (post-fulltime, /replays/goals) will feed this same player in A4b.
   */
  playGoalClip(goalTick, scorerExtId){
    if (this.clip) return;
    const from = goalTick - 8 * 60, to = goalTick + 72;
    const frames = this.tape.filter(f => f.tick >= from && f.tick <= to);
    if (frames.length < 6 || frames[frames.length - 1].tick - frames[0].tick < 120) return;
    const scorerPid = scorerExtId ? this.byExternal.get(scorerExtId)?.pid ?? null : null;
    this.lastGoalClip = { frames, goalTick, scorerPid };
    this.playClip(this.lastGoalClip);
  }

  playClip({ frames, goalTick, scorerPid }){
    const game = this.win.game, gr = game.goalReplay;
    this.clip = { frames, goalTick, t: frames[0].tick, endTick: frames[frames.length - 1].tick };
    // the golden overlay reads playing.goalTick/endTick + game.simTick
    gr.playing = { goalTick, endTick: this.clip.endTick };
    gr.t0 = game.animT;
    gr.skip = () => this.endClip();   // Space/Escape/click routes here
    gr.cams.start(scorerPid, goalTick / 60, this.clip.endTick / 60);
  }

  pumpClip(dt){
    const game = this.win.game, gr = game.goalReplay, clip = this.clip;
    // golden broadcast pacing: buildup slightly quick, the finish in slow-mo
    const toGoal = (clip.goalTick - clip.t) / 60;
    const rate = toGoal < 2.4 ? gr.cfg.slowmo : gr.cfg.buildupRate;
    clip.t += dt * 60 * rate;
    if (clip.t >= clip.endTick){ this.endClip(); return; }
    let a = clip.frames[0], b = clip.frames[clip.frames.length - 1];
    for (const f of clip.frames){
      if (f.tick <= clip.t) a = f;
      else { b = f; break; }
    }
    const span = Math.max(1, b.tick - a.tick);
    const k = Math.min(1, Math.max(0, (clip.t - a.tick) / span));
    const lerp = (x, y) => x + (y - x) * k;
    for (const [extId, pa] of a.players){
      const gp = this.byExternal.get(extId);
      if (!gp || pa.onPitch === false) continue;
      const pb = b.players.get(extId) ?? pa;
      const x = lerp(pa.position.x, pb.position.x), y = lerp(pa.position.y, pb.position.y);
      const prev = this.lastPos.get(extId);
      if (prev){
        const dx = x - prev.x, dy = y - prev.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 5){
          gp.runPhase += dist;
          // server clips carry positions only — derive facing from motion
          // (the golden convention is atan2(dy, dx) radians)
          if (pb.facing === undefined && dist > 0.03) gp.facing = Math.atan2(dy, dx);
        }
      }
      this.lastPos.set(extId, { x, y });
      gp.pos.x = x; gp.pos.y = y;
      if (pb.facing !== undefined) gp.facing = pb.facing;
      if (pa.action) gp.action = pa.action;
    }
    game.ball.x = lerp(a.ball.position.x, b.ball.position.x);
    game.ball.y = lerp(a.ball.position.y, b.ball.position.y);
    game.ball.z = lerp(a.ball.position.z, b.ball.position.z);
    // tape frames carry the full HUD state; sparse server clips leave the
    // (final) score and clock standing — exactly how TV plays highlights
    if (a.score){ game.match.score[0] = a.score[0]; game.match.score[1] = a.score[1]; }
    if (a.matchState) game.match.state = a.matchState;
    if (a.clock) game.match.tMatch = parseClock(a.clock);
    game.simTick = Math.round(clip.t);   // overlay progress + camera cut plan
    gr.cams.update();
  }

  endClip(){
    const game = this.win.game, gr = game.goalReplay;
    if (!this.clip) return;
    this.clip = null;
    gr.playing = null;
    delete gr.skip;                   // prototype skip no-ops on playing=null
    gr.cams.stop();
    game.replayFadeT = game.animT;    // golden fade back to live
    this.lastPos.clear();             // live positions jump; no sprint spikes
    const next = this.clipQueue?.shift();
    if (next) this.clipTimer = setTimeout(() => this.playClip(next), 900);
  }

  /**
   * A4b — the authoritative highlight reel. After full time the server can
   * re-simulate every goal window from the recorded match (/replays/goals);
   * those dense per-tick frames feed the exact same ClipPlayer. Fetched over
   * HTTP with the match token (the hub speaks CORS for this) and auto-played
   * once after the FULL TIME banner has had its moment.
   */
  async loadServerClips(conn){
    try {
      const base = conn.url.replace(/^ws/, 'http').replace(/\/+$/, '');
      const res = await fetch(`${base}/matches/${conn.matchId}/replays/goals`, {
        headers: { authorization: `Bearer ${conn.token}` },
      });
      if (!res.ok) return [];
      const { clips } = await res.json();
      this.serverClips = (clips ?? []).map(c => ({
        goalTick: c.goalTick,
        scorerPid: c.playerId ? this.byExternal.get(c.playerId)?.pid ?? null : null,
        frames: c.frames.map(f => ({
          tick: f.tick,
          ball: { position: { x: f.ball.x, y: f.ball.y, z: f.ball.z } },
          players: new Map(f.players.map(p => [p.playerId, { position: { x: p.x, y: p.y } }])),
        })),
      })).filter(c => c.frames.length > 5);
      return this.serverClips;
    } catch { return []; }   // replays are a luxury; never break the client
  }

  async playHighlightReel(conn){
    const clips = await this.loadServerClips(conn);
    if (!clips.length) return;
    this.win.game.announce(`GOAL REPLAYS — ${clips.length} goal${clips.length > 1 ? 's' : ''}`, 2.5);
    this.clipQueue = clips.slice(1).map(c => ({ frames: c.frames, goalTick: c.goalTick, scorerPid: c.scorerPid }));
    this.playClip(clips[0]);
  }

  showBanner(text, live, seconds){
    if (!live && seconds !== 0) return;    // stale HT banners stay quiet on join
    const match = this.win.game.match;
    match.banner = text;
    match.bannerSub = match.scoreLine ? match.scoreLine() : '';
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    if (seconds > 0)
      this.bannerTimer = setTimeout(() => { match.banner = ''; match.bannerSub = ''; }, seconds * 1000);
  }

  /** Drive the golden presentation from the connection's interpolated frames. */
  start(conn){
    this.stop();
    this.conn = conn;
    // join catch-up: rebuild the feed and re-apply substitutions/dismissals
    // from the full event history (net.js always hellos with resumeFromSeq,
    // so the server replays it), quietly. Each event's own clock stamps the
    // feed minute — the first frame overwrites tMatch right after.
    for (const e of conn.events){
      if (e.clock) this.win.game.match.tMatch = parseClock(e.clock);
      this.handleEvent(e, false);
    }
    const prevOnEvent = conn.hooks.onEvent;
    conn.hooks.onEvent = (e) => {
      if (prevOnEvent) prevOnEvent(e);
      this.handleEvent(e, true);
    };
    // full time: give the banner its moment, then run the authoritative
    // highlight reel from the server's re-simulated goal windows
    const prevOnResult = conn.hooks.onResult;
    conn.hooks.onResult = (r) => {
      if (prevOnResult) prevOnResult(r);
      this.clipTimer = setTimeout(() => { void this.playHighlightReel(conn); }, 4500);
    };
    this.lastT = performance.now();
    const pump = (t) => {
      const dt = Math.min(0.1, (t - this.lastT) / 1000);
      this.lastT = t;
      this.win.game.animT += dt;     // sim is frozen; the animation clock is ours to advance
      const frame = conn.frame(Date.now());
      if (frame){
        // rolling broadcast tape — recorded even while a replay plays, so
        // back-to-back goals still have footage
        const newest = this.tape[this.tape.length - 1];
        if (!newest || frame.tick > newest.tick){
          this.tape.push(frame);
          const horizon = frame.tick - 14 * 60;
          while (this.tape.length && this.tape[0].tick < horizon) this.tape.shift();
        }
      }
      if (this.clip){ this.pumpClip(dt); return; }
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
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = 0;
    if (this.clipTimer) clearTimeout(this.clipTimer);
    this.clipTimer = 0;
    if (this.clip) this.endClip();
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
    game.simTick = frame.tick;   // keeps golden reads coherent after replays
    if (this.conn && this.conn.lastSnapshotTick !== this.syncedSnapshotTick)
      this.syncScoreboardState(this.conn);
  }

  /**
   * A3 cosmetic audit: the golden stats surfaces (stats panel, full-time
   * stat line, player sheets, bench) read team/player fields the sim would
   * normally accrue — frozen online. Full snapshots stream them all
   * (teams[].stats, teams[].tactics, per-player cards), so reconcile on
   * every fresh snapshot (~5s cadence). Not streamed and left at zero:
   * per-player touches/distance/chances (nothing authoritative to show).
   */
  syncScoreboardState(conn){
    const game = this.win.game;
    this.syncedSnapshotTick = conn.lastSnapshotTick;
    conn.lastTeams?.forEach((ts, idx) => {
      const team = game.teams[idx];
      const s = ts.stats;
      team.shots = s.shots; team.onTarget = s.onTarget;
      team.passAtt = s.passAtt; team.passCmp = s.passCmp;
      team.possT = s.possessionSeconds; team.fouls = s.fouls;
      team.subsUsed = ts.subsUsed;
      // tactics truth for the panels — but never underneath an open tactics
      // panel, where the controller's local slider edits are the truth until
      // the close-flush sends them
      if (!(game.panel?.type === 'tactics')){
        const { markTarget, formation, ...rest } = ts.tactics;
        Object.assign(team.tactics, rest);
        team.tactics.formation = formation;
        team.assignedFormation = formation;
        team.tactics.markTarget = markTarget ? this.byExternal.get(markTarget)?.pid ?? null : null;
      }
    });
    for (const ps of conn.lastSnapshotPlayers ?? []){
      const gp = this.byExternal.get(ps.playerId);
      if (!gp) continue;
      gp.stats.yellow = ps.yellow ?? gp.stats.yellow;
      gp.stats.red = ps.red ? 1 : gp.stats.red;
      }
  }
}
