// C2 — the LLM tactical interpreter endpoint. The model is faked (an
// injected client), so these cover the whole contract EXCEPT the provider:
// auth gating, schema validation/clamping, refusal and garbage fallbacks,
// and the 501 unconfigured path clients degrade through.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { sampleManifest } from '@fobal/protocol/samples';
import { startMatchServer } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-coach-'));

/** Fake Anthropic client: create() resolves with a scripted response in the
 *  structured-outputs wire shape (a text block carrying JSON). */
const fakeClient = (outputs: Array<{ stop_reason: string; parsed_output: unknown }>) => {
  let i = 0;
  return {
    messages: {
      create: async () => {
        const o = outputs[Math.min(i++, outputs.length - 1)]!;
        return {
          stop_reason: o.stop_reason,
          content: o.parsed_output == null ? [] : [{ type: 'text', text: JSON.stringify(o.parsed_output) }],
        };
      },
    },
  } as never;
};

type Interpreted = { patch?: Record<string, unknown>; coachText?: string; say?: string | null };
const body = (res: Response) => res.json() as Promise<Interpreted>;

async function boot(outputs?: Array<{ stop_reason: string; parsed_output: unknown }>){
  const server = await startMatchServer({
    port: 0, storeRoot: tmp(), createKey: 'coach-key', autoDrive: false,
    coach: outputs ? { client: fakeClient(outputs) } : {},
  });
  const created = server.createMatch(sampleManifest({ matchId: 'coach-1' }));
  const base = `http://127.0.0.1:${server.port}`;
  const interpret = (token: string, body: unknown) =>
    fetch(`${base}/matches/coach-1/coach/interpret`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { server, created, interpret };
}

describe('coach interpreter endpoint', () => {
  test('answers 501 when no interpreter is configured (client falls back to v0)', async () => {
    const { server, created, interpret } = await boot();
    try {
      const res = await interpret(created.tokens['team-rhinos']!, { text: 'press high' });
      expect(res.status).toBe(501);
    } finally { await server.close(); }
  });

  test('controller-only: spectators 403, bad tokens 401, malformed bodies 400', async () => {
    const { server, created, interpret } = await boot([{ stop_reason: 'end_turn', parsed_output: { say: 'ok' } }]);
    try {
      expect((await interpret(created.spectatorToken, { text: 'press high' })).status).toBe(403);
      expect((await interpret('nonsense', { text: 'press high' })).status).toBe(401);
      expect((await interpret(created.tokens['team-rhinos']!, '{oops')).status).toBe(400);
      expect((await interpret(created.tokens['team-rhinos']!, { text: '' })).status).toBe(400);
      expect((await interpret(created.tokens['team-rhinos']!, { text: 'x'.repeat(501) })).status).toBe(400);
    } finally { await server.close(); }
  });

  test('a valid model patch is clamped, schema-validated and returned with the say line', async () => {
    const { server, created, interpret } = await boot([{
      stop_reason: 'end_turn',
      parsed_output: { patch: { pressing: 1.4, defLine: 0.8, formation: '433' }, say: '¡Presionamos arriba, jefe!' },
    }]);
    try {
      const res = await interpret(created.tokens['team-rhinos']!, { text: 'presiona arriba y juega con tres delanteros' });
      expect(res.status).toBe(200);
      const out = await body(res);
      expect(out.patch).toEqual({ pressing: 1, defLine: 0.8, formation: '433' });  // 1.4 clamped
      expect(out.coachText).toBeUndefined();
      expect(out.say).toBe('¡Presionamos arriba, jefe!');
    } finally { await server.close(); }
  });

  test('refusals and garbage degrade to coachText so golden parseCoach still runs', async () => {
    const { server, created, interpret } = await boot([
      { stop_reason: 'refusal', parsed_output: null },
      { stop_reason: 'end_turn', parsed_output: { patch: { formation: '999' }, say: 'hm' } },
    ]);
    try {
      const refused = await body(await interpret(created.tokens['team-rhinos']!, { text: 'press high' }));
      expect(refused.coachText).toBe('press high');
      expect(refused.patch).toBeUndefined();

      const garbage = await body(await interpret(created.tokens['team-rhinos']!, { text: 'play a 999' }));
      expect(garbage.coachText).toBe('play a 999');   // invalid enum → schema rejects → fallback
      expect(garbage.patch).toBeUndefined();
    } finally { await server.close(); }
  });

  test('non-tactical speech returns only the say line (no command implied)', async () => {
    const { server, created, interpret } = await boot([
      { stop_reason: 'end_turn', parsed_output: { say: 'Great half, coach — no changes.' } },
    ]);
    try {
      const out = await body(await interpret(created.tokens['team-rhinos']!, { text: 'good job everyone' }));
      expect(out.patch).toBeUndefined();
      expect(out.coachText).toBeUndefined();
      expect(out.say).toBe('Great half, coach — no changes.');
    } finally { await server.close(); }
  });
});
