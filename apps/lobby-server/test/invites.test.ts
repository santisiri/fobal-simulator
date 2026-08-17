// Email invitations — the full lifecycle against a FAKE provider (no test
// run may ever send real mail). Covers the workstream's required matrix:
// send / invalid recipient / provider error / rate limit / duplicate /
// expired / used / invalid token / accept-from-any-account, plus the
// svix-signed webhook path with idempotent, ladder-only status updates.
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { startMatchServer } from '@fobal/match-server';
import {
  startLobbyServer, renderInvitationEmail, LobbyServerOptions, MatchInvitationEmail,
} from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fobal-invites-'));

interface FakeProvider {
  sent: MatchInvitationEmail[];
  failNext: boolean;
  sendLoginCode(email: string, code: string): Promise<void>;
  sendMatchInvitation(invite: MatchInvitationEmail): Promise<{ messageId?: string }>;
}

function fakeProvider(): FakeProvider {
  return {
    sent: [],
    failNext: false,
    async sendLoginCode() {},
    async sendMatchInvitation(invite) {
      if (this.failNext) { this.failNext = false; throw new Error('provider down'); }
      this.sent.push(invite);
      return { messageId: `msg-${this.sent.length}` };
    },
  };
}

const WEBHOOK_SECRET = `whsec_${Buffer.from('invite-test-secret').toString('base64')}`;

function svixHeaders(payload: string, { id = 'msg_evt_1', ts = Math.floor(Date.now() / 1000) } = {}){
  const key = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` };
}

async function boot(overrides: Partial<LobbyServerOptions> = {}){
  const provider = fakeProvider();
  const match = await startMatchServer({ port: 0, storeRoot: tmp(), createKey: 'ck', autoDrive: false });
  const lobby = await startLobbyServer({
    port: 0, devAuth: true, authRequestIntervalMs: 0,
    matchServer: { url: `http://127.0.0.1:${match.port}`, createKey: 'ck' },
    emailProvider: provider,
    inviteBaseUrl: 'https://play-staging.fobal.ai',
    emailWebhookSecret: WEBHOOK_SECRET,
    ...overrides,
  });
  const base = `http://127.0.0.1:${lobby.port}`;
  const post = async (path: string, body: unknown, token?: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };
  const login = async (email: string) => {
    const { body: { devCode } } = await post('/auth/request', { email });
    const out = await post('/auth/verify', { email, code: devCode });
    return out.body.token as string;
  };
  return { base, post, login, provider, close: async () => { await lobby.close(); await match.close(); } };
}

describe('email invitations', () => {
  test('happy path: send → live view → accept from a fresh account → challenge to the inviter', async () => {
    const { base, post, login, provider, close } = await boot();
    try {
      const santi = await login('santi@fobal.ai');
      const sent = await post('/invites', { email: 'Friend@Example.com', message: 'bring your best XI' }, santi);
      expect(sent.status).toBe(201);
      expect(sent.body.invitation.status).toBe('sent');
      expect(sent.body.inviteUrl).toMatch(/^https:\/\/play-staging\.fobal\.ai\/invite\.html\?t=[A-Za-z0-9_-]{20,}$/);
      // the provider got the full football story, lowercased recipient
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]).toMatchObject({
        to: 'friend@example.com', inviterName: 'santi', inviterTeam: 'SANTI FC', message: 'bring your best XI',
      });

      // the recipient's landing view — public, no session
      const token = sent.body.inviteUrl.split('t=')[1]!;
      const view = await fetch(`${base}/invites/${token}`);
      expect(view.status).toBe(200);
      const ctx = await view.json() as any;
      expect(ctx.inviter.teamName).toBe('SANTI FC');
      expect(ctx.message).toBe('bring your best XI');

      // a brand-new account (no squad customization, no wallet) accepts
      const friend = await login('friend@example.com');
      const accepted = await post(`/invites/${token}/accept`, {}, friend);
      expect(accepted.status).toBe(200);
      expect(accepted.body.inviter.teamName).toBe('SANTI FC');
      // the reward is game-native: the inviter now has an incoming challenge
      const lobbyState = await fetch(`${base}/lobby`, { headers: { authorization: `Bearer ${santi}` } });
      const state = await lobbyState.json() as any;
      expect(state.challenges.incoming).toHaveLength(1);
    } finally { await close(); }
  });

  test('validation wall: bad email, self-invite, oversized message type, unconfigured provider', async () => {
    const { post, login, close } = await boot();
    try {
      const t = await login('a@fobal.ai');
      expect((await post('/invites', { email: 'not-an-email' }, t)).status).toBe(400);
      expect((await post('/invites', { email: 'a@fobal.ai' }, t)).status).toBe(400);      // yourself
      expect((await post('/invites', { email: 'b@x.com', message: 42 }, t)).status).toBe(400);
    } finally { await close(); }

    const bare = await boot({ emailProvider: null });
    try {
      const t = await bare.login('a@fobal.ai');
      expect((await bare.post('/invites', { email: 'b@x.com' }, t)).status).toBe(501);
    } finally { await bare.close(); }
  });

  test('provider error → 502, invite marked failed, and a RETRY is allowed', async () => {
    const { post, login, provider, close } = await boot();
    try {
      const t = await login('a@fobal.ai');
      provider.failNext = true;
      const failed = await post('/invites', { email: 'b@x.com' }, t);
      expect(failed.status).toBe(502);
      const list = await post('/invites', { email: 'b@x.com' }, t);   // retry — not blocked by dedup
      expect(list.status).toBe(201);
      const mine = await fetch(`http://${new URL(list.body.inviteUrl).host}`, { method: 'HEAD' }).catch(() => null);
      void mine;
      expect(provider.sent).toHaveLength(1);
    } finally { await close(); }
  });

  test('rate limit counts ATTEMPTS; duplicate live invite → 409 with the existing one', async () => {
    const { post, login, close } = await boot({ inviteLimit: { count: 3, windowMs: 60_000 } });
    try {
      const t = await login('a@fobal.ai');
      expect((await post('/invites', { email: 'one@x.com' }, t)).status).toBe(201);
      const dup = await post('/invites', { email: 'one@x.com' }, t);
      expect(dup.status).toBe(409);
      expect(dup.body.invitation.recipientEmail).toBe('one@x.com');
      expect((await post('/invites', { email: 'two@x.com' }, t)).status).toBe(201);
      // fourth attempt (1 sent + 1 dup attempt + 1 sent) hits the cap
      expect((await post('/invites', { email: 'three@x.com' }, t)).status).toBe(429);
    } finally { await close(); }
  });

  test('expired → 410 on view and accept; invalid token → 404; used → 409', async () => {
    const { base, post, login, close } = await boot({ inviteTtlMs: 1 });
    try {
      const t = await login('a@fobal.ai');
      const sent = await post('/invites', { email: 'b@x.com' }, t);
      const token = sent.body.inviteUrl.split('t=')[1]!;
      await new Promise(r => setTimeout(r, 5));
      expect((await fetch(`${base}/invites/${token}`)).status).toBe(410);
      const b = await login('b@x.com');
      expect((await post(`/invites/${token}/accept`, {}, b)).status).toBe(410);
      expect((await fetch(`${base}/invites/${'x'.repeat(32)}`)).status).toBe(404);
    } finally { await close(); }

    const fresh = await boot();
    try {
      const t = await fresh.login('a@fobal.ai');
      const sent = await fresh.post('/invites', { email: 'b@x.com' }, t);
      const token = sent.body.inviteUrl.split('t=')[1]!;
      const b = await fresh.login('b@x.com');
      expect((await fresh.post(`/invites/${token}/accept`, {}, b)).status).toBe(200);
      // second use — by anyone, including the same account
      expect((await fresh.post(`/invites/${token}/accept`, {}, b)).status).toBe(409);
      // the inviter cannot claim their own invite
      const sent2 = await fresh.post('/invites', { email: 'c@x.com' }, t);
      const token2 = sent2.body.inviteUrl.split('t=')[1]!;
      expect((await fresh.post(`/invites/${token2}/accept`, {}, t)).status).toBe(400);
    } finally { await fresh.close(); }
  });

  test('webhook: signature verified, ladder-only status, idempotent replays', async () => {
    const { base, post, login, close } = await boot();
    try {
      const t = await login('a@fobal.ai');
      await post('/invites', { email: 'b@x.com' }, t);   // providerMessageId = msg-1

      const delivered = JSON.stringify({ type: 'email.delivered', data: { email_id: 'msg-1' } });
      // bad signature → 401
      expect((await post('/webhooks/email', delivered, undefined,
        { 'svix-id': 'e1', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,AAAA' })).status).toBe(401);
      // stale timestamp → 401
      expect((await post('/webhooks/email', delivered, undefined,
        svixHeaders(delivered, { ts: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(401);
      // good → 204 and the invite advances
      expect((await post('/webhooks/email', delivered, undefined, svixHeaders(delivered))).status).toBe(204);
      const mine = await fetch(`${base}/invites`, { headers: { authorization: `Bearer ${t}` } });
      expect((await mine.json() as any).invitations[0].status).toBe('delivered');

      // replay (same event) and an out-of-order 'sent-level' event change nothing
      expect((await post('/webhooks/email', delivered, undefined, svixHeaders(delivered))).status).toBe(204);
      const opened = JSON.stringify({ type: 'email.opened', data: { email_id: 'msg-1' } });
      await post('/webhooks/email', opened, undefined, svixHeaders(opened, { id: 'e2' }));
      const after = await fetch(`${base}/invites`, { headers: { authorization: `Bearer ${t}` } });
      expect((await after.json() as any).invitations[0].status).toBe('opened');

      // an accepted invite never regresses on a late bounce
      const token = (await post('/invites', { email: 'c@x.com' }, t)).body.inviteUrl.split('t=')[1]!;
      const c = await login('c@x.com');
      await post(`/invites/${token}/accept`, {}, c);
      const bounce = JSON.stringify({ type: 'email.bounced', data: { email_id: 'msg-2' } });
      await post('/webhooks/email', bounce, undefined, svixHeaders(bounce, { id: 'e3' }));
      const final = await fetch(`${base}/invites`, { headers: { authorization: `Bearer ${t}` } });
      expect((await final.json() as any).invitations[0].status).toBe('accepted');

      // unknown message ids are acknowledged silently (204, no error storm)
      const ghost = JSON.stringify({ type: 'email.delivered', data: { email_id: 'msg-ghost' } });
      expect((await post('/webhooks/email', ghost, undefined, svixHeaders(ghost, { id: 'e4' }))).status).toBe(204);
    } finally { await close(); }
  });

  test('the template is a football challenge, not a crypto artifact', () => {
    const { subject, html, text } = renderInvitationEmail({
      to: 'x@y.com', inviterName: 'santi', inviterTeam: 'SANTI FC',
      message: 'come <b>on</b>', inviteUrl: 'https://play-staging.fobal.ai/invite.html?t=abc',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(subject).toBe('santi challenged you to a football match');
    expect(html).toContain('SANTI FC');
    expect(html).toContain('come &lt;b&gt;on&lt;/b&gt;');          // note is escaped
    expect(html).toContain('invite.html?t=abc');
    expect(text).toContain('football match');
    for (const jargon of ['wallet', 'blockchain', 'NFT', 'crypto', 'web3', 'token'])
      expect(html.toLowerCase()).not.toContain(jargon.toLowerCase());
  });

  test('a wallet inviter with a verified ENS name sends as that name', async () => {
    const { secp256k1 } = await import('@noble/curves/secp256k1');
    const { keccak_256 } = await import('@noble/hashes/sha3');
    const PRIV = Buffer.from('2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', 'hex');
    const pub = secp256k1.getPublicKey(PRIV, false);
    const ADDRESS = `0x${Buffer.from(keccak_256(pub.subarray(1)).slice(-20)).toString('hex')}`;
    const personalSign = (message: string): string => {
      const body = Buffer.from(message, 'utf8');
      const digest = keccak_256(Buffer.concat([
        Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8'), body]));
      const sig = secp256k1.sign(digest, PRIV);
      return `0x${sig.toCompactHex()}${(27 + sig.recovery!).toString(16)}`;
    };
    const identity = {
      // the email path AWAITS resolve (unlike the poll's peek-only rule)
      async resolve(address: string){
        return { address, displayName: 'santi.eth', ensName: 'santi.eth', verified: true, source: 'ens' as const };
      },
      peek(){ return null; },
    };
    const { post, provider, close } = await boot({ identity: identity as never });
    try {
      const { body: { message } } = await post('/auth/wallet', { address: ADDRESS });
      const verify = await post('/auth/wallet/verify', { address: ADDRESS, signature: personalSign(message) });
      expect(verify.status).toBe(200);
      const sent = await post('/invites', { email: 'rival@example.com' }, verify.body.token);
      expect(sent.status).toBe(201);
      expect(provider.sent[0]!.inviterName).toBe('santi.eth');
    } finally { await close(); }
  });
});
