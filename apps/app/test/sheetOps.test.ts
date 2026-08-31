// The squad room's placement rules. The invariant: THE ELEVEN ALWAYS STAYS
// ELEVEN, and nobody silently disappears — a placement trades places. These
// mirror the behavior squad.html shipped with, now pure and locked down.
import { describe, expect, test } from 'vitest';
import { lineupSet, pickerSections, placePlayer } from '../src/views/sheetOps.js';

const sheet = (lineup: (string | null)[], bench: string[] = []) =>
  ({ version: 1, lineup, bench, formation: '442', tactics: {} });

const XI = ['gk', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];

describe('placePlayer', () => {
  test('swap within the XI — both players keep a shirt', () => {
    const out = placePlayer(sheet(XI), 9, 'p2');
    expect(out.lineup[9]).toBe('p2');
    expect(out.lineup[2]).toBe('p9');
    expect(out.lineup.filter(Boolean)).toHaveLength(11);
  });

  test('bench → occupied slot is a straight trade of seats', () => {
    const out = placePlayer(sheet(XI, ['b1', 'b2']), 5, 'b2');
    expect(out.lineup[5]).toBe('b2');
    expect(out.bench).toEqual(['b1', 'p5']);
  });

  test('bench → empty slot closes the bench seat', () => {
    const lineup: (string | null)[] = [...XI];
    lineup[10] = null;
    const out = placePlayer(sheet(lineup, ['b1']), 10, 'b1');
    expect(out.lineup[10]).toBe('b1');
    expect(out.bench).toEqual([]);
  });

  test('outside → occupied slot drops the outgoing man to the bench', () => {
    const out = placePlayer(sheet(XI, ['b1']), 0, 'newGk');
    expect(out.lineup[0]).toBe('newGk');
    expect(out.bench).toEqual(['b1', 'gk']);
  });

  test('outside → occupied slot with a full bench: outgoing leaves the sheet, never vanishes from the squad list', () => {
    const bench = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const out = placePlayer(sheet(XI, bench), 3, 'newcomer');
    expect(out.lineup[3]).toBe('newcomer');
    expect(out.bench).toEqual(bench);                       // still five
    const all = new Set([...XI, ...bench, 'newcomer']);
    const { rest } = pickerSections(out, all);
    expect(rest).toContain('p3');                           // listed, pickable again
  });

  test('moving an XI player to an empty slot vacates his old one', () => {
    const lineup: (string | null)[] = [...XI];
    lineup[10] = null;
    const out = placePlayer(sheet(lineup), 10, 'p4');
    expect(out.lineup[10]).toBe('p4');
    expect(out.lineup[4]).toBeNull();
  });

  test('placing a player on his own slot is a no-op', () => {
    const out = placePlayer(sheet(XI, ['b1']), 6, 'p6');
    expect(out.lineup).toEqual(XI);
    expect(out.bench).toEqual(['b1']);
  });

  test('pure — the input sheet is never mutated', () => {
    const before = sheet(XI, ['b1']);
    const lineupRef = before.lineup;
    placePlayer(before, 2, 'b1');
    expect(before.lineup).toBe(lineupRef);
    expect(before.lineup).toEqual(XI);
    expect(before.bench).toEqual(['b1']);
  });
});

describe('pickerSections', () => {
  test('bench first, then the rest; the XI never appears; sold players drop out', () => {
    const all = new Set([...XI, 'b1', 'r1', 'r2']);
    const { onBench, rest } = pickerSections(sheet(XI, ['b1', 'soldPlayer']), all);
    expect(onBench).toEqual(['b1']);                        // soldPlayer no longer owned
    expect(rest).toEqual(['r1', 'r2']);
  });

  test('lineupSet ignores empty slots', () => {
    expect(lineupSet(sheet(['gk', null, 'p2'], []))).toEqual(new Set(['gk', 'p2']));
  });
});
