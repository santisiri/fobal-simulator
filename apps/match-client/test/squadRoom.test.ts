// H2 — the squad room's pure parts. Two things are worth locking down:
// the slot layouts a sheet is built by tapping, and the promise that the
// room's tactical shortcuts are the SAME patches the spoken commands
// compile to. If that second one ever drifts, tapping PRESS HIGH and
// shouting "press high" would quietly mean different things.
import { describe, expect, test } from 'vitest';
import { compileGameCommand, TeamSnapshot } from '@fobal/protocol';
import { FORMATIONS, FORMATION_SLOTS, outOfPosition, prettyFormation, slotsFor } from '../src/ui/formation.js';
import { PRESETS, SLIDER_KEYS, TACTIC_CHOICES } from '../src/ui/tactics.js';

// the UI modules are plain JS (checkJs is on), so the slot table is typed as
// a literal — index it by the formation NAMES the room actually offers
type Slot = { role: string; x: number; y: number };
const SLOTS = FORMATION_SLOTS as Record<string, Slot[]>;

const team = TeamSnapshot.parse({
  teamId: 'team-x', name: 'X',
  players: Array.from({ length: 11 }, (_, i) => ({
    playerId: `p${i}`, name: `P${i}`, shirtNumber: i + 1, role: i === 0 ? 'GK' : 'CM',
    ratings: {
      pace: 55, accel: 55, stamina: 55, strength: 55, passing: 55, shooting: 55,
      tackling: 55, dribbling: 55, vision: 55, positioning: 55, aggression: 55,
      composure: 55, gk: i === 0 ? 85 : 10,
    },
  })),
});

describe('formation slots', () => {
  test('every formation fields exactly eleven, keeper first', () => {
    for (const f of FORMATIONS as string[]){
      const slots = SLOTS[f]!;
      expect(slots, f).toHaveLength(11);
      expect(slots[0]!.role, f).toBe('GK');                 // matches TeamSheet's rule
      expect(slots.filter(s => s.role === 'GK'), f).toHaveLength(1);
    }
  });

  test('slots sit on the pitch and get deeper toward the opposition', () => {
    for (const f of FORMATIONS as string[]){
      for (const s of SLOTS[f]!){
        expect(s.x).toBeGreaterThanOrEqual(0); expect(s.x).toBeLessThanOrEqual(100);
        expect(s.y).toBeGreaterThanOrEqual(0); expect(s.y).toBeLessThanOrEqual(100);
      }
      const ys = SLOTS[f]!.map(s => s.y);
      expect(Math.min(...ys), f).toBe(ys[0]);               // the keeper is deepest
    }
  });

  test('an unknown formation falls back rather than blanking the pitch', () => {
    expect(slotsFor('999')).toEqual(SLOTS['442']);
    expect(prettyFormation('433')).toBe('4-3-3');
  });

  test('out-of-position reads by family, so an RM on the right wing is not news', () => {
    expect(outOfPosition('RM', 'RW')).toBe(false);
    expect(outOfPosition('CB', 'LB')).toBe(false);
    expect(outOfPosition('CB', 'ST')).toBe(true);
    expect(outOfPosition('GK', 'CB')).toBe(true);
  });
});

describe('the tactics board speaks the enginedictionary', () => {
  test('every slider key is a real TacticalState field', () => {
    // proven by construction: a patch of all of them survives the schema
    const patch = Object.fromEntries((SLIDER_KEYS as string[]).map(k => [k, 0.5]));
    const out = compileGameCommand(
      { version: 1, scope: 'team', intent: 'press_high' } as never,
      { own: team, opponent: team, teamId: 'team-x' },
    );
    expect(out.ok).toBe(true);                               // sanity: ctx is usable
    const merged = TeamSnapshot.safeParse({ ...team, tactics: patch });
    expect(merged.success, JSON.stringify(patch)).toBe(true);
  });

  test('every choice list matches what TacticalState allows', () => {
    for (const choice of TACTIC_CHOICES as Array<{ key: string; options: string[] }>){
      const parsed = TeamSnapshot.safeParse({
        ...team, tactics: { [choice.key]: choice.options[0] },
      });
      expect(parsed.success, choice.key).toBe(true);
    }
  });

  test('THE COHERENCE TEST: a preset is exactly what the spoken command does', () => {
    for (const preset of PRESETS as Array<{ intent: string; patch: Record<string, unknown> }>){
      const out = compileGameCommand(
        { version: 1, scope: 'team', intent: preset.intent } as never,
        { own: team, opponent: team, teamId: 'team-x' },
      );
      expect(out.ok, preset.intent).toBe(true);
      if (out.ok && out.wire.kind === 'tactical')
        expect(out.wire.payload.patch, preset.intent).toEqual(preset.patch);
      else expect.fail(`${preset.intent} did not compile to a tactical patch`);
    }
  });
});
