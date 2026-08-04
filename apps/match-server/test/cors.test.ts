// Browser clients live on a different origin than the hub (local file
// server or play.*), so every HTTP surface must speak CORS: preflights
// answered, the allow-origin header on every response — including errors —
// and the Authorization header explicitly allowed (tokens travel there,
// never in cookies, which is why a permissive origin grants nothing).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { startMatchServer } from '../src/index.js';

describe('hub CORS', () => {
  test('preflight and responses carry the CORS headers', async () => {
    const server = await startMatchServer({ port: 0, storeRoot: mkdtempSync(join(tmpdir(), 'fobal-cors-')) });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const preflight = await fetch(`${base}/matches/x/result`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:8471', 'access-control-request-headers': 'authorization' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
      expect(preflight.headers.get('access-control-allow-methods')).toContain('GET');

      // the header must ride error responses too, or the browser hides the
      // status from the client and every failure looks like a network error
      const unauthorized = await fetch(`${base}/matches`, { method: 'POST', body: '{}' });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('access-control-allow-origin')).toBe('*');

      const health = await fetch(`${base}/health`);
      expect(health.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await server.close();
    }
  });

  test('a configured origin replaces the wildcard', async () => {
    const server = await startMatchServer({
      port: 0, storeRoot: mkdtempSync(join(tmpdir(), 'fobal-cors2-')),
      corsOrigin: 'https://play-staging.fobal.ai',
    });
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(health.headers.get('access-control-allow-origin')).toBe('https://play-staging.fobal.ai');
    } finally {
      await server.close();
    }
  });
});
