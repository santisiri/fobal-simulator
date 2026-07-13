// Stateless HMAC-signed access tokens. Issued at match creation; verified on
// every WebSocket hello. A token grants exactly one role on exactly one match.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenPayload {
  matchId: string;
  role: 'controller' | 'spectator';
  teamId?: string;              // required when role === 'controller'
}

const b64u = (buf: Buffer): string => buf.toString('base64url');

function mac(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function signToken(payload: TokenPayload, secret: string): string {
  const data = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${data}.${b64u(mac(data, secret))}`;
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let given: Buffer;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  const expected = mac(data, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.matchId !== 'string') return null;
    if (payload.role !== 'controller' && payload.role !== 'spectator') return null;
    if (payload.role === 'controller' && typeof payload.teamId !== 'string') return null;
    return payload;
  } catch { return null; }
}
