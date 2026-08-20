// The browser keccak must be the same function the chain uses, or the
// preview shows players the mint will not produce.
import { describe, expect, test } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
// @ts-expect-error — plain JS module
import { keccak256 } from '../src/keccak-web.js';

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

describe('standalone keccak-256', () => {
  test('matches the known empty-input digest', () => {
    expect(hex(keccak256(new Uint8Array(0))))
      .toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  });

  test('matches @noble across lengths that straddle the 136-byte rate', () => {
    for (const len of [0, 1, 31, 32, 55, 64, 135, 136, 137, 200, 272, 273, 1000]) {
      const msg = new Uint8Array(len).map((_, i) => (i * 37 + len) & 0xff);
      expect(hex(keccak256(msg)), `length ${len}`).toBe(hex(keccak_256(msg)));
    }
  });

  test('matches @noble over 300 random inputs', () => {
    let state = 12345;
    const rnd = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 300; i++) {
      const msg = new Uint8Array(Math.floor(rnd() * 300)).map(() => Math.floor(rnd() * 256));
      expect(hex(keccak256(msg))).toBe(hex(keccak_256(msg)));
    }
  });
});
