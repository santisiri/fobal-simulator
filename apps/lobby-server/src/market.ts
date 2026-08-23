// Workstream I — the market index (docs/CLUB_AND_MARKET.md).
//
// Everything a browsable marketplace needs is already on chain: the
// deployed FobalMarketplace emits PlayerListed / ListingCancelled /
// PlayerSold, and those three events ARE the order book and the price
// history. So this is an INDEX, never a source of truth: it replays logs
// into memory and can be thrown away and rebuilt at any time. Nothing here
// is authoritative — `buy` re-checks live ownership, approval, lock and
// expiry on chain, so a stale index can misinform a browser but can never
// mis-sell a player.
//
// Two rules the code keeps:
//   1. MONEY IS NEVER A JS NUMBER. Prices are uint96 wei, which overflows
//      Number.MAX_SAFE_INTEGER at ~9 ETH-with-18-decimals. They stay
//      BigInt inside and decimal STRINGS on the wire.
//   2. RE-SCANNING IS SAFE. Each refresh re-reads a small overlap of
//      blocks; events are applied in (block, logIndex) order and sales are
//      de-duplicated by log identity, so an overlapping or repeated scan
//      converges on the same view. That is what makes reorg handling on a
//      testnet a non-event.
import { keccak_256 } from '@noble/hashes/sha3';

const topic = (signature: string): string =>
  `0x${Buffer.from(keccak_256(Buffer.from(signature, 'utf8'))).toString('hex')}`;

const TOPIC_LISTED = topic('PlayerListed(uint256,address,address,uint96,uint40)');
const TOPIC_CANCELLED = topic('ListingCancelled(uint256,address)');
const TOPIC_SOLD = topic('PlayerSold(uint256,address,address,address,uint96,uint256)');

/** blocks re-read on every refresh, so a short reorg cannot strand the index */
const OVERLAP_BLOCKS = 24;
/** public RPCs refuse wide eth_getLogs ranges, so the catch-up walks in
 *  windows. The first sync from the deploy block is many windows and slow;
 *  every refresh after it is one small window. */
const MAX_RANGE = 9_000;

export interface MarketReaderOptions {
  rpcUrl?: string;
  marketplaceAddress?: string;
  /** the block the marketplace was deployed in — where indexing starts */
  fromBlock?: number;
  fetchImpl?: typeof fetch;
  /** clock seam, so expiry is testable */
  now?: () => number;
}

export interface Listing {
  tokenId: string;
  seller: string;
  /** 0x000…0 means ETH */
  asset: string;
  /** wei, decimal string */
  price: string;
  /** unix seconds; 0 means no expiry */
  expiry: number;
  block: number;
}

export interface Sale {
  tokenId: string;
  seller: string;
  buyer: string;
  asset: string;
  price: string;
  fee: string;
  block: number;
}

export interface MarketReader {
  /** pull new logs into the index; safe to call repeatedly */
  refresh(): Promise<void>;
  /** live listings, newest first — expired ones are filtered, not deleted */
  listings(): Listing[];
  listingFor(tokenId: string): Listing | null;
  /** every completed sale for one player, oldest first — the price history */
  salesFor(tokenId: string): Sale[];
  /** the market's own summary: what is for sale and what things go for */
  summary(): { listed: number; sales: number; floor: string | null; lastBlock: number };
  readonly lastBlock: number;
}

const hexToBig = (hex: string): bigint => BigInt(hex.startsWith('0x') ? hex : `0x${hex}`);
const word = (data: string, i: number): string => data.replace(/^0x/, '').slice(i * 64, (i + 1) * 64);
const addressFromTopic = (t: string): string => `0x${t.slice(-40)}`.toLowerCase();

export function createMarketReader(options: MarketReaderOptions = {}): MarketReader | null {
  const { rpcUrl, marketplaceAddress } = options;
  if (!rpcUrl || !marketplaceAddress) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const startBlock = options.fromBlock ?? 0;

  /** tokenId → the listing that stands, or null once sold/cancelled */
  const live = new Map<string, Listing | null>();
  /** tokenId → sales, keyed by log identity so re-scans cannot duplicate */
  const sales = new Map<string, Map<string, Sale>>();
  let lastBlock = startBlock === 0 ? 0 : startBlock - 1;
  let nextId = 1;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetchImpl(rpcUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`market rpc ${method}: http ${res.status}`);
    const body = await res.json() as { result?: T; error?: { message?: string } };
    if (body.error || body.result === undefined)
      throw new Error(`market rpc ${method}: ${body.error?.message ?? 'no result'}`);
    return body.result;
  }

  function apply(log: { topics: string[]; data: string; blockNumber: string; logIndex: string }){
    const tokenId = hexToBig(log.topics[1]!).toString();
    const block = Number(hexToBig(log.blockNumber));
    switch (log.topics[0]){
      case TOPIC_LISTED:
        live.set(tokenId, {
          tokenId,
          seller: addressFromTopic(log.topics[2]!),
          asset: addressFromTopic(log.topics[3]!),
          price: hexToBig(word(log.data, 0)).toString(),
          expiry: Number(hexToBig(word(log.data, 1))),
          block,
        });
        break;
      case TOPIC_CANCELLED:
        live.set(tokenId, null);
        break;
      case TOPIC_SOLD: {
        live.set(tokenId, null);                       // a sale ends the listing
        const sale: Sale = {
          tokenId,
          seller: addressFromTopic(log.topics[2]!),
          buyer: addressFromTopic(log.topics[3]!),
          asset: `0x${word(log.data, 0).slice(24)}`.toLowerCase(),
          price: hexToBig(word(log.data, 1)).toString(),
          fee: hexToBig(word(log.data, 2)).toString(),
          block,
        };
        const key = `${log.blockNumber}:${log.logIndex}`;
        const forToken = sales.get(tokenId) ?? new Map<string, Sale>();
        forToken.set(key, sale);                        // idempotent by log identity
        sales.set(tokenId, forToken);
        break;
      }
      default: break;
    }
  }

  return {
    get lastBlock(){ return lastBlock; },

    async refresh(){
      const head = Number(hexToBig(await rpc<string>('eth_blockNumber', [])));
      if (head < startBlock) return;
      let from = Math.max(startBlock, lastBlock - OVERLAP_BLOCKS + 1, 0);
      while (from <= head){
        const to = Math.min(from + MAX_RANGE - 1, head);
        const logs = await rpc<Array<{ topics: string[]; data: string; blockNumber: string; logIndex: string }>>(
          'eth_getLogs',
          [{
            address: marketplaceAddress,
            topics: [[TOPIC_LISTED, TOPIC_CANCELLED, TOPIC_SOLD]],
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
          }],
        );
        // chain order decides: a cancel in a later log must beat an earlier list
        logs
          .slice()
          .sort((a, b) =>
            Number(hexToBig(a.blockNumber) - hexToBig(b.blockNumber))
            || Number(hexToBig(a.logIndex) - hexToBig(b.logIndex)))
          .forEach(apply);
        lastBlock = to;                 // progress survives a mid-walk failure
        from = to + 1;
      }
    },

    listings(){
      const t = now();
      return [...live.values()]
        .filter((l): l is Listing => l !== null && (l.expiry === 0 || l.expiry > t))
        .sort((a, b) => b.block - a.block);
    },

    listingFor(tokenId){
      const l = live.get(tokenId) ?? null;
      if (!l) return null;
      return l.expiry === 0 || l.expiry > now() ? l : null;
    },

    salesFor(tokenId){
      return [...(sales.get(tokenId)?.values() ?? [])].sort((a, b) => a.block - b.block);
    },

    summary(){
      const open = this.listings();
      // floor across ETH listings only — mixing assets would be a lie
      const eth = open.filter(l => /^0x0{40}$/.test(l.asset)).map(l => BigInt(l.price));
      const floor = eth.length ? eth.reduce((m, p) => (p < m ? p : m)).toString() : null;
      let saleCount = 0;
      for (const forToken of sales.values()) saleCount += forToken.size;
      return { listed: open.length, sales: saleCount, floor, lastBlock };
    },
  };
}
