// Workstream G — the command layer's deterministic core. No LLM anywhere:
// the taxonomy schema, the reference resolver, and the compile table are
// plain functions, and this suite is the contract the interpreter's output
// is held to. (Live-model behavior is exercised separately and optionally —
// the test suite must never depend on a paid API call.)
import { describe, expect, test } from 'vitest';
import {
  compileGameCommand, GameCommand, resolvePlayerRef, rosterDigest,
  TacticalPatch, TeamIntent, TeamSnapshot,
} from '../src/index.js';

const player = (id: string, name: string, shirt: number, role = 'CM') =>
  ({ playerId: id, name, shirtNumber: shirt, role: role as 'CM',
     ratings: Object.fromEntries(['pace','accel','stamina','strength','passing','shooting','tackling',
       'dribbling','vision','positioning','aggression','composure','gk'].map(k => [k, 50])) as never });

const OWN: TeamSnapshot = {
  teamId: 'team-own', name: 'SANTI FC', formation: '442',
  players: [
    player('own-1', 'Iker Peña', 1, 'GK'),
    player('own-2', 'Luca Moretti', 4, 'CB'),
    player('own-3', 'Dario Moretti', 15, 'CB'),
    player('own-4', 'Leo Kovač', 7, 'LM'),
    player('own-5', 'Nico Ferreyra', 11, 'LW'),
    player('own-6', 'Ba', 9, 'ST'),
    ...Array.from({ length: 5 }, (_, i) => player(`own-b${i}`, `Bench Man${i}`, 20 + i)),
  ],
};
const OPP: TeamSnapshot = {
  teamId: 'team-opp', name: 'RIVALS', formation: '433',
  players: [
    player('opp-1', 'Gero Costa', 1, 'GK'),
    player('opp-2', 'Ivan Drach', 5, 'CB'),
    player('opp-3', 'Karim Öz', 9, 'ST'),
    ...Array.from({ length: 8 }, (_, i) => player(`opp-x${i}`, `Filler Guy${i}`, 30 + i)),
  ],
};
const CTX = { own: OWN, opponent: OPP, teamId: 'team-own' };

const cmd = (partial: Record<string, unknown>) =>
  GameCommand.parse({ version: 1, ...partial });

describe('player reference resolution (deterministic, no invented ids)', () => {
  test('surname, case-insensitive, diacritics ignored', () => {
    const r = resolvePlayerRef({ side: 'own', name: 'kovac' }, CTX);
    expect(r).toMatchObject({ ok: true, playerId: 'own-4', shirtNumber: 7 });
  });

  test('shirt number beats everything', () => {
    expect(resolvePlayerRef({ side: 'opponent', shirtNumber: 9 }, CTX))
      .toMatchObject({ ok: true, playerId: 'opp-3', name: 'Karim Öz' });
    expect(resolvePlayerRef({ side: 'own', shirtNumber: 99 }, CTX))
      .toMatchObject({ ok: false, reason: expect.stringContaining('no number 99') });
  });

  test('ambiguity is a terse QUESTION naming the candidates', () => {
    const r = resolvePlayerRef({ side: 'own', name: 'Moretti' }, CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('Moretti or Moretti?');
  });

  test('an invented name resolves to an error, never a player', () => {
    const r = resolvePlayerRef({ side: 'own', name: 'Zlatan' }, CTX);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('no player called "Zlatan"') });
  });

  test('sides are separate universes', () => {
    expect(resolvePlayerRef({ side: 'own', name: 'Costa' }, CTX).ok).toBe(false);
    expect(resolvePlayerRef({ side: 'opponent', name: 'Costa' }, CTX).ok).toBe(true);
  });
});

describe('the GameCommand schema (closed vocabulary)', () => {
  test('unknown intents die at the schema', () => {
    expect(GameCommand.safeParse({ version: 1, scope: 'team', intent: 'summon_dragon' }).success).toBe(false);
    expect(GameCommand.safeParse({ version: 1, scope: 'player', intent: 'press_high',
      target: { side: 'own', name: 'x' } }).success).toBe(false);   // team intent under player scope
  });

  test('structural requirements enforced', () => {
    expect(GameCommand.safeParse({ version: 1, scope: 'player', intent: 'mark_player' }).success).toBe(false);
    expect(GameCommand.safeParse({ version: 1, scope: 'match', intent: 'change_formation' }).success).toBe(false);
    expect(GameCommand.safeParse({ version: 1, scope: 'match', intent: 'substitution' }).success).toBe(false);
  });
});

describe('the compile table (intent → the engine surface that exists)', () => {
  test('every TEAM intent compiles to a protocol-valid patch', () => {
    for (const intent of TeamIntent.options){
      const out = compileGameCommand(cmd({ scope: 'team', intent }), CTX);
      expect(out.ok, intent).toBe(true);
      if (out.ok && out.wire.kind === 'tactical'){
        expect(TacticalPatch.safeParse(out.wire.payload.patch).success, intent).toBe(true);
        expect(out.ack.length, intent).toBeGreaterThan(2);
      }
    }
  });

  test('press_high honors intensity', () => {
    const out = compileGameCommand(cmd({ scope: 'team', intent: 'press_high', intensity: 0.6 }), CTX);
    expect(out.ok && out.wire.kind === 'tactical' && out.wire.payload.patch.pressing).toBe(0.6);
  });

  test('mark_player binds to the engine markTarget with a short ack', () => {
    const out = compileGameCommand(
      cmd({ scope: 'player', intent: 'mark_player', target: { side: 'opponent', shirtNumber: 9 } }), CTX);
    expect(out).toMatchObject({ ok: true, ack: 'MARK #9 ÖZ ✓' });
    if (out.ok && out.wire.kind === 'tactical')
      expect(out.wire.payload.patch).toEqual({ markTarget: 'opp-3', scheme: 'man' });
  });

  test('marking your own player is refused with direction, not applied sideways', () => {
    const out = compileGameCommand(
      cmd({ scope: 'player', intent: 'mark_player', target: { side: 'own', name: 'Kovač' } }), CTX);
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('OPPONENT') });
  });

  test('reserved player intents reject honestly — after resolving the name', () => {
    const out = compileGameCommand(
      cmd({ scope: 'player', intent: 'overlap', target: { side: 'own', name: 'Ferreyra' } }), CTX);
    expect(out.ok).toBe(false);
    if (!out.ok){
      expect(out.reason).toContain('Ferreyra');
      expect(out.reason).toContain('not on the pitch yet');
    }
    // …but a typo'd name is a NAME error, not an "unsupported" error
    const typo = compileGameCommand(
      cmd({ scope: 'player', intent: 'overlap', target: { side: 'own', name: 'Ferreira' } }), CTX);
    expect(!typo.ok && typo.reason.includes('no player called')).toBe(true);
  });

  test('change_formation and substitution compile to their wire commands', () => {
    const f = compileGameCommand(cmd({ scope: 'match', intent: 'change_formation', formation: '433' }), CTX);
    expect(f.ok && f.wire.kind === 'tactical' && f.wire.payload.patch.formation).toBe('433');

    const sub = compileGameCommand(cmd({ scope: 'match', intent: 'substitution',
      sub: { out: { side: 'own', name: 'Ba' }, in: { side: 'own', shirtNumber: 21 } } }), CTX);
    expect(sub).toMatchObject({ ok: true, ack: 'SUB BA → MAN1' });
    if (sub.ok && sub.wire.kind === 'substitution')
      expect(sub.wire).toMatchObject({ playerOut: 'own-6', playerIn: 'own-b1' });
  });

  test('determinism: same command, same context, byte-equal output', () => {
    const a = compileGameCommand(cmd({ scope: 'team', intent: 'park_the_bus' }), CTX);
    const b = compileGameCommand(cmd({ scope: 'team', intent: 'park_the_bus' }), CTX);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('interpreter context stays compact', () => {
  test('rosterDigest is names/shirts/roles and nothing else', () => {
    const d = rosterDigest(OWN);
    expect(d[0]).toEqual({ shirt: 1, name: 'Iker Peña', role: 'GK' });
    expect(Object.keys(d[0]!)).toHaveLength(3);
  });
});
