// v0 squad generation: every account owns a deterministic, plausible squad
// derived from its handle — the placeholder behind the roadmap's "player team
// storage". Real team building (and eventually Phase D NFT-fed teams)
// replaces this generator; the MatchManifest contract stays.
import { MatchManifest, PROTOCOL_VERSION } from '@fobal/protocol';
import type { PlayerSnapshot, TeamSnapshot } from '@fobal/protocol';
import type { Account } from './store.js';

const ROLES_XI = ['GK', 'CB', 'CB', 'LB', 'RB', 'CM', 'CM', 'LM', 'RM', 'ST', 'ST'] as const;
const ROLES_BENCH = ['GK', 'CB', 'CM', 'LW', 'ST'] as const;

const hashOf = (s: string): number =>
  [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function player(account: Account, i: number, role: PlayerSnapshot['role']): PlayerSnapshot {
  // same plausible-and-asymmetric spread as the protocol sample fixtures,
  // seeded per-account so no two squads are identical
  const base = 55 + ((i * 7 + (hashOf(account.teamKey) % 97)) % 30);
  const r = (offset: number) => Math.max(30, Math.min(95, base + offset));
  return {
    playerId: `${account.teamKey}-p${String(i + 1).padStart(2, '0')}`,
    name: `${account.handle.toUpperCase()} ${role} ${i + 1}`.slice(0, 48),
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

export function buildTeam(account: Account, { customized = true } = {}): TeamSnapshot {
  const players = [
    ...ROLES_XI.map((role, i) => player(account, i, role)),
    ...ROLES_BENCH.map((role, i) => player(account, 11 + i, role)),
  ];
  const squad = customized ? account.squad : undefined;
  if (squad?.playerNames)
    for (const p of players){
      const custom = squad.playerNames[p.playerId];
      if (custom) p.name = custom;
    }
  return {
    teamId: `team-${account.teamKey}`,
    name: account.teamName,
    ...(squad?.colors && (squad.colors.primary || squad.colors.secondary)
      ? { colors: squad.colors } : {}),
    formation: '442',
    players,
  };
}

/** Frozen match input from two accounts. Parsed here so a bad build fails in
 *  the lobby with a real message instead of a 400 from the match server. */
export function buildManifest(matchId: string, seed: number, home: Account, away: Account): MatchManifest {
  return MatchManifest.parse({
    protocolVersion: PROTOCOL_VERSION,
    matchId,
    seed,
    createdAt: new Date().toISOString(),
    rules: { ceremonies: true, autoGoalReplays: true },
    teams: [buildTeam(home), buildTeam(away)],
  });
}
