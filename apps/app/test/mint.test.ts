// The mint flow's pure parts (moved from lobby.html in J4). What matters:
// receipt parsing follows exactly the topics the SERVER named (never a
// hard-coded event shape), and the seed skills match the generator's fair
// flat squad.
import { describe, expect, test } from 'vitest';
import { idsFromReceipt, packFlatSkills, ROLE_POS } from '../src/views/mint.js';
import { countdown } from '../src/views/lobby.js';

const log = (topic0: string, ...rest: string[]) => ({ topics: [topic0, ...rest] });
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

describe('idsFromReceipt', () => {
  test('single id: the LAST matching event wins (create-team emits once, but retries may stack)', () => {
    const receipt = { logs: [log('0xaa', hex(1)), log('0xbb', hex(9)), log('0xaa', hex(3))] };
    expect(idsFromReceipt(receipt, { topic0: '0xaa', idTopic: 1 })).toBe('3');
  });

  test('many: every matching event, in order — the eleven token ids', () => {
    const receipt = { logs: Array.from({ length: 11 }, (_, i) => log('0xmint', hex(0), hex(100 + i))) };
    expect(idsFromReceipt(receipt, { topic0: '0xmint', idTopic: 2, many: true }))
      .toEqual(Array.from({ length: 11 }, (_, i) => String(100 + i)));
  });

  test('requireTopic1 filters foreign events sharing the signature', () => {
    const receipt = { logs: [log('0xaa', '0xme', hex(7)), log('0xaa', '0xother', hex(8))] };
    expect(idsFromReceipt(receipt, { topic0: '0xaa', requireTopic1: '0xme', idTopic: 2 })).toBe('7');
  });

  test('a confirmed receipt with no matching event throws the resume line', () => {
    expect(() => idsFromReceipt({ logs: [] }, { topic0: '0xaa', idTopic: 1 }))
      .toThrow(/try again to resume/);
  });
});

describe('packFlatSkills', () => {
  test('outfielders: 55 in every lane, 10 in the GK lane', () => {
    const packed = BigInt(packFlatSkills(false));
    for (let lane = 0; lane < 11; lane++)
      expect(Number((packed >> BigInt(lane * 8)) & 0xffn), `lane ${lane}`).toBe(55);
    expect(Number((packed >> 88n) & 0xffn)).toBe(10);
  });

  test('keepers: 85 in the GK lane', () => {
    expect(Number((BigInt(packFlatSkills(true)) >> 88n) & 0xffn)).toBe(85);
  });

  test('every golden role maps to an on-chain position', () => {
    for (const role of ['GK', 'CB', 'LB', 'RB', 'CM', 'LM', 'RM', 'LW', 'RW', 'ST'])
      expect(ROLE_POS[role as keyof typeof ROLE_POS]).toBeGreaterThanOrEqual(0);
  });
});

describe('countdown', () => {
  test('m:ss to the deadline, never negative', () => {
    const now = Date.parse('2026-08-31T12:00:00Z');
    expect(countdown('2026-08-31T12:04:51Z', now)).toBe('4:51');
    expect(countdown('2026-08-31T12:00:05Z', now)).toBe('0:05');
    expect(countdown('2026-08-31T11:59:00Z', now)).toBe('0:00');
  });
});
