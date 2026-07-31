// S3-mirrored persistence: every artifact the match loop writes must reach
// the object store, and a fresh task with an empty disk must hydrate from
// the mirror and resume bit-identically. Runs against MemoryObjectStore —
// the ObjectStore seam is what production swaps for S3.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Command } from '@fobal/protocol';
import { sampleManifest } from '@fobal/protocol/samples';
import {
  MatchRoom, MatchStore, MemoryObjectStore, MirroredMatchStore,
  generateSigningKeys, startMatchServer, verifyResult,
} from '../src/index.js';

const keys = generateSigningKeys();
const tmp = (label: string): string => mkdtempSync(join(tmpdir(), `fobal-${label}-`));

const fakeClient = (sink: unknown[] = []) => ({
  id: 999, role: 'controller' as const, teamId: 'team-rhinos',
  send: (m: unknown) => sink.push(m),
});

const PATCH: Command = {
  kind: 'tactical', commandId: 's3-cmd-1', teamId: 'team-rhinos',
  payload: { type: 'patch', patch: { pressing: 0.88 } },
};

const mirrored = (root: string, remote: MemoryObjectStore): MirroredMatchStore =>
  new MirroredMatchStore(root, remote, { jsonlDelayMs: 0 });

describe('S3-mirrored match store', () => {
  test('every persisted artifact reaches the mirror; a fresh store hydrates identically', async () => {
    const remote = new MemoryObjectStore();
    const store = mirrored(tmp('s3-src'), remote);
    const room = MatchRoom.create(sampleManifest({ matchId: 's3-1' }), { store, keys });
    const client = fakeClient();
    room.attach(client);
    room.submitCommand(client, PATCH);
    const result = await room.runTurbo();
    await store.drain();

    // the mirror holds the complete on-disk layout
    const uploaded = await remote.list('matches/s3-1/');
    expect(uploaded).toContain('matches/s3-1/manifest.json');
    expect(uploaded).toContain('matches/s3-1/commands.jsonl');
    expect(uploaded).toContain('matches/s3-1/events.jsonl');
    expect(uploaded).toContain('matches/s3-1/result.json');
    expect(uploaded.some(k => k.startsWith('matches/s3-1/snapshots/'))).toBe(true);

    // an empty disk hydrates the identical store back out of the mirror
    const twin = mirrored(tmp('s3-hydrated'), remote);
    expect(await twin.hydrate()).toEqual(['s3-1']);
    expect(twin.loadManifest('s3-1')).toEqual(store.loadManifest('s3-1'));
    expect(twin.loadCommands('s3-1')).toEqual(store.loadCommands('s3-1'));
    expect(twin.loadEvents('s3-1')).toEqual(store.loadEvents('s3-1'));
    expect(twin.loadResult('s3-1')).toEqual(result);
    expect(verifyResult(twin.loadResult('s3-1')!)).toBe(true);
  });

  test('a task replacement mid-match resumes from the mirror alone, bit-identical to uninterrupted play', async () => {
    const remote = new MemoryObjectStore();
    const store = mirrored(tmp('s3-crash'), remote);
    const room = MatchRoom.create(sampleManifest({ matchId: 's3-2' }), { store, keys, internalEvery: 600 });
    const client = fakeClient();
    room.attach(client);
    room.submitCommand(client, PATCH);
    room.advance(1500);
    await store.drain();
    room.stop();                                   // task killed; local disk is gone

    const replacement = mirrored(tmp('s3-replacement'), remote);
    expect(await replacement.hydrate()).toEqual(['s3-2']);
    const resumed = MatchRoom.resume('s3-2', { store: replacement, keys });
    const resumedResult = await resumed.runTurbo();
    await replacement.drain();

    // twin: the same match played through without interruption
    const twin = MatchRoom.create(sampleManifest({ matchId: 's3-2' }),
      { store: new MatchStore(tmp('s3-twin')), keys });
    const twinClient = fakeClient();
    twin.attach(twinClient);
    twin.submitCommand(twinClient, PATCH);
    const twinResult = await twin.runTurbo();

    expect(resumedResult.finalStateHash).toBe(twinResult.finalStateHash);
    expect(resumedResult.finalScore).toEqual(twinResult.finalScore);
    expect(resumedResult.goals).toEqual(twinResult.goals);
    // the mirror now also holds the finished result for the resumed timeline
    const hydratedResult = mirrored(tmp('s3-verify'), remote);
    await hydratedResult.hydrate();
    expect(hydratedResult.loadResult('s3-2')?.finalStateHash).toBe(twinResult.finalStateHash);
  });

  test('hydrate never writes bucket keys outside the known match layout', async () => {
    const remote = new MemoryObjectStore();
    await remote.put('matches/../evil/manifest.json', '{}');
    await remote.put('matches/ok-1/../../escape.json', '{}');
    await remote.put('matches/ok-1/unknown-file.bin', 'x');
    await remote.put('matches/ok-1/manifest.json', JSON.stringify(sampleManifest({ matchId: 'ok-1' })));
    const store = mirrored(tmp('s3-safety'), remote);
    expect(await store.hydrate()).toEqual(['ok-1']);
    expect(store.exists('ok-1')).toBe(true);
  });
});

describe('health endpoint', () => {
  test('GET /health answers 200 without a token', async () => {
    const server = await startMatchServer({ port: 0, storeRoot: tmp('health') });
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; activeRooms: number };
    expect(body.ok).toBe(true);
    expect(body.activeRooms).toBe(0);
    await server.close();
  });
});
