// M4 — the voice endpoint: raw push-to-talk audio → hosted STT → the C2
// interpreter, one round trip. Providers are faked; what's under test is
// the contract: gating, limits, fallbacks, and that the transcript rides
// the response so the ack UI can show the player what the team heard.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { sampleManifest } from '@fobal/protocol/samples';
import { createTranscriber, createTelemetry, startMatchServer, MatchServerOptions } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-voice-'));

interface VoiceResponse { transcript?: string; patch?: Record<string, unknown>; coachText?: string; say?: string | null; error?: string }

async function boot(overrides: Partial<MatchServerOptions> = {}){
  const lines: string[] = [];
  const telemetry = createTelemetry({ write: l => lines.push(l) });
  const server = await startMatchServer({
    port: 0, storeRoot: tmp(), createKey: 'v-ck', autoDrive: false,
    telemetry, heartbeatMs: 0, ...overrides,
  });
  const created = server.createMatch(sampleManifest({ matchId: 'voice-1' }));
  const voice = (token: string, body: Buffer | Uint8Array, contentType = 'audio/webm') =>
    fetch(`http://127.0.0.1:${server.port}/matches/voice-1/coach/voice`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      body,
    });
  return { server, created, lines, voice };
}

const audio = Buffer.alloc(4096, 7);   // pretend opus; providers are faked

describe('voice endpoint', () => {
  test('501 without an STT key — the client falls back to browser speech recognition', async () => {
    const { server, created, voice } = await boot();
    try {
      expect((await voice(created.tokens['team-rhinos']!, audio)).status).toBe(501);
    } finally { await server.close(); }
  });

  test('controller-gated, audio-typed, size- and sanity-limited', async () => {
    const { server, created, voice } = await boot({
      stt: { apiKey: 'k', fetchImpl: (async () => new Response(JSON.stringify({ text: 'hola' }))) as typeof fetch },
    });
    try {
      expect((await voice(created.spectatorToken, audio)).status).toBe(403);
      expect((await voice('garbage', audio)).status).toBe(401);
      expect((await voice(created.tokens['team-rhinos']!, audio, 'application/json')).status).toBe(400);
      expect((await voice(created.tokens['team-rhinos']!, Buffer.alloc(64))).status).toBe(400);   // too short
      expect((await voice(created.tokens['team-rhinos']!, Buffer.alloc(3 * 1024 * 1024))).status).toBe(413);
    } finally { await server.close(); }
  });

  test('happy path: transcript + interpretation in ONE response; SttMs metered', async () => {
    const fakeSttFetch = (async (_url: unknown, init?: RequestInit) => {
      // the provider receives multipart with our audio file + model
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('whisper-1');
      expect((form.get('file') as File).type).toBe('audio/webm');
      return new Response(JSON.stringify({ text: ' presiona arriba y ataca por las bandas ' }));
    }) as typeof fetch;
    const fakeCoach = {
      messages: { create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ patch: { pressing: 0.9 }, say: '¡Presionamos, jefe!' }) }],
      }) },
    } as never;
    const { server, created, lines, voice } = await boot({
      stt: { apiKey: 'k', fetchImpl: fakeSttFetch },
      coach: { client: fakeCoach },
    });
    try {
      const res = await voice(created.tokens['team-rhinos']!, audio);
      expect(res.status).toBe(200);
      const out = await res.json() as VoiceResponse;
      expect(out.transcript).toBe('presiona arriba y ataca por las bandas');   // trimmed
      expect(out.patch).toEqual({ pressing: 0.9 });
      expect(out.say).toBe('¡Presionamos, jefe!');
      expect(lines.some(l => l.includes('"SttMs"'))).toBe(true);
      expect(lines.some(l => l.includes('coach_voice') && l.includes('"outcome":"patch"'))).toBe(true);
    } finally { await server.close(); }
  });

  test('G: a spoken player order comes back COMPILED — wire-ready player_instruction (+ capture metered)', async () => {
    const fakeCoach = {
      messages: { create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({
          orders: [{ version: 1, scope: 'player', intent: 'stay_wide',
            target: { side: 'own', shirtNumber: 4 } }],
          say: 'Wide it is, boss.',
        }) }],
      }) },
    } as never;
    const { server, created, lines } = await boot({
      stt: { apiKey: 'k', fetchImpl: (async () => new Response(JSON.stringify({ text: 'number four stay wide' }))) as typeof fetch },
      coach: { client: fakeCoach },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/matches/voice-1/coach/voice`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${created.tokens['team-rhinos']!}`,
          'content-type': 'audio/webm',
          'x-fobal-voice-capture-ms': '1450',            // G4: client capture stamp
        },
        body: audio,
      });
      expect(res.status).toBe(200);
      const out = await res.json() as VoiceResponse & {
        orders?: Array<{ ack: string; wire: { kind: string; playerId: string; instruction: string } }>;
      };
      expect(out.orders).toHaveLength(1);
      expect(out.orders![0]!.wire).toMatchObject({ kind: 'player_instruction', instruction: 'stay_wide' });
      expect(out.orders![0]!.wire.playerId).toMatch(/.+/);       // resolved to a real manifest id
      expect(out.orders![0]!.ack).toContain('WIDE');
      expect(lines.some(l => l.includes('"VoiceCaptureMs"'))).toBe(true);
    } finally { await server.close(); }
  });

  test('STT works even with NO interpreter: transcript degrades to coachText (golden parseCoach path)', async () => {
    const { server, created, voice } = await boot({
      stt: { apiKey: 'k', fetchImpl: (async () => new Response(JSON.stringify({ text: 'press high' }))) as typeof fetch },
    });
    try {
      const out = await (await voice(created.tokens['team-rhinos']!, audio)).json() as VoiceResponse;
      expect(out.transcript).toBe('press high');
      expect(out.coachText).toBe('press high');
      expect(out.patch).toBeUndefined();
    } finally { await server.close(); }
  });

  test('a dying STT provider answers 502 and the match is untouched', async () => {
    const { server, created, voice } = await boot({
      stt: { apiKey: 'k', fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch },
    });
    try {
      const res = await voice(created.tokens['team-rhinos']!, audio);
      expect(res.status).toBe(502);
      expect(server.rooms.get('voice-1')!.currentTick).toBe(0);   // input transformers never touch the sim
    } finally { await server.close(); }
  });

  test('transcriber unit: multipart shape, language passthrough, no-key → null', async () => {
    expect(createTranscriber({})).toBeNull();
    let captured: FormData | null = null;
    const t = createTranscriber({
      apiKey: 'k', model: 'whisper-large-v3-turbo', url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        captured = init?.body as FormData;
        return new Response(JSON.stringify({ text: 'ok' }));
      }) as typeof fetch,
    })!;
    await t(Buffer.from('x'.repeat(300)), 'audio/ogg', 'es');
    expect(captured!.get('model')).toBe('whisper-large-v3-turbo');
    expect(captured!.get('language')).toBe('es');
    expect((captured!.get('file') as File).name).toBe('coach.ogg');
  });
});
