// Workstream G — the instruction book: per-player tactical instructions
// applied to the golden simulation WITHOUT touching golden code.
//
// The mechanism: every golden player carries a formation station,
// `p.slot = { x, y, role }` (x: 0..1 along the pitch toward the opposition
// goal, y: 0..1 across the width), and `formationWorld` re-reads it EVERY
// tick to derive the player's home position — which the player AI then
// blends with ball state, tactics, marking and pressing. A spatial
// instruction is therefore a deterministic bias of the station: the manager
// moves the player's post, and the player's own AI — pace, stamina,
// positioning, decision-making — still decides every actual step. Intent
// vs execution, by construction.
//
// Rules (all deterministic, all tick-based):
//   - one active instruction per player; a new one replaces the old
//   - geometry is ALWAYS derived from the player's captured base station,
//     so replacements never compound drift
//   - ttl expiry restores the base station on the tick boundary
//   - a formation change deletes the team's spatial instructions WITHOUT
//     restoring (setFormation just rebuilt every station); mark assignments
//     survive — they are assignments, not geometry
//   - mark_opponent rides the golden team-level markTarget (the engine's
//     one marking machine): a new mark on the same team replaces the
//     previous marker's record. One shadow per team — an honest engine
//     limitation, documented, not hidden.
//   - slots live inside the vm snapshot (SnapshotManager captures them), so
//     biased geometry survives crash-resume; this book's metadata rides
//     CapturedState so expiry and reporting survive with it.
import type { ActiveInstruction, PlayerInstructionCommand } from '@fobal/protocol';
import type { IdMap } from './ids.js';

/** station-bias magnitudes, in slot space (fractions of pitch dimensions) */
const ADVANCE = 0.12;      // push_forward / drop_back along the length
const WIDEN = 0.16;        // stay_wide / stay_central across the width
const OVERLAP_X = 0.10;    // overlap: forward…
const OVERLAP_Y = 0.14;    // …and wide, together
const X_MIN = 0.06, X_MAX = 0.93;   // never station a player inside a goal
const Y_MIN = 0.05, Y_MAX = 0.95;

export interface InstructionRecord {
  playerId: string;                  // external id (canonical identity)
  teamIdx: 0 | 1;
  kind: Exclude<PlayerInstructionCommand['instruction'], 'clear'>;
  targetPlayerId: string | null;     // external id, mark_opponent only
  sinceTick: number;
  expiresAtTick: number | null;
  baseSlot: { x: number; y: number };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** the station a spatial instruction produces, derived from the base only */
export function biasedSlot(kind: InstructionRecord['kind'], base: { x: number; y: number }):
  { x: number; y: number } {
  const towardTouchline = base.y >= 0.5 ? 1 : -1;
  switch (kind) {
    case 'stay_wide':
      return { x: base.x, y: clamp(base.y + towardTouchline * WIDEN, Y_MIN, Y_MAX) };
    case 'stay_central': {
      // 0.16 toward the centre line, never crossing it
      const y = base.y >= 0.5 ? Math.max(0.5, base.y - WIDEN) : Math.min(0.5, base.y + WIDEN);
      return { x: base.x, y };
    }
    case 'push_forward':
      return { x: clamp(base.x + ADVANCE, X_MIN, X_MAX), y: base.y };
    case 'drop_back':
      return { x: clamp(base.x - ADVANCE, X_MIN, X_MAX), y: base.y };
    case 'overlap':
      return {
        x: clamp(base.x + OVERLAP_X, X_MIN, X_MAX),
        y: clamp(base.y + towardTouchline * OVERLAP_Y, Y_MIN, Y_MAX),
      };
    case 'underlap': {
      // the inside channel: forward like an overlap, but toward the half-space
      const y = base.y >= 0.5 ? Math.max(0.5, base.y - OVERLAP_Y) : Math.min(0.5, base.y + OVERLAP_Y);
      return { x: clamp(base.x + OVERLAP_X, X_MIN, X_MAX), y };
    }
    case 'hold_position':
    case 'mark_opponent':
      return { x: base.x, y: base.y };
  }
}

export class InstructionBook {
  private records = new Map<string, InstructionRecord>();   // playerId → record

  /** Apply a validated player_instruction at its effective tick. The caller
   *  (MatchEngine) has already validated ids, team membership, GK rules and
   *  mark targets; this is pure deterministic application. Returns the
   *  internal mark pid when the golden markTarget must be updated. */
  apply(game: any, teamIdx: 0 | 1, ids: IdMap, cmd: PlayerInstructionCommand, tick: number):
    { setMark?: string | null } {
    const pid = ids.pid(cmd.playerId);
    const player = game.teams[teamIdx].players.find((p: any) => p.pid === pid);
    if (!player) return {};                       // validated, but raced a red card — no-op

    const existing = this.records.get(cmd.playerId);
    if (cmd.instruction === 'clear') {
      if (existing) {
        player.slot.x = existing.baseSlot.x;
        player.slot.y = existing.baseSlot.y;
        this.records.delete(cmd.playerId);
        if (existing.kind === 'mark_opponent') {
          game.teams[teamIdx]._marker = null;
          return { setMark: null };
        }
      }
      return {};
    }

    // the base station is the FORMATION's station: captured on first
    // instruction, invariant under replacements, restored on clear/expiry
    const baseSlot = existing?.baseSlot ?? { x: player.slot.x, y: player.slot.y };
    const record: InstructionRecord = {
      playerId: cmd.playerId,
      teamIdx,
      kind: cmd.instruction,
      targetPlayerId: cmd.targetPlayerId ?? null,
      sinceTick: tick,
      expiresAtTick: cmd.ttlTicks ? tick + cmd.ttlTicks : null,
      baseSlot,
    };

    if (cmd.instruction === 'mark_opponent') {
      // one shadow per team (golden's single markTarget): drop any other
      // marker's record on this team, keep his geometry (mark is not spatial)
      for (const [otherId, r] of this.records)
        if (r.teamIdx === teamIdx && r.kind === 'mark_opponent' && otherId !== cmd.playerId)
          this.records.delete(otherId);
      this.records.set(cmd.playerId, record);
      // golden's marking machinery elects a marker and STICKS to him via
      // team._marker — claiming it here makes the INSTRUCTED player the
      // shadow instead of whoever wandered into the branch first
      game.teams[teamIdx]._marker = player;
      return { setMark: ids.pid(cmd.targetPlayerId!) };
    }

    const target = biasedSlot(cmd.instruction, baseSlot);
    player.slot.x = target.x;
    player.slot.y = target.y;
    this.records.set(cmd.playerId, record);
    // replacing a mark with a spatial instruction releases the shadow
    if (existing?.kind === 'mark_opponent') {
      game.teams[teamIdx]._marker = null;
      return { setMark: null };
    }
    return {};
  }

  /** Tick-boundary sweep: expire ttl'd instructions (restore stations) and
   *  drop records of players no longer on the pitch. Deterministic — runs
   *  after due commands, before the sim step, every tick. Returns whether
   *  a mark assignment lapsed (caller clears golden markTarget). */
  sweep(game: any, ids: IdMap, tick: number): { clearMark: Array<0 | 1> } {
    const clearMark: Array<0 | 1> = [];
    for (const [playerId, r] of this.records) {
      const team = game.teams[r.teamIdx];
      const pid = ids.pid(playerId);
      const player = team.players.find((p: any) => p.pid === pid);
      if (!player) {                              // substituted or sent off
        this.records.delete(playerId);
        if (r.kind === 'mark_opponent') { team._marker = null; clearMark.push(r.teamIdx); }
        continue;
      }
      if (r.expiresAtTick !== null && tick >= r.expiresAtTick) {
        player.slot.x = r.baseSlot.x;
        player.slot.y = r.baseSlot.y;
        this.records.delete(playerId);
        if (r.kind === 'mark_opponent') { team._marker = null; clearMark.push(r.teamIdx); }
      }
    }
    return { clearMark };
  }

  /** Formation change: every station was just rebuilt — spatial records are
   *  meaningless now. Delete them WITHOUT restoring. Marks survive. */
  onFormationChange(teamIdx: 0 | 1): void {
    for (const [playerId, r] of this.records)
      if (r.teamIdx === teamIdx && r.kind !== 'mark_opponent')
        this.records.delete(playerId);
  }

  /** the world-visible view (snapshot + debug tooling) */
  report(teamIdx: 0 | 1): ActiveInstruction[] {
    const out: ActiveInstruction[] = [];
    for (const r of this.records.values())
      if (r.teamIdx === teamIdx)
        out.push({
          playerId: r.playerId,
          instruction: r.kind,
          targetPlayerId: r.targetPlayerId,
          sinceTick: r.sinceTick,
          expiresAtTick: r.expiresAtTick,
        });
    return out.sort((a, b) => a.playerId.localeCompare(b.playerId));
  }

  /** crash-resume: metadata out… */
  capture(): InstructionRecord[] {
    return JSON.parse(JSON.stringify([...this.records.values()])) as InstructionRecord[];
  }

  /** …and back in. Slot geometry itself was restored by the vm snapshot;
   *  only the book (expiry clocks, base stations, reporting) needs refill. */
  restore(records: InstructionRecord[]): void {
    this.records.clear();
    for (const r of records) this.records.set(r.playerId, r);
  }

  get size(): number { return this.records.size; }
}
