// Footballer names — the generator's contract: deterministic forever,
// plausible in shape, unique-by-surname within a squad, and small enough
// to fit every downstream limit (protocol ≤48, mint/contract ≤32 BYTES,
// custom-name UI ≤24 chars). Tone is enforced structurally (First Surname,
// capitalized, from curated regional pools) — the pools themselves are the
// no-comedy, no-famous-players guarantee.
import { describe, expect, test } from 'vitest';
import { playerName, squadNames, startLobbyServer, buildTeam } from '../src/index.js';
import { startMatchServer } from '@fobal/match-server';
import { nameAllowed } from '../src/names.js';
import { TeamSnapshot } from '@fobal/protocol';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('playerNames', () => {
  test('deterministic: the same key is the same footballer, forever', () => {
    expect(playerName('team-abc:0')).toBe(playerName('team-abc:0'));
    expect(squadNames('team-abc', 16)).toEqual(squadNames('team-abc', 16));
  });

  test('different keys diverge (spread sanity over 200 squads)', () => {
    const all = new Set<string>();
    for (let k = 0; k < 200; k++) all.add(playerName(`spread:${k}`));
    expect(all.size).toBeGreaterThan(150);   // collisions allowed, monoculture is not
  });

  test('shape: First Surname, capitalized, within every length limit', () => {
    for (let k = 0; k < 300; k++){
      const name = playerName(`shape:${k}`);
      const parts = name.split(' ');
      expect(parts.length).toBe(2);
      for (const p of parts) expect(p[0]).toBe(p[0]!.toUpperCase());
      expect(name.length).toBeGreaterThanOrEqual(5);
      expect(name.length).toBeLessThanOrEqual(24);            // custom-name UI cap
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(32);   // on-chain cap
      expect(nameAllowed(name)).toBe(true);                   // moderation-clean
    }
  });

  test('unique surnames within a squad — 500 squads, no duplicate identities', () => {
    for (let k = 0; k < 500; k++){
      const surnames = squadNames(`squad:${k}`, 16).map(n => n.split(' ').pop());
      expect(new Set(surnames).size).toBe(16);
    }
  });

  test('buildTeam wears the names: deterministic, protocol-valid, overrides intact', async () => {
    const account = {
      accountId: 'acc-1', email: 'a@b.c', handle: 'santi', teamKey: 'santi-1234',
      teamName: 'SANTI FC', createdAt: new Date().toISOString(),
    };
    const team = buildTeam(account);
    expect(() => TeamSnapshot.parse(team)).not.toThrow();
    // no inventory labels anywhere
    for (const p of team.players) expect(p.name).not.toMatch(/\b(GK|CB|CM|ST|LB|RB|LM|RM|LW|RW) \d+$/);
    // same account, same players — the second-device rule
    expect(buildTeam(account)).toEqual(team);
    // a custom name still wins over the generated one
    const custom = { ...account, squad: { playerNames: { [team.players[0]!.playerId]: 'El Muro' } } };
    expect(buildTeam(custom).players[0]!.name).toBe('El Muro');
  });

  test('the /squad editor round-trips generated defaults (mint reads this path)', async () => {
    const match = await startMatchServer({ port: 0, storeRoot: mkdtempSync(join(tmpdir(), 'pn-')), createKey: 'ck', autoDrive: false });
    const lobby = await startLobbyServer({
      port: 0, devAuth: true, authRequestIntervalMs: 0,
      matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'ck' },
    });
    const base = `http://127.0.0.1:${lobby.port}`;
    try {
      const post = (p: string, b: unknown, t?: string) => fetch(`${base}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
        body: JSON.stringify(b),
      });
      const { devCode } = await (await post('/auth/request', { email: 'n@fobal.ai' })).json() as { devCode: string };
      const { token } = await (await post('/auth/verify', { email: 'n@fobal.ai', code: devCode })).json() as { token: string };
      const squad = await (await fetch(`${base}/squad`, { headers: { authorization: `Bearer ${token}` } })).json() as
        { players: Array<{ name: string; defaultName: string }> };
      expect(squad.players).toHaveLength(16);
      for (const p of squad.players){
        expect(p.name).toBe(p.defaultName);
        expect(p.name).toMatch(/^\S+ \S+$/);            // First Surname
        expect(Buffer.byteLength(p.name, 'utf8')).toBeLessThanOrEqual(32);   // mintable as-is
      }
    } finally { await lobby.close(); await match.close(); }
  });
});
