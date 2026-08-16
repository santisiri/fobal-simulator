// M5 — POST /mint/prepare gating. The step machine itself is oracle-tested
// in mint.test.ts; here the contract is the DOOR: no session → 401, email
// session → 403 (minting needs a wallet — NFTs must land in an address the
// player controls), unconfigured lobby → 501, and MintError statuses pass
// through untouched.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { startMatchServer } from '@fobal/match-server';
import { startLobbyServer, LobbyServerOptions, MintError } from '../src/index.js';
import type { MintService } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-mint-'));

// anvil's #9 — well-known throwaway, never real money
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
    port: 0, authRequestIntervalMs: 0, devAuth: true,
    matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'ck' },
    ...overrides,
  });
  const base = `http://127.0.0.1:${lobby.port}`;
  return { base, close: async () => { await lobby.close(); await match.close(); } };
}

async function walletLogin(base: string): Promise<string> {
  const { message } = await (await post(`${base}/auth/wallet`, { address: ADDRESS })).json() as { message: string };
  const res = await post(`${base}/auth/wallet/verify`, {
    address: ADDRESS, signature: personalSign(message, PRIV),
  });
  return (await res.json() as { token: string }).token;
}

async function emailLogin(base: string): Promise<string> {
  const { devCode } = await (await post(`${base}/auth/request`, { email: 'coach@fobal.ai' })).json() as { devCode: string };
  const res = await post(`${base}/auth/verify`, { email: 'coach@fobal.ai', code: devCode });
  return (await res.json() as { token: string }).token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const BODY = { teamName: 'GOLDEN PUPPETS', seeds: [] };

describe('POST /mint/prepare gating', () => {
  test('401 without a session; 403 for an email session (no wallet)', async () => {
    const { base, close } = await boot();
    try {
      expect((await post(`${base}/mint/prepare`, BODY)).status).toBe(401);
      const token = await emailLogin(base);
      const res = await post(`${base}/mint/prepare`, BODY, auth(token));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/wallet/);
    } finally { await close(); }
  });

  test('501 when the lobby has no mint service', async () => {
    const { base, close } = await boot();
    try {
      const token = await walletLogin(base);
      expect((await post(`${base}/mint/prepare`, BODY, auth(token))).status).toBe(501);
    } finally { await close(); }
  });

  test('wallet + service: bad bodies 400, MintError status passes through, plans flow', async () => {
    const seen: string[] = [];
    const mintService: MintService = {
      prepare: async (wallet, teamName) => {
        seen.push(wallet, teamName);
        if (teamName === 'REJECTED') throw new MintError(422, 'squad power 1200 exceeds budget');
        return { done: false, tx: { step: 'create-team', description: 'Create your team', to: '0xr', data: '0x00' } };
      },
    } as MintService;
    const { base, close } = await boot({ mintService });
    try {
      const token = await walletLogin(base);
      expect((await post(`${base}/mint/prepare`, { teamName: 'X' }, auth(token))).status).toBe(400);

      const rejected = await post(`${base}/mint/prepare`, { ...BODY, teamName: 'REJECTED' }, auth(token));
      expect(rejected.status).toBe(422);
      expect(((await rejected.json()) as { error: string }).error).toMatch(/budget/);

      const ok = await post(`${base}/mint/prepare`, BODY, auth(token));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ done: false, tx: { step: 'create-team' } });
      // the wallet passed to the service is the SESSION's wallet — the
      // caller can't mint into someone else's address
      expect(seen[0]).toBe(ADDRESS);
    } finally { await close(); }
  });
});
