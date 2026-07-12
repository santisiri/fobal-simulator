// Deterministic sample fixtures shared by tests across the monorepo.
// NOT part of the wire protocol — a convenience for development only.
import type { MatchManifest, PlayerSnapshot, TeamSnapshot } from './match.js';
import { PROTOCOL_VERSION } from './core.js';

const ROLES_XI = ['GK', 'CB', 'CB', 'LB', 'RB', 'CM', 'CM', 'LM', 'RM', 'ST', 'ST'] as const;
const ROLES_BENCH = ['GK', 'CB', 'CM', 'LW', 'ST'] as const;

function player(teamKey: string, i: number, role: PlayerSnapshot['role']): PlayerSnapshot {
  // Spread ratings deterministically so squads are plausible and asymmetric.
  const base = 55 + ((i * 7 + teamKey.length * 13) % 30);
  const r = (offset: number) => Math.max(30, Math.min(95, base + offset));
  return {
    playerId: `${teamKey}-player-${String(i + 1).padStart(2, '0')}`,
    name: `${teamKey.toUpperCase()} ${role} ${i + 1}`,
    shirtNumber: i + 1,
    role,
    nationality: i % 3 === 0 ? 'AR' : i % 3 === 1 ? 'BR' : 'DE',
    age: 19 + ((i * 3) % 15),
    ratings: {
      pace: r(role === 'ST' || role === 'LW' || role === 'RW' ? 8 : 0),
      accel: r(4), stamina: r(6), strength: r(-2),
      passing: r(role === 'CM' ? 10 : 0), shooting: r(role === 'ST' ? 12 : -6),
      tackling: r(role === 'CB' ? 12 : -4), dribbling: r(2),
      vision: r(role === 'CM' ? 8 : 0), positioning: r(3),
      aggression: r(-8), composure: r(0),
      gk: role === 'GK' ? 85 : 10,
    },
  };
}

export function sampleTeam(teamKey: string, name: string): TeamSnapshot {
  const players = [
    ...ROLES_XI.map((role, i) => player(teamKey, i, role)),
    ...ROLES_BENCH.map((role, i) => player(teamKey, 11 + i, role)),
  ];
  return { teamId: `team-${teamKey}`, name, formation: '442', players };
}

export function sampleManifest(overrides: Partial<MatchManifest> = {}): MatchManifest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    matchId: 'match-sample-001',
    seed: 12345,
    createdAt: '2026-07-12T12:00:00.000Z',
    rules: { ceremonies: true, autoGoalReplays: true },
    teams: [sampleTeam('rhinos', 'RED RHINOS'), sampleTeam('comets', 'SKY COMETS')],
    ...overrides,
  };
}
