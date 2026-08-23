// Workstream I2 — trading, prepared but never signed here.
//
// The same shape as the mint flow, for the same reason: the server builds
// calldata, the PLAYER'S OWN WALLET sends it. FOBAL never takes custody of
// a footballer, never holds a key that can move one, and never asks for an
// approval the player did not see described in plain words.
//
// The checks below run BEFORE the wallet opens. They exist so a manager
// gets "he is locked in a match" instead of a red revert box — they are
// courtesy, not authority. FobalMarketplace re-checks live ownership,
// approval, lock, expiry and price on every call, and it is the only thing
// that decides whether a trade happens.
import { keccak_256 } from '@noble/hashes/sha3';

const selector = (signature: string): string =>
  Buffer.from(keccak_256(Buffer.from(signature, 'utf8'))).subarray(0, 4).toString('hex');

const SEL_LIST = selector('list(uint256,address,uint96,uint40)');
const SEL_CANCEL = selector('cancel(uint256)');
const SEL_BUY = selector('buy(uint256)');
const SEL_SET_APPROVAL = selector('setApprovalForAll(address,bool)');
const SEL_IS_APPROVED = selector('isApprovedForAll(address,address)');
const SEL_PLAYER_VIEW = selector('playerView(uint256)');
const SEL_LISTINGS = selector('listings(uint256)');

const ZERO = `0x${'0'.repeat(40)}`;
const pad32 = (v: bigint): string => v.toString(16).padStart(64, '0');
const padAddress = (a: string): string => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = (data: string, i: number): string => data.replace(/^0x/, '').slice(i * 64, (i + 1) * 64);
const addressAt = (data: string, i: number): string => `0x${word(data, i).slice(24)}`.toLowerCase();
const bigAt = (data: string, i: number): bigint => BigInt(`0x${word(data, i) || '0'}`);

/** uint96 and uint40 are real limits on chain; refusing here beats a revert */
const MAX_UINT96 = (1n << 96n) - 1n;
const MAX_UINT40 = (1n << 40n) - 1n;
/** the contract refuses expiry <= block.timestamp — a listing ALWAYS ends.
 *  When a manager does not name a date, this is the horizon we give him. */
const DEFAULT_LISTING_DAYS = 30;

export interface TradeTx {
  step: 'approve' | 'list' | 'cancel' | 'buy';
  /** shown to the manager before the wallet opens */
  description: string;
  to: string;
  data: string;
  /** wei, decimal string — present only when the call carries ETH */
  value?: string;
}

export interface TradePlan {
  steps: TradeTx[];
  summary: string;
}

export class TradeError extends Error {
  constructor(readonly status: number, message: string){ super(message); }
}

export interface TradeRequest {
  action: 'list' | 'cancel' | 'buy';
  tokenId: string;
  /** list only: wei, decimal string */
  price?: string;
  /** list only: unix seconds. Omitted → DEFAULT_LISTING_DAYS from now.
   *  There is no "forever": FobalMarketplace requires expiry > now. */
  expiry?: number;
}

export interface TradeServiceOptions {
  rpcUrl?: string;
  marketplaceAddress?: string;
  playerAddress?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface TradeService {
  prepare(wallet: string, request: TradeRequest): Promise<TradePlan>;
}

export function createTradeService(options: TradeServiceOptions = {}): TradeService | null {
  const { rpcUrl, marketplaceAddress, playerAddress } = options;
  if (!rpcUrl || !marketplaceAddress || !playerAddress) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let nextId = 1;

  async function call(to: string, data: string): Promise<string> {
    const res = await fetchImpl(rpcUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'eth_call', params: [{ to, data: `0x${data}` }, 'latest'] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new TradeError(502, 'the chain did not answer — try again shortly');
    const body = await res.json() as { result?: string; error?: { message?: string } };
    if (body.error || body.result === undefined)
      throw new TradeError(502, 'the chain did not answer — try again shortly');
    return body.result.replace(/^0x/, '');
  }

  /** owner + lock straight from the token, at head */
  async function playerState(tokenId: bigint): Promise<{ owner: string; locked: boolean }> {
    const data = await call(playerAddress!, SEL_PLAYER_VIEW + pad32(tokenId))
      .catch(() => { throw new TradeError(404, `player ${tokenId} does not exist`); });
    const tuple = data.slice(64);            // past the struct offset word
    return { owner: addressAt(tuple, 17), locked: addressAt(tuple, 18) !== ZERO };
  }

  /** the listing as the CONTRACT has it — the index is not consulted here */
  async function listingState(tokenId: bigint){
    const data = await call(marketplaceAddress!, SEL_LISTINGS + pad32(tokenId));
    return {
      seller: addressAt(data, 0),
      asset: addressAt(data, 1),
      price: bigAt(data, 2),
      expiry: Number(bigAt(data, 3)),
    };
  }

  return {
    async prepare(wallet, request){
      const me = wallet.toLowerCase();
      let tokenId: bigint;
      try { tokenId = BigInt(request.tokenId); }
      catch { throw new TradeError(400, 'that is not a token id'); }

      if (request.action === 'buy'){
        const listing = await listingState(tokenId);
        if (listing.seller === ZERO) throw new TradeError(404, 'he is not for sale');
        if (listing.expiry !== 0 && listing.expiry <= now())
          throw new TradeError(409, 'that listing has expired');
        if (listing.seller === me) throw new TradeError(409, 'he is already yours — cancel the listing instead');
        if (listing.asset !== ZERO)
          throw new TradeError(501, 'this player is priced in a token; only ETH purchases are supported so far');
        return {
          summary: `Buy player ${tokenId} for ${listing.price} wei`,
          steps: [{
            step: 'buy',
            description: `Buy player #${tokenId}`,
            to: marketplaceAddress!,
            data: `0x${SEL_BUY}${pad32(tokenId)}`,
            value: listing.price.toString(),
          }],
        };
      }

      if (request.action === 'cancel'){
        const listing = await listingState(tokenId);
        if (listing.seller === ZERO) throw new TradeError(404, 'he is not listed');
        if (listing.seller !== me) throw new TradeError(403, 'only the seller can take a listing down');
        return {
          summary: `Take player ${tokenId} off the market`,
          steps: [{
            step: 'cancel',
            description: `Take player #${tokenId} off the market`,
            to: marketplaceAddress!,
            data: `0x${SEL_CANCEL}${pad32(tokenId)}`,
          }],
        };
      }

      // list
      let price: bigint;
      try { price = BigInt(request.price ?? '0'); }
      catch { throw new TradeError(400, 'that is not a price'); }
      if (price <= 0n) throw new TradeError(400, 'a price is required');
      if (price > MAX_UINT96) throw new TradeError(400, 'that price is beyond what the market can hold');
      // FobalMarketplace requires expiry > block.timestamp: there is no
      // open-ended listing, so an unspecified one gets a real horizon
      // rather than a zero the contract would reject.
      const expiry = BigInt(request.expiry || (now() + DEFAULT_LISTING_DAYS * 86_400));
      if (expiry > MAX_UINT40) throw new TradeError(400, 'that expiry is too far away');
      if (expiry <= BigInt(now()))
        throw new TradeError(400, 'that listing would already have expired');

      const state = await playerState(tokenId);
      if (state.owner !== me) throw new TradeError(403, 'he is not yours to sell');
      if (state.locked) throw new TradeError(409, 'he is locked in a match — he can be sold when it settles');

      const steps: TradeTx[] = [];
      const approved = await call(playerAddress!,
        SEL_IS_APPROVED + padAddress(me) + padAddress(marketplaceAddress!));
      if (bigAt(approved, 0) === 0n){
        // one approval covers every future sale; the manager is told exactly that
        steps.push({
          step: 'approve',
          description: 'Allow the market to transfer a player when he sells (once per wallet)',
          to: playerAddress!,
          data: `0x${SEL_SET_APPROVAL}${padAddress(marketplaceAddress!)}${pad32(1n)}`,
        });
      }
      steps.push({
        step: 'list',
        description: `List player #${tokenId} for ${price} wei until ${new Date(Number(expiry) * 1000).toISOString().slice(0, 10)}`,
        to: marketplaceAddress!,
        data: `0x${SEL_LIST}${pad32(tokenId)}${padAddress(ZERO)}${pad32(price)}${pad32(expiry)}`,
      });
      return { steps, summary: `List player ${tokenId} for ${price} wei` };
    },
  };
}
