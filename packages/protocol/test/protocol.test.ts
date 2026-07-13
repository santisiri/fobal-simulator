import { describe, expect, test } from 'vitest';
import {
  AcceptedCommand, canonicalJson, ClientMessage, Command, fnv1a, MatchManifest,
  MatchResult, parseClientMessage, parseServerMessage, PROTOCOL_VERSION,
  ReplayFile, ServerMessage, StateDelta, StateSnapshot, TacticalState,
} from '../src/index.js';
import { sampleManifest, sampleTeam } from '../src/samples.js';

describe('MatchManifest', () => {
  test('the sample manifest is valid', () => {
    const r = MatchManifest.safeParse(sampleManifest());
    expect(r.success).toBe(true);
  });

  test('protocol version is enforced', () => {
    const r = MatchManifest.safeParse({ ...sampleManifest(), protocolVersion: '0.9.0' });
    expect(r.success).toBe(false);
  });

  test('externally supplied player ids are required and must be unique per team', () => {
    const m = sampleManifest();
    const clone = structuredClone(m);
    clone.teams[0].players[1]!.playerId = clone.teams[0].players[0]!.playerId;
    expect(MatchManifest.safeParse(clone).success).toBe(false);

    const noId = structuredClone(m) as Record<string, any>;
    delete noId.teams[0].players[0].playerId;
    expect(MatchManifest.safeParse(noId).success).toBe(false);
  });

  test('a player cannot appear in both teams', () => {
    const m = structuredClone(sampleManifest());
    m.teams[1].players[3]!.playerId = m.teams[0].players[3]!.playerId;
    expect(MatchManifest.safeParse(m).success).toBe(false);
  });

  test('ratings are integer 0-100', () => {
    const m = structuredClone(sampleManifest());
    (m.teams[0].players[0]!.ratings as any).pace = 101;
    expect(MatchManifest.safeParse(m).success).toBe(false);
    (m.teams[0].players[0]!.ratings as any).pace = 0.5;
    expect(MatchManifest.safeParse(m).success).toBe(false);
  });

  test('starting XI must include a goalkeeper', () => {
    const t = sampleTeam('x', 'X');
    t.players[0]!.role = 'CB';
    expect(MatchManifest.safeParse(sampleManifest({ teams: [t, sampleTeam('y', 'Y')] })).success).toBe(false);
  });

  test('seed must be a uint32', () => {
    expect(MatchManifest.safeParse({ ...sampleManifest(), seed: -1 }).success).toBe(false);
    expect(MatchManifest.safeParse({ ...sampleManifest(), seed: 2 ** 32 }).success).toBe(false);
    expect(MatchManifest.safeParse({ ...sampleManifest(), seed: 1.5 }).success).toBe(false);
  });
});

describe('Commands', () => {
  test('tactical patch and coach text commands parse', () => {
    const patch: unknown = {
      kind: 'tactical', commandId: 'cmd-1', teamId: 'team-rhinos',
      payload: { type: 'patch', patch: { pressing: 0.9, attackSide: 'left' } },
    };
    expect(Command.safeParse(patch).success).toBe(true);
    const text: unknown = {
      kind: 'tactical', commandId: 'cmd-2', teamId: 'team-rhinos',
      payload: { type: 'coach_text', text: 'press high and attack the wings' },
    };
    expect(Command.safeParse(text).success).toBe(true);
  });

  test('tactical values outside 0..1 are rejected', () => {
    const bad: unknown = {
      kind: 'tactical', commandId: 'cmd-3', teamId: 'team-rhinos',
      payload: { type: 'patch', patch: { pressing: 1.5 } },
    };
    expect(Command.safeParse(bad).success).toBe(false);
  });

  test('substitution command parses and accepted commands carry seq + effectiveTick', () => {
    const sub: unknown = {
      kind: 'substitution', commandId: 'cmd-4', teamId: 'team-rhinos',
      playerOut: 'rhinos-player-10', playerIn: 'rhinos-player-13',
    };
    expect(Command.safeParse(sub).success).toBe(true);
    const acc: unknown = { seq: 4, effectiveTick: 6100, receivedAtTick: 6040, command: sub };
    expect(AcceptedCommand.safeParse(acc).success).toBe(true);
  });

  test('client-supplied positions/scores have no schema to enter through', () => {
    // The command surface is closed: any attempt to smuggle state is rejected.
    const bad: unknown = {
      kind: 'teleport', commandId: 'cmd-5', teamId: 'team-rhinos',
      x: 5, y: 34,
    };
    expect(Command.safeParse(bad).success).toBe(false);
    const bad2: unknown = {
      kind: 'tactical', commandId: 'cmd-6', teamId: 'team-rhinos',
      payload: { type: 'patch', patch: { score: [9, 0] } },
    };
    const parsed = Command.safeParse(bad2);
    // unknown keys are stripped, not honored
    expect(parsed.success ? JSON.stringify(parsed.data) : '').not.toContain('score');
  });
});

describe('Wire messages', () => {
  test('client hello and command messages parse from raw JSON', () => {
    const hello = parseClientMessage(JSON.stringify({ type: 'hello', matchId: 'm1', token: 'tok-12345678' }));
    expect(hello.ok).toBe(true);
    const bad = parseClientMessage('{not json');
    expect(bad.ok).toBe(false);
    const badType = parseClientMessage(JSON.stringify({ type: 'teleport' }));
    expect(badType.ok).toBe(false);
  });

  test('server messages round-trip', () => {
    const msg: ServerMessage = { type: 'command_ack', commandId: 'cmd-1', seq: 1, effectiveTick: 300 };
    const r = parseServerMessage(JSON.stringify(msg));
    expect(r.ok && r.value.type === 'command_ack' && r.value.effectiveTick === 300).toBe(true);
  });

  test('oversized frames are rejected', () => {
    const r = parseClientMessage('"' + 'x'.repeat(300 * 1024) + '"');
    expect(r.ok).toBe(false);
  });
});

describe('Snapshots, deltas, results, replays', () => {
  const snapshot: StateSnapshot = {
    tick: 600, clock: '4:16', matchState: 'PLAYING', score: [0, 0], half: 1,
    ball: { position: { x: 52.5, y: 34, z: 0.11 }, velocity: { x: 0, y: 0, z: 0 } },
    players: [{
      playerId: 'rhinos-player-01', position: { x: 5, y: 34 }, velocity: { x: 0, y: 0 },
      facing: 0, stamina: 0.98, action: 'idle', onPitch: true, yellow: 0, red: false,
    }],
    teams: [
      {
        teamId: 'team-rhinos',
        tactics: TacticalState.parse({
          formation: '442', width: 0.5, scheme: 'zonal', trap: 0, tempo: 0.5, crossing: 0.5,
          shootTendency: 0.5, overlap: 0.5, counter: 0.35, timeWaste: 0, pressAfterLoss: 0.5,
          defAggression: 0.5, gkLong: 0.5, attackSide: 'both', markTarget: null, mentality: 0.55,
          defLine: 0.5, pressing: 0.68, risk: 0.45, compactness: 0.32, style: 'direct',
        }),
        stats: { shots: 0, onTarget: 0, passAtt: 3, passCmp: 2, possessionSeconds: 6, fouls: 0 },
        subsUsed: 0,
      },
      {
        teamId: 'team-comets',
        tactics: TacticalState.parse({
          formation: '433', width: 0.5, scheme: 'zonal', trap: 0, tempo: 0.5, crossing: 0.5,
          shootTendency: 0.5, overlap: 0.5, counter: 0.35, timeWaste: 0, pressAfterLoss: 0.5,
          defAggression: 0.5, gkLong: 0.5, attackSide: 'both', markTarget: null, mentality: 0.55,
          defLine: 0.5, pressing: 0.68, risk: 0.45, compactness: 0.32, style: 'direct',
        }),
        stats: { shots: 1, onTarget: 0, passAtt: 5, passCmp: 4, possessionSeconds: 4, fouls: 1 },
        subsUsed: 0,
      },
    ],
    stateHash: 'a893f5ef',
  };

  test('snapshot and delta validate', () => {
    expect(StateSnapshot.safeParse(snapshot).success).toBe(true);
    const delta: StateDelta = {
      tick: 601,
      ball: { position: { x: 52.6, y: 34.1, z: 0.11 } },
      players: [{ playerId: 'rhinos-player-01', position: { x: 5.1, y: 34 } }],
    };
    expect(StateDelta.safeParse(delta).success).toBe(true);
  });

  test('replay file validates and result hash fields are shaped', () => {
    const result: MatchResult = {
      protocolVersion: PROTOCOL_VERSION, matchId: 'match-sample-001', seed: 12345,
      finalScore: [1, 0], teams: ['team-rhinos', 'team-comets'],
      goals: [{ tick: 5502, clock: '39:12', teamId: 'team-rhinos', playerId: 'rhinos-player-10' }],
      stats: [snapshot.teams[0].stats, snapshot.teams[1].stats],
      cards: [], finalTick: 12600, finalStateHash: 'deadbeef', commandLogHash: fnv1a('[]'),
    };
    expect(MatchResult.safeParse(result).success).toBe(true);
    const replay: ReplayFile = {
      protocolVersion: PROTOCOL_VERSION, kind: 'fobal-replay',
      manifest: sampleManifest(), commands: [], finalStateHash: 'deadbeef', result,
    };
    expect(ReplayFile.safeParse(replay).success).toBe(true);
  });
});

describe('canonical JSON', () => {
  test('key order does not change the canonical form (or its hash)', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } });
    const b = canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(fnv1a(a)).toBe(fnv1a(b));
  });

  test('undefined values are dropped, arrays keep order', () => {
    expect(canonicalJson({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
  });
});
