// C2 — the LLM tactical interpreter. Free speech (any language) in, a
// schema-constrained TacticalPatch + a natural-language confirmation out.
//
// The determinism boundary holds absolutely: the model runs HERE, outside
// the engine, as an input transformer. The client sends the resulting
// validated command through its normal authorized WebSocket path; only that
// command enters the log, so a voice-coached match replays bit-identically
// without ever re-invoking a model. Provider keys live server-side
// (Secrets Manager in staging) — never in the browser.
import Anthropic from '@anthropic-ai/sdk';
import { GameCommand, MatchIntent, PlayerIntent, TacticalPatch, TeamIntent } from '@fobal/protocol';

/** Structured-output schema the model must satisfy: a loose patch (numeric
 *  constraints are unsupported by structured outputs — we clamp, then
 *  validate against the real protocol Zod schema) plus the spoken
 *  confirmation. markTarget is deliberately absent: external player ids are
 *  meaningless to the model. Hand-written JSON Schema rather than the SDK's
 *  zodOutputFormat helper, which requires zod v4 (the protocol package —
 *  the deterministic core — pins zod 3). */
const NUM = { type: 'number' } as const;
/** A player REFERENCE — the model names who it heard; it never sees or
 *  emits playerIds (resolution is deterministic, server-side, manifest-
 *  bound: an invented player cannot survive). */
const REF = {
  type: 'object',
  properties: {
    side: { type: 'string', enum: ['own', 'opponent'] },
    name: { type: 'string' },
    shirtNumber: { type: 'integer' },
  },
  required: ['side'],
  additionalProperties: false,
} as const;
const INTERPRETATION_SCHEMA = {
  type: 'object',
  properties: {
    // workstream G: taxonomy orders — the closed football vocabulary
    orders: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['team', 'player', 'match'] },
          intent: { type: 'string', enum: [...TeamIntent.options, ...PlayerIntent.options, ...MatchIntent.options] },
          target: REF,
          formation: { type: 'string', enum: ['442', '433', '352'] },
          sub: {
            type: 'object',
            properties: { out: REF, in: REF },
            required: ['out', 'in'],
            additionalProperties: false,
          },
          intensity: NUM,
        },
        required: ['scope', 'intent'],
        additionalProperties: false,
      },
    },
    // free-form numeric adjustments for COMPARATIVE language the taxonomy
    // cannot carry ("press a LITTLE harder") — relative to current tactics
    patch: {
      type: 'object',
      properties: {
        formation: { type: 'string', enum: ['442', '433', '352'] },
        scheme: { type: 'string', enum: ['zonal', 'man', 'trap'] },
        style: { type: 'string', enum: ['direct', 'possession', 'counter', 'mixed'] },
        attackSide: { type: 'string', enum: ['left', 'right', 'both'] },
        width: NUM, trap: NUM, tempo: NUM, crossing: NUM, shootTendency: NUM,
        overlap: NUM, counter: NUM, timeWaste: NUM, pressAfterLoss: NUM,
        defAggression: NUM, gkLong: NUM, mentality: NUM, defLine: NUM,
        pressing: NUM, risk: NUM, compactness: NUM,
      },
      additionalProperties: false,
    },
    say: { type: 'string' },
  },
  required: ['say'],
  additionalProperties: false,
} as const;

export interface CoachContext {
  teamName: string;
  scoreLine: string;
  minute: number;
  currentTactics: Record<string, unknown>;
  opponent: { formation?: string; style?: unknown; pressing?: unknown };
  /** compact roster digests (shirt/name/role) — reference resolution needs
   *  names; NOTHING else from the sim rides along (STEP 6: no state dumps) */
  roster?: {
    own: Array<{ shirt: number; name: string; role: string }>;
    opponent: Array<{ shirt: number; name: string; role: string }>;
  };
}

export interface CoachInterpretation {
  patch?: TacticalPatch;
  /** schema-validated taxonomy orders (references unresolved — the hub
   *  resolves + compiles them against the manifest) */
  orders?: GameCommand[];
  coachText?: string;
  say: string | null;
}

const SYSTEM = `You are the tactical interpreter for a football management game. A coach speaks an instruction — in ANY language, in natural sideline speech (slang, fragments, self-corrections, "go go go") — and you translate it into the game's command vocabulary.

PREFER "orders": the closed football taxonomy. Team intents set the whole team's approach (press_high, drop_deep, counterattack, attack_left, play_direct, waste_time, park_the_bus, …). Player intents address ONE player (mark_player, overlap, stay_wide, …) — identify the player by a "target" REFERENCE: side ('own' = the coach's player, 'opponent' = theirs) plus the name you heard and/or a shirt number. NEVER invent players; if the coach names someone, pass the name through exactly as heard — the game resolves it against the real roster, and asks back when it is ambiguous. Match intents: change_formation (with formation), substitution (with sub.out/sub.in references). A multi-part instruction ("press high and mark their nine") becomes MULTIPLE orders. If the coach self-corrects ("no, actually drop back"), emit only the FINAL intention.

Use "patch" ONLY for comparative or fine-grained numeric language the taxonomy cannot carry ("press a bit harder", "slightly deeper line") — numeric settings range 0..1, adjusted RELATIVE to currentTactics. Enum settings: formation (442|433|352), scheme (zonal|man|trap), style (direct|possession|counter|mixed), attackSide (left|right|both).

If the instruction is not tactical (chit-chat, a question, encouragement with no actionable content), omit both orders and patch.

"say" is your confirmation back to the coach: ONE short sentence, in the SAME language the coach spoke, in the voice of an assistant coach acknowledging the order.`;

export interface CoachInterpreterOptions {
  /** injectable for tests; defaults to a real client using apiKey */
  client?: Pick<Anthropic, 'messages'>;
  apiKey?: string;
  model?: string;
}

export type CoachInterpreter = (text: string, ctx: CoachContext) => Promise<CoachInterpretation>;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Returns null when no client/key is configured — the hub then answers 501
 * and clients fall back to the golden parseCoach path (voice v0 behavior).
 */
export function createCoachInterpreter(options: CoachInterpreterOptions = {}): CoachInterpreter | null {
  if (!options.client && !options.apiKey) return null;
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  const model = options.model ?? 'claude-opus-5';

  return async function interpret(text: string, ctx: CoachContext): Promise<CoachInterpretation> {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 2000,
        output_config: {
          format: { type: 'json_schema', schema: INTERPRETATION_SCHEMA as unknown as Record<string, unknown> },
          effort: 'low',
        },
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: JSON.stringify({
            instruction: text,
            team: ctx.teamName,
            score: ctx.scoreLine,
            minute: ctx.minute,
            currentTactics: ctx.currentTactics,
            opponent: ctx.opponent,
            ...(ctx.roster ? { roster: ctx.roster } : {}),
          }),
        }],
      }, { timeout: 10_000, maxRetries: 1 });

      // safety classifiers can decline with a 200 — check before content
      if (response.stop_reason === 'refusal') return { coachText: text, say: null };
      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') return { coachText: text, say: null };
      const out = JSON.parse(textBlock.text) as {
        patch?: Record<string, unknown>; orders?: unknown[]; say?: string;
      };

      // taxonomy orders: each shape must survive the protocol schema — a
      // malformed order is dropped here, an invented PLAYER dies later at
      // the deterministic resolver (there is no id field to hallucinate)
      const orders = (out.orders ?? [])
        .map(o => GameCommand.safeParse({ version: 1, ...(o as Record<string, unknown>) }))
        .filter((r): r is { success: true; data: GameCommand } => r.success)
        .map(r => r.data);

      let patch: TacticalPatch | undefined;
      if (out.patch && Object.keys(out.patch).length > 0){
        const clamped = Object.fromEntries(Object.entries(out.patch)
          .map(([k, v]) => [k, typeof v === 'number' ? clamp01(v) : v]));
        const parsed = TacticalPatch.safeParse(clamped);
        if (parsed.success && Object.keys(parsed.data).length > 0) patch = parsed.data;
      }

      if (!patch && orders.length === 0)
        // nothing structured survived: hand the raw text to the golden
        // parseCoach fallback ONLY if the model produced a failed read
        return out.patch || out.orders?.length
          ? { coachText: text, say: out.say ?? null }
          : { say: out.say ?? null };
      return { ...(patch ? { patch } : {}), ...(orders.length ? { orders } : {}), say: out.say ?? null };
    } catch {
      // model unreachable/timeout — the golden parseCoach still gets a shot
      return { coachText: text, say: null };
    }
  };
}
