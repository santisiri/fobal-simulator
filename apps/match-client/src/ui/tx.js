// Transaction-flow state machine (product-UI workstream).
// A single vocabulary for every on-chain interaction the game performs:
//
//   preparing → wallet → submitted → confirming → indexing → success
//                                                          ↘ failure
//
// The machine is PURE (node-tested); rendering subscribes to it. Multi-
// transaction flows (the mint's create-team → mint-squad → declare-roster)
// model each on-chain step as a labelled leg that re-walks
// wallet→submitted→confirming, so the player always knows which of the
// N transactions their wallet is showing and why.

export const TX_STATES = ['idle', 'preparing', 'wallet', 'submitted', 'confirming', 'indexing', 'success', 'failure'];

export function createTxFlow({ action, onChange } = {}) {
  const flow = {
    action: action ?? 'Transaction',
    state: 'idle',
    /** current leg label when a flow spans several transactions */
    leg: null,
    legsDone: 0,
    txHash: null,
    error: null,          // NormalizedError when state === 'failure'
    startedAt: null,
  };
  const emit = () => { try { onChange?.({ ...flow }); } catch { /* render must not break the flow */ } };

  const to = (state, patch = {}) => {
    flow.state = state;
    Object.assign(flow, patch);
    emit();
  };

  return {
    get snapshot() { return { ...flow }; },
    /** building the request (server round trip, encoding)
     *  @param {string|null} [leg] */
    preparing(leg = null) { to('preparing', { leg, txHash: null, error: null, startedAt: flow.startedAt ?? Date.now() }); },
    /** the wallet popup is (or should be) open
     *  @param {string|null} [leg] */
    wallet(leg = flow.leg) { to('wallet', { leg }); },
    /** the wallet returned a hash — it is on its way */
    submitted(txHash) { to('submitted', { txHash }); },
    /** waiting for the chain to include it */
    confirming() { to('confirming'); },
    /** one leg confirmed; more remain */
    legDone() { flow.legsDone += 1; emit(); },
    /** chain done — reading fresh state back (link, refetch, re-render) */
    indexing() { to('indexing'); },
    success() { to('success', { leg: null }); },
    /** expects a NormalizedError (errors.js)
     *  @param {{message?: string}|null} error */
    failure(error) { to('failure', { error }); },
    reset() { to('idle', { leg: null, legsDone: 0, txHash: null, error: null, startedAt: null }); },
  };
}

/** Human line per state — shared so every surface says the same words. */
export function txStateLine(snap) {
  const leg = snap.leg ? `${snap.leg}: ` : '';
  switch (snap.state) {
    case 'preparing': return `${leg}preparing…`;
    case 'wallet': return `${leg}confirm in your wallet`;
    case 'submitted': return `${leg}sent — waiting for the chain`;
    case 'confirming': return `${leg}confirming on-chain…`;
    case 'indexing': return 'confirmed — updating your club…';
    case 'success': return 'done';
    case 'failure': return snap.error?.message ?? 'failed';
    default: return '';
  }
}
