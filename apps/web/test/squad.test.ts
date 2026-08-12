// The onboarding squad generator and the on-chain avatar port are pure
// (no DOM), so they test in Node directly. They must stay faithful to the
// contract: 11 players, valid skill ranges, a GK, deterministic from the
// club name, and avatars structurally identical to FobalAvatarRenderer.
import { describe, expect, test } from 'vitest';
// @ts-expect-error — plain ESM browser module, no types
import { generateSquad, ratingFace, overall } from '../public/js/squad.js';
// @ts-expect-error — plain ESM browser module, no types
import { avatarSvg } from '../public/js/avatar.js';
// @ts-expect-error — plain ESM browser module, no types
import { clubOverall, crestInitials } from '../public/js/club.js';

const kit = { primary: '#22c55e', secondary: '#0a0f1e' };

describe('starter squad generation', () => {
  test('produces a valid 11-player 4-3-3 with one keeper', () => {
    const { players } = generateSquad({ clubName: 'Fobal FC', kit });
    expect(players).toHaveLength(11);
    expect(players.filter((p: any) => p.position === 0)).toHaveLength(1); // exactly one GK
    expect(players.filter((p: any) => p.position === 1)).toHaveLength(4); // back four
    expect(players.filter((p: any) => p.position === 3)).toHaveLength(3); // front three
    for (const p of players) {
      for (const v of Object.values(p.skills) as number[]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
      expect(p.overall).toBeGreaterThan(30);
      expect(p.overall).toBeLessThan(100);
    }
  });

  test('a generated squad is JSON-serializable (the Hub persists it verbatim)', () => {
    const club = { name: 'Fobal FC', kit, squad: generateSquad({ clubName: 'Fobal FC', kit }) };
    const round = JSON.parse(JSON.stringify(club)); // dna must NOT be a BigInt
    expect(round.squad.players).toHaveLength(11);
    expect(typeof round.squad.players[0].dna).toBe('string');
    expect(round.squad.players[0].dna).toMatch(/^0x[0-9a-f]+$/);
  });

  test('is deterministic from the club name (same club → same squad)', () => {
    const a = generateSquad({ clubName: 'Fobal FC', kit });
    const b = generateSquad({ clubName: 'Fobal FC', kit });
    expect(a.players.map((p: any) => p.name)).toEqual(b.players.map((p: any) => p.name));
    expect(a.players.map((p: any) => p.overall)).toEqual(b.players.map((p: any) => p.overall));
    const c = generateSquad({ clubName: 'Rival FC', kit });
    expect(c.players.map((p: any) => p.name)).not.toEqual(a.players.map((p: any) => p.name));
  });

  test('player names are unique within a squad', () => {
    const { players } = generateSquad({ clubName: 'Fobal FC', kit });
    expect(new Set(players.map((p: any) => p.name)).size).toBe(11);
  });

  test('the keeper card shows a GK-variant rating face', () => {
    const { players } = generateSquad({ clubName: 'Fobal FC', kit });
    const gk = players.find((p: any) => p.position === 0)!;
    expect(ratingFace(gk.skills)[0][0]).toBe('GK');
    const striker = players.find((p: any) => p.position === 3)!;
    expect(ratingFace(striker.skills)[0][0]).toBe('PAC'); // outfield variant
    expect(overall(gk.skills)).toBeGreaterThan(30);
  });
});

describe('on-chain avatar port', () => {
  test('renders a deterministic 15-rect SVG identical for identical inputs', () => {
    const { players } = generateSquad({ clubName: 'Fobal FC', kit });
    const p = players[9];
    const svg = avatarSvg({ appearance: p.appearance, dna: BigInt(p.dna), position: p.position, kit });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect((svg.match(/<rect/g) || []).length).toBe(15); // matches the contract renderer
    const again = avatarSvg({ appearance: p.appearance, dna: BigInt(p.dna), position: p.position, kit });
    expect(again).toBe(svg);
  });

  test('the keeper gets the distinct keeper kit, outfielders get the club kit', () => {
    const { players } = generateSquad({ clubName: 'Fobal FC', kit });
    const gk = players.find((p: any) => p.position === 0)!;
    const outfield = players.find((p: any) => p.position === 3)!;
    const gkSvg = avatarSvg({ appearance: gk.appearance, dna: BigInt(gk.dna), position: 0, kit });
    const ofSvg = avatarSvg({ appearance: outfield.appearance, dna: BigInt(outfield.dna), position: 3, kit });
    expect(gkSvg).toContain('e0c04a'); // keeper amber
    expect(ofSvg.toLowerCase()).toContain('22c55e'); // club primary on the shirt
  });
});

describe('club helpers', () => {
  test('crest initials and squad overall derive from the club', () => {
    expect(crestInitials('Fobal FC')).toBe('FF');
    expect(crestInitials('Barcelona')).toBe('BA');
    expect(crestInitials('')).toBe('FC');
    const club = { name: 'Fobal FC', kit, squad: generateSquad({ clubName: 'Fobal FC', kit }) };
    const ovr = clubOverall(club);
    expect(ovr).toBeGreaterThan(40);
    expect(ovr).toBeLessThan(90);
  });
});
