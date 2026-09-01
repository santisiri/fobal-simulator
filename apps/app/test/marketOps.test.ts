// Which trade the market sheet offers a viewer — pure, and honest: nothing
// anyone cannot actually do, wallet addresses compared case-insensitively,
// and email accounts told plainly that trading is a wallet thing.
import { describe, expect, test } from 'vitest';
import { tradeChoice } from '../src/views/marketOps.js';

const W = '0xAbCd000000000000000000000000000000000001';
const OTHER = '0x9999000000000000000000000000000000000009';

describe('tradeChoice', () => {
  test('signed out (or email account): the wallet door, whatever the lot', () => {
    expect(tradeChoice(null, { listing: { seller: OTHER } }).kind).toBe('signin');
    expect(tradeChoice({ wallet: null }, {}).kind).toBe('signin');
  });

  test('my own listing → cancel, case-insensitively', () => {
    const out = tradeChoice({ wallet: W }, { listing: { seller: W.toLowerCase() }, player: { owner: OTHER } });
    expect(out.kind).toBe('cancel');
  });

  test('someone else\'s listing → buy', () => {
    expect(tradeChoice({ wallet: W }, { listing: { seller: OTHER } }).kind).toBe('buy');
  });

  test('unlisted and mine → list; unlisted and not mine → nothing', () => {
    expect(tradeChoice({ wallet: W }, { player: { owner: W.toUpperCase() } }).kind).toBe('list');
    expect(tradeChoice({ wallet: W }, { player: { owner: OTHER } }).kind).toBe('none');
    expect(tradeChoice({ wallet: W }, {}).kind).toBe('none');
  });

  test('a seller match wins over ownership (the escrowed player is the marketplace\'s)', () => {
    // while listed, the marketplace contract may hold the token — the
    // SELLER field is the identity that matters for cancel
    const out = tradeChoice({ wallet: W }, { listing: { seller: W }, player: { owner: OTHER } });
    expect(out.kind).toBe('cancel');
  });
});
