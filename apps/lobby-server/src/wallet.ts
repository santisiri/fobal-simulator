// D2 — wallet auth beside email. SIWE-flavored challenge/response over
// EIP-191 personal_sign: the lobby hands out a one-shot nonce message, the
// wallet signs it, the server recovers the signer address offline. No RPC,
// no chain, no gas — a signature only ever proves control of a key to THIS
// lobby. Sessions come out the other end identical to email sessions.
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The exact text a wallet is asked to sign. Deliberately human-readable —
 *  wallets render it verbatim, and a player should be able to see that it
 *  authorizes nothing beyond a lobby login. */
export function challengeMessage(address: string, nonce: string, issuedAt: string): string {
  return [
    'FOBAL lobby wants you to sign in.',
    '',
    `Wallet: ${address.toLowerCase()}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
    '',
    'Signing proves wallet ownership to the lobby.',
    'This is not a transaction and costs nothing.',
  ].join('\n');
}

/** Recover the EIP-191 personal_sign signer of `message`. Returns the
 *  lowercase 0x address, or null for anything malformed — never throws. */
export function recoverPersonalSigner(message: string, signature: string): string | null {
  try {
    const hex = signature.startsWith('0x') ? signature.slice(2) : signature;
    if (!/^[0-9a-fA-F]{130}$/.test(hex)) return null;
    const bytes = Buffer.from(hex, 'hex');
    let v = bytes[64]!;
    if (v >= 27) v -= 27;
    if (v > 1) return null;
    const body = Buffer.from(message, 'utf8');
    const digest = keccak_256(
      Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8'), body]),
    );
    const pubkey = secp256k1.Signature
      .fromCompact(bytes.subarray(0, 64))
      .addRecoveryBit(v)
      .recoverPublicKey(digest)
      .toRawBytes(false);
    return `0x${Buffer.from(keccak_256(pubkey.subarray(1)).slice(-20)).toString('hex')}`;
  } catch {
    return null;
  }
}
