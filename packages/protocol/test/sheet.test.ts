// Workstream H — the team sheet contract. The promise under test: the
// eleven a manager picks are the eleven the engine starts, the shape they
// set is the shape that kicks off, and no sheet can ever produce a squad
// the match server would refuse.
import { describe, expect, test } from 'vitest';
import { applyTeamSheet, defaultSheetFor, TeamSheet, TeamSnapshot } from '../src/index.js';

const ROLES = ['GK', 'CB', 'CB', 'LB', 'RB', 'CM', 'CM', 'LM', 'RM', 'ST', 'ST',
  'GK', 'CB', 'CM', 'LW', 'ST'] as const;

const squad = (): TeamSnapshot => TeamSnapshot.parse({
  teamId: 'team-fc',
  name: 'FOBAL FC',
  formation: '442',
  players: ROLES.map((role, i) => ({
    playerId: `p${i + 1}`,
    name: `Player ${i + 1}`,
    shirtNumber: i + 1,
    role,
    ratings: {
      pace: 55, accel: 55, stamina: 55, strength: 55, passing: 55, shooting: 55,
      tackling: 55, dribbling: 55, vision: 55, positioning: 55, aggression: 55,
      composure: 55, gk: role === 'GK' ? 85 : 10,
    },
  })),
});

const sheet = (over: Partial<TeamSheet> = {}): TeamSheet => TeamSheet.parse({
  version: 1,
  lineup: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11'],
  bench: ['p12', 'p13', 'p14', 'p15', 'p16'],
  ...over,
});

describe('TeamSheet schema', () => {
  test('an eleven is exactly eleven, a bench is at most five', () => {
    expect(TeamSheet.safeParse({ version: 1, lineup: ['p1'], bench: [] }).success).toBe(false);
    expect(TeamSheet.safeParse({
      version: 1, lineup: Array.from({ length: 11 }, (_, i) => `p${i + 1}`),
      bench: Array.from({ length: 6 }, (_, i) => `b${i}`),
    }).success).toBe(false);
    expect(TeamSheet.safeParse({
      version: 1, lineup: Array.from({ length: 11 }, (_, i) => `p${i + 1}`), bench: [],
    }).success).toBe(true);
  });
});

describe('defaultSheetFor — what a squad plays with no sheet saved', () => {
  test('the first eleven start, the next five sit; the editor opens on the truth', () => {
    const d = defaultSheetFor(squad());
    expect(d.lineup).toEqual(['p1','p2','p3','p4','p5','p6','p7','p8','p9','p10','p11']);
    expect(d.bench).toEqual(['p12','p13','p14','p15','p16']);
    expect(d.formation).toBe('442');
    // and it round-trips: applying the default changes nothing
    const applied = applyTeamSheet(squad(), d);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.team.players.map(p => p.playerId)).toEqual(squad().players.map(p => p.playerId));
  });
});

describe('applyTeamSheet — the eleven you pick are the eleven that walk out', () => {
  test('the picked XI leads the squad, in slot order', () => {
    // bench the strikers, start the reserve winger and the reserve forward
    const out = applyTeamSheet(squad(), sheet({
      lineup: ['p1','p2','p3','p4','p5','p6','p7','p8','p9','p15','p16'],
      bench: ['p10','p11','p12','p13','p14'],
    }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.team.players.slice(0, 11).map(p => p.playerId))
      .toEqual(['p1','p2','p3','p4','p5','p6','p7','p8','p9','p15','p16']);
    expect(out.team.players.slice(11).map(p => p.playerId)).toEqual(['p10','p11','p12','p13','p14']);
  });

  test('players left out do not travel', () => {
    const out = applyTeamSheet(squad(), sheet({ bench: ['p12'] }));
    expect(out.ok).toBe(true);
    if (out.ok){
      expect(out.team.players).toHaveLength(12);
      expect(out.team.players.some(p => p.playerId === 'p16')).toBe(false);
    }
  });

  test('formation and tactics reach the team; tactics MERGE over what the squad declares', () => {
    const base = { ...squad(), tactics: { pressing: 0.5, tempo: 0.4 } };
    const out = applyTeamSheet(base, sheet({ formation: '433', tactics: { defLine: 0.8, tempo: 0.9 } }));
    expect(out.ok).toBe(true);
    if (out.ok){
      expect(out.team.formation).toBe('433');
      // the sheet's choices win; untouched fields survive
      expect(out.team.tactics).toMatchObject({ pressing: 0.5, tempo: 0.9, defLine: 0.8 });
    }
  });

  test('a sold player makes the sheet stale, and says so by id', () => {
    const out = applyTeamSheet(squad(), sheet({
      lineup: ['p1','p2','p3','p4','p5','p6','p7','p8','p9','p10','sold-99'],
    }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('sold-99');
  });

  test('picking the same player twice names him', () => {
    const out = applyTeamSheet(squad(), sheet({
      lineup: ['p1','p2','p2','p4','p5','p6','p7','p8','p9','p10','p11'],
    }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('Player 2 is picked twice');
  });

  test('an eleven without a keeper is refused; so is a keeper out of slot 0', () => {
    const noGk = applyTeamSheet(squad(), sheet({
      lineup: ['p2','p3','p4','p5','p6','p7','p8','p9','p10','p11','p13'],
      bench: ['p14','p15','p16'],
    }));
    expect(noGk.ok).toBe(false);
    if (!noGk.ok) expect(noGk.reason).toContain('goalkeeper');

    const wrongSlot = applyTeamSheet(squad(), sheet({
      lineup: ['p2','p1','p3','p4','p5','p6','p7','p8','p9','p10','p11'],
      bench: ['p12','p13'],
    }));
    expect(wrongSlot.ok).toBe(false);
    if (!wrongSlot.ok) expect(wrongSlot.reason).toContain('first slot');
  });

  test('the schema is the gate: whatever comes out is a legal TeamSnapshot', () => {
    const out = applyTeamSheet(squad(), sheet());
    expect(out.ok).toBe(true);
    if (out.ok) expect(() => TeamSnapshot.parse(out.team)).not.toThrow();
  });
});
