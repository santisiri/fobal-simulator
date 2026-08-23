// Money formatting, where a rounding bug is a real bug. Everything is
// BigInt end to end: these tests exist to prove no Number sneaks in.
import { describe, expect, test } from 'vitest';
import { formatEth, assetLabel, priceLabel, priceMove } from '../src/ui/money.js';

describe('formatEth', () => {
  test('whole and fractional ETH, trailing zeros trimmed', () => {
    expect(formatEth('1000000000000000000')).toBe('1');
    expect(formatEth('2500000000000000000')).toBe('2.5');
    expect(formatEth('15000000000000000')).toBe('0.015');
    expect(formatEth('0')).toBe('0');
  });

  test('values far beyond Number.MAX_SAFE_INTEGER stay exact', () => {
    // 1234567.891 ETH — a float would have lost this long ago
    expect(formatEth('1234567891000000000000000')).toBe('1,234,567.891');
    // 2^95 wei is 39614081257.132168796771975168 ETH — shown truncated,
    // never rounded up, so a displayed price can never overstate the real one
    expect(formatEth((2n ** 95n).toString())).toBe('39,614,081,257.1321');
  });

  test('a dust price never renders as a flat zero — that would misprice a sale', () => {
    expect(formatEth('1')).toBe('0.0001');            // floored to the last shown place
    expect(formatEth('1')).not.toBe('0');
  });

  test('garbage in, dash out', () => {
    expect(formatEth('not-a-number')).toBe('—');
    expect(formatEth(undefined)).toBe('0');
  });
});

describe('labels', () => {
  test('address zero is ETH; anything else shows short', () => {
    expect(assetLabel('0x' + '0'.repeat(40))).toBe('ETH');
    expect(assetLabel('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe('0xA0b8…');
    expect(priceLabel('2500000000000000000', '0x' + '0'.repeat(40))).toBe('2.5 ETH');
  });
});

describe('priceMove', () => {
  test('direction and percentage from two sales', () => {
    expect(priceMove('100', '150')).toEqual({ direction: 'up', percent: '50' });
    expect(priceMove('200', '100')).toEqual({ direction: 'down', percent: '50' });
    expect(priceMove('100', '100')).toEqual({ direction: 'flat', percent: '0' });
  });

  test('big-number moves keep their precision', () => {
    expect(priceMove('1000000000000000000', '2500000000000000000'))
      .toEqual({ direction: 'up', percent: '150' });
  });

  test('no baseline, no claim', () => {
    expect(priceMove('0', '100')).toBeNull();
    expect(priceMove('x', '100')).toBeNull();
  });
});
