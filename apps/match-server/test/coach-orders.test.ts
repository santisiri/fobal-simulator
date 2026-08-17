// Workstream G — the interpret endpoint with taxonomy orders. The LLM is a
// FAKE (the suite never touches a paid API); what's under test is the
// contract around it: schema-validated orders in, deterministic
// resolution + compilation against the real manifest, honest rejections,
// invented players dying at the resolver, latency in the response.
//
// A live-model smoke exists at the bottom, gated on ANTHROPIC_API_KEY —
// skipped in CI by design.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { sampleManifest } from '@fobal/protocol/samples';
import { startMatchServer } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-orders-'));

/** a fake Anthropic client that returns the given structured output */
const fakeClient = (payload: unknown) => ({
  messages: { create: async () => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }) },
}) as never;

/** manifest with resolvable names on both sides */
function namedManifest(){
  const manifest = sampleManifest({ matchId: 'orders-1' });
  manifest.teams[0]!.players[5]!.name = 'Leo Kovač';       // shirt 6, a CM — eligible marker
  manifest.teams[0]!.players[9]!.name = 'Nico Ferreyra';
  manifest.teams[0]!.players[10]!.name = 'Aldo Moretti';
  manifest.teams[1]!.players[8]!.name = 'Karim Öz';      // shirt 9, their striker
  return manifest;
}

async function boot(modelPayload: unknown){
  const server = await startMatchServer({
    port: 0, storeRoot: tmp(), createKey: 'ok-ck', autoDrive: false,
    coach: { client: fakeClient(modelPayload) },
  });
  const created = server.createMatch(namedManifest());
  const interpret = (text: string) =>
    fetch(`http://127.0.0.1:${server.port}/matches/orders-1/coach/interpret`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.tokens['team-rhinos']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  return { server, interpret, token: created.tokens['team-rhinos']! };
}

interface OrdersResponse {
  orders?: Array<{ intent: string; scope: string; ack: string; wire: { kind: string; payload?: { type: string; patch: Record<string, unknown> }; playerOut?: string; playerIn?: string } }>;
  rejected?: Array<{ intent: string; reason: string }>;
  patch?: Record<string, unknown>;
  say?: string | null;
  latency?: { interpretMs: number };
}

describe('interpret endpoint: taxonomy orders (mocked model)', () => {
  test('a multi-order utterance compiles to wire-ready commands with short acks + latency', async () => {
    const { server, interpret } = await boot({
      orders: [
        { scope: 'team', intent: 'press_high' },
        { scope: 'player', intent: 'mark_player', target: { side: 'opponent', shirtNumber: 9 } },
      ],
      say: '¡Vamos!',
    });
    try {
      const out = await (await interpret('press them and mark their nine')).json() as OrdersResponse;
      expect(out.orders).toHaveLength(2);
      expect(out.orders![0]).toMatchObject({ intent: 'press_high', ack: 'PRESS HIGH ✓' });
      expect(out.orders![0]!.wire.payload!.patch.pressing).toBe(0.85);
      expect(out.orders![1]!.ack).toBe('MARK #9 ÖZ ✓');
      expect(out.orders![1]!.wire.payload!.patch.markTarget).toBe('comets-player-09');
      expect(out.latency!.interpretMs).toBeGreaterThanOrEqual(0);
      expect(out.say).toBe('¡Vamos!');
    } finally { await server.close(); }
  });

  test('an invented player name dies at the resolver and surfaces as an honest rejection', async () => {
    const { server, interpret } = await boot({
      orders: [{ scope: 'player', intent: 'mark_player', target: { side: 'opponent', name: 'Zlatan' } }],
      say: 'ok',
    });
    try {
      const out = await (await interpret('mark zlatan')).json() as OrdersResponse;
      expect(out.orders).toBeUndefined();
      expect(out.rejected).toHaveLength(1);
      expect(out.rejected![0]!.reason).toContain('no player called "Zlatan"');
    } finally { await server.close(); }
  });

  test('G3 bridge: a spatial instruction compiles to the player_instruction wire', async () => {
    const { server, interpret } = await boot({
      orders: [{ scope: 'player', intent: 'overlap', target: { side: 'own', name: 'Ferreyra' } }],
      say: 'ok',
    });
    try {
      const out = await (await interpret('ferreyra overlap left')).json() as OrdersResponse;
      expect(out.rejected).toBeUndefined();
      expect(out.orders![0]!.ack).toBe('FERREYRA → OVERLAP ✓');
      expect(out.orders![0]!.wire).toMatchObject({
        kind: 'player_instruction', playerId: 'rhinos-player-10', instruction: 'overlap',
      });
    } finally { await server.close(); }
  });

  test('still-reserved instructions reject with their SPECIFIC reason, named', async () => {
    const { server, interpret } = await boot({
      orders: [{ scope: 'player', intent: 'dribble_more', target: { side: 'own', name: 'Ferreyra' } }],
      say: 'ok',
    });
    try {
      const out = await (await interpret('ferreyra take them on')).json() as OrdersResponse;
      expect(out.rejected![0]!.reason).toContain('Ferreyra');
      expect(out.rejected![0]!.reason).toContain('not tunable');
    } finally { await server.close(); }
  });

  test('malformed model orders are dropped by the schema; the valid one survives', async () => {
    const { server, interpret } = await boot({
      orders: [
        { scope: 'team', intent: 'summon_dragon' },                       // unknown intent
        { scope: 'player', intent: 'mark_player' },                       // missing target
        { scope: 'team', intent: 'drop_deep', bogus: 'field' },           // extra field → zod strips? object schema is strict via superRefine paths only
        { scope: 'team', intent: 'waste_time' },
      ],
      say: 'ok',
    });
    try {
      const out = await (await interpret('kill the game')).json() as OrdersResponse;
      const intents = (out.orders ?? []).map(o => o.intent);
      expect(intents).toContain('waste_time');
      expect(intents).not.toContain('summon_dragon');
      expect((out.orders ?? []).every(o => o.wire.kind === 'tactical')).toBe(true);
    } finally { await server.close(); }
  });

  test('substitution order compiles to canonical playerIds from names', async () => {
    const { server, interpret } = await boot({
      orders: [{ scope: 'match', intent: 'substitution',
        sub: { out: { side: 'own', name: 'Moretti' }, in: { side: 'own', shirtNumber: 12 } } }],
      say: 'ok',
    });
    try {
      const out = await (await interpret('take moretti off for the twelve')).json() as OrdersResponse;
      expect(out.orders![0]!.wire).toMatchObject({
        kind: 'substitution', playerOut: 'rhinos-player-11', playerIn: 'rhinos-player-12',
      });
    } finally { await server.close(); }
  });

  test('no orders + no patch degrades exactly as C2 always did (say-only)', async () => {
    const { server, interpret } = await boot({ say: 'good luck out there' });
    try {
      const out = await (await interpret('thanks coach')).json() as OrdersResponse;
      expect(out.orders).toBeUndefined();
      expect(out.patch).toBeUndefined();
      expect(out.say).toBe('good luck out there');
    } finally { await server.close(); }
  });
});

describe('G5 — durations and two references, end to end', () => {
  test('"Kovač, mark their nine for ten minutes" reaches the instruction book WITH an expiry', async () => {
    const { WebSocket } = await import('ws');
    // @ts-expect-error plain-JS browser module, typechecked loosely on purpose
    const { MatchConnection } = await import('../../match-client/src/net.js');
    const { server, interpret, token } = await boot({
      orders: [{
        scope: 'player', intent: 'mark_player',
        assignee: { side: 'own', name: 'Kovač' },
        target: { side: 'opponent', shirtNumber: 9 },
        durationMinutes: 10,
      }],
      say: 'on him for ten',
    });
    try {
      const room = server.rooms.get('orders-1')!;
      const out = await (await interpret('kovač, mark their nine for ten minutes')).json() as OrdersResponse;
      expect(out.rejected).toBeUndefined();
      const order = out.orders![0]!;
      expect(order.ack).toBe("KOVAČ → MARK #9 ÖZ 10' ✓");
      expect(order.wire).toMatchObject({
        kind: 'player_instruction', playerId: 'rhinos-player-06',
        instruction: 'mark_opponent', targetPlayerId: 'comets-player-09', ttlTicks: 1200,
      });

      const acks: Array<{ commandId: string; effectiveTick: number }> = [];
      const rejections: unknown[] = [];
      const conn = await new MatchConnection({
        url: `ws://127.0.0.1:${server.port}`, matchId: 'orders-1', token,
        socketFactory: (url: string) => new WebSocket(url) as never,
        hooks: {
          onAck: (a: { commandId: string; effectiveTick: number }) => acks.push(a),
          onRejected: (r: unknown) => rejections.push(r),
        },
      }).connect();
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const poll = () => {
          if (conn.status === 'live') return resolve();
          if (Date.now() - start > 5000) return reject(new Error('never went live'));
          setTimeout(poll, 10);
        };
        poll();
      });

      const w = order.wire as Record<string, unknown>;
      conn.sendCommand({ kind: 'player_instruction', commandId: 'g5-1', teamId: 'team-rhinos',
        playerId: w.playerId, instruction: w.instruction,
        targetPlayerId: w.targetPlayerId, ttlTicks: w.ttlTicks });
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const poll = () => {
          if (acks.length === 1) return resolve();
          if (Date.now() - start > 10_000) return reject(new Error('ack never arrived; rejections=' + JSON.stringify(rejections)));
          setTimeout(poll, 10);
        };
        poll();
      });

      room.advance(acks[0]!.effectiveTick - room.currentTick + 1);
      const instructions = (room.snapshot().teams[0] as {
        instructions?: Array<{ playerId: string; instruction: string; targetPlayerId: string | null; expiresAtTick: number | null }>;
      }).instructions!;
      const mark = instructions.find(i => i.playerId === 'rhinos-player-06')!;
      expect(mark).toMatchObject({ instruction: 'mark_opponent', targetPlayerId: 'comets-player-09' });
      // the spoken ten minutes became a real expiry the engine will honor
      expect(mark.expiresAtTick).toBeGreaterThan(room.currentTick);
      conn.close();
    } finally { await server.close(); }
  });
});

describe('the FULL loop: interpret -> compiled order -> real WS -> engine state', () => {
  test('a marking order changes the authoritative tactical state at its effective tick', async () => {
    const { WebSocket } = await import('ws');
    // @ts-expect-error plain-JS browser module, typechecked loosely on purpose
    const { MatchConnection } = await import('../../match-client/src/net.js');
    const { server, interpret, token } = await boot({
      orders: [
        { scope: 'team', intent: 'press_high' },
        { scope: 'player', intent: 'mark_player', target: { side: 'opponent', shirtNumber: 9 } },
        { scope: 'player', intent: 'overlap', target: { side: 'own', name: 'Ferreyra' } },
      ],
      say: 'done',
    });
    try {
      const room = server.rooms.get('orders-1')!;
      const out = await (await interpret('press high, mark their nine, ferreyra overlap')).json() as OrdersResponse;
      expect(out.orders).toHaveLength(3);

      const acks: Array<{ commandId: string; effectiveTick: number }> = [];
      const rejections: unknown[] = [];
      const conn = await new MatchConnection({
        url: `ws://127.0.0.1:${server.port}`, matchId: 'orders-1', token,
        socketFactory: (url: string) => new WebSocket(url) as never,
        hooks: {
          onAck: (a: { commandId: string; effectiveTick: number }) => acks.push(a),
          onRejected: (r: unknown) => rejections.push(r),
        },
      }).connect();

      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const poll = () => {
          if (conn.status === 'live') return resolve();
          if (Date.now() - start > 5000) return reject(new Error('never went live'));
          setTimeout(poll, 10);
        };
        poll();
      });

      // exactly what puppet.dispatchInterpretation does with the response
      const sendResults: boolean[] = [];
      for (const [i, order] of out.orders!.entries()){
        const wire = order.wire as Record<string, unknown> & { kind: string };
        if (wire.kind === 'tactical')
          sendResults.push(conn.sendCommand({ kind: 'tactical', commandId: `t-${i}`, teamId: 'team-rhinos', payload: wire.payload }));
        else if (wire.kind === 'player_instruction')
          sendResults.push(conn.sendCommand({ kind: 'player_instruction', commandId: `t-${i}`, teamId: 'team-rhinos',
            playerId: wire.playerId, instruction: wire.instruction }));
      }
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const poll = () => {
          if (acks.length === 3) return resolve();
          if (Date.now() - start > 10_000) return reject(new Error('acks never arrived; sends=' + JSON.stringify(sendResults) + ' status=' + conn.status + ' rejections=' + JSON.stringify(rejections)));
          setTimeout(poll, 10);
        };
        poll();
      });

      // the engine applies at effectiveTick — advance past it and observe
      const maxTick = Math.max(...acks.map(a => a.effectiveTick));
      room.advance(maxTick - room.currentTick + 1);
      const snap = room.snapshot();
      const tactics = snap.teams[0]!.tactics as { pressing: number; markTarget: string | null; scheme: string };
      expect(tactics.pressing).toBe(0.85);
      expect(tactics.markTarget).toBe('comets-player-09');
      expect(tactics.scheme).toBe('man');
      // the G3 bridge's observable result: the instruction book, in the
      // authoritative snapshot both players and spectators receive
      const instructions = (snap.teams[0] as { instructions?: Array<{ playerId: string; instruction: string }> }).instructions;
      expect(instructions).toBeDefined();
      expect(instructions).toContainEqual(expect.objectContaining({
        playerId: 'rhinos-player-10', instruction: 'overlap',
      }));
      conn.close();
    } finally { await server.close(); }
  });
});

// ---------------------------------------------------------------------------
// The representative phrase dataset (STEP 14). Deterministic layer: these
// document the EXPECTED intent for each phrasing; the live-model smoke below
// asserts a sample maps correctly when a key is present. The dataset is the
// contract new interpreter prompts are tuned against.
// ---------------------------------------------------------------------------
export const PHRASE_DATASET: Array<{ phrase: string; expect: { scope: string; intent: string } }> = [
  { phrase: 'press high', expect: { scope: 'team', intent: 'press_high' } },
  { phrase: 'push up and press them', expect: { scope: 'team', intent: 'press_high' } },
  { phrase: "don't let them breathe", expect: { scope: 'team', intent: 'press_high' } },
  { phrase: 'pressure them in their half', expect: { scope: 'team', intent: 'press_high' } },
  { phrase: 'everyone back', expect: { scope: 'team', intent: 'drop_deep' } },
  { phrase: 'put ten behind the ball', expect: { scope: 'team', intent: 'park_the_bus' } },
  { phrase: 'hit them on the counter', expect: { scope: 'team', intent: 'counterattack' } },
  { phrase: 'slow the tempo down', expect: { scope: 'team', intent: 'decrease_tempo' } },
  { phrase: 'switch the attack to the right', expect: { scope: 'team', intent: 'attack_right' } },
  { phrase: 'mark their number nine', expect: { scope: 'player', intent: 'mark_player' } },
  { phrase: 'number seven, stay wide', expect: { scope: 'player', intent: 'stay_wide' } },
  { phrase: 'move to a 4-3-3', expect: { scope: 'match', intent: 'change_formation' } },
];

describe('live-model smoke (skipped without ANTHROPIC_API_KEY — never in CI)', () => {
  test.skipIf(!process.env.ANTHROPIC_API_KEY)('a real model maps a slang phrase into the taxonomy', async () => {
    const server = await startMatchServer({
      port: 0, storeRoot: tmp(), createKey: 'live-ck', autoDrive: false,
      coach: { apiKey: process.env.ANTHROPIC_API_KEY },
    });
    const created = server.createMatch(namedManifest());
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/matches/orders-1/coach/interpret`, {
        method: 'POST',
        headers: { authorization: `Bearer ${created.tokens['team-rhinos']}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: "press them high and mark their number nine" }),
      });
      const out = await res.json() as OrdersResponse;
      const intents = (out.orders ?? []).map(o => o.intent);
      expect(intents).toContain('mark_player');
    } finally { await server.close(); }
  }, 30_000);
});
