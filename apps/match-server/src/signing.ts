// Ed25519 signing of final MatchResults. The signature covers the canonical
// JSON of the result with the signature field removed; Ed25519 is
// deterministic, so re-signing an identical result yields an identical
// signature (idempotent result processing stays byte-stable).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, KeyObject } from 'node:crypto';
import { canonicalJson, MatchResult } from '@fobal/protocol';

export interface SigningKeys { privateKey: KeyObject; publicKey: KeyObject }

export function generateSigningKeys(): SigningKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey };
}

export function keysFromPem(privatePem: string): SigningKeys {
  const privateKey = createPrivateKey(privatePem);
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export function exportPrivatePem(keys: SigningKeys): string {
  return keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function payloadOf(result: MatchResult): Buffer {
  const { signature: _drop, ...rest } = result;
  return Buffer.from(canonicalJson(rest), 'utf8');
}

export function signResult(result: MatchResult, keys: SigningKeys): MatchResult {
  const value = sign(null, payloadOf(result), keys.privateKey).toString('base64');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { ...result, signature: { algorithm: 'Ed25519', publicKey, value } };
}

export function verifyResult(result: MatchResult): boolean {
  if (!result.signature) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(result.signature.publicKey, 'base64'), type: 'spki', format: 'der',
    });
    return verify(null, payloadOf(result), publicKey, Buffer.from(result.signature.value, 'base64'));
  } catch { return false; }
}
