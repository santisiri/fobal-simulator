// D1 — the chain reader. The RPC transport is faked, but the WIRE BYTES are
// real: responses are hand-encoded to the exact ABI layouts the contracts
// produce (playerView's dynamic struct, the teams() getter, RosterUpdated
// log data). What's under test: decoding, the lane→rating seam, ownership
// enforcement, latest-roster-wins, block pinning, and determinism.
import { describe, expect, test } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { createChainReader, ChainReadError } from '../src/index.js';
import { TeamSnapshot } from '@fobal/protocol';

const sel = (sig: string) =>
  Buffer.from(keccak_256(Buffer.from(sig, 'utf8'))).subarray(0, 4).toString('hex');
const SEL_OWNER = sel('ownerOfTeam(uint64)');
const SEL_TEAMS = sel('teams(uint64)');
const SEL_VIEW = sel('playerView(uint256)');

const W = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
const ADDR = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');
const STR = (s: string) => {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return W(s.length) + hex.padEnd(Math.ceil(Math.max(hex.length, 1) / 64) * 64, '0');
};

const ALICE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const MALLORY = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';

interface FakePlayer { owner: string; name: string; position: number; skills: bigint }

/** skills with named lanes set (lane order = PlayerCodec schema 1) */
const skills = (lanes: Partial<Record<number, number>>) => {
  let packed = 0n;
  for (const [lane, value] of Object.entries(lanes))
    packed |= BigInt(value!) << BigInt(Number(lane) * 8);
  return packed;
};

const flat55 = skills(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, 55])));

/** 11 demo-shaped players: GK first, then DF/MF/FW rotation, all owned by alice */
function squadOf(owner: string): Map<bigint, FakePlayer> {
  const players = new Map<bigint, FakePlayer>();
  for (let i = 0; i < 11; i++) {
    players.set(BigInt(i + 1), {
      owner,
      name: `Player ${i + 1}`,
      position: i === 0 ? 0 : 1 + (i % 3),
      skills: i === 0 ? skills({ 11: 85 }) : flat55,
    });
  }
  return players;
}

function encodePlayerView(p: FakePlayer): string {
  const head =
    W(1) + W(0) + W(1) + W(32) + W(p.position) + W(1) +      // PlayerCore
    W(0) + W(0) + W(0) + W(0) + W(0) + W(0) + W(0) +          // CareerStats
    W(0x1234n) + W(p.skills) + W(0) +                          // dna, skills, appearance
    W(19 * 32) +                                               // name offset (tuple-relative)
    ADDR(p.owner) + W(0);                                      // owner, lockedBy
  return `0x${W(0x20) + head + STR(p.name)}`;
}

interface FakeChain {
  teamOwner: string;
  teamName: string;
  rosters: bigint[][];                    // each entry = one RosterUpdated log
  players: Map<bigint, FakePlayer>;
  calls: Array<{ method: string; blockTag?: string }>;
}

function fakeFetch(chain: FakeChain): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    if (req.method === 'eth_blockNumber') {
      chain.calls.push({ method: req.method });
      return reply('0x10');
    }
    if (req.method === 'eth_getLogs') {
      chain.calls.push({ method: req.method, blockTag: (req.params[0] as { toBlock: string }).toBlock });
      return reply(chain.rosters.map(ids => ({
        data: `0x${W(0x20) + W(ids.length) + ids.map(W).join('')}`,
      })));
    }
    if (req.method === 'eth_call') {
      const { data } = req.params[0] as { data: string };
      chain.calls.push({ method: req.method, blockTag: req.params[1] as string });
      const selector = data.slice(2, 10);
      const arg = BigInt(`0x${data.slice(10)}`);
      if (selector === SEL_OWNER) return reply(`0x${ADDR(chain.teamOwner)}`);
      if (selector === SEL_TEAMS)
        return reply(`0x${ADDR(chain.teamOwner) + W(123) + W(0xabcn) + W(0x80) + STR(chain.teamName)}`);
      if (selector === SEL_VIEW) {
        const p = chain.players.get(arg);
        if (!p) return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { message: 'revert' } }));
        return reply(encodePlayerView(p));
      }
    }
    throw new Error(`unexpected rpc ${req.method}`);
  }) as typeof fetch;
}

const readerFor = (chain: FakeChain) => createChainReader({
  rpcUrl: 'http://fake', playerAddress: '0x' + '11'.repeat(20), registryAddress: '0x' + '22'.repeat(20),
  fetchImpl: fakeFetch(chain),
})!;

const baseChain = (): FakeChain => ({
  teamOwner: ALICE,
  teamName: 'ALICE NFT FC',
  rosters: [Array.from({ length: 11 }, (_, i) => BigInt(i + 1))],
  players: squadOf(ALICE),
  calls: [],
});

describe('chain reader (D1)', () => {
  test('reads a valid, protocol-parsed squad; every call pinned to one block', async () => {
    const chain = baseChain();
    const team = await readerFor(chain).readTeam(ALICE, 1);
    expect(() => TeamSnapshot.parse(team)).not.toThrow();
    expect(team.teamId).toBe('team-nft-1');
    expect(team.name).toBe('ALICE NFT FC');
    expect(team.players).toHaveLength(11);
    expect(team.players[0]).toMatchObject({ playerId: 'nft-1', role: 'GK', shirtNumber: 1 });
    expect(team.players[1]!.role).toBe('CM');          // position 2 → CM
    expect(team.players[3]!.role).toBe('CB');          // position 1 → CB
    // one eth_blockNumber, then every read pinned to that block
    const tagged = chain.calls.filter(c => c.blockTag !== undefined);
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every(c => c.blockTag === '0x10')).toBe(true);
  });

  test('the lane→rating seam maps exactly as documented', async () => {
    const chain = baseChain();
    // striker with distinct lanes: pace 90, finishing 80, passing 70,
    // dribbling 60, defending 50, physical 40, stamina 95, vision 85,
    // technique 75, aggression 65, composure 45, goalkeeping 5
    chain.players.set(11n, {
      owner: ALICE, name: 'Sharp Striker', position: 3,
      skills: skills({ 0: 90, 1: 80, 2: 70, 3: 60, 4: 50, 5: 40, 6: 95, 7: 85, 8: 75, 9: 65, 10: 45, 11: 5 }),
    });
    const team = await readerFor(chain).readTeam(ALICE, 1);
    const striker = team.players.find(p => p.playerId === 'nft-11')!;
    expect(striker.name).toBe('Sharp Striker');
    expect(striker.role).toBe('ST');
    expect(striker.ratings).toEqual({
      pace: 90, accel: 90,               // accel rides pace
      shooting: 80, passing: 70, dribbling: 60,
      tackling: 50, strength: 40, stamina: 95,
      vision: 85, positioning: 75,       // positioning rides technique
      aggression: 65, composure: 45, gk: 5,
    });
  });

  test('determinism: two reads produce deep-equal snapshots', async () => {
    const chain = baseChain();
    const reader = readerFor(chain);
    expect(await reader.readTeam(ALICE, 1)).toEqual(await reader.readTeam(ALICE, 1));
  });

  test('the LATEST RosterUpdated wins', async () => {
    const chain = baseChain();
    chain.players.set(99n, { owner: ALICE, name: 'Late Signing', position: 0, skills: skills({ 11: 90 }) });
    chain.rosters.push([99n, ...Array.from({ length: 10 }, (_, i) => BigInt(i + 2))]);
    const team = await readerFor(chain).readTeam(ALICE, 1);
    expect(team.players[0]!.playerId).toBe('nft-99');
    expect(team.players.some(p => p.playerId === 'nft-1')).toBe(false);
  });

  test('a team owned by someone else is a 403', async () => {
    const chain = baseChain();
    chain.teamOwner = MALLORY;
    await expect(readerFor(chain).readTeam(ALICE, 1))
      .rejects.toSatisfy((e: unknown) => e instanceof ChainReadError && e.status === 403);
  });

  test('a rostered player SOLD to someone else is a 403 naming the player', async () => {
    const chain = baseChain();
    chain.players.get(7n)!.owner = MALLORY;
    await expect(readerFor(chain).readTeam(ALICE, 1))
      .rejects.toThrow(/player 7 is rostered but owned by/);
  });

  test('an 11-void roster and a GK-less XI both fail with real messages', async () => {
    const short = baseChain();
    short.rosters = [[1n, 2n, 3n]];
    await expect(readerFor(short).readTeam(ALICE, 1)).rejects.toThrow(/needs 11 to 16/);

    const gkless = baseChain();
    for (const p of gkless.players.values()) p.position = 2;   // everyone a CM
    await expect(readerFor(gkless).readTeam(ALICE, 1))
      .rejects.toThrow(/not a valid match squad/);
  });

  test('readPlayer: one call → the full normalized profile (Feature 4)', async () => {
    const chain = baseChain();
    chain.players.set(7n, {
      owner: ALICE, name: 'Mateo Ferreyra', position: 3,
      skills: skills({ 0: 90, 1: 80, 6: 70, 11: 4 }),
    });
    const p = await readerFor(chain).readPlayer(7n);
    expect(p).toMatchObject({
      tokenId: '7', name: 'Mateo Ferreyra', owner: ALICE, lockedBy: null,
      position: 3, role: 'ST', generation: 1, level: 1, xp: 0,
    });
    expect(p.career).toEqual({ matchesPlayed: 0, wins: 0, draws: 0, losses: 0, goals: 0, assists: 0, cleanSheets: 0 });
    expect(p.ratings.pace).toBe(90);
    expect(p.ratings.shooting).toBe(80);
    expect(p.overall).toBe(Math.round((90 + 80 + 70 + 4) / 12));
    await expect(readerFor(chain).readPlayer(999n))
      .rejects.toSatisfy((e: unknown) => e instanceof ChainReadError && e.status === 404);
  });

  test('GET /players/:tokenId serves the profile publicly; 501 dark, 404 unknown', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { startMatchServer } = await import('@fobal/match-server');
    const { startLobbyServer } = await import('../src/index.js');
    const chain = baseChain();
    chain.players.set(7n, { owner: ALICE, name: 'Luca Moretti', position: 2, skills: flat55 });
    const match = await startMatchServer({ port: 0, storeRoot: mkdtempSync(join(tmpdir(), 'pn-')), createKey: 'ck', autoDrive: false });
    const lobby = await startLobbyServer({
      port: 0, matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'ck' },
      chainReader: readerFor(chain),
    });
    const dark = await startLobbyServer({
      port: 0, matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'ck' },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${lobby.port}/players/7`);
      expect(res.status).toBe(200);
      const { player } = await res.json() as { player: { name: string; role: string; overall: number } };
      expect(player).toMatchObject({ name: 'Luca Moretti', role: 'CM', overall: 55 });
      expect((await fetch(`http://127.0.0.1:${lobby.port}/players/999`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${dark.port}/players/7`)).status).toBe(501);
    } finally { await lobby.close(); await dark.close(); await match.close(); }
  });

  test('unconfigured → null (the 501 path); a dead rpc → ChainReadError 502', async () => {
    expect(createChainReader({})).toBeNull();
    const reader = createChainReader({
      rpcUrl: 'http://fake', playerAddress: '0xaa', registryAddress: '0xbb',
      fetchImpl: (async () => new Response('boom', { status: 500 })) as typeof fetch,
    })!;
    await expect(reader.readTeam(ALICE, 1))
      .rejects.toSatisfy((e: unknown) => e instanceof ChainReadError && e.status === 502);
  });
});
