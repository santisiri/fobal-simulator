// Workstream I — the market index. The RPC is faked; the LOG BYTES are real,
// hand-encoded to the exact shapes FobalMarketplace emits. What's under test
// is everything a shop window can get wrong: money precision, which listing
// still stands, idempotent re-scans, expiry, and the price history.
import { describe, expect, test } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { createMarketReader } from '../src/index.js';

const topic = (sig: string) =>
  `0x${Buffer.from(keccak_256(Buffer.from(sig, 'utf8'))).toString('hex')}`;
const T_LISTED = topic('PlayerListed(uint256,address,address,uint96,uint40)');
const T_CANCELLED = topic('ListingCancelled(uint256,address)');
const T_SOLD = topic('PlayerSold(uint256,address,address,address,uint96,uint256)');

const W = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
const TOPIC_ADDR = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const ETH = '0x0000000000000000000000000000000000000000';
const ALICE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const BOB = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';

// 2.5 ETH in wei — larger than Number.MAX_SAFE_INTEGER, which is the point
const TWO_POINT_FIVE = 2_500_000_000_000_000_000n;

interface Log { topics: string[]; data: string; blockNumber: string; logIndex: string }

const listed = (tokenId: number, price: bigint, expiry: number, block: number, logIndex = 0, seller = ALICE): Log => ({
  topics: [T_LISTED, `0x${W(tokenId)}`, TOPIC_ADDR(seller), TOPIC_ADDR(ETH)],
  data: `0x${W(price)}${W(expiry)}`,
  blockNumber: `0x${block.toString(16)}`, logIndex: `0x${logIndex.toString(16)}`,
});
const cancelled = (tokenId: number, block: number, logIndex = 0): Log => ({
  topics: [T_CANCELLED, `0x${W(tokenId)}`, TOPIC_ADDR(ALICE)],
  data: '0x', blockNumber: `0x${block.toString(16)}`, logIndex: `0x${logIndex.toString(16)}`,
});
const sold = (tokenId: number, price: bigint, block: number, logIndex = 0): Log => ({
  topics: [T_SOLD, `0x${W(tokenId)}`, TOPIC_ADDR(ALICE), TOPIC_ADDR(BOB)],
  data: `0x${W(BigInt(ETH))}${W(price)}${W(price / 40n)}`,
  blockNumber: `0x${block.toString(16)}`, logIndex: `0x${logIndex.toString(16)}`,
});

function readerOver(logs: Log[], { head = 100, now = () => 10_000, fromBlock = 0 } = {}){
  const ranges: Array<[number, number]> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: any[] };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    if (req.method === 'eth_blockNumber') return reply(`0x${head.toString(16)}`);
    if (req.method === 'eth_getLogs'){
      const from = Number(BigInt(req.params[0].fromBlock));
      const to = Number(BigInt(req.params[0].toBlock));
      ranges.push([from, to]);
      return reply(logs.filter(l => {
        const b = Number(BigInt(l.blockNumber));
        return b >= from && b <= to;
      }));
    }
    throw new Error(`unexpected ${req.method}`);
  }) as typeof fetch;
  const reader = createMarketReader({
    rpcUrl: 'http://fake', marketplaceAddress: '0x' + 'aa'.repeat(20), fetchImpl, now, fromBlock,
  })!;
  return { reader, ranges };
}

describe('market index', () => {
  test('unconfigured → null (the 501 path)', () => {
    expect(createMarketReader({})).toBeNull();
    expect(createMarketReader({ rpcUrl: 'http://x' })).toBeNull();
  });

  test('a listing is read whole, and the price keeps every wei', async () => {
    const { reader } = readerOver([listed(7, TWO_POINT_FIVE, 99_999, 50)]);
    await reader.refresh();
    const [l] = reader.listings();
    expect(l).toMatchObject({ tokenId: '7', seller: ALICE, asset: ETH, expiry: 99_999, block: 50 });
    // the whole point: exact, not 2.5000000000000002e18
    expect(l!.price).toBe('2500000000000000000');
    expect(BigInt(l!.price)).toBe(TWO_POINT_FIVE);
  });

  test('cancelling and selling both end the listing; order decides', async () => {
    const { reader } = readerOver([
      listed(1, 10n, 0, 10), listed(2, 20n, 0, 11), listed(3, 30n, 0, 12),
      cancelled(2, 20),
      sold(3, 30n, 21),
    ]);
    await reader.refresh();
    expect(reader.listings().map(l => l.tokenId)).toEqual(['1']);
    expect(reader.listingFor('2')).toBeNull();
    expect(reader.listingFor('3')).toBeNull();
  });

  test('a RE-LIST after a sale stands again (later log wins)', async () => {
    const { reader } = readerOver([
      listed(5, 10n, 0, 10),
      sold(5, 10n, 11),
      listed(5, 99n, 0, 12, 0, BOB),      // the new owner lists it again
    ]);
    await reader.refresh();
    expect(reader.listingFor('5')).toMatchObject({ price: '99', seller: BOB });
  });

  test('two events in ONE block resolve by logIndex, not by luck', async () => {
    const { reader } = readerOver([
      listed(9, 10n, 0, 30, 5),
      cancelled(9, 30, 9),                 // same block, later log → cancelled wins
    ]);
    await reader.refresh();
    expect(reader.listingFor('9')).toBeNull();
  });

  test('re-scanning is idempotent — no duplicate sales, no resurrected listings', async () => {
    const logs = [listed(4, 100n, 0, 60), sold(4, 100n, 61)];
    const { reader } = readerOver(logs);
    await reader.refresh();
    await reader.refresh();                // overlap re-reads the same blocks
    await reader.refresh();
    expect(reader.salesFor('4')).toHaveLength(1);
    expect(reader.listingFor('4')).toBeNull();
    expect(reader.summary().sales).toBe(1);
  });

  test('expiry hides a listing without deleting the history', async () => {
    const clock = { t: 1_000 };
    const { reader } = readerOver([listed(8, 50n, 5_000, 70)], { now: () => clock.t });
    await reader.refresh();
    expect(reader.listings()).toHaveLength(1);
    clock.t = 6_000;                        // the listing lapses
    expect(reader.listings()).toHaveLength(0);
    expect(reader.listingFor('8')).toBeNull();
  });

  test('price history is every sale, oldest first', async () => {
    const { reader } = readerOver([
      listed(6, 100n, 0, 10), sold(6, 100n, 11),
      listed(6, 300n, 0, 20), sold(6, 300n, 21),
      listed(6, 200n, 0, 30), sold(6, 200n, 31),
    ]);
    await reader.refresh();
    expect(reader.salesFor('6').map(s => s.price)).toEqual(['100', '300', '200']);
    expect(reader.salesFor('6')[0]).toMatchObject({ seller: ALICE, buyer: BOB, asset: ETH });
    expect(reader.salesFor('6')[0]!.fee).toBe('2');            // 2.5% of 100
  });

  test('the summary floors on ETH listings only, and counts what is open', async () => {
    const { reader } = readerOver([
      listed(1, 500n, 0, 10), listed(2, 200n, 0, 11), listed(3, 900n, 0, 12),
      cancelled(3, 13),
    ]);
    await reader.refresh();
    expect(reader.summary()).toMatchObject({ listed: 2, sales: 0, floor: '200' });
  });

  test('a wide catch-up is WALKED, not demanded in one gulp (public RPCs refuse it)', async () => {
    const { reader, ranges } = readerOver([listed(1, 5n, 0, 40_000)], { head: 40_500, fromBlock: 20_000 });
    await reader.refresh();
    expect(ranges.length).toBeGreaterThan(1);                  // chunked
    for (const [from, to] of ranges) expect(to - from).toBeLessThan(9_000);
    expect(reader.listings()).toHaveLength(1);                 // and it still found it
    expect(reader.lastBlock).toBe(40_500);
  });
});
