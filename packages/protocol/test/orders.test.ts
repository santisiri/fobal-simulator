// Workstream G — the GameCommand contract. These are INTEGRATION-CRITICAL
// tests: every interpreter (LLM, keyword, console) compiles through this
// exact surface, so the closed vocabulary, deterministic resolution, and
// honest-rejection rules are what keep the simulation authoritative.
import { describe, expect, test } from 'vitest';
import {
  GameCommand, compileGameCommand, resolvePlayerRef, rosterDigest,
  TeamIntent, PlayerIntent,
} from '../src/index.js';
import type { TeamSnapshot } from '../src/index.js';

const team = (key: string, names: string[]): TeamSnapshot => ({
  teamId: `team-${key}`,
  name: key.toUpperCase(),
  formation: '442',
  players: names.map((name, i) => ({
    playerId: `${key}-p${i + 1}`,
    name,
    shirtNumber: i + 1,
    role: i === 0 ? 'GK' as const : 'CM' as const,
    ratings: {
      pace: 55, accel: 55, stamina: 55, strength: 55, passing: 55, shooting: 55,
      tackling: 55, dribbling: 55, vision: 55, positioning: 55, aggression: 55,
      composure: 55, gk: i === 0 ? 85 : 10,
    },
  })),
});

const own = team('own', [
  'Iker Peña', 'Luca Moretti', 'Diego Moretti', 'Jonás Ferreyra',
  'Sam Njoku', 'Tomás Costa', 'Erik Lund', 'Yuki Tanaka',
  'Ada Kovač', 'Leo Brandt', 'Marco Silva',
]);
const opponent = team('opp', [
  'Karl Weiss', 'Ben Adeyemi', 'Oscar Núñez', 'Ilya Petrov',
  'Noah King', 'Ravi Sharma', 'Jean Dupont', 'Emil Novak',
  'Ian Doyle', 'Aleksander Wójcik', 'Théo Martín',
]);
const ctx = { own, opponent, teamId: 'team-own' };

describe('GameCommand schema (the closed vocabulary)', () => {
  test('an intent outside its scope enum does not validate', () => {
    expect(GameCommand.safeParse({ version: 1, scope: 'team', intent: 'sing_louder' }).success).toBe(false);
    expect(GameCommand.safeParse({ version: 1, scope: 'player', intent: 'press_high',
      target: { side: 'own', name: 'Moretti' } }).success).toBe(false);
    expect(GameCommand.safeParse({ version: 1, scope: 'team', intent: 'press_high' }).success).toBe(true);
  });

  test('player scope requires a target; formation/sub require their payloads', () => {
    expect(GameCommand.safeParse({ version: 1, scope: 'player', intent: 'mark_player' }).success).toBe(false);
    expect(GameCommand.safeParse({ version: 1, scope: 'match', intent: 'change_formation' }).success).toBe(false);
    expect(GameCommand.safeParse({ version: 1, scope: 'match', intent: 'substitution' }).success).toBe(false);
  });

  test('there is no id field for a model to hallucinate into', () => {
    const parsed = GameCommand.parse({ version: 1, scope: 'player', intent: 'mark_player',
      target: { side: 'opponent', shirtNumber: 9, playerId: 'evil-injection' } as never });
    expect(JSON.stringify(parsed)).not.toContain('evil-injection');
  });
});

describe('resolvePlayerRef (deterministic, never fuzzy)', () => {
  test('surname token, diacritics-insensitive', () => {
    const r = resolvePlayerRef({ side: 'own', name: 'ferreyra' }, ctx);
    expect(r).toMatchObject({ ok: true, playerId: 'own-p4' });
    const accent = resolvePlayerRef({ side: 'opponent', name: 'nunez' }, ctx);
    expect(accent).toMatchObject({ ok: true, playerId: 'opp-p3' });
  });

  test('shirt number wins outright; a missing number names the side', () => {
    expect(resolvePlayerRef({ side: 'opponent', shirtNumber: 9 }, ctx))
      .toMatchObject({ ok: true, playerId: 'opp-p9' });
    const miss = resolvePlayerRef({ side: 'own', shirtNumber: 77 }, ctx);
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.reason).toContain('77');
  });

  test('ambiguity is a terse question, not a guess', () => {
    const r = resolvePlayerRef({ side: 'own', name: 'Moretti' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('Moretti or Moretti?');
  });

  test('an invented player cannot survive', () => {
    const r = resolvePlayerRef({ side: 'own', name: 'Zlatan' }, ctx);
    expect(r.ok).toBe(false);
  });
});

describe('compileGameCommand (the simulation integration boundary)', () => {
  test('every TEAM intent compiles to a tactical patch the engine already validates', () => {
    for (const intent of TeamIntent.options){
      const out = compileGameCommand(GameCommand.parse({ version: 1, scope: 'team', intent }), ctx);
      expect(out.ok, intent).toBe(true);
      if (out.ok) expect(out.wire.kind).toBe('tactical');
    }
  });

  test('intensity scales the intents that accept it', () => {
    const soft = compileGameCommand(GameCommand.parse({ version: 1, scope: 'team', intent: 'press_high', intensity: 0.6 }), ctx);
    if (soft.ok && soft.wire.kind === 'tactical') expect(soft.wire.payload.patch.pressing).toBe(0.6);
  });

  test('mark_player binds today: opponent resolved to a playerId, man scheme', () => {
    const out = compileGameCommand(GameCommand.parse({
      version: 1, scope: 'player', intent: 'mark_player',
      target: { side: 'opponent', shirtNumber: 9 },
    }), ctx);
    expect(out).toMatchObject({ ok: true });
    if (out.ok && out.wire.kind === 'tactical')
      expect(out.wire.payload.patch).toMatchObject({ markTarget: 'opp-p9', scheme: 'man' });
  });

  test('marking your own player is rejected with direction, not applied', () => {
    const out = compileGameCommand(GameCommand.parse({
      version: 1, scope: 'player', intent: 'mark_player',
      target: { side: 'own', name: 'Ferreyra' },
    }), ctx);
    expect(out.ok).toBe(false);
  });

  test('G3 bridge: the six spatial intents lower onto PlayerInstruction', () => {
    const expected: Array<[string, string, string]> = [
      ['stay_wide', 'stay_wide', 'STAY WIDE'],
      ['cut_inside', 'stay_central', 'CUT INSIDE'],
      ['overlap', 'overlap', 'OVERLAP'],
      ['hold_position', 'hold_position', 'HOLD POSITION'],
      ['make_forward_runs', 'push_forward', 'PUSH FORWARD'],
      ['come_short', 'drop_back', 'COME SHORT'],
    ];
    for (const [intent, instruction, ackWord] of expected){
      const out = compileGameCommand(GameCommand.parse({
        version: 1, scope: 'player', intent,
        target: { side: 'own', name: 'Ferreyra' },
      }), ctx);
      expect(out.ok, intent).toBe(true);
      if (out.ok && out.wire.kind === 'player_instruction'){
        expect(out.wire.playerId, intent).toBe('own-p4');
        expect(out.wire.instruction, intent).toBe(instruction);
        expect(out.ack, intent).toBe(`FERREYRA → ${ackWord} ✓`);
      } else if (out.ok) expect.fail(`${intent} compiled to ${out.wire.kind}, expected player_instruction`);
    }
  });

  test('spatial orders are for YOUR players; the goalkeeper keeps his post', () => {
    const theirs = compileGameCommand(GameCommand.parse({
      version: 1, scope: 'player', intent: 'overlap',
      target: { side: 'opponent', shirtNumber: 9 },
    }), ctx);
    expect(theirs.ok).toBe(false);
    if (!theirs.ok) expect(theirs.reason).toContain('YOUR players');

    const gk = compileGameCommand(GameCommand.parse({
      version: 1, scope: 'player', intent: 'stay_wide',
      target: { side: 'own', shirtNumber: 1 },
    }), ctx);
    expect(gk.ok).toBe(false);
    if (!gk.ok) expect(gk.reason).toContain('keeps his post');
  });

  test('still-reserved intents resolve the name FIRST, then reject with a SPECIFIC reason', () => {
    const typo = compileGameCommand(GameCommand.parse({
      version: 1, scope: 'player', intent: 'press_player',
      target: { side: 'own', name: 'Zlatan' },
    }), ctx);
    expect(typo.ok).toBe(false);
    if (!typo.ok) expect(typo.reason).toContain('Zlatan');   // the typo surfaces as a typo

    const cases: Array<[string, string]> = [
      ['press_player', 'single out a presser'],
      ['shoot_more', 'shoot_on_sight'],
      ['dribble_more', 'not tunable'],
    ];
    for (const [intent, fragment] of cases){
      const out = compileGameCommand(GameCommand.parse({
        version: 1, scope: 'player', intent,
        target: { side: intent === 'press_player' ? 'opponent' : 'own',
          name: intent === 'press_player' ? 'Doyle' : 'Ferreyra' },
      }), ctx);
      expect(out.ok, intent).toBe(false);
      if (!out.ok) expect(out.reason, intent).toContain(fragment);
    }
  });

  test('underlap binds (the engine has the half-space run) and make_forward_runs is a spell with a ttl', () => {
    const under = compileGameCommand(GameCommand.parse({
      version: 1, scope: 'player', intent: 'underlap',
      target: { side: 'own', name: 'Ferreyra' },
    }), ctx);
    expect(under).toMatchObject({ ok: true, wire: { kind: 'player_instruction', instruction: 'underlap' } });

    const runs = compileGameCommand(GameCommand.parse({
      version: 1, scope: 'player', intent: 'make_forward_runs',
      target: { side: 'own', name: 'Njoku' },
    }), ctx);
    expect(runs).toMatchObject({
      ok: true, wire: { kind: 'player_instruction', instruction: 'push_forward', ttlTicks: 900 },
    });
    // spatial orders without a ttl carry none — persistence until replaced
    const wide = compileGameCommand(GameCommand.parse({
      version: 1, scope: 'player', intent: 'stay_wide',
      target: { side: 'own', name: 'Njoku' },
    }), ctx);
    if (wide.ok && wide.wire.kind === 'player_instruction') expect(wide.wire.ttlTicks).toBeUndefined();
  });

  test('substitutions resolve both refs on OUR side and emit the wire command', () => {
    const out = compileGameCommand(GameCommand.parse({
      version: 1, scope: 'match', intent: 'substitution',
      sub: { out: { side: 'own', name: 'Njoku' }, in: { side: 'own', name: 'Silva' } },
    }), ctx);
    expect(out).toMatchObject({ ok: true });
    if (out.ok && out.wire.kind === 'substitution')
      expect(out.wire).toMatchObject({ playerOut: 'own-p5', playerIn: 'own-p11' });
  });

  test('rosterDigest is the compact interpreter context — names, shirts, roles, nothing else', () => {
    const digest = rosterDigest(own);
    expect(digest).toHaveLength(11);
    expect(Object.keys(digest[0]!).sort()).toEqual(['name', 'role', 'shirt']);
  });

  test('every reserved PlayerIntent stays in the enum (the language is spoken before it binds)', () => {
    expect(PlayerIntent.options).toContain('overlap');
    expect(PlayerIntent.options).toContain('mark_player');
  });
});
