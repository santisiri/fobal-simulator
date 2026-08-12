// M4 — hosted speech-to-text behind the hub. The provider speaks the
// OpenAI-compatible audio-transcriptions wire shape, which covers OpenAI
// Whisper (api.openai.com, model whisper-1) and Groq's fast Whisper
// (api.groq.com/openai/v1, model whisper-large-v3-turbo) with ONE
// implementation — pick with FOBAL_STT_URL / FOBAL_STT_MODEL. The key
// lives server-side (Secrets Manager in deployed envs), exactly like the
// C2 interpreter key: providers are input transformers, never in the
// browser, never in the deterministic core.

export interface SttOptions {
  apiKey?: string;
  /** full endpoint URL (default OpenAI's) */
  url?: string;
  model?: string;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
}

export type Transcriber = (audio: Buffer, mimeType: string, language?: string) => Promise<string>;

/** Returns null when no key is configured — the hub answers 501 and the
 *  client falls back to browser speech recognition (voice v0/C1). */
export function createTranscriber(options: SttOptions = {}): Transcriber | null {
  if (!options.apiKey) return null;
  const url = options.url ?? 'https://api.openai.com/v1/audio/transcriptions';
  const model = options.model ?? 'whisper-1';
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (audio, mimeType, language) => {
    const form = new FormData();
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `coach.${ext}`);
    form.append('model', model);
    if (language) form.append('language', language);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`stt provider answered ${res.status}`);
    const out = await res.json() as { text?: string };
    if (typeof out.text !== 'string') throw new Error('stt provider returned no text');
    return out.text.trim();
  };
}
