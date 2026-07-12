import { describe, expect, test } from 'vitest';
import { MatchConnection } from '../src/net.js';

class FakeSocket {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(s: string){ this.sent.push(s); }
  close(){ this.onclose && this.onclose(); }
  // test helpers
  open(){ this.onopen && this.onopen(); }
  push(msg: unknown){ this.onmessage && this.onmessage({ data: JSON.stringify(msg) }); }
  pushRaw(raw: string){ this.onmessage && this.onmessage({ data: raw }); }
}

const SNAPSHOT = (tick: number, score: [number, number] = [0, 0]) => ({
  tick, clock: '2:00', matchState: 'PLAYING', score, half: 1,
  ball: { position: { x: 52, y: 34, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
  players: [{
    playerId: 'a-1', position: { x: 10, y: 30 }, velocity: { x: 0, y: 0 },
    facing: 0, stamina: 1, action: 'jog', onPitch: true, yellow: 0, red: false,
  }],
  teams: [], stateHash: '00000000',
});

const MANIFEST = { teams: [{ name: 'A', players: [{ playerId: 'a-1' }] }, { name: 'B', players: [] }] };

function connect(opts: Partial<ConstructorParameters<typeof MatchConnection>[0]> = {}){
  const sockets: FakeSocket[] = [];
  const scheduled: Array<{ ms: number; fn: () => void }> = [];
  const conn = new MatchConnection({
    url: 'ws://test', matchId: 'm1', token: 'tok-12345678',
    socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    schedule: (ms: number, fn: () => void) => scheduled.push({ ms, fn }),
    ...opts,
  });
  conn.connect();
  return { conn, sockets, scheduled };
}

function welcome(sock: FakeSocket, tick = 100){
  sock.open();
  sock.push({ type: 'welcome', matchId: 'm1', role: 'spectator', manifest: MANIFEST, snapshot: SNAPSHOT(tick), eventSeq: -1 });
}

describe('MatchConnection', () => {
  test('hello → welcome → live, with an authoritative frame', () => {
    const { conn, sockets } = connect();
    const sock = sockets[0]!;
    welcome(sock);
    expect(JSON.parse(sock.sent[0]!)).toMatchObject({ type: 'hello', matchId: 'm1' });
    expect(conn.status).toBe('live');
    expect(conn.frame()!.ball.position.x).toBe(52);
  });

  test('official numbers come verbatim from the server (deltas patch, events append)', () => {
    const { conn, sockets } = connect();
    const sock = sockets[0]!;
    welcome(sock);
    sock.push({ type: 'delta', delta: { tick: 106, score: [1, 0], clock: '2:06', players: [{ playerId: 'a-1', position: { x: 14, y: 30 } }] } });
    sock.push({ type: 'event', event: { seq: 0, tick: 106, clock: '2:06', type: 'goal', playerId: 'a-1' } });
    expect(conn.lastFrame!.score).toEqual([1, 0]);
    expect(conn.lastFrame!.players.get('a-1').position.x).toBe(14);
    expect(conn.events.map((e: { type: string }) => e.type)).toEqual(['goal']);
  });

  test('stale deltas and pre-snapshot deltas are ignored; garbage never throws', () => {
    const { conn, sockets } = connect();
    const sock = sockets[0]!;
    sock.open();
    sock.push({ type: 'delta', delta: { tick: 50 } });          // before welcome
    expect(conn.frame()).toBeNull();
    welcome(sock, 100);
    sock.push({ type: 'delta', delta: { tick: 90 } });          // stale
    expect(conn.lastFrame!.tick).toBe(100);
    sock.pushRaw('{{{{ not json');
    sock.push({ type: 'mystery', payload: 1 });
    expect(conn.status).toBe('live');
  });

  test('reconnection resumes from the last event seq and resyncs from a snapshot', () => {
    const { conn, sockets, scheduled } = connect();
    const first = sockets[0]!;
    welcome(first, 100);
    first.push({ type: 'event', event: { seq: 0, tick: 100, clock: '2:00', type: 'kickoff' } });
    first.push({ type: 'event', event: { seq: 1, tick: 150, clock: '2:30', type: 'foul' } });

    first.close();                                   // drop mid-match
    expect(conn.status).toBe('reconnecting');
    expect(scheduled.length).toBe(1);
    scheduled[0]!.fn();                              // fire the backoff timer

    const second = sockets[1]!;
    welcome(second, 400);
    const hello = JSON.parse(second.sent[0]!);
    expect(hello.resumeFromSeq).toBe(2);             // asks only for what it missed
    // server resends nothing old; new events continue the sequence
    second.push({ type: 'event', event: { seq: 1, tick: 150, clock: '2:30', type: 'foul' } });   // dupe: dropped
    second.push({ type: 'event', event: { seq: 2, tick: 420, clock: '3:30', type: 'goal' } });
    expect(conn.events.map((e: { seq: number }) => e.seq)).toEqual([0, 1, 2]);
    expect(conn.status).toBe('live');
    expect(conn.frame()!.tick).toBeGreaterThanOrEqual(400);   // state comes from the fresh snapshot
  });

  test('gives up after maxRetries and reports failure', () => {
    const { conn, sockets, scheduled } = connect({ maxRetries: 2 });
    sockets[0]!.close();
    scheduled[0]!.fn();
    sockets[1]!.close();
    scheduled[1]!.fn();
    sockets[2]!.close();                             // third failure exceeds maxRetries=2
    expect(conn.status).toBe('failed');
  });

  test('commands are only sent when live, and go out verbatim', () => {
    const { conn, sockets } = connect();
    const sock = sockets[0]!;
    const cmd = { kind: 'tactical', commandId: 'c1', teamId: 't1', payload: { type: 'patch', patch: { pressing: 0.9 } } };
    expect(conn.sendCommand(cmd)).toBe(false);       // not live yet
    welcome(sock);
    expect(conn.sendCommand(cmd)).toBe(true);
    const sent = JSON.parse(sock.sent.at(-1)!);
    expect(sent).toEqual({ type: 'command', command: cmd });
  });
});
