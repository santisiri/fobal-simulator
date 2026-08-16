// Wallet identity — verified ENS primary names for connected wallets.
//
// santi.eth instead of 0x8A3f…91Bd, but only when it's TRUE: a reverse
// record is a claim anyone can point anywhere, so a name is displayed as
// identity only after forward-resolving it and confirming it maps back to
// the same address (the ENS-documented two-step). Anything less falls back
// to the shortened address.
//
// Two networks, deliberately separate:
//   GAME EXECUTION NETWORK    — Base Sepolia (squads, minting, rosters)
//   IDENTITY RESOLUTION NETWORK — Ethereum mainnet (where ENS lives)
// A testnet wallet keeps its mainnet name. Mainnet resolution transitively
// covers *.base.eth basenames set as primary names (their L1 resolver
// CCIP-reads into Base, which viem's universal resolver follows). A slot
// for chain-native L2 primary names (ENSIP-19) is reserved in `source`;
// the installed viem (2.55) ships no ENS deployment for Base, so that
// rung activates when the library does — never by hand-pinned addresses.
//
// ENS is PRESENTATION, not authorization: nothing anywhere may gate on a
// name. Ownership and security logic stay on addresses.
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';

export interface WalletIdentity {
  /** lowercase 0x address — the only field authorization may ever use */
  address: string;
  /** what the UI shows: the verified name, else the shortened address */
  displayName: string;
  /** present ONLY when reverse + forward verification both passed */
  ensName?: string;
  /** avatar of the verified name — best-effort, never blocks identity */
  ensAvatar?: string;
  verified: boolean;
  source: 'ens-mainnet' | 'ens-base' | 'address';
}

/** the three calls the resolver needs — viem's shapes, injectable for tests */
export interface EnsClient {
  getEnsName(args: { address: `0x${string}` }): Promise<string | null>;
  getEnsAddress(args: { name: string }): Promise<string | null>;
  getEnsAvatar(args: { name: string }): Promise<string | null>;
}

export interface IdentityResolverOptions {
  /** identity-network RPC (Ethereum mainnet). Default: viem's built-in
   *  public transport for mainnet. A keyed URL is a secret — env, not code. */
  rpcUrl?: string;
  /** injectable client (tests); overrides rpcUrl */
  client?: EnsClient;
  /** how long a resolved identity (verified OR address-fallback) holds */
  ttlMs?: number;
  /** how long an RPC-failure fallback holds — short, so a blip does not
   *  pin everyone to hex for ttlMs */
  errorTtlMs?: number;
  /** per-request transport timeout — identity must never stall the lobby */
  timeoutMs?: number;
  now?: () => number;
}

export interface IdentityResolver {
  /** Resolve (cached, deduplicated). NEVER rejects — failure degrades to
   *  the shortened-address identity with a short TTL. */
  resolve(address: string): Promise<WalletIdentity>;
  /** The cached identity, if fresh — synchronous, for request paths that
   *  must not wait. */
  peek(address: string): WalletIdentity | null;
}

export const shortAddress = (address: string): string =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

export function createIdentityResolver(options: IdentityResolverOptions = {}): IdentityResolver {
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const errorTtlMs = options.errorTtlMs ?? 45 * 1000;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const now = options.now ?? Date.now;

  // the real client is built lazily so tests never touch the network and
  // a lobby that never sees a wallet never dials mainnet
  let client = options.client ?? null;
  const ensClient = (): EnsClient => {
    if (!client) {
      const pub = createPublicClient({
        chain: mainnet,
        transport: http(options.rpcUrl, { timeout: timeoutMs }),
      });
      client = {
        getEnsName: args => pub.getEnsName(args),
        getEnsAddress: args => pub.getEnsAddress({ name: args.name }),
        getEnsAvatar: args => pub.getEnsAvatar({ name: args.name }),
      };
    }
    return client;
  };

  const cache = new Map<string, { value: WalletIdentity; expiresAt: number }>();
  const inflight = new Map<string, Promise<WalletIdentity>>();

  const fallback = (address: string): WalletIdentity =>
    ({ address, displayName: shortAddress(address), verified: false, source: 'address' });

  async function lookup(address: string): Promise<{ value: WalletIdentity; ttl: number }> {
    const c = ensClient();
    let name: string | null;
    try {
      name = await c.getEnsName({ address: address as `0x${string}` });
    } catch {
      // RPC unreachable — the game must not care; retry soon
      return { value: fallback(address), ttl: errorTtlMs };
    }
    if (!name) return { value: fallback(address), ttl: ttlMs };

    // THE verification step: a reverse record is a claim; forward-resolve
    // the claimed name and require it to map back to this exact address
    let forward: string | null;
    try {
      forward = await c.getEnsAddress({ name });
    } catch {
      return { value: fallback(address), ttl: errorTtlMs };
    }
    if (!forward || forward.toLowerCase() !== address)
      return { value: fallback(address), ttl: ttlMs };   // unverified claim — not an error, just not identity

    // avatar is decoration on a verified identity — its failure is nobody's
    const avatar = await c.getEnsAvatar({ name }).catch(() => null);
    return {
      value: {
        address, displayName: name, ensName: name,
        ...(avatar ? { ensAvatar: avatar } : {}),
        verified: true, source: 'ens-mainnet',
      },
      ttl: ttlMs,
    };
  }

  return {
    peek(address: string): WalletIdentity | null {
      const hit = cache.get(address.toLowerCase());
      return hit && hit.expiresAt > now() ? hit.value : null;
    },
    resolve(address: string): Promise<WalletIdentity> {
      const key = address.toLowerCase();
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return Promise.resolve(hit.value);
      const running = inflight.get(key);
      if (running) return running;
      const task = lookup(key)
        .then(({ value, ttl }) => {
          cache.set(key, { value, expiresAt: now() + ttl });
          return value;
        })
        // lookup() already converts every failure; this is the belt for
        // the braces — resolve() must NEVER reject
        .catch(() => fallback(key))
        .finally(() => inflight.delete(key));
      inflight.set(key, task);
      return task;
    },
  };
}
