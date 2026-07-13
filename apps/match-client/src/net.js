// MatchConnection — the client's only pipe to an authoritative match.
//
// Rules enforced by construction:
//  - the client NEVER computes official state: score, clock, match state,
//    events and results are read verbatim from server messages
//  - reconnection recovers from a fresh authoritative snapshot plus events
//    after the last seen seq (hello.resumeFromSeq)
//  - commands are fire-and-ack; the sim applies them at the server-assigned
//    effective tick, never locally
//
// The class takes a socket factory so tests can drive it with a fake socket;
// in the browser pass url => new WebSocket(url).
import { buildFrame, frameFromSnapshot, InterpolationBuffer } from './interpolate.js';

export class MatchConnection {
  /**
   * @param {object} opts
   * @param {string} opts.url            ws:// endpoint
   * @param {string} opts.matchId
   * @param {string} opts.token
   * @param {(url: string) => any} opts.socketFactory
   * @param {object} [opts.hooks]        onEvent/onResult/onStatus/onAck/onRejected
   * @param {number} [opts.maxRetries]
   * @param {(ms: number, fn: () => void) => any} [opts.schedule] injectable for tests
   */
  constructor({ url, matchId, token, socketFactory, hooks = {}, maxRetries = 8, schedule }){
    this.url = url;
    this.matchId = matchId;
    this.token = token;
    this.socketFactory = socketFactory;
    this.hooks = hooks;
    this.maxRetries = maxRetries;
    this.schedule = schedule ?? ((ms, fn) => setTimeout(fn, ms));

    this.buffer = new InterpolationBuffer();
    this.lastFrame = null;          // newest authoritative frame (pre-interpolation)
    this.lastEventSeq = -1;
    this.events = [];               // verbatim server events
    this.manifest = null;
    this.role = null;
    this.teamId = null;
    this.result = null;
    this.status = 'idle';           // idle → connecting → live → reconnecting → closed/failed
    this.retries = 0;
    this.socket = null;
    this._closedByUser = false;
    this._welcomed = false;         // true once any welcome arrived (enables resume)
  }

  connect(){
    this._closedByUser = false;
    this.status = this.status === 'live' || this.status === 'reconnecting' ? 'reconnecting' : 'connecting';
    this._emitStatus();
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    socket.onopen = () => {
      const hello = { type: 'hello', matchId: this.matchId, token: this.token };
      // Any reconnect after a first welcome must resume — even from seq 0.
      // Gating on lastEventSeq >= 0 would silently drop every event that
      // happened during an outage that began before the first event arrived.
      if (this._welcomed) hello.resumeFromSeq = this.lastEventSeq + 1;
      socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (ev) => this._onRaw(typeof ev === 'string' ? ev : ev.data);
    socket.onclose = () => this._onDisconnect();
    socket.onerror = () => { /* onclose follows */ };
    return this;
  }

  close(){
    this._closedByUser = true;
    this.status = 'closed';
    if (this.socket) this.socket.close();
    this._emitStatus();
  }

  /** Submit a Command (protocol shape). The server acks with seq + tick. */
  sendCommand(command){
    if (this.status !== 'live' || !this.socket) return false;
    this.socket.send(JSON.stringify({ type: 'command', command }));
    return true;
  }

  requestSnapshot(){
    if (this.socket && this.status === 'live')
      this.socket.send(JSON.stringify({ type: 'request_snapshot' }));
  }

  /** The frame to render right now (interpolated), or null before welcome.
   *  Render loops should pass Date.now() for continuous inter-frame motion. */
  frame(nowMs){ return this.buffer.sample(nowMs); }

  // -- internals ----------------------------------------------------------

  _onDisconnect(){
    if (this._closedByUser) return;
    if (this.retries >= this.maxRetries){
      this.status = 'failed';
      this._emitStatus();
      return;
    }
    this.status = 'reconnecting';
    this._emitStatus();
    const backoff = Math.min(8000, 250 * 2 ** this.retries++);
    this.schedule(backoff, () => { if (!this._closedByUser) this.connect(); });
  }

  _onRaw(raw){
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type){
      case 'welcome': {
        this.manifest = msg.manifest;
        this.role = msg.role;
        this.teamId = msg.teamId ?? null;
        this.retries = 0;
        const frame = frameFromSnapshot(msg.snapshot);
        this.buffer.reset(frame);          // authoritative resync point
        this.lastFrame = frame;
        this._welcomed = true;
        this.status = 'live';
        this._emitStatus();
        break;
      }
      case 'snapshot': {
        const frame = frameFromSnapshot(msg.snapshot);
        // periodic snapshots correct drift without wiping the lerp window
        this.buffer.push(frame);
        this.lastFrame = frame;
        break;
      }
      case 'delta': {
        if (!this.lastFrame) break;        // deltas before the first snapshot are unusable
        if (msg.delta.tick < this.lastFrame.tick) break; // stale
        const frame = buildFrame(this.lastFrame, msg.delta);
        this.buffer.push(frame);
        this.lastFrame = frame;
        break;
      }
      case 'event': {
        const e = msg.event;
        if (e.seq <= this.lastEventSeq) break;          // dedupe on resume
        this.lastEventSeq = e.seq;
        this.events.push(e);
        if (this.hooks.onEvent) this.hooks.onEvent(e);
        break;
      }
      case 'result': {
        this.result = msg.result;
        if (this.hooks.onResult) this.hooks.onResult(msg.result);
        break;
      }
      case 'command_ack': {
        if (this.hooks.onAck) this.hooks.onAck(msg);
        break;
      }
      case 'command_rejected': {
        if (this.hooks.onRejected) this.hooks.onRejected(msg);
        break;
      }
      case 'error': {
        if (this.hooks.onError) this.hooks.onError(msg);
        break;
      }
      default: break;
    }
  }

  _emitStatus(){ if (this.hooks.onStatus) this.hooks.onStatus(this.status); }
}
