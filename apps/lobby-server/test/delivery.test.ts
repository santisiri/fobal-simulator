// SES slice — login-code delivery. The rules: codes never vanish into a
// black hole (501 when nothing is configured), a failed send leaves no live
// code (502 + rollback), production responses never reveal the code, and the
// acceptance test key is the only non-dev way to see one.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { startMatchServer } from '@fobal/match-server';
import { createSesDeliverer, startLobbyServer, LobbyServerOptions } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-delivery-'));

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function boot(overrides: Partial<LobbyServerOptions>){
  const match = await startMatchServer({ port: 0, storeRoot: tmp(), createKey: 'ck', autoDrive: false });
  const lobby = await startLobbyServer({
    port: 0, authRequestIntervalMs: 0,
    matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'ck' },
    ...overrides,
  });
  const base = `http://127.0.0.1:${lobby.port}`;
  return { base, close: async () => { await lobby.close(); await match.close(); } };
}

describe('login-code delivery', () => {
  test('no devAuth and no deliverer → 501, never a silent black hole', async () => {
    const { base, close } = await boot({});
    try {
      const res = await post(`${base}/auth/request`, { email: 'santi@fobal.ai' });
      expect(res.status).toBe(501);
    } finally { await close(); }
  });

  test('a configured deliverer gets the code; the response does NOT', async () => {
    const sent: Array<{ email: string; code: string }> = [];
    const { base, close } = await boot({ deliverCode: (email, code) => { sent.push({ email, code }); } });
    try {
      const res = await post(`${base}/auth/request`, { email: 'Santi@Fobal.AI' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });          // no devCode
      expect(sent).toHaveLength(1);
      expect(sent[0]!.email).toBe('santi@fobal.ai');           // lowercased

      // the DELIVERED code logs in
      const verified = await post(`${base}/auth/verify`, { email: 'santi@fobal.ai', code: sent[0]!.code });
      expect(verified.status).toBe(200);
    } finally { await close(); }
  });

  test('a failed send answers 502 and leaves no live code or rate-limit lock', async () => {
    let fail = true;
    const sent: string[] = [];
    const { base, close } = await boot({
      deliverCode: (_email, code) => { if (fail) throw new Error('ses down'); sent.push(code); },
    });
    try {
      const res = await post(`${base}/auth/request`, { email: 'santi@fobal.ai' });
      expect(res.status).toBe(502);
      // no live code survives the failure
      const guess = await post(`${base}/auth/verify`, { email: 'santi@fobal.ai', code: 'anything' });
      expect(guess.status).toBe(401);
      // and the retry is not rate-limited
      fail = false;
      expect((await post(`${base}/auth/request`, { email: 'santi@fobal.ai' })).status).toBe(200);
      expect(sent).toHaveLength(1);
    } finally { await close(); }
  });

  test('the test key reveals the code ONLY with the exact header', async () => {
    const { base, close } = await boot({ deliverCode: () => {}, testLoginKey: 'acceptance-secret' });
    try {
      const plain = await (await post(`${base}/auth/request`, { email: 'a@fobal.ai' })).json() as { devCode?: string };
      expect(plain.devCode).toBeUndefined();
      const wrong = await (await post(`${base}/auth/request`, { email: 'b@fobal.ai' },
        { 'x-fobal-test-key': 'nope' })).json() as { devCode?: string };
      expect(wrong.devCode).toBeUndefined();
      const right = await (await post(`${base}/auth/request`, { email: 'c@fobal.ai' },
        { 'x-fobal-test-key': 'acceptance-secret' })).json() as { devCode?: string };
      expect(right.devCode).toBeDefined();
    } finally { await close(); }
  });

  test('SES deliverer sends the code to the address from the configured sender', async () => {
    const sends: unknown[] = [];
    const fakeClient = { send: async (cmd: { input: unknown }) => { sends.push(cmd.input); } };
    const deliver = createSesDeliverer({ from: 'lobby@fobal.ai', client: fakeClient as never });
    await deliver('santi@fobal.ai', 'c0dec0de');
    expect(sends).toHaveLength(1);
    const input = sends[0] as {
      FromEmailAddress: string;
      Destination: { ToAddresses: string[] };
      Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } };
    };
    expect(input.FromEmailAddress).toBe('lobby@fobal.ai');
    expect(input.Destination.ToAddresses).toEqual(['santi@fobal.ai']);
    expect(input.Content.Simple.Subject.Data).toContain('c0dec0de');
    expect(input.Content.Simple.Body.Text.Data).toContain('c0dec0de');
  });
});
