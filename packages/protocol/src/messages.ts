import { z } from 'zod';
import { Command, MatchEvent, MatchManifest, MatchResult, StateDelta, StateSnapshot } from './match.js';
import { MatchId, Seq, Tick } from './core.js';

// ---------------------------------------------------------------------------
// WebSocket wire messages. All messages are JSON objects with a `type` tag.
// ---------------------------------------------------------------------------

export const ClientMessage = z.discriminatedUnion('type', [
  // First message on any connection. `token` decides the role (controller of
  // one team, or spectator). `resumeFromSeq` asks for events after a seq for
  // reconnection recovery.
  z.object({
    type: z.literal('hello'),
    matchId: MatchId,
    token: z.string().min(8).max(1024),   // base64url(payload).base64url(mac); two 128-char ids fit
    resumeFromSeq: Seq.optional(),
  }),
  z.object({ type: z.literal('command'), command: Command }),
  z.object({ type: z.literal('request_snapshot') }),
  z.object({ type: z.literal('ping'), t: z.number().optional() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    matchId: MatchId,
    role: z.enum(['controller', 'spectator']),
    teamId: z.string().optional(),          // set when role === 'controller'
    manifest: MatchManifest,
    snapshot: StateSnapshot,
    eventSeq: z.number().int().min(-1),      // last event seq at snapshot time; -1 = none yet
  }),
  z.object({ type: z.literal('snapshot'), snapshot: StateSnapshot }),
  z.object({ type: z.literal('delta'), delta: StateDelta }),
  z.object({ type: z.literal('event'), event: MatchEvent }),
  z.object({
    type: z.literal('command_ack'),
    commandId: z.string(),
    seq: Seq,
    effectiveTick: Tick,
  }),
  z.object({
    type: z.literal('command_rejected'),
    commandId: z.string().optional(),
    code: z.enum(['unauthorized', 'invalid', 'rate_limited', 'out_of_range', 'match_over', 'malformed']),
    message: z.string(),
  }),
  z.object({ type: z.literal('result'), result: MatchResult }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('pong'), t: z.number().optional() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---------------------------------------------------------------------------
// Parse helpers — never throw; malformed input yields { ok: false }.
// ---------------------------------------------------------------------------
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function safeJson(raw: unknown): ParseResult<unknown> {
  if (typeof raw !== 'string' && !(raw instanceof Uint8Array))
    return { ok: false, error: 'expected string or binary frame' };
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    if (text.length > 256 * 1024) return { ok: false, error: 'frame too large' };
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
}

export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  const j = safeJson(raw);
  if (!j.ok) return j;
  const r = ClientMessage.safeParse(j.value);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues.map(i => i.message).join('; ') };
}

export function parseServerMessage(raw: unknown): ParseResult<ServerMessage> {
  const j = safeJson(raw);
  if (!j.ok) return j;
  const r = ServerMessage.safeParse(j.value);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues.map(i => i.message).join('; ') };
}
