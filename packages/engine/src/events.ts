// Taps the golden recorder's semantic stream and translates it into protocol
// MatchEvents with external ids. Presentation noise (crowd, touches, call
// outs) and raw input echoes are filtered out of the official stream.
import type { MatchEvent, MatchEventType } from '@fobal/protocol';
import type { IdMap } from './ids.js';
import type { GoldenHandle } from './goldenRuntime.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const TYPE_MAP: Record<string, MatchEventType> = {
  goal: 'goal',
  kickoff: 'kickoff',
  pass_complete: 'pass_complete',
  interception: 'interception',
  tackle: 'tackle',
  foul_committed: 'foul',
  card: 'card',
  send_off: 'card',
  substitution: 'substitution',
  offside: 'offside',
  restart: 'restart',
  restart_taken: 'restart',
  tactic: 'tactic_change',
  gk_catch: 'gk_catch',
  gk_parry: 'gk_parry',
  cross: 'cross',
  header: 'header',
  shot: 'shot',
  pass: 'other',
  through: 'other',
  clear: 'clearance',
};

const IGNORED = new Set([
  'crowd', 'touch', 'call_for_ball', 'state', 'reset_start', 'advantage',
  'human_move', 'human_kick', 'human_select', 'human_mode', 'take_trigger',
]);

export function formatClock(tMatch: number): string {
  const total = Math.max(0, Math.floor(tMatch));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export class EventTap {
  readonly events: MatchEvent[] = [];
  private seq = 0;

  constructor(private handle: GoldenHandle, private ids: IdMap){}

  /** Wraps game.recorder.log — the single semantic chokepoint. */
  install(): void {
    const game = this.handle.game;
    const recorder = game.recorder;
    const original = recorder.log.bind(recorder);
    const tap = this;
    recorder.log = function(type: string, data: any){
      original(type, data);
      tap.onGoldenEvent(type, data ?? {});
    };
  }

  private extPlayer(pid: unknown): string | undefined {
    if (typeof pid !== 'string') return undefined;
    return this.ids.externalOrNull(pid) ?? undefined;
  }

  private extTeam(tid: unknown): string | undefined {
    if (tid !== 0 && tid !== 1) return undefined;
    return this.ids.teamExternal(tid);
  }

  private onGoldenEvent(type: string, data: any): void {
    if (IGNORED.has(type)) return;
    const game = this.handle.game;
    if (game.replayMode) return; // cinematic re-simulation must not re-emit
    const mapped = TYPE_MAP[type] ?? 'other';
    const playerId = this.extPlayer(data.actor);
    const teamId = this.extTeam(data.team) ?? (playerId ? this.teamOfPlayer(playerId) : undefined);
    const event: MatchEvent = {
      seq: this.seq++,
      tick: game.simTick,
      clock: formatClock(game.match.tMatch),
      type: mapped,
      ...(teamId ? { teamId } : {}),
      ...(playerId ? { playerId } : {}),
      ...(this.extPlayer(data.target) ? { targetId: this.extPlayer(data.target) } : {}),
      ...(data.position ? { position: { x: data.position.x, y: data.position.y } } : {}),
      data: sanitizeData(type, data),
    };
    this.events.push(event);
  }

  /** Engine-generated lifecycle events (not present in the recorder stream). */
  emitSynthetic(type: MatchEventType, data: Record<string, unknown> = {}): void {
    const game = this.handle.game;
    this.events.push({
      seq: this.seq++,
      tick: game.simTick,
      clock: formatClock(game.match.tMatch),
      type,
      data,
    });
  }

  eventsSince(seq: number): MatchEvent[] {
    return this.events.filter(e => e.seq >= seq);
  }

  nextSeq(): number { return this.seq; }

  /** Continue the sequence after a snapshot restore (events before the
   *  restore point live in the server's append-only log, not here). */
  seedSeq(seq: number): void { this.seq = seq; }

  private teamOfPlayer(externalId: string): string | undefined {
    const game = this.handle.game;
    const pid = this.ids.pid(externalId);
    for (const idx of [0, 1] as const){
      const t = game.teams[idx];
      if ([...t.players, ...(t.bench ?? []), ...(t.offList ?? [])].some((p: any) => p.pid === pid))
        return this.ids.teamExternal(idx);
    }
    return undefined;
  }
}

function sanitizeData(type: string, data: any): Record<string, unknown> {
  const out: Record<string, unknown> = { goldenType: type };
  for (const k of ['card', 'kind', 'auto', 'won', 'slide', 'save', 'og', 'label']){
    if (data[k] !== undefined) out[k] = data[k];
  }
  return out;
}
