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
import { TacticalPatch } from '@fobal/protocol';

/** Structured-output schema the model must satisfy: a loose patch (numeric
 *  constraints are unsupported by structured outputs — we clamp, then
 *  validate against the real protocol Zod schema) plus the spoken
 *  confirmation. markTarget is deliberately absent: external player ids are
 *  meaningless to the model. Hand-written JSON Schema rather than the SDK's
 *  zodOutputFormat helper, which requires zod v4 (the protocol package —
 *  the deterministic core — pins zod 3). */
const NUM = { type: 'number' } as const;
const INTERPRETATION_SCHEMA = {
  type: 'object',
  properties: {
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
}

export interface CoachInterpretation {
  patch?: TacticalPatch;
  coachText?: string;
  say: string | null;
}

const SYSTEM = `You are the tactical interpreter for a football management game. A coach speaks an instruction — in ANY language — and you translate it into tactical settings.

Numeric settings range 0..1: pressing, defLine, mentality, risk, compactness, width, tempo, crossing, shootTendency, overlap, counter, timeWaste, pressAfterLoss, defAggression, gkLong, trap. Enum settings: formation (442|433|352), scheme (zonal|man|trap), style (direct|possession|counter|mixed), attackSide (left|right|both). Adjust RELATIVE to the team's current tactics when the instruction is comparative ("press harder" means raise pressing from its current value).

Include in patch ONLY the settings the instruction changes. If the instruction is not tactical (chit-chat, a question, encouragement with no actionable content), omit patch entirely.

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
          }),
        }],
      }, { timeout: 10_000, maxRetries: 1 });

      // safety classifiers can decline with a 200 — check before content
      if (response.stop_reason === 'refusal') return { coachText: text, say: null };
      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') return { coachText: text, say: null };
      const out = JSON.parse(textBlock.text) as { patch?: Record<string, unknown>; say?: string };
      if (!out.patch || Object.keys(out.patch).length === 0)
        return { say: out.say ?? null };

      const clamped = Object.fromEntries(Object.entries(out.patch)
        .map(([k, v]) => [k, typeof v === 'number' ? clamp01(v) : v]));
      const patch = TacticalPatch.safeParse(clamped);
      if (!patch.success || Object.keys(patch.data).length === 0)
        return { coachText: text, say: out.say ?? null };
      return { patch: patch.data, say: out.say ?? null };
    } catch {
      // model unreachable/timeout — the golden parseCoach still gets a shot
      return { coachText: text, say: null };
    }
  };
}
