// Wallet identity — verified ENS names. The ENS client is faked; under
// test is the CONTRACT: a name only counts as identity after the forward
// check maps it back to the same address, every failure degrades to the
// shortened address without ever rejecting, caching/dedup keep mainnet
// traffic bounded, and the hub decorates every public account surface.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { startMatchServer } from '@fobal/match-server';
import {
  createIdentityResolver, shortAddress, startLobbyServer, EnsClient,
} from '../src/index.js';

const SANTI = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const OTHER = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';

interface FakeEns {
  client: EnsClient;
  calls: { name: number; address: number; avatar: number };
}

function fakeEns(overrides: Partial<EnsClient> = {}): FakeEns {
  const calls = { name: 0, address: 0, avatar: 0 };
  return {
    calls,
    client: {
      getEnsName: async ({ address }) => {
        calls.name++;
        return address.toLowerCase() === SANTI ? 'santi.eth' : null;
      },
      getEnsAddress: async ({ name }) => {
        calls.address++;
        return name === 'santi.eth' ? SANTI : null;
      },
      getEnsAvatar: async () => { calls.avatar++; return 'https://ens.example/santi.png'; },
      ...overrides,
    },
  };
}

describe('identity resolver', () => {
  test('valid mainnet primary name: reverse + forward verified, avatar aboard', async () => {
    const { client } = fakeEns();
    const id = await createIdentityResolver({ client }).resolve(SANTI);
    expect(id).toEqual({
      address: SANTI, displayName: 'santi.eth', ensName: 'santi.eth',
      ensAvatar: 'https://ens.example/santi.png', verified: true, source: 'ens-mainnet',
    });
  });

  test('no ENS: shortened address, never verified', async () => {
    const { client } = fakeEns();
    const id = await createIdentityResolver({ client }).resolve(OTHER);
    expect(id.displayName).toBe('0x90f7…b906');
    expect(id.verified).toBe(false);
    expect(id.ensName).toBeUndefined();
    expect(id.source).toBe('address');
  });

  test('forward/reverse MISMATCH: the claimed name is refused (the security case)', async () => {
    const { client } = fakeEns({
      getEnsName: async () => 'stolen-name.eth',
      getEnsAddress: async () => OTHER,        // resolves to someone else
    });
    const id = await createIdentityResolver({ client }).resolve(SANTI);
    expect(id.verified).toBe(false);
    expect(id.ensName).toBeUndefined();
    expect(id.displayName).toBe(shortAddress(SANTI));
  });

  test('a reverse record whose forward resolution is EMPTY is refused too', async () => {
    const { client } = fakeEns({ getEnsAddress: async () => null });
    const id = await createIdentityResolver({ client }).resolve(SANTI);
    expect(id.verified).toBe(false);
  });

  test('RPC failure: fallback identity, short TTL, retry succeeds after it', async () => {
    let now = 1_000_000;
    let dead = true;
    const { client } = fakeEns({
      getEnsName: async ({ address }) => {
        if (dead) throw new Error('rpc down');
        return address.toLowerCase() === SANTI ? 'santi.eth' : null;
      },
    });
    const resolver = createIdentityResolver({ client, errorTtlMs: 1000, now: () => now });
    expect((await resolver.resolve(SANTI)).verified).toBe(false);   // degraded, not thrown
    dead = false;
    expect((await resolver.resolve(SANTI)).verified).toBe(false);   // still cached (error ttl)
    now += 1500;                                                     // error ttl expired
    expect((await resolver.resolve(SANTI)).ensName).toBe('santi.eth');
  });

  test('avatar failure never spoils a verified identity', async () => {
    const { client } = fakeEns({ getEnsAvatar: async () => { throw new Error('gateway down'); } });
    const id = await createIdentityResolver({ client }).resolve(SANTI);
    expect(id.verified).toBe(true);
    expect(id.ensAvatar).toBeUndefined();
  });

  test('cache: a fresh entry answers without touching the client', async () => {
    const { client, calls } = fakeEns();
    const resolver = createIdentityResolver({ client });
    await resolver.resolve(SANTI);
    const after = calls.name;
    await resolver.resolve(SANTI);
    await resolver.resolve(SANTI.toUpperCase().replace('0X', '0x'));  // case-insensitive key
    expect(calls.name).toBe(after);
    expect(resolver.peek(SANTI)?.ensName).toBe('santi.eth');
  });

  test('dedup: concurrent resolves share ONE lookup', async () => {
    const { client, calls } = fakeEns();
    const resolver = createIdentityResolver({ client });
    await Promise.all([resolver.resolve(SANTI), resolver.resolve(SANTI), resolver.resolve(SANTI)]);
    expect(calls.name).toBe(1);
  });

  test('wallet switching: two addresses, two independent identities', async () => {
    const { client } = fakeEns();
    const resolver = createIdentityResolver({ client });
    const [a, b] = await Promise.all([resolver.resolve(SANTI), resolver.resolve(OTHER)]);
    expect(a.ensName).toBe('santi.eth');
    expect(b.ensName).toBeUndefined();
    expect(resolver.peek(OTHER)?.displayName).toBe(shortAddress(OTHER));
  });
});

// ---------------------------------------------------------------------------
// hub integration: the identity decorates every public account surface
// ---------------------------------------------------------------------------

const PRIV = Buffer.from('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'hex');
const pub = secp256k1.getPublicKey(PRIV, false);
const WALLET = `0x${Buffer.from(keccak_256(pub.subarray(1)).slice(-20)).toString('hex')}`;

function personalSign(message: string): string {
  const body = Buffer.from(message, 'utf8');
  const digest = keccak_256(
    Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8'), body]),
  );
  const sig = secp256k1.sign(digest, PRIV);
  return `0x${sig.toCompactHex()}${(27 + sig.recovery!).toString(16)}`;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('hub integration', () => {
  test('wallet account carries its verified name on /lobby (me AND roster); email accounts are untouched', async () => {
    const { client } = fakeEns({
      getEnsName: async ({ address }) => address.toLowerCase() === WALLET ? 'coach.eth' : null,
      getEnsAddress: async ({ name }) => name === 'coach.eth' ? WALLET : null,
      getEnsAvatar: async () => null,
    });
    const match = await startMatchServer({
      port: 0, storeRoot: mkdtempSync(join(tmpdir(), 'fobal-id-')), createKey: 'ck', autoDrive: false,
    });
    const lobby = await startLobbyServer({
      port: 0, devAuth: true, authRequestIntervalMs: 0,
      matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'ck' },
      identity: createIdentityResolver({ client }),
    });
    const base = `http://127.0.0.1:${lobby.port}`;
    try {
      const { message } = await (await post(`${base}/auth/wallet`, { address: WALLET })).json() as { message: string };
      const { token } = await (await post(`${base}/auth/wallet/verify`, {
        address: WALLET, signature: personalSign(message),
      })).json() as { token: string };

      // first poll warms the cache; the name lands by the second — the
      // asynchronous-decoration contract
      const get = async () => (await (await fetch(`${base}/lobby`, {
        headers: { authorization: `Bearer ${token}` } })).json()) as {
        me: { identity?: { displayName: string; verified: boolean; ensName?: string } } };
      await get();
      await new Promise(r => setTimeout(r, 20));
      const state = await get();
      expect(state.me.identity).toMatchObject({ displayName: 'coach.eth', ensName: 'coach.eth', verified: true });

      // an email opponent sees the wallet player's name in THEIR roster
      const { devCode } = await (await post(`${base}/auth/request`, { email: 'rival@fobal.ai' })).json() as { devCode: string };
      const rival = await (await post(`${base}/auth/verify`, { email: 'rival@fobal.ai', code: devCode })).json() as { token: string };
      const roster = (await (await fetch(`${base}/lobby`, {
        headers: { authorization: `Bearer ${rival.token}` } })).json()) as {
        me: { identity?: unknown }; players: Array<{ identity?: { displayName: string } }> };
      expect(roster.me.identity).toBeUndefined();                       // email account: no identity block
      expect(roster.players.some(p => p.identity?.displayName === 'coach.eth')).toBe(true);
    } finally { await lobby.close(); await match.close(); }
  });
});
