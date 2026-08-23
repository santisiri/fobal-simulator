// I2 — preparing a trade. The chain is faked; the CALLDATA is real, and the
// tests assert the exact bytes a wallet would send. What matters here:
// the server prepares and never signs, the pre-flight refusals are kind and
// specific, and an approval is asked for only when it is actually missing.
import { describe, expect, test } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { createTradeService, TradeError } from '../src/index.js';

const sel = (sig: string) =>
  Buffer.from(keccak_256(Buffer.from(sig, 'utf8'))).subarray(0, 4).toString('hex');
const S_LIST = sel('list(uint256,address,uint96,uint40)');
const S_CANCEL = sel('cancel(uint256)');
const S_BUY = sel('buy(uint256)');
const S_APPROVE = sel('setApprovalForAll(address,bool)');
const S_IS_APPROVED = sel('isApprovedForAll(address,address)');
const S_VIEW = sel('playerView(uint256)');
const S_LISTINGS = sel('listings(uint256)');

const W = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
const word = (data: string, i: number) => `0x${data.replace(/^0x/, '').slice(8 + i * 64, 8 + (i + 1) * 64)}`;
const A = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const ZERO = `0x${'0'.repeat(40)}`;
const ALICE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const BOB = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const MARKET = `0x${'aa'.repeat(20)}`;
const PLAYER = `0x${'bb'.repeat(20)}`;

interface World {
  owner: string; locked: boolean; approved: boolean;
  listing: { seller: string; asset: string; price: bigint; expiry: number };
}
const empty = { seller: ZERO, asset: ZERO, price: 0n, expiry: 0 };

function serviceOver(world: Partial<World>, now = () => 1_000){
  const w: World = { owner: ALICE, locked: false, approved: false, listing: empty, ...world };
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; params: any[] };
    const data: string = req.params[0].data;
    const s = data.slice(2, 10);
    const reply = (result: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    if (s === S_VIEW){
      // playerView: offset word, then the tuple — owner at 17, lockedBy at 18
      const tuple = W(0).repeat(17) + A(w.owner) + A(w.locked ? BOB : ZERO);
      return reply(`0x${W(0x20)}${tuple}`);
    }
    if (s === S_IS_APPROVED) return reply(`0x${W(w.approved ? 1 : 0)}`);
    if (s === S_LISTINGS)
      return reply(`0x${A(w.listing.seller)}${A(w.listing.asset)}${W(w.listing.price)}${W(w.listing.expiry)}`);
    throw new Error(`unexpected call ${s}`);
  }) as typeof fetch;
  return createTradeService({ rpcUrl: 'http://fake', marketplaceAddress: MARKET, playerAddress: PLAYER, fetchImpl, now })!;
}

const rejects = async (p: Promise<unknown>, status: number, match: RegExp) => {
  await expect(p).rejects.toThrow(match);
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof TradeError && e.status === status);
};

describe('trade preparation', () => {
  test('unconfigured → null (the 501 path)', () => {
    expect(createTradeService({})).toBeNull();
    expect(createTradeService({ rpcUrl: 'http://x', marketplaceAddress: MARKET })).toBeNull();
  });

  test('listing a player you own: approval FIRST, then the listing itself', async () => {
    const plan = await serviceOver({ owner: ALICE, approved: false })
      .prepare(ALICE, { action: 'list', tokenId: '7', price: '2500000000000000000', expiry: 0 });
    expect(plan.steps.map(s => s.step)).toEqual(['approve', 'list']);
    expect(plan.steps[0]!.to).toBe(PLAYER);
    expect(plan.steps[0]!.data).toBe(`0x${S_APPROVE}${A(MARKET)}${W(1)}`);
    expect(plan.steps[0]!.description).toMatch(/once per wallet/);
    expect(plan.steps[1]!.to).toBe(MARKET);
    // the contract REFUSES expiry <= now, so an unnamed expiry becomes a real
    // horizon (30 days) — a zero here would revert every listing
    const expiry = BigInt(word(plan.steps[1]!.data, 3));
    expect(expiry).toBeGreaterThan(1_000n);
    expect(plan.steps[1]!.data).toBe(`0x${S_LIST}${W(7)}${A(ZERO)}${W(2500000000000000000n)}${W(expiry)}`);
    expect(plan.steps[1]!.description).toMatch(/until \d{4}-\d{2}-\d{2}/);
    expect(plan.steps[1]!.value).toBeUndefined();          // listing costs nothing
  });

  test('an approval already given is not asked for twice', async () => {
    const plan = await serviceOver({ approved: true })
      .prepare(ALICE, { action: 'list', tokenId: '7', price: '1000' });
    expect(plan.steps.map(s => s.step)).toEqual(['list']);
  });

  test('you cannot list what is not yours, or what is locked in a match', async () => {
    await rejects(serviceOver({ owner: BOB }).prepare(ALICE, { action: 'list', tokenId: '7', price: '10' }),
      403, /not yours to sell/);
    await rejects(serviceOver({ owner: ALICE, locked: true }).prepare(ALICE, { action: 'list', tokenId: '7', price: '10' }),
      409, /locked in a match/);
  });

  test('prices are checked against what the contract can actually hold', async () => {
    const svc = serviceOver({ approved: true });
    await rejects(svc.prepare(ALICE, { action: 'list', tokenId: '7', price: '0' }), 400, /price is required/);
    await rejects(svc.prepare(ALICE, { action: 'list', tokenId: '7', price: (2n ** 96n).toString() }),
      400, /beyond what the market can hold/);
    await rejects(svc.prepare(ALICE, { action: 'list', tokenId: '7', price: '10', expiry: 999 }),
      400, /already have expired/);
    // and a named future date is honoured exactly
    const dated = await svc.prepare(ALICE, { action: 'list', tokenId: '7', price: '10', expiry: 4_102_444_800 });
    expect(word(dated.steps[0]!.data, 3)).toBe(`0x${W(4_102_444_800)}`);
  });

  test('buying carries the price as VALUE, read from the contract not the index', async () => {
    const plan = await serviceOver({ listing: { seller: BOB, asset: ZERO, price: 7500000000000000000n, expiry: 0 } })
      .prepare(ALICE, { action: 'buy', tokenId: '10' });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      step: 'buy', to: MARKET, data: `0x${S_BUY}${W(10)}`, value: '7500000000000000000',
    });
  });

  test('buying refuses honestly: not listed, expired, your own, or priced in a token', async () => {
    await rejects(serviceOver({}).prepare(ALICE, { action: 'buy', tokenId: '10' }), 404, /not for sale/);
    await rejects(
      serviceOver({ listing: { seller: BOB, asset: ZERO, price: 5n, expiry: 500 } })
        .prepare(ALICE, { action: 'buy', tokenId: '10' }), 409, /expired/);
    await rejects(
      serviceOver({ listing: { seller: ALICE, asset: ZERO, price: 5n, expiry: 0 } })
        .prepare(ALICE, { action: 'buy', tokenId: '10' }), 409, /already yours/);
    await rejects(
      serviceOver({ listing: { seller: BOB, asset: `0x${'cc'.repeat(20)}`, price: 5n, expiry: 0 } })
        .prepare(ALICE, { action: 'buy', tokenId: '10' }), 501, /only ETH purchases/);
  });

  test("cancelling is the seller's alone", async () => {
    const mine = { seller: ALICE, asset: ZERO, price: 5n, expiry: 0 };
    const plan = await serviceOver({ listing: mine }).prepare(ALICE, { action: 'cancel', tokenId: '3' });
    expect(plan.steps[0]).toMatchObject({ step: 'cancel', to: MARKET, data: `0x${S_CANCEL}${W(3)}` });

    await rejects(serviceOver({ listing: { ...mine, seller: BOB } }).prepare(ALICE, { action: 'cancel', tokenId: '3' }),
      403, /only the seller/);
    await rejects(serviceOver({}).prepare(ALICE, { action: 'cancel', tokenId: '3' }), 404, /not listed/);
  });

  test('nothing prepared ever carries a signature, a key, or a from address', async () => {
    const plan = await serviceOver({ approved: true }).prepare(ALICE, { action: 'list', tokenId: '7', price: '10' });
    const text = JSON.stringify(plan);
    expect(text).not.toMatch(/signature|privateKey|"from"|mnemonic/i);
    for (const step of plan.steps) expect(Object.keys(step).sort())
      .toEqual(expect.arrayContaining(['data', 'description', 'step', 'to']));
  });
});
