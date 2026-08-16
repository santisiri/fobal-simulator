// M5 mint service — the hand-rolled ABI/EIP-712 plumbing is verified
// byte-for-byte against viem (a DEV-ONLY oracle; the runtime stays on the
// house-style minimal encoder). A wrong encoding here would produce a
// playersHash mismatch on-chain and a revert AFTER the user paid gas — the
// oracle tests are the wall between us and that.
import { describe, expect, test } from 'vitest';
import {
  encodeAbiParameters, encodeFunctionData, hashTypedData, recoverAddress,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createMintService, encodeCreateTeam, encodeDeclareRoster, encodeMintSquad,
  encodeSeedsStandalone, MintError, signSquadMint, validateSeeds,
} from '../src/mint.js';
import type { PlayerSeedInput } from '../src/mint.js';

const ABI = parseAbi([
  'function createTeam(string name, bytes32 teamDna) returns (uint64)',
  'function declareRoster(uint64 teamId, uint256[] playerIds)',
  'struct PlayerSeed { string name; bytes32 dna; uint256 skills; uint256 appearance; uint32 generation; uint16 country; uint8 position; }',
  'function mintSquad(address recipient, uint64 teamId, uint32 generation, uint256 deadline, PlayerSeed[] seeds, bytes signature) returns (uint256[])',
]);

const SEED_COMPONENTS = [
  { name: 'name', type: 'string' },
  { name: 'dna', type: 'bytes32' },
  { name: 'skills', type: 'uint256' },
  { name: 'appearance', type: 'uint256' },
  { name: 'generation', type: 'uint32' },
  { name: 'country', type: 'uint16' },
  { name: 'position', type: 'uint8' },
] as const;

const packSkills = (values: number[]): string => {
  let packed = 0n;
  values.forEach((v, lane) => { packed |= BigInt(v) << BigInt(lane * 8); });
  return packed.toString();
};

const seed = (i: number, over: Partial<PlayerSeedInput> = {}): PlayerSeedInput => ({
  name: `Player ${i + 1}`,
  dna: `0x${(i + 1).toString(16).padStart(64, '0')}`,
  skills: packSkills(Array(12).fill(55)),
  appearance: String(0xabcdef + i),
  generation: 1,
  country: 32,
  position: i === 0 ? 0 : 1 + (i % 3),
  ...over,
});
const squad = (): PlayerSeedInput[] => Array.from({ length: 11 }, (_, i) => seed(i));

const asViem = (s: PlayerSeedInput) => ({
  name: s.name, dna: s.dna as `0x${string}`, skills: BigInt(s.skills),
  appearance: BigInt(s.appearance), generation: s.generation,
  country: s.country, position: s.position,
});

describe('mint encodings vs the viem oracle', () => {
  test('createTeam calldata matches', () => {
    const mine = encodeCreateTeam('GOLDEN PUPPETS', `0x${'ab'.repeat(32)}`);
    const oracle = encodeFunctionData({
      abi: ABI, functionName: 'createTeam',
      args: ['GOLDEN PUPPETS', `0x${'ab'.repeat(32)}`],
    });
    expect(mine).toBe(oracle);
  });

  test('abi.encode(seeds) — the playersHash preimage — matches', () => {
    const seeds = squad();
    const oracle = encodeAbiParameters(
      [{ type: 'tuple[]', components: SEED_COMPONENTS }], [seeds.map(asViem)]);
    expect(encodeSeedsStandalone(seeds)).toBe(oracle);
  });

  test('mintSquad calldata matches, odd-length names and all', () => {
    const seeds = squad();
    seeds[3] = seed(3, { name: 'Zlatan Ibrahimović' });   // multi-byte utf8
    const sig = `0x${'11'.repeat(65)}`;
    const mine = encodeMintSquad('0x' + 'a1'.repeat(20), 7n, 1, 1786500000n, seeds, sig);
    const oracle = encodeFunctionData({
      abi: ABI, functionName: 'mintSquad',
      args: [`0x${'a1'.repeat(20)}`, 7n, 1, 1786500000n, seeds.map(asViem), sig as `0x${string}`],
    });
    expect(mine).toBe(oracle);
  });

  test('declareRoster calldata matches', () => {
    const ids = [101n, 102n, 103n, 104n, 105n, 106n, 107n, 108n, 109n, 110n, 111n];
    const oracle = encodeFunctionData({ abi: ABI, functionName: 'declareRoster', args: [7n, ids] });
    expect(encodeDeclareRoster(7n, ids)).toBe(oracle);
  });

  test('the SquadMint permit recovers to the signer via viem typed-data hashing', async () => {
    const pk = `0x${'42'.repeat(32)}` as const;
    const signer = privateKeyToAccount(pk);
    const seeds = squad();
    const params = {
      signerPk: pk, chainId: 84532,
      generatorAddress: '0x' + 'b2'.repeat(20),
      recipient: '0x' + 'a1'.repeat(20),
      teamId: 7n, generation: 1, nonce: 0n, deadline: 1786500000n, seeds,
    };
    const signature = signSquadMint(params);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);

    const playersHash = `0x${Buffer.from(
      (await import('@noble/hashes/sha3')).keccak_256(
        Buffer.from(encodeSeedsStandalone(seeds).slice(2), 'hex'))).toString('hex')}`;
    const digest = hashTypedData({
      domain: {
        name: 'FobalPlayerGenerator', version: '1',
        chainId: 84532, verifyingContract: params.generatorAddress as `0x${string}`,
      },
      types: { SquadMint: [
        { name: 'recipient', type: 'address' }, { name: 'teamId', type: 'uint64' },
        { name: 'generation', type: 'uint32' }, { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }, { name: 'playersHash', type: 'bytes32' },
      ] },
      primaryType: 'SquadMint',
      message: {
        recipient: params.recipient as `0x${string}`, teamId: 7n, generation: 1,
        nonce: 0n, deadline: 1786500000n, playersHash: playersHash as `0x${string}`,
      },
    });
    const recovered = await recoverAddress({ hash: digest, signature: signature as `0x${string}` });
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });
});

describe('seed validation — the fairness gate', () => {
  const fails = (seeds: PlayerSeedInput[], match: RegExp) => {
    try { validateSeeds(seeds, 720); throw new Error('should have thrown'); }
    catch (err){
      expect(err).toBeInstanceOf(MintError);
      expect((err as MintError).message).toMatch(match);
    }
  };

  test('a legal squad passes; the gates each hold', () => {
    validateSeeds(squad(), 720);
    fails(squad().slice(0, 10), /exactly 11/);
    fails(squad().map((s, i) => i === 0 ? { ...s, position: 1 } : s), /goalkeeper/);
    fails(squad().map((s, i) => i === 4 ? { ...s, skills: packSkills(Array(12).fill(100)) } : s), /power 1200 exceeds/);
    fails(squad().map((s, i) => i === 4 ? { ...s, skills: (1n << 200n).toString() } : s), /above lane 12/);
    fails(squad().map((s, i) => i === 2 ? { ...s, name: 'h1tl3r' } : s), /not allowed/);
    fails(squad().map((s, i) => i === 2 ? { ...s, dna: '0xshort' } : s), /dna/);
  });
});

describe('the step machine', () => {
  const WALLET = '0x' + 'a1'.repeat(20);
  const SEL_OWNER_OF_TEAM = 'a2c72bb3';   // pinned below against viem

  // eth_call-only fake chain: routes by selector (nonces vs ownerOfTeam)
  const boot = (chainState: { teamOwner?: string; nonce?: bigint } = {}) => {
    const calls: Array<{ to: string; data: string }> = [];
    const fetchImpl = (async (_url: unknown, init: { body?: string }) => {
      const req = JSON.parse(init.body!) as { method: string; params: [{ to: string; data: string }, string] };
      expect(req.method).toBe('eth_call');   // NO eth_getLogs — public RPCs cap ranges
      calls.push(req.params[0]);
      const sel = req.params[0].data.slice(2, 10);
      const result = sel === SEL_OWNER_OF_TEAM
        ? `0x${'0'.repeat(24)}${(chainState.teamOwner ?? 'a1'.repeat(20))}`
        : `0x${(chainState.nonce ?? 0n).toString(16).padStart(64, '0')}`;
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    }) as unknown as typeof fetch;
    const service = createMintService({
      rpcUrl: 'http://fake-rpc.test', chainId: 84532,
      generatorAddress: '0x' + 'b2'.repeat(20),
      registryAddress: '0xregistry',
      playerAddress: '0xplayer',
      signerPk: `0x${'42'.repeat(32)}`,
      fetchImpl,
    });
    return { service, calls };
  };
  const IDS = Array.from({ length: 11 }, (_, i) => String(100 + i));

  test('the ownerOfTeam selector matches the oracle', () => {
    expect(encodeFunctionData({
      abi: parseAbi(['function ownerOfTeam(uint64 teamId) view returns (address)']),
      functionName: 'ownerOfTeam', args: [7n],
    }).slice(2, 10)).toBe(SEL_OWNER_OF_TEAM);
  });

  test('no progress → create-team (zero chain reads, parse metadata attached)', async () => {
    const { service, calls } = boot();
    const plan = await service.prepare(WALLET, 'GOLDEN PUPPETS', squad());
    expect(plan).toMatchObject({ done: false, tx: {
      step: 'create-team', to: '0xregistry',
      parse: { idTopic: 1, many: false },
    } });
    expect(calls).toHaveLength(0);
  });

  test('teamId → verify owner, then mint-squad with a fresh permit', async () => {
    const { service, calls } = boot();
    const plan = await service.prepare(WALLET, 'GOLDEN PUPPETS', squad(), { teamId: '7' });
    expect(plan).toMatchObject({ done: false, tx: {
      step: 'mint-squad',
      parse: { idTopic: 3, many: true, requireTopic1: `0x${'0'.repeat(64)}` },
    } });
    // the mint tx carries a permit that verifies (oracle-checked above) and
    // 11 seeds — spot-check the calldata length is substantial
    expect((plan as { tx: { data: string } }).tx.data.length).toBeGreaterThan(2000);
    // reads: ownerOfTeam + nonces, nothing else
    expect(calls.map(c => c.data.slice(2, 10))).toEqual([SEL_OWNER_OF_TEAM, expect.any(String)]);
  });

  test('a teamId the wallet does not own is a 403 BEFORE any gas is spent', async () => {
    const { service } = boot({ teamOwner: 'ee'.repeat(20) });
    await expect(service.prepare(WALLET, 'GOLDEN PUPPETS', squad(), { teamId: 7 }))
      .rejects.toSatisfy((e: unknown) => e instanceof MintError && e.status === 403);
  });

  test('a teamId that never existed (ownerOfTeam reverts) is a 403, not a 502', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }),
    })) as unknown as typeof fetch;
    const service = createMintService({
      rpcUrl: 'http://fake-rpc.test', chainId: 84532,
      generatorAddress: '0x' + 'b2'.repeat(20), registryAddress: '0xregistry',
      playerAddress: '0xplayer', signerPk: `0x${'42'.repeat(32)}`, fetchImpl,
    });
    await expect(service.prepare(WALLET, 'GOLDEN PUPPETS', squad(), { teamId: 999 }))
      .rejects.toSatisfy((e: unknown) =>
        e instanceof MintError && e.status === 403 && /does not exist/.test(e.message));
  });

  test('teamId + tokenIds → declare-roster; + declared → done', async () => {
    const minted = await boot().service.prepare(WALLET, 'GOLDEN PUPPETS', squad(), { teamId: 7, tokenIds: IDS });
    expect(minted).toMatchObject({ done: false, tx: { step: 'declare-roster', to: '0xregistry' } });
    expect(encodeDeclareRoster(7n, IDS.map(BigInt))).toBe((minted as { tx: { data: string } }).tx.data);

    const all = await boot().service.prepare(WALLET, 'GOLDEN PUPPETS', squad(), { teamId: 7, tokenIds: IDS, declared: true });
    expect(all).toEqual({ done: true, teamId: 7 });
  });

  test('a roster that is not exactly 11 token ids is a 400', async () => {
    await expect(boot().service.prepare(WALLET, 'GOLDEN PUPPETS', squad(), { teamId: 7, tokenIds: IDS.slice(0, 3) }))
      .rejects.toSatisfy((e: unknown) => e instanceof MintError && e.status === 400);
  });

  test('bad squads are rejected before any chain read', async () => {
    const { service, calls } = boot();
    await expect(service.prepare(WALLET, 'X', squad())).rejects.toThrow(/team name/);
    await expect(service.prepare(WALLET, 'OK NAME', squad().slice(0, 5))).rejects.toThrow(/exactly 11/);
    expect(calls).toHaveLength(0);
  });
});
