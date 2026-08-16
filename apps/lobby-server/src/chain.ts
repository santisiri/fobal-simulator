// D1 — the team registry adapter: chain read → PlayerSnapshot → validated
// TeamSnapshot. Chain access lives HERE, in the lobby layer, and nowhere
// else — the match server continues to see nothing but manifests.
//
// The client is a hand-rolled JSON-RPC caller over fetch: the read surface
// is three fixed view calls plus one log query, and every response layout is
// pinned by the contracts in contracts/src (FobalTeamRegistry, FobalPlayer).
// All reads are pinned to ONE block number so a squad is a snapshot of a
// single chain state — the determinism proof ("same wallet, second device,
// identical manifest") depends on it only to the extent the chain moved
// between reads.
//
// Roster semantics mirror the contracts' philosophy: FobalTeamRegistry only
// EMITS rosters (RosterUpdated, latest wins) and never custodies players;
// live ERC-721 ownership is the control check. The adapter enforces both:
// the team must be owned by the wallet, and every rostered player must be
// live-owned by the wallet at the pinned block. A player locked in escrow
// is still readable (lockedBy is informational here — lobby matches don't
// custody anything).
import { keccak_256 } from '@noble/hashes/sha3';
import { TeamSnapshot } from '@fobal/protocol';
import type { PlayerSnapshot } from '@fobal/protocol';

export interface ChainReaderOptions {
  /** JSON-RPC endpoint (anvil, Base Sepolia, …) */
  rpcUrl?: string;
  /** FobalPlayer ERC-721 address */
  playerAddress?: string;
  /** FobalTeamRegistry address */
  registryAddress?: string;
  fetchImpl?: typeof fetch;
}

export interface ChainReader {
  /** Read wallet's team at one pinned block → protocol-validated snapshot. */
  readTeam(wallet: string, teamId: number): Promise<TeamSnapshot>;
  /** One player, one eth_call — the frontend's getPlayer(tokenId). */
  readPlayer(tokenId: bigint): Promise<NormalizedPlayer>;
}

/** The canonical read shape for a player NFT (docs/PLAYER_DATA_MODEL.md).
 *  Everything here decodes from ONE playerView call — no multicall needed.
 *  `ratings` speaks the game's 13-rating language via the D1 lane seam;
 *  `overall` is the presentation aggregate (mean of the 12 on-chain lanes,
 *  the same quantity the generator's power budget bounds). */
export interface NormalizedPlayer {
  tokenId: string;
  name: string;
  owner: string;
  lockedBy: string | null;
  position: number;
  role: string;
  generation: number;
  level: number;
  xp: number;
  career: {
    matchesPlayed: number; wins: number; draws: number; losses: number;
    goals: number; assists: number; cleanSheets: number;
  };
  ratings: PlayerSnapshot['ratings'];
  overall: number;
}

/** Thrown for every "the chain says no" case — carries an http-ish status
 *  so the hub can answer 403/404/422 with the real reason. */
export class ChainReadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// minimal ABI plumbing (fixed shapes only — see layout notes at each decoder)
// ---------------------------------------------------------------------------

const selector = (signature: string): string =>
  Buffer.from(keccak_256(Buffer.from(signature, 'utf8'))).subarray(0, 4).toString('hex');

const SEL_OWNER_OF_TEAM = selector('ownerOfTeam(uint64)');
const SEL_TEAMS = selector('teams(uint64)');
const SEL_PLAYER_VIEW = selector('playerView(uint256)');
const TOPIC_ROSTER_UPDATED =
  `0x${Buffer.from(keccak_256(Buffer.from('RosterUpdated(uint64,address,uint256[])', 'utf8'))).toString('hex')}`;

const pad32 = (value: bigint | number): string => value.toString(16).padStart(64, '0');

/** word i of ABI return data (0x-stripped hex in, hex out) */
const word = (data: string, i: number): string => data.slice(i * 64, (i + 1) * 64);
const wordNum = (data: string, i: number): number => Number(BigInt(`0x${word(data, i) || '0'}`));
const wordAddress = (data: string, i: number): string => `0x${word(data, i).slice(24)}`.toLowerCase();

/** decode a dynamic string given the byte offset of its length word */
function stringAt(data: string, byteOffset: number): string {
  const lenWord = data.slice(byteOffset * 2, byteOffset * 2 + 64);
  const len = Number(BigInt(`0x${lenWord || '0'}`));
  const body = data.slice(byteOffset * 2 + 64, byteOffset * 2 + 64 + len * 2);
  return Buffer.from(body, 'hex').toString('utf8');
}

// ---------------------------------------------------------------------------
// chain data → game data (THE D1 seam — documented, deterministic, one place)
// ---------------------------------------------------------------------------

/** PlayerCodec schema-1 lanes, in lane order. */
const LANES = ['pace', 'finishing', 'passing', 'dribbling', 'defending', 'physical',
  'stamina', 'vision', 'technique', 'aggression', 'composure', 'goalkeeping'] as const;

const laneValues = (skills: bigint): Record<(typeof LANES)[number], number> => {
  const out = {} as Record<(typeof LANES)[number], number>;
  LANES.forEach((lane, i) => {
    out[lane] = Math.min(100, Number((skills >> BigInt(i * 8)) & 0xffn));
  });
  return out;
};

/** On-chain position codes (FobalTypes.PlayerCore.position). The engine's
 *  richer role set (LB/RM/LW/…) is a lineup concern, not an identity one —
 *  the chain stores the archetype, the manifest gets the archetype. */
const ROLE_BY_POSITION = ['GK', 'CB', 'CM', 'ST'] as const;

export interface ChainPlayer {
  tokenId: bigint;
  name: string;
  owner: string;
  position: number;
  skills: bigint;
  level: number;
  matchesPlayed: number;
  goals: number;
}

/** chain skill lanes → the protocol's 13 external ratings (0-100).
 *  Mapping is 1:1 where names align; accel rides pace and positioning rides
 *  technique — the two attributes the chain schema does not distinguish. */
export function ratingsFromSkills(skills: bigint): PlayerSnapshot['ratings'] {
  const lane = laneValues(skills);
  return {
    pace: lane.pace, accel: lane.pace,
    stamina: lane.stamina, strength: lane.physical,
    passing: lane.passing, shooting: lane.finishing,
    tackling: lane.defending, dribbling: lane.dribbling,
    vision: lane.vision, positioning: lane.technique,
    aggression: lane.aggression, composure: lane.composure,
    gk: lane.goalkeeping,
  };
}

export function playerSnapshotFrom(player: ChainPlayer, shirtNumber: number): PlayerSnapshot {
  return {
    playerId: `nft-${player.tokenId}`,
    name: (player.name || `PLAYER ${player.tokenId}`).slice(0, 48),
    shirtNumber,
    role: ROLE_BY_POSITION[player.position] ?? 'CM',
    ratings: ratingsFromSkills(player.skills),
  };
}

// ---------------------------------------------------------------------------
// the reader
// ---------------------------------------------------------------------------

export function createChainReader(options: ChainReaderOptions = {}): ChainReader | null {
  const { rpcUrl, playerAddress, registryAddress } = options;
  if (!rpcUrl || !playerAddress || !registryAddress) return null;
  const fetchImpl = options.fetchImpl ?? fetch;

  let nextId = 1;
  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetchImpl(rpcUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new ChainReadError(502, `rpc ${method} answered http ${res.status}`);
    const body = await res.json() as { result?: T; error?: { message?: string } };
    if (body.error || body.result === undefined)
      throw new ChainReadError(502, `rpc ${method} failed: ${body.error?.message ?? 'no result'}`);
    return body.result;
  }

  const call = async (to: string, data: string, blockTag: string): Promise<string> => {
    const out = await rpc<string>('eth_call', [{ to, data: `0x${data}` }, blockTag]);
    return out.replace(/^0x/, '');
  };

  /** playerView tuple decode — see the layout notes in readTeam */
  const decodePlayerView = (data: string) => {
    const t = data.slice(64);
    return {
      name: stringAt(t, wordNum(t, 16)),
      owner: wordAddress(t, 17),
      lockedBy: wordAddress(t, 18),
      generation: wordNum(t, 0),
      xp: wordNum(t, 1),
      level: wordNum(t, 2),
      position: wordNum(t, 4),
      skills: BigInt(`0x${word(t, 14) || '0'}`),
      career: {
        matchesPlayed: wordNum(t, 6), wins: wordNum(t, 7), draws: wordNum(t, 8),
        losses: wordNum(t, 9), goals: wordNum(t, 10), assists: wordNum(t, 11),
        cleanSheets: wordNum(t, 12),
      },
    };
  };

  return {
    async readPlayer(tokenId: bigint): Promise<NormalizedPlayer> {
      const blockTag = await rpc<string>('eth_blockNumber', []);
      const data = await call(playerAddress!, SEL_PLAYER_VIEW + pad32(tokenId), blockTag)
        .catch(() => { throw new ChainReadError(404, `player ${tokenId} does not exist`); });
      const v = decodePlayerView(data);
      let total = 0;
      for (let lane = 0; lane < 12; lane++) total += Number((v.skills >> BigInt(lane * 8)) & 0xffn);
      return {
        tokenId: tokenId.toString(),
        name: v.name,
        owner: v.owner,
        lockedBy: /^0x0+$/.test(v.lockedBy) ? null : v.lockedBy,
        position: v.position,
        role: ROLE_BY_POSITION[v.position] ?? 'CM',
        generation: v.generation,
        level: v.level,
        xp: v.xp,
        career: v.career,
        ratings: ratingsFromSkills(v.skills),
        overall: Math.round(total / 12),
      };
    },

    async readTeam(wallet: string, teamId: number): Promise<TeamSnapshot> {
      const me = wallet.toLowerCase();
      // pin every read to one block — the squad is a snapshot, not a smear
      const blockTag = await rpc<string>('eth_blockNumber', []);

      const ownerData = await call(registryAddress!, SEL_OWNER_OF_TEAM + pad32(teamId), blockTag)
        .catch(() => { throw new ChainReadError(404, `team ${teamId} does not exist on the registry`); });
      if (wordAddress(ownerData, 0) !== me)
        throw new ChainReadError(403, `team ${teamId} is not owned by ${me}`);

      // teams(uint64) → (address owner, uint40 createdAt, bytes32 teamDna,
      // string name): head = 4 words, name tail at the offset in word 3
      const teamData = await call(registryAddress!, SEL_TEAMS + pad32(teamId), blockTag);
      const name = stringAt(teamData, wordNum(teamData, 3)).slice(0, 32) || `NFT TEAM ${teamId}`;

      // roster = the LATEST RosterUpdated for this teamId (events are the
      // registry's storage — see the contract's header comment)
      const logs = await rpc<Array<{ data: string }>>('eth_getLogs', [{
        address: registryAddress,
        topics: [TOPIC_ROSTER_UPDATED, `0x${pad32(teamId)}`],
        fromBlock: '0x0',
        toBlock: blockTag,
      }]);
      if (logs.length === 0)
        throw new ChainReadError(422, `team ${teamId} has never declared a roster`);
      // data = (uint256[] playerIds): offset word, length word, items
      const rosterData = logs[logs.length - 1]!.data.replace(/^0x/, '');
      const count = wordNum(rosterData, 1);
      const tokenIds = Array.from({ length: count },
        (_, i) => BigInt(`0x${word(rosterData, 2 + i) || '0'}`));
      if (tokenIds.length < 11 || tokenIds.length > 16)
        throw new ChainReadError(422,
          `roster has ${tokenIds.length} players — a match squad needs 11 to 16`);

      const players: PlayerSnapshot[] = [];
      for (const [i, tokenId] of tokenIds.entries()) {
        // playerView(uint256) → one dynamic struct: word 0 is the tuple
        // offset (0x20); tuple head = PlayerCore 6 words, CareerStats 7,
        // dna, skills, appearance, name-offset, owner, lockedBy
        const data = await call(playerAddress!, SEL_PLAYER_VIEW + pad32(tokenId), blockTag)
          .catch(() => { throw new ChainReadError(422, `player ${tokenId} does not exist`); });
        const v = decodePlayerView(data);
        if (v.owner !== me)
          throw new ChainReadError(403,
            `player ${tokenId} is rostered but owned by ${v.owner} — declare a roster you own`);
        players.push(playerSnapshotFrom({
          tokenId,
          name: v.name,
          owner: v.owner,
          position: v.position,
          skills: v.skills,
          level: v.level,
          matchesPlayed: v.career.matchesPlayed,
          goals: v.career.goals,
        }, i + 1));
      }

      // the protocol schema is the gate, exactly like POST /squad: shirt
      // numbers, duplicate ids, GK-in-the-XI all fail here with a real
      // message instead of a 400 from the match server later
      try {
        return TeamSnapshot.parse({
          teamId: `team-nft-${teamId}`,
          name,
          formation: '442',
          players,
        });
      } catch (err) {
        throw new ChainReadError(422,
          `on-chain roster is not a valid match squad: ${(err as Error).message.split('\n')[0]}`);
      }
    },
  };
}
