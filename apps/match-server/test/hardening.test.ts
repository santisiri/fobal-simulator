// B2 + observability — the hub goes public: WS origin allowlist, per-IP and
// global connection caps, structured logs and EMF metrics. Telemetry is
// asserted through an injected sink; nothing here talks to AWS.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { sampleManifest } from '@fobal/protocol/samples';
import { startMatchServer, MatchServerOptions, createTelemetry } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-hard-'));

async function boot(overrides: Partial<MatchServerOptions> = {}){
  const lines: string[] = [];
  const telemetry = createTelemetry({ write: l => lines.push(l) });
  const server = await startMatchServer({
    port: 0, storeRoot: tmp(), createKey: 'hard-ck', autoDrive: false,
    telemetry, heartbeatMs: 0, ...overrides,
  });
  const created = server.createMatch(sampleManifest({ matchId: 'hard-1' }));
  return { server, created, lines, url: `ws://127.0.0.1:${server.port}` };
}

/** Open a socket and resolve with how the server treated it. */
function connect(url: string, opts: { origin?: string } = {}): Promise<{ outcome: string; code?: number; socket?: WebSocket }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, opts.origin ? { origin: opts.origin } : {});
    socket.on('open', () => resolve({ outcome: 'open', socket }));
    socket.on('unexpected-response', (_req, res) => { resolve({ outcome: 'refused', code: res.statusCode }); socket.terminate(); });
    socket.on('error', () => resolve({ outcome: 'error' }));
  });
}

const hello = (socket: WebSocket, matchId: string, token: string): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    socket.on('message', raw => resolve(JSON.parse(String(raw)) as Record<string, unknown>));
    socket.send(JSON.stringify({ type: 'hello', matchId, token }));
  });

describe('WS origin allowlist', () => {
  test('cross-site browsers are refused at upgrade; allowed origins and originless tools pass', async () => {
    const { server, created, lines, url } = await boot({ wsOrigins: ['https://play-staging.fobal.ai'] });
    try {
      const evil = await connect(url, { origin: 'https://evil.example' });
      expect(evil).toMatchObject({ outcome: 'refused', code: 403 });

      const allowed = await connect(url, { origin: 'https://PLAY-STAGING.fobal.ai' });   // case-insensitive
      expect(allowed.outcome).toBe('open');
      const welcome = await hello(allowed.socket!, 'hard-1', created.spectatorToken);
      expect(welcome.type).toBe('welcome');
      allowed.socket!.close();

      const tool = await connect(url);                     // no Origin header
      expect(tool.outcome).toBe('open');
      tool.socket!.close();

      expect(lines.some(l => l.includes('ws_origin_rejected') && l.includes('evil.example'))).toBe(true);
      expect(lines.some(l => l.includes('"OriginRejected"'))).toBe(true);
    } finally { await server.close(); }
  });

  test('no allowlist configured → any origin connects (today’s behavior, unchanged)', async () => {
    const { server, url } = await boot();
    try {
      const anyOrigin = await connect(url, { origin: 'https://anywhere.example' });
      expect(anyOrigin.outcome).toBe('open');
      anyOrigin.socket!.close();
    } finally { await server.close(); }
  });
});

describe('connection caps', () => {
  test('per-IP cap closes the excess socket with 1013 and frees the slot on disconnect', async () => {
    const { server, lines, url } = await boot({ maxConnectionsPerIp: 2 });
    try {
      const first = await connect(url);
      const second = await connect(url);
      expect(first.outcome).toBe('open');
      expect(second.outcome).toBe('open');

      const third = await connect(url);
      expect(third.outcome).toBe('open');               // upgrade succeeds…
      const closeCode = await new Promise<number>(resolve =>
        third.socket!.on('close', code => resolve(code)));
      expect(closeCode).toBe(1013);                     // …then the server sheds it

      first.socket!.close();
      await new Promise(r => setTimeout(r, 100));       // release propagates
      const fourth = await connect(url);
      expect(fourth.outcome).toBe('open');
      const stillOpen = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(true), 200);
        fourth.socket!.on('close', () => { clearTimeout(timer); resolve(false); });
      });
      expect(stillOpen).toBe(true);
      fourth.socket!.close();
      second.socket!.close();

      expect(lines.some(l => l.includes('ws_connection_capped'))).toBe(true);
      expect(lines.some(l => l.includes('"ConnectionCapped"'))).toBe(true);
    } finally { await server.close(); }
  });
});

describe('telemetry', () => {
  test('the hub narrates its life: rooms, joins, rejected hellos and commands', async () => {
    const { server, created, lines, url } = await boot();
    try {
      expect(lines.some(l => l.includes('room_created') && l.includes('hard-1'))).toBe(true);

      const bad = await connect(url);
      const err = await hello(bad.socket!, 'hard-1', 'forged-token');
      expect(err.type).toBe('error');
      expect(lines.some(l => l.includes('hello_rejected') && l.includes('unauthorized'))).toBe(true);

      const good = await connect(url);
      await hello(good.socket!, 'hard-1', created.tokens['team-rhinos']!);
      expect(lines.some(l => l.includes('client_joined') && l.includes('team-rhinos'))).toBe(true);

      // a spectator token cannot command — the room meters the rejection
      const spec = await connect(url);
      await hello(spec.socket!, 'hard-1', created.spectatorToken);
      await new Promise<void>((resolve) => {
        spec.socket!.on('message', raw => {
          if (JSON.parse(String(raw)).type === 'command_rejected') resolve();
        });
        spec.socket!.send(JSON.stringify({ type: 'command', command: {
          kind: 'tactical', commandId: 'cmd-1', teamId: 'team-rhinos',
          payload: { type: 'coach_text', text: 'press high' },
        } }));
      });
      expect(lines.some(l => l.includes('command_rejected') && l.includes('unauthorized'))).toBe(true);
      expect(lines.some(l => l.includes('"CommandRejected"'))).toBe(true);

      good.socket!.close();
      spec.socket!.close();
    } finally { await server.close(); }
  });

  test('EMF: with a namespace, metric lines carry the _aws envelope CloudWatch extracts', () => {
    const lines: string[] = [];
    const emf = createTelemetry({ metricsNamespace: '/fobal/staging/match-server', write: l => lines.push(l) });
    emf.metric('RoomsActive', 3);
    emf.metric('CoachInterpretMs', 812, 'Milliseconds');

    const first = JSON.parse(lines[0]!);
    expect(first._aws.CloudWatchMetrics[0].Namespace).toBe('/fobal/staging/match-server');
    expect(first._aws.CloudWatchMetrics[0].Metrics[0]).toEqual({ Name: 'RoomsActive', Unit: 'Count' });
    expect(first.RoomsActive).toBe(3);
    expect(first.Service).toBe('match-server');
    const second = JSON.parse(lines[1]!);
    expect(second._aws.CloudWatchMetrics[0].Metrics[0]).toEqual({ Name: 'CoachInterpretMs', Unit: 'Milliseconds' });

    // no namespace → plain structured log, no EMF envelope
    const plain: string[] = [];
    createTelemetry({ write: l => plain.push(l) }).metric('RoomsActive', 1);
    expect(JSON.parse(plain[0]!)._aws).toBeUndefined();
    expect(JSON.parse(plain[0]!).level).toBe('metric');
  });
});
