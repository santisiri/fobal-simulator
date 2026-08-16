// M5 — the mint SERVICE the runbook's forge script was standing in for.
//
// The generator contract's only mint path is an EIP-712 SquadMint permit
// signed by the generator signer. That key now lives server-side (Secrets
// Manager → env), and THIS module turns a wallet-authed player's previewed
// squad into prepared transactions their own wallet submits and pays for:
//
//   createTeam → mintSquad (permit signed here) → declareRoster
//
// /mint/prepare is a STEP MACHINE driven by client-reported progress: the
// browser holds every transaction receipt, so it extracts the ids the next
// step needs (teamId from TeamCreated, tokenIds from the mint Transfers —
// each PreparedTx carries the topic metadata to match on) and posts them
// back. The server verifies the ONE claim that matters (ownerOfTeam ==
// wallet, an eth_call) and never scans logs: public RPCs reject unbounded
// eth_getLogs ranges, and nothing here needs them — declareRoster is
// informational by contract design, and /squad/chain re-validates full
// ownership at adoption. Lost progress (cleared storage) just means
// creating a fresh team; NFTs are never lost — they live in the wallet.
// The browser needs no web3 library at all: eth_sendTransaction with
// prepared calldata is the whole client contract.
//
// House style matches chain.ts: hand-rolled minimal ABI over fetch —
// verified in tests against viem as a dev-only oracle. The signer holds
// ZERO on-chain roles (bounded blast radius by contract design): a leaked
// key can fake plausible squads within the power budget, never steal.
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { nameAllowed } from './names.js';

export interface PlayerSeedInput {
  name: string;
  /** 0x-hex 32 bytes */
  dna: string;
  /** decimal or 0x-hex uint256 — 12×8bit packed skills */
  skills: string;
  /** decimal or 0x-hex uint256 — packed appearance */
  appearance: string;
  generation: number;
  country: number;
  /** 0 GK · 1 DF · 2 MF · 3 FW */
  position: number;
}

export interface MintServiceOptions {
  rpcUrl: string;
  generatorAddress: string;
  registryAddress: string;
  playerAddress: string;
  chainId: number;
  /** generator signer private key, 0x-hex (Secrets Manager → env) */
  signerPk: string;
  /** per-player skill-sum ceiling mirrored from the contract (default 720) */
  perPlayerPowerBudget?: number;
  fetchImpl?: typeof fetch;
}

export interface PreparedTx {
  step: 'create-team' | 'mint-squad' | 'declare-roster';
  description: string;
  to: string;
  data: string;
  /** how the client reads the id(s) out of the receipt: collect
   *  topics[idTopic] of every log matching topic0 (and topics[1] when
   *  requireTopic1 is set — filters the mint Transfers to from-zero) */
  parse?: { topic0: string; idTopic: number; many: boolean; requireTopic1?: string };
}

/** client-reported receipt facts; the server verifies team ownership */
export interface MintProgress {
  teamId?: string | number;
  tokenIds?: Array<string | number>;
  declared?: boolean;
}

export type MintPlan =
  | { done: false; tx: PreparedTx }
  | { done: true; teamId: number };

export class MintError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// minimal ABI plumbing (same discipline as chain.ts)
// ---------------------------------------------------------------------------

const keccak = (data: Uint8Array): Uint8Array => keccak_256(data);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const selector = (signature: string): string =>
  hex(keccak(Buffer.from(signature, 'utf8'))).slice(0, 8);

const SEL_CREATE_TEAM = selector('createTeam(string,bytes32)');
const SEL_MINT_SQUAD =
  selector('mintSquad(address,uint64,uint32,uint256,(string,bytes32,uint256,uint256,uint32,uint16,uint8)[],bytes)');
const SEL_DECLARE_ROSTER = selector('declareRoster(uint64,uint256[])');
const SEL_NONCES = selector('nonces(address)');
const TOPIC_TEAM_CREATED =
  `0x${hex(keccak(Buffer.from('TeamCreated(uint64,address,string,bytes32)', 'utf8')))}`;
const TOPIC_TRANSFER =
  `0x${hex(keccak(Buffer.from('Transfer(address,address,uint256)', 'utf8')))}`;

const pad32 = (value: bigint): string => value.toString(16).padStart(64, '0');
const padAddress = (address: string): string => address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const strip0x = (s: string): string => s.replace(/^0x/, '');

function toBig(value: string | number, label: string): bigint {
  try {
    const v = BigInt(value);
    if (v < 0n) throw new Error('negative');
    return v;
  } catch {
    throw new MintError(400, `${label} must be a non-negative integer`);
  }
}

/** utf8 string → padded ABI tail block (length + data, 32-byte aligned) */
function encodeStringTail(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  const padded = Math.ceil(bytes.length / 32) * 32;
  return pad32(BigInt(bytes.length)) + bytes.toString('hex').padEnd(padded * 2, '0');
}

/** one PlayerSeed struct (dynamic: string head/tail inside) */
function encodeSeed(seed: PlayerSeedInput): string {
  // heads: name offset (7 static-slot head → 0xe0), then the six values
  const head =
    pad32(0xe0n) +
    strip0x(seed.dna).padStart(64, '0') +
    pad32(toBig(seed.skills, 'skills')) +
    pad32(toBig(seed.appearance, 'appearance')) +
    pad32(BigInt(seed.generation)) +
    pad32(BigInt(seed.country)) +
    pad32(BigInt(seed.position));
  return head + encodeStringTail(seed.name);
}

/** PlayerSeed[] array block: length + per-element offsets + elements */
function encodeSeedArray(seeds: PlayerSeedInput[]): string {
  const encoded = seeds.map(encodeSeed);
  let offset = seeds.length * 32;             // offsets are relative to array data start
  const offsets: string[] = [];
  for (const e of encoded) {
    offsets.push(pad32(BigInt(offset)));
    offset += e.length / 2;
  }
  return pad32(BigInt(seeds.length)) + offsets.join('') + encoded.join('');
}

/** solidity abi.encode(seeds) — single dynamic param: offset + array block */
export function encodeSeedsStandalone(seeds: PlayerSeedInput[]): string {
  return '0x' + pad32(0x20n) + encodeSeedArray(seeds);
}

export function encodeCreateTeam(name: string, teamDna: string): string {
  // heads: string offset (2 slots → 0x40), dna; tail: string
  return '0x' + SEL_CREATE_TEAM + pad32(0x40n) + strip0x(teamDna).padStart(64, '0') + encodeStringTail(name);
}

export function encodeMintSquad(
  recipient: string, teamId: bigint, generation: number, deadline: bigint,
  seeds: PlayerSeedInput[], signature: string,
): string {
  const seedBlock = encodeSeedArray(seeds);
  const sigTail = encodeStringLikeBytes(signature);
  // 6 head slots: recipient, teamId, generation, deadline, seedsOffset, sigOffset
  const seedsOffset = 6n * 32n;
  const sigOffset = seedsOffset + BigInt(seedBlock.length / 2);
  return '0x' + SEL_MINT_SQUAD +
    padAddress(recipient) +
    pad32(teamId) +
    pad32(BigInt(generation)) +
    pad32(deadline) +
    pad32(seedsOffset) +
    pad32(sigOffset) +
    seedBlock +
    sigTail;
}

function encodeStringLikeBytes(hexData: string): string {
  const bytes = Buffer.from(strip0x(hexData), 'hex');
  const padded = Math.ceil(bytes.length / 32) * 32;
  return pad32(BigInt(bytes.length)) + bytes.toString('hex').padEnd(padded * 2, '0');
}

export function encodeDeclareRoster(teamId: bigint, playerIds: bigint[]): string {
  return '0x' + SEL_DECLARE_ROSTER +
    pad32(teamId) +
    pad32(0x40n) +
    pad32(BigInt(playerIds.length)) +
    playerIds.map(pad32).join('');
}

// ---------------------------------------------------------------------------
// EIP-712 SquadMint permit
// ---------------------------------------------------------------------------

const SQUAD_MINT_TYPEHASH = keccak(Buffer.from(
  'SquadMint(address recipient,uint64 teamId,uint32 generation,uint256 nonce,uint256 deadline,bytes32 playersHash)',
  'utf8'));
const DOMAIN_TYPEHASH = keccak(Buffer.from(
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)', 'utf8'));

export function signSquadMint(options: {
  signerPk: string; chainId: number; generatorAddress: string;
  recipient: string; teamId: bigint; generation: number;
  nonce: bigint; deadline: bigint; seeds: PlayerSeedInput[];
}): string {
  const playersHash = keccak(Buffer.from(strip0x(encodeSeedsStandalone(options.seeds)), 'hex'));
  const structHash = keccak(Buffer.from(
    hex(SQUAD_MINT_TYPEHASH) +
    padAddress(options.recipient) +
    pad32(options.teamId) +
    pad32(BigInt(options.generation)) +
    pad32(options.nonce) +
    pad32(options.deadline) +
    hex(playersHash), 'hex'));
  const domainSeparator = keccak(Buffer.from(
    hex(DOMAIN_TYPEHASH) +
    hex(keccak(Buffer.from('FobalPlayerGenerator', 'utf8'))) +
    hex(keccak(Buffer.from('1', 'utf8'))) +
    pad32(BigInt(options.chainId)) +
    padAddress(options.generatorAddress), 'hex'));
  const digest = keccak(Buffer.concat([
    Buffer.from('1901', 'hex'),
    Buffer.from(domainSeparator),
    Buffer.from(structHash),
  ]));
  const sig = secp256k1.sign(digest, strip0x(options.signerPk), { lowS: true });
  const v = (sig.recovery + 27).toString(16).padStart(2, '0');
  // abi.encodePacked(r, s, v) — the shape SignatureChecker expects
  return '0x' + sig.r.toString(16).padStart(64, '0') + sig.s.toString(16).padStart(64, '0') + v;
}

// ---------------------------------------------------------------------------
// seed validation — the fairness gate BEFORE the signature exists
// ---------------------------------------------------------------------------

export function validateSeeds(seeds: PlayerSeedInput[], budget: number): void {
  if (!Array.isArray(seeds) || seeds.length !== 11)
    throw new MintError(400, 'a squad is exactly 11 players');
  if (seeds[0]!.position !== 0)
    throw new MintError(400, 'the first player must be the goalkeeper (position 0)');
  for (const [i, seed] of seeds.entries()){
    if (typeof seed.name !== 'string' || seed.name.trim().length < 2 || seed.name.length > 32)
      throw new MintError(400, `player ${i + 1}: name must be 2-32 characters`);
    if (!nameAllowed(seed.name))
      throw new MintError(400, `player ${i + 1}: that name is not allowed`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(seed.dna))
      throw new MintError(400, `player ${i + 1}: dna must be 32 bytes of 0x-hex`);
    if (![0, 1, 2, 3].includes(seed.position))
      throw new MintError(400, `player ${i + 1}: position must be 0-3`);
    if (!Number.isInteger(seed.country) || seed.country < 0 || seed.country > 65535)
      throw new MintError(400, `player ${i + 1}: bad country`);
    if (seed.generation !== 1)
      throw new MintError(400, `player ${i + 1}: generation must be 1`);
    const skills = toBig(seed.skills, `player ${i + 1} skills`);
    let sum = 0;
    for (let lane = 0; lane < 12; lane++){
      const s = Number((skills >> BigInt(lane * 8)) & 0xffn);
      if (s > 100) throw new MintError(400, `player ${i + 1}: skill lane ${lane} exceeds 100`);
      sum += s;
    }
    if (skills >> 96n !== 0n)
      throw new MintError(400, `player ${i + 1}: skills has bits above lane 12`);
    if (sum > budget)
      throw new MintError(400, `player ${i + 1}: power ${sum} exceeds the ${budget} budget`);
    toBig(seed.appearance, `player ${i + 1} appearance`);
  }
}

// ---------------------------------------------------------------------------
// the step machine
// ---------------------------------------------------------------------------

export interface MintService {
  prepare(wallet: string, teamName: string, seeds: PlayerSeedInput[], progress?: MintProgress): Promise<MintPlan>;
}

const SEL_OWNER_OF_TEAM = selector('ownerOfTeam(uint64)');
const ZERO32 = `0x${'0'.repeat(64)}`;

export function createMintService(options: MintServiceOptions): MintService {
  const fetchImpl = options.fetchImpl ?? fetch;
  const budget = options.perPlayerPowerBudget ?? 720;
  let requestId = 1;

  async function call(to: string, data: string): Promise<string> {
    const res = await fetchImpl(options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId++, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    if (!res.ok) throw new MintError(502, `chain rpc ${res.status}`);
    const body = await res.json() as { result?: string; error?: { message?: string } };
    if (body.error) throw new MintError(502, `chain rpc: ${body.error.message ?? 'error'}`);
    return body.result ?? '0x';
  }

  /** the one claim the server checks itself — a wrong/foreign teamId gets a
   *  403 here instead of a revert after the user paid gas */
  async function verifyTeamOwner(teamId: bigint, wallet: string): Promise<void> {
    let owner: string;
    try {
      owner = await call(options.registryAddress, `0x${SEL_OWNER_OF_TEAM}${pad32(teamId)}`);
    } catch (err) {
      // ownerOfTeam reverts (TeamDoesNotExist) for ids that were never
      // created — that's a stale/garbage claim, not a chain outage
      if (err instanceof MintError && /revert/i.test(err.message))
        throw new MintError(403, `team ${teamId} does not exist — restart the mint`);
      throw err;
    }
    if (strip0x(owner).slice(-40).toLowerCase() !== strip0x(wallet).toLowerCase())
      throw new MintError(403, `team ${teamId} is not owned by your wallet`);
  }

  return {
    async prepare(wallet, teamName, seeds, progress = {}){
      if (typeof teamName !== 'string' || teamName.trim().length < 2 || teamName.length > 32)
        throw new MintError(400, 'team name must be 2-32 characters');
      if (!nameAllowed(teamName)) throw new MintError(400, 'that team name is not allowed');
      validateSeeds(seeds, budget);

      if (progress.teamId === undefined || progress.teamId === null){
        const dna = `0x${hex(keccak(Buffer.from(padAddress(wallet) + Buffer.from(teamName, 'utf8').toString('hex'), 'hex')))}`;
        return { done: false, tx: {
          step: 'create-team',
          description: `Create "${teamName.trim()}" on the FOBAL team registry`,
          to: options.registryAddress,
          data: encodeCreateTeam(teamName.trim(), dna),
          parse: { topic0: TOPIC_TEAM_CREATED, idTopic: 1, many: false },
        } };
      }

      const teamId = toBig(progress.teamId, 'teamId');
      await verifyTeamOwner(teamId, wallet);

      if (!Array.isArray(progress.tokenIds) || progress.tokenIds.length === 0){
        const nonce = BigInt(await call(options.generatorAddress, `0x${SEL_NONCES}${padAddress(wallet)}`));
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const signature = signSquadMint({
          signerPk: options.signerPk, chainId: options.chainId,
          generatorAddress: options.generatorAddress,
          recipient: wallet, teamId, generation: 1, nonce, deadline, seeds,
        });
        return { done: false, tx: {
          step: 'mint-squad',
          description: 'Mint your 11 players as NFTs (permit signed by FOBAL)',
          to: options.generatorAddress,
          data: encodeMintSquad(wallet, teamId, 1, deadline, seeds, signature),
          // the 11 mint Transfers: from is the zero address
          parse: { topic0: TOPIC_TRANSFER, idTopic: 3, many: true, requireTopic1: ZERO32 },
        } };
      }

      const tokenIds = progress.tokenIds.map((id, i) => toBig(id, `tokenIds[${i}]`));
      if (tokenIds.length !== 11)
        throw new MintError(400, 'a roster is exactly 11 token ids');

      if (!progress.declared){
        return { done: false, tx: {
          step: 'declare-roster',
          description: 'Declare your starting XI on the team registry',
          to: options.registryAddress,
          data: encodeDeclareRoster(teamId, tokenIds),
        } };
      }

      return { done: true, teamId: Number(teamId) };
    },
  };
}
