// Authoritative spectator renderer for Online Mode.
//
// Draws whatever the server said and NOTHING else: every number on screen
// (score, clock, events) comes verbatim from server messages. This renderer
// runs at 60fps over the interpolation buffer. The full golden presentation
// (stadium, crowd, avatars, replays) remains available in Local Mode; porting
// it onto the online state feed is tracked in docs/refactor-plan.md.
const PITCH_L = 105, PITCH_W = 68;

export class SpectatorRenderer {
  constructor(canvas, connection){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.conn = connection;
    this.ticker = [];
    connection.hooks.onEvent = (e) => {
      if (['goal', 'card', 'substitution', 'foul', 'offside', 'halftime', 'fulltime', 'kickoff'].includes(e.type))
        this.ticker.unshift(e);
      if (this.ticker.length > 6) this.ticker.pop();
    };
  }

  colors(teamIdx){ return teamIdx === 0 ? '#e04848' : '#4888e0'; }

  teamIndexOf(playerId){
    const m = this.conn.manifest;
    if (!m) return 0;
    return m.teams[1].players.some(p => p.playerId === playerId) ? 1 : 0;
  }

  draw(){
    const { ctx, canvas } = this;
    const frame = this.conn.frame(Date.now());
    const W = canvas.width = canvas.clientWidth;
    const H = canvas.height = canvas.clientHeight;
    ctx.fillStyle = '#0a1410';
    ctx.fillRect(0, 0, W, H);
    if (!frame){ this.drawStatus(W, H); return; }
    if (W <= 80 || H <= 100){ this.drawStatus(W, H); return; } // degenerate canvas

    // pitch mapping with margins
    const pad = 30;
    const sx = (W - pad * 2) / PITCH_L, sy = (H - pad * 2 - 40) / PITCH_W;
    const s = Math.max(0.01, Math.min(sx, sy)); // never a negative arc radius
    const ox = (W - PITCH_L * s) / 2, oy = 40 + (H - 40 - PITCH_W * s) / 2;
    const X = x => ox + x * s, Y = y => oy + y * s;

    // pitch
    ctx.fillStyle = '#12351f';
    ctx.fillRect(X(0), Y(0), PITCH_L * s, PITCH_W * s);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(X(0), Y(0), PITCH_L * s, PITCH_W * s);
    ctx.beginPath(); ctx.moveTo(X(52.5), Y(0)); ctx.lineTo(X(52.5), Y(68)); ctx.stroke();
    ctx.beginPath(); ctx.arc(X(52.5), Y(34), 9.15 * s, 0, 7); ctx.stroke();
    for (const gx of [0, 105]){
      const dir = gx === 0 ? 1 : -1;
      ctx.strokeRect(X(gx), Y(34 - 20.16), 16.5 * s * dir, 40.32 * s);
      ctx.strokeRect(X(gx), Y(34 - 9.16), 5.5 * s * dir, 18.32 * s);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(X(gx) - (gx === 0 ? 3 : -1), Y(34 - 3.66), 2, 7.32 * s);
    }

    // players
    for (const [id, p] of frame.players){
      if (!p.onPitch) continue;
      const ti = this.teamIndexOf(id);
      ctx.beginPath();
      ctx.arc(X(p.position.x), Y(p.position.y), Math.max(3, 4.5 * s * 0.6), 0, 7);
      ctx.fillStyle = this.colors(ti);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.stroke();
    }

    // ball (with a little height cue)
    const b = frame.ball.position;
    ctx.beginPath();
    ctx.arc(X(b.x), Y(b.y) - b.z * s * 0.8, Math.max(2, 2.2 * s * 0.5), 0, 7);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(X(b.x), Y(b.y), 2.5, 1.2, 0, 0, 7);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    // score bug — verbatim authoritative values
    const m = this.conn.manifest;
    const names = m ? [m.teams[0].name, m.teams[1].name] : ['HOME', 'AWAY'];
    ctx.fillStyle = 'rgba(8,13,22,0.85)';
    ctx.fillRect(12, 8, 330, 26);
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.fillStyle = this.colors(0); ctx.fillText(names[0].slice(0, 12), 20, 26);
    ctx.fillStyle = '#fff';
    ctx.fillText(`${frame.score[0]} - ${frame.score[1]}`, 150, 26);
    ctx.fillStyle = this.colors(1); ctx.fillText(names[1].slice(0, 12), 200, 26);
    ctx.fillStyle = '#7fe8bd';
    ctx.fillText(frame.clock, 300, 26);
    ctx.fillStyle = '#93a1b5';
    ctx.fillText(frame.matchState, W - 110, 26);

    // event ticker
    ctx.font = '11px ui-monospace, monospace';
    this.ticker.forEach((e, i) => {
      ctx.fillStyle = `rgba(200,215,230,${1 - i * 0.15})`;
      ctx.fillText(`${e.clock}  ${e.type.toUpperCase()}${e.playerId ? '  ' + e.playerId : ''}`, 12, H - 12 - i * 15);
    });

    this.drawStatus(W, H);
  }

  drawStatus(W){
    const { ctx } = this;
    const st = this.conn.status;
    if (st === 'live') return;
    ctx.fillStyle = st === 'reconnecting' ? '#ffc93d' : '#e05252';
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.fillText(st.toUpperCase(), W - 110, 48);
  }

  start(){
    const loop = () => {
      // a bad frame must never kill the rAF chain
      try { this.draw(); } catch (err){ console.error('spectator draw failed', err); }
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop(){ if (this._raf) cancelAnimationFrame(this._raf); }
}
