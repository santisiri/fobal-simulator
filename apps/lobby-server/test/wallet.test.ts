// D2 — wallet auth. Signatures are REAL (noble secp256k1, the same math a
// wallet does); only the wallet UI is absent. The contract under test:
// challenge → sign → verify mints a session indistinguishable from an email
// session, nonces are one-shot, and nothing here needs an RPC endpoint.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { startMatchServer } from '@fobal/match-server';
import { recoverPersonalSigner, startLobbyServer, LobbyServerOptions } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-wallet-'));

// a deterministic test wallet (anvil's #9 — well-known, never real money)
const PRIV = Buffer.from('2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', 'hex');
const pub = secp256k1.getPublicKey(PRIV, false);
const ADDRESS = `0x${Buffer.from(keccak_256(pub.subarray(1)).slice(-20)).toString('hex')}`;

function personalSign(message: string, priv: Uint8Array): string {
  const body = Buffer.from(message, 'utf8');
  const digest = keccak_256(
    Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8'), body]),
  );
  const sig = secp256k1.sign(digest, priv);
  return `0x${sig.toCompactHex()}${(27 + sig.recovery!).toString(16)}`;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function boot(overrides: Partial<LobbyServerOptions> = {}){
  const match = await startMatchServer({ port: 0, storeRoot: tmp(), createKey: 'ck', autoDrive: false });
  const lobby = await startLobbyServer({
    port: 0, authRequestIntervalMs: 0,
    matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'ck' },
    ...overrides,
  });
  const base = `http://127.0.0.1:${lobby.port}`;
  return { base, close: async () => { await lobby.close(); await match.close(); } };
}

async function login(base: string): Promise<{ token: string; account: { accountId: string; wallet?: string } }> {
  const { message } = await (await post(`${base}/auth/wallet`, { address: ADDRESS })).json() as { message: string };
  const res = await post(`${base}/auth/wallet/verify`, {
    address: ADDRESS, signature: personalSign(message, PRIV),
  });
  expect(res.status).toBe(200);
  return await res.json() as { token: string; account: { accountId: string; wallet?: string } };
}

describe('wallet auth', () => {
  test('challenge → sign → verify mints a working session; account carries the wallet', async () => {
    const { base, close } = await boot();
    try {
      const { token, account } = await login(base);
      expect(account.wallet).toBe(ADDRESS);
      const lobby = await fetch(`${base}/lobby`, { headers: { authorization: `Bearer ${token}` } });
      expect(lobby.status).toBe(200);
      const me = (await lobby.json() as { me: { wallet?: string } }).me;
      expect(me.wallet).toBe(ADDRESS);
    } finally { await close(); }
  });

  test('same wallet, second login — SAME account (the second-device story)', async () => {
    const { base, close } = await boot();
    try {
      const first = await login(base);
      const second = await login(base);
      expect(second.account.accountId).toBe(first.account.accountId);
    } finally { await close(); }
  });

  test('a challenge is one-shot and a wrong key never verifies', async () => {
    const { base, close } = await boot();
    try {
      const { message } = await (await post(`${base}/auth/wallet`, { address: ADDRESS })).json() as { message: string };
      const wrongKey = Buffer.from('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'hex');
      const forged = await post(`${base}/auth/wallet/verify`, {
        address: ADDRESS, signature: personalSign(message, wrongKey),
      });
      expect(forged.status).toBe(401);
      // the honest signature still works (failed attempts don't burn it)…
      const ok = await post(`${base}/auth/wallet/verify`, {
        address: ADDRESS, signature: personalSign(message, PRIV),
      });
      expect(ok.status).toBe(200);
      // …but only ONCE
      const replay = await post(`${base}/auth/wallet/verify`, {
        address: ADDRESS, signature: personalSign(message, PRIV),
      });
      expect(replay.status).toBe(401);
    } finally { await close(); }
  });

  test('garbage in, 400/401 out — never a crash', async () => {
    const { base, close } = await boot();
    try {
      expect((await post(`${base}/auth/wallet`, { address: 'not-an-address' })).status).toBe(400);
      expect((await post(`${base}/auth/wallet/verify`, { address: ADDRESS, signature: '0xdeadbeef' })).status).toBe(401);
      expect(recoverPersonalSigner('m', '0x' + '00'.repeat(65))).toBeNull();
      expect(recoverPersonalSigner('m', 'zz')).toBeNull();
    } finally { await close(); }
  });

  test('recoverPersonalSigner round-trips a known key (unit, no server)', () => {
    const message = 'FOBAL test message';
    expect(recoverPersonalSigner(message, personalSign(message, PRIV))).toBe(ADDRESS);
  });
});
