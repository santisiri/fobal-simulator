// Normalized wallet/chain error layer (product-UI workstream).
// One job: turn the raw soup of provider errors into a calm, useful
// message for the player, while preserving the technical detail for the
// "details" affordance and the console. Pure module — no DOM, unit-tested.

/** @typedef {{ message: string, detail: string, kind: string, retryable: boolean }} NormalizedError */

const RULES = [
  // [kind, test, message, retryable]
  ['rejected', e => e.code === 4001 || /user rejected|user denied|rejected the request/i.test(e.msg),
    'You declined the request in your wallet. Nothing was sent.', true],
  ['pending', e => e.code === -32002 || /already pending/i.test(e.msg),
    'Your wallet already has a request waiting — open it and finish or dismiss that first.', true],
  ['funds', e => /insufficient funds|exceeds balance/i.test(e.msg),
    'Not enough ETH in this wallet to pay for the transaction. Top it up and try again.', true],
  ['network', e => e.code === 4902 || /unrecognized chain|wrong network|chain mismatch|does not match the target chain/i.test(e.msg),
    'Your wallet is on the wrong network. Switch it to Base Sepolia and try again.', true],
  ['disconnected', e => e.code === 4900 || e.code === 4100 || /disconnected|not been authorized/i.test(e.msg),
    'Your wallet is disconnected. Reconnect it and try again.', true],
  ['replaced', e => /replaced|repriced|nonce too low/i.test(e.msg),
    'The transaction was replaced in your wallet (usually a speed-up). Check your wallet activity, then try again if it did not go through.', true],
  ['reverted', e => /reverted|revert|execution failed|status 0x0/i.test(e.msg),
    'The contract refused the transaction. Nothing was changed on-chain.', true],
  ['rpc', e => /fetch|network error|timeout|timed out|econn|rate limit|429|503|unavailable/i.test(e.msg),
    'The network node is not answering right now. Wait a moment and try again.', true],
  ['metadata', e => /metadata|tokenuri|failed to load player/i.test(e.msg),
    'Player data did not load. Pull to refresh or try again shortly.', true],
];

/** Normalize anything a wallet/RPC/fetch path can throw. Never throws.
 *  @returns {NormalizedError} */
export function normalizeWalletError(err) {
  const raw = err ?? {};
  const msg = String(raw.message ?? raw.reason ?? raw);
  const code = typeof raw.code === 'number' ? raw.code : undefined;
  const probe = { code, msg };
  for (const [kind, test, message, retryable] of RULES) {
    try {
      if (test(probe)) return { kind, message, retryable, detail: detailOf(raw, msg, code) };
    } catch { /* a rule must never break normalization */ }
  }
  return {
    kind: 'unknown',
    message: 'Something went wrong. Nothing was charged — you can try again.',
    retryable: true,
    detail: detailOf(raw, msg, code),
  };
}

function detailOf(raw, msg, code) {
  const parts = [];
  if (code !== undefined) parts.push(`code ${code}`);
  parts.push(msg.slice(0, 400));
  const inner = raw?.data?.message ?? raw?.error?.message;
  if (inner && inner !== msg) parts.push(String(inner).slice(0, 200));
  return parts.join(' — ');
}
