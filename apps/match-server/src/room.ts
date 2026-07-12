// MatchRoom — one authoritative MatchEngine per active match, plus everything
// around it: command sequencing, rate limiting, persistence, broadcasting,
// recovery and result finalization.
import { MatchEngine } from '@fobal/engine';
import {
  AcceptedCommand, Command, MatchEvent, MatchManifest, MatchResult,
  ServerMessage, StateSnapshot,
} from '@fobal/protocol';
import { MatchStore } from './store.js';
import { signResult, SigningKeys } from './signing.js';

export interface RoomClient {
  id: number;
  role: 'controller' | 'spectator';
  teamId: string | null;
  send(message: ServerMessage): void;
}

export interface RoomOptions {
  store: MatchStore;
  keys: SigningKeys;
  /** ticks between deltas (6 ≈ 10Hz at real-time pacing) */
  deltaEvery?: number;
  /** ticks between broadcast/persisted protocol snapshots */
  snapshotEvery?: number;
  /** ticks between persisted internal recovery states */
  internalEvery?: number;
  /** scheduling delay added to accepted commands */
  commandDelay?: number;
  /** tactical commands allowed per rolling minute per connection */
  tacticalPerMinute?: number;
}

interface Bucket { tokens: number; lastRefill: number }

export class MatchRoom {
  readonly matchId: string;
  readonly manifest: MatchManifest;
  private engine: MatchEngine;
  private store: MatchStore;
  private keys: SigningKeys;
  private clients = new Map<number, RoomClient>();
  private buckets = new Map<number, Bucket>();
  private nextSeq = 0;
  private flushedEventSeq = -1;       // last event seq persisted+broadcast
  private lastDeltaTick = -1;
  private lastSnapshotTick = -1;
  private lastInternalTick = -1;
  private opts: Required<Omit<RoomOptions, 'store' | 'keys'>>;
  private finalized: MatchResult | null = null;
  private driver: NodeJS.Timeout | null = null;
  private turboRunning = false;

  private constructor(engine: MatchEngine, manifest: MatchManifest, options: RoomOptions){
    this.engine = engine;
    this.manifest = manifest;
    this.matchId = manifest.matchId;
    this.store = options.store;
    this.keys = options.keys;
    this.opts = {
      deltaEvery: options.deltaEvery ?? 6,
      snapshotEvery: options.snapshotEvery ?? 300,
      internalEvery: options.internalEvery ?? 1800,
      commandDelay: options.commandDelay ?? 30,
      tacticalPerMinute: options.tacticalPerMinute ?? 6,
    };
  }

  /** Fresh match from a validated manifest. */
  static create(rawManifest: unknown, options: RoomOptions): MatchRoom {
    const engine = MatchEngine.create(rawManifest);
    const manifest = engine.manifest!;
    const room = new MatchRoom(engine, manifest, options);
    options.store.saveManifest(manifest);
    return room;
  }

  /**
   * Crash recovery: rebuild from the latest internal snapshot when present,
   * otherwise deterministically replay the persisted command log.
   */
  static resume(matchId: string, options: RoomOptions): MatchRoom {
    const manifest = options.store.loadManifest(matchId);
    const commands = options.store.loadCommands(matchId);
    const engine = MatchEngine.create(manifest);
    const internal = options.store.loadInternal(matchId);
    if (internal){
      engine.restoreInternalState(internal, commands);
    } else {
      for (const c of commands){
        const r = engine.submit(c);
        if (!r.accepted) throw new Error(`resume: persisted command ${c.seq} rejected: ${r.reason}`);
      }
    }
    const room = new MatchRoom(engine, manifest, options);
    room.nextSeq = commands.length ? Math.max(...commands.map(c => c.seq)) + 1 : 0;
    const events = options.store.loadEvents(matchId);
    room.flushedEventSeq = events.length ? events[events.length - 1]!.seq : -1;
    return room;
  }

  get currentTick(): number { return this.engine.currentTick; }
  isOver(): boolean { return this.engine.isOver(); }
  result(): MatchResult | null { return this.finalized ?? this.store.loadResult(this.matchId); }

  // ---- clients -----------------------------------------------------------

  attach(client: RoomClient, resumeFromSeq?: number): void {
    this.clients.set(client.id, client);
    const snapshot = this.engine.snapshot();
    client.send({
      type: 'welcome',
      matchId: this.matchId,
      role: client.role,
      ...(client.teamId ? { teamId: client.teamId } : {}),
      manifest: this.manifest,
      snapshot,
      eventSeq: this.flushedEventSeq,
    });
    // reconnection recovery: persisted events after the client's last seq
    if (resumeFromSeq !== undefined){
      for (const event of this.store.loadEvents(this.matchId))
        if (event.seq >= resumeFromSeq) client.send({ type: 'event', event });
    }
    const result = this.result();
    if (result) client.send({ type: 'result', result });
  }

  detach(clientId: number): void {
    this.clients.delete(clientId);
    this.buckets.delete(clientId);
  }

  sendSnapshotTo(clientId: number): void {
    this.clients.get(clientId)?.send({ type: 'snapshot', snapshot: this.engine.snapshot() });
  }

  // ---- commands ----------------------------------------------------------

  submitCommand(client: RoomClient, rawCommand: unknown): void {
    const parsed = Command.safeParse(rawCommand);
    if (!parsed.success){
      client.send({ type: 'command_rejected', code: 'malformed', message: parsed.error.issues.map(i => i.message).join('; ') });
      return;
    }
    const command = parsed.data;
    if (client.role !== 'controller' || client.teamId !== command.teamId){
      client.send({ type: 'command_rejected', commandId: command.commandId, code: 'unauthorized', message: 'token does not control this team' });
      return;
    }
    if (this.isOver()){
      client.send({ type: 'command_rejected', commandId: command.commandId, code: 'match_over', message: 'the match has finished' });
      return;
    }
    if (command.kind === 'tactical' && !this.takeToken(client.id)){
      client.send({ type: 'command_rejected', commandId: command.commandId, code: 'rate_limited', message: `max ${this.opts.tacticalPerMinute} tactical commands per minute` });
      return;
    }
    const accepted: AcceptedCommand = {
      seq: this.nextSeq,
      effectiveTick: this.engine.currentTick + this.opts.commandDelay,
      receivedAtTick: this.engine.currentTick,
      command,
    };
    const outcome = this.engine.submit(accepted);
    if (!outcome.accepted){
      client.send({ type: 'command_rejected', commandId: command.commandId, code: 'out_of_range', message: outcome.reason ?? 'rejected' });
      return;
    }
    this.nextSeq++;
    this.store.appendCommand(this.matchId, accepted);
    client.send({ type: 'command_ack', commandId: command.commandId, seq: accepted.seq, effectiveTick: accepted.effectiveTick });
  }

  private takeToken(clientId: number): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(clientId) ?? { tokens: this.opts.tacticalPerMinute, lastRefill: now };
    const refill = ((now - bucket.lastRefill) / 60_000) * this.opts.tacticalPerMinute;
    bucket.tokens = Math.min(this.opts.tacticalPerMinute, bucket.tokens + refill);
    bucket.lastRefill = now;
    if (bucket.tokens < 1){ this.buckets.set(clientId, bucket); return false; }
    bucket.tokens -= 1;
    this.buckets.set(clientId, bucket);
    return true;
  }

  // ---- simulation driving -------------------------------------------------

  /** Advance n ticks and flush events/deltas/snapshots to store + clients. */
  advance(ticks: number): void {
    if (this.isOver()){ this.finalize(); return; }
    this.engine.run(ticks);
    this.flush();
  }

  /** Real-time pacing: 60 sim ticks per wall second. */
  startRealtime(): void {
    if (this.driver) return;
    this.driver = setInterval(() => {
      this.advance(6);
      if (this.isOver()) this.stop();
    }, 100);
  }

  /** As-fast-as-possible pacing that still yields to the event loop. */
  runTurbo(sliceTicks = 240): Promise<MatchResult> {
    this.turboRunning = true;
    return new Promise((resolve, reject) => {
      const slice = (): void => {
        try {
          if (!this.turboRunning) return reject(new Error('room stopped'));
          this.advance(sliceTicks);
          if (this.isOver()){
            const result = this.finalize();
            this.turboRunning = false;
            resolve(result);
          } else setImmediate(slice);
        } catch (err){ reject(err as Error); }
      };
      setImmediate(slice);
    });
  }

  stop(): void {
    this.turboRunning = false;
    if (this.driver){ clearInterval(this.driver); this.driver = null; }
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients.values()) client.send(message);
  }

  private flush(): void {
    // events: persist + broadcast strictly in seq order
    for (const event of this.engine.events(this.flushedEventSeq + 1)){
      this.store.appendEvent(this.matchId, event);
      this.broadcast({ type: 'event', event });
      this.flushedEventSeq = event.seq;
    }
    const tick = this.engine.currentTick;
    if (tick - this.lastDeltaTick >= this.opts.deltaEvery){
      this.broadcast({ type: 'delta', delta: this.engine.drainDelta() });
      this.lastDeltaTick = tick;
    }
    if (tick - this.lastSnapshotTick >= this.opts.snapshotEvery){
      const snapshot: StateSnapshot = this.engine.snapshot();
      this.store.saveSnapshot(this.matchId, snapshot);
      this.broadcast({ type: 'snapshot', snapshot });
      this.lastSnapshotTick = tick;
    }
    if (tick - this.lastInternalTick >= this.opts.internalEvery){
      this.store.saveInternal(this.matchId, this.engine.captureInternalState());
      this.lastInternalTick = tick;
    }
    if (this.isOver()) this.finalize();
  }

  /** Sign + persist the final result exactly once; always broadcast the
   *  persisted copy (idempotent under crashes and repeated calls). */
  finalize(): MatchResult {
    if (this.finalized) return this.finalized;
    const unsigned = this.engine.result();
    const signed = signResult(unsigned, this.keys);
    const persisted = this.store.saveResultOnce(this.matchId, signed);
    this.finalized = persisted;
    this.broadcast({ type: 'result', result: persisted });
    return persisted;
  }

  /** The engine's authoritative final-state hash (proof hooks). */
  stateHash(): string { return this.engine.finalStateHash(); }
}
