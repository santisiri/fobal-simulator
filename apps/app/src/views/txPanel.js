// The ONE transaction-lifecycle panel (mockup 3g: "same lifecycle
// component everywhere: signings, listings, club founding"). Renders a
// createTxFlow snapshot into .txflow markup (atoms in ui.css): the action,
// the shared state line, the hash as an explorer link, failure in plain
// words with one retry — and the settled moment plays the ELEVEN-PIP
// ripple in ownership purple, the product's signature acknowledgment.
import { elevenPips, esc, html } from '../ui.js';

/**
 * @param {HTMLElement} el         container; cleared while the flow is idle
 * @param {any} snap               createTxFlow snapshot
 * @param {{ txStateLine: Function, explorerBase?: string, onRetry?: Function,
 *           settledLine?: string }} options
 */
export function renderTxPanel(el, snap, { txStateLine, explorerBase = 'https://sepolia.basescan.org', onRetry, settledLine = 'Settled — it is yours.' } = {}) {
  if (!snap || snap.state === 'idle') {
    el.replaceChildren();
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const busy = !['success', 'failure'].includes(snap.state);
  const mark = snap.state === 'success' ? '✓' : snap.state === 'failure' ? '✗' : '<span class="spin"></span>';
  const hashRow = snap.txHash
    ? `<div class="txHash">tx <a href="${esc(explorerBase)}/tx/${esc(snap.txHash)}" target="_blank" rel="noopener">${esc(snap.txHash.slice(0, 10))}…${esc(snap.txHash.slice(-6))}</a></div>`
    : '';
  const failure = snap.state === 'failure' && snap.error
    ? `<div class="txErr">${esc(snap.error.message ?? 'that did not go through')}</div>
       ${snap.error.detail ? `<details><summary>details</summary>${esc(snap.error.detail)}</details>` : ''}
       ${snap.error.retryable && onRetry ? '<button class="sm txRetry" data-tx-retry>Try again</button>' : ''}`
    : '';
  const settled = snap.state === 'success'
    ? `<div class="txSettled">${elevenPips(true)}<span>${esc(settledLine)}</span></div>`
    : '';
  html(el, `
    <div class="txflow${snap.state === 'success' ? ' ok' : ''}">
      <div class="txAction">${esc(snap.action)}</div>
      <div class="txLine">${mark}
        <span>${snap.state === 'failure' ? 'stopped — nothing was lost' : esc(txStateLine(snap))}</span></div>
      ${hashRow}${failure}${settled}
    </div>`);
  if (busy) return;
  el.querySelector('[data-tx-retry]')?.addEventListener('click', () => onRetry?.());
  if (snap.state === 'success') {
    // arm a frame later so the stagger actually plays
    requestAnimationFrame(() => el.querySelector('.ripple')?.classList.add('ripple--go'));
  }
}
