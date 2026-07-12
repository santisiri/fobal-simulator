import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { sampleManifest } from '@fobal/protocol/samples';
import { PROTOCOL_VERSION, type MatchResult } from '@fobal/protocol';
import { generateSigningKeys, signResult, verifyResult, signToken, verifyToken, startMatchServer } from '../src/index.js';

describe('tokens', () => {
  test('sign/verify round trip; tampering breaks it', () => {
    const t = signToken({ matchId: 'm1', role: 'controller', teamId: 'team-a' }, 'secret-1');
    expect(verifyToken(t, 'secret-1')).toEqual({ matchId: 'm1', role: 'controller', teamId: 'team-a' });
    expect(verifyToken(t, 'secret-2')).toBeNull();
    expect(verifyToken(t.slice(0, -4) + 'AAAA', 'secret-1')).toBeNull();
    expect(verifyToken('garbage', 'secret-1')).toBeNull();
    // controller without a team is malformed by construction
    const bad = signToken({ matchId: 'm1', role: 'controller' } as never, 'secret-1');
    expect(verifyToken(bad, 'secret-1')).toBeNull();
  });
});

describe('result signing', () => {
  const result: MatchResult = {
    protocolVersion: PROTOCOL_VERSION as MatchResult['protocolVersion'],
    matchId: 'm1', seed: 1, finalScore: [1, 0],
    teams: ['a', 'b'], goals: [], cards: [],
    stats: [
      { shots: 1, onTarget: 1, passAtt: 5, passCmp: 4, possessionSeconds: 60, fouls: 0 },
      { shots: 0, onTarget: 0, passAtt: 3, passCmp: 2, possessionSeconds: 40, fouls: 1 },
    ],
    finalTick: 12000, finalStateHash: 'aabbccdd', commandLogHash: '11223344',
  };

  test('signed results verify; any mutation invalidates; signing is deterministic', () => {
    const keys = generateSigningKeys();
    const signed = signResult(result, keys);
    expect(verifyResult(signed)).toBe(true);
    expect(verifyResult({ ...signed, finalScore: [9, 0] })).toBe(false);
    expect(verifyResult({ ...signed, finalStateHash: 'ffffffff' })).toBe(false);
    const again = signResult(result, keys);
    expect(again.signature!.value).toBe(signed.signature!.value); // idempotent bytes
  });
});

describe('secure match creation + connection auth', async () => {
  const server = await startMatchServer({ storeRoot: mkdtempSync(join(tmpdir(), 'fobal-auth-')) });
  afterAll(() => server.close());

  test('creation requires the bearer key and a valid manifest', async () => {
    const url = `http://127.0.0.1:${server.port}/matches`;
    const no = await fetch(url, { method: 'POST', body: JSON.stringify(sampleManifest()) });
    expect(no.status).toBe(401);
    const bad = await fetch(url, {
      method: 'POST', headers: { authorization: `Bearer ${server.createKey}` }, body: '{"broken":true}',
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(url, {
      method: 'POST', headers: { authorization: `Bearer ${server.createKey}` },
      body: JSON.stringify(sampleManifest({ matchId: 'auth-match' })),
    });
    expect(ok.status).toBe(201);
    const created = await ok.json() as { matchId: string; tokens: Record<string, string> };
    expect(created.matchId).toBe('auth-match');
    expect(Object.keys(created.tokens)).toEqual(['team-rhinos', 'team-comets']);
    // duplicate ids are refused
    const dup = await fetch(url, {
      method: 'POST', headers: { authorization: `Bearer ${server.createKey}` },
      body: JSON.stringify(sampleManifest({ matchId: 'auth-match' })),
    });
    expect(dup.status).toBe(400);
  });

  test('a bogus or cross-match token is refused at hello', async () => {
    const created = server.createMatch(sampleManifest({ matchId: 'auth-match-2' }));
    const other = server.createMatch(sampleManifest({ matchId: 'auth-match-3' }));
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const messages: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', matchId: created.matchId, token: other.spectatorToken }));
      ws.onmessage = (ev) => { messages.push(JSON.parse(ev.data as string)); };
      ws.onclose = () => resolve();
    });
    expect(messages[0]).toMatchObject({ type: 'error', code: 'unauthorized' });
  });
});
