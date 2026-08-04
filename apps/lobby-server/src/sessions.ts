// Stateless HMAC-signed lobby sessions — the same token shape the match
// server uses for match access, but scoped to an account instead of a match.
// A session is bearer-only (no cookies), so CORS can stay permissive without
// granting anything by itself.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  accountId: string;
  iat: number;                  // issued-at, ms epoch
}

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const b64u = (buf: Buffer): string => buf.toString('base64url');
const mac = (data: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(data).digest();

export function signSession(accountId: string, secret: string, now = Date.now()): string {
  const data = b64u(Buffer.from(JSON.stringify({ accountId, iat: now }), 'utf8'));
  return `${data}.${b64u(mac(data, secret))}`;
}

export function verifySession(token: string, secret: string, now = Date.now()): SessionPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  let given: Buffer;
  try { given = Buffer.from(token.slice(dot + 1), 'base64url'); } catch { return null; }
  const expected = mac(data, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.accountId !== 'string' || typeof payload.iat !== 'number') return null;
    if (now - payload.iat > SESSION_MAX_AGE_MS) return null;
    return payload;
  } catch { return null; }
}
