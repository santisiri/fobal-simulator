// The market — /market and /market/:tokenId. Absorbs market.html.
//
// Public chain data: anyone may window-shop signed out; buying, selling
// and cancelling need a wallet session (the sheet offers the wallet door
// inline). The player sheet IS the deep link — opening a lot navigates to
// /market/:tokenId, back closes it, and a refresh anywhere lands right.
//
// Writes follow the proven shape: the server prepares calldata
// (/market/prepare), YOUR wallet sends it, the receipt drives the UI
// through the one tx-lifecycle panel — settled plays the eleven pips.
import { esc, html, pick } from '../ui.js';
import { tradeChoice } from './marketOps.js';
import { renderTxPanel } from './txPanel.js';

/**
 * @param {HTMLElement} el
 * @param {{ auth: any, router: any, deps: any, lobbyUrl: string,
 *           params?: Record<string, string> }} ctx
 * @returns {{ dispose(): void, update(match: any): void }}
 */
export function mountMarket(el, { auth, router, deps, lobbyUrl, params = {} }) {
  const { avatarTile, formatEth, assetLabel, priceLabel, priceMove, ethToWei,
    createTxFlow, txStateLine, normalizeWalletError } = deps;

  let disposed = false;
  let openToken = null;        // the tokenId the sheet is showing
  let listedIds = [];

  // the market is public — authenticated when a session exists, plain otherwise
  const api = (path) => auth.state.status === 'signed_in'
    ? auth.api(path)
    : fetch(`${lobbyUrl}${path}`);

  html(el, `
    <div class="marketwrap">
      <section class="panel roomcard">
        <h2 class="label purple">The market</h2>
        <div class="ticker" id="ticker">
          <span class="skeleton mstat-skel"></span><span class="skeleton mstat-skel"></span>
          <span class="skeleton mstat-skel"></span><span class="skeleton mstat-skel"></span>
        </div>
      </section>
      <p class="err" id="mErr" role="alert"></p>
      <div class="lots" id="lots"></div>
      <p class="muted hidden" id="mEmpty">Nothing is for sale right now. When a manager lists a footballer, he appears here.</p>
      <section class="panel roomcard hidden" id="mineCard">
        <h2 class="label">Your players</h2>
        <p class="muted" style="margin:0 0 10px">Tap a footballer to name his price.</p>
        <div class="lots" id="mine"></div>
      </section>
    </div>
    <div class="drawerScrim hidden" id="mScrim"></div>
    <aside class="sheet" id="mSheet" role="dialog" aria-modal="true" aria-label="Player listing" aria-hidden="true"></aside>`);

  const sheet = pick(el, 'mSheet');
  const scrim = pick(el, 'mScrim');

  // ---- the shop window ---------------------------------------------------
  function statHtml(k, v, sub) {
    return `<div class="mstat"><span class="k">${esc(k)}</span><span class="v">${esc(v)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></div>`;
  }

  function lotCard({ tokenId, title, subtitle, colors, bodyHtml }) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'lot';
    const head = document.createElement('div');
    head.className = 'lot-head';
    // the tile carries the TOKEN id; the overall gets its own label rather
    // than a badge, or the two numbers read as one (#7 + 55 → "755")
    head.appendChild(avatarTile({ role: '', shirtNumber: tokenId }, colors));
    head.insertAdjacentHTML('beforeend',
      `<span class="lot-nm">${esc(title)}</span><span class="lot-rl">${esc(subtitle)}</span>`);
    card.appendChild(head);
    card.insertAdjacentHTML('beforeend', bodyHtml);
    card.addEventListener('click', () => router.go(`/market/${tokenId}`));
    return card;
  }

  async function load() {
    let out;
    try {
      const res = await api('/market');
      if (res.status === 501) {
        pick(el, 'ticker').replaceChildren();
        pick(el, 'mErr').textContent = 'This lobby has no market configured yet.';
        return;
      }
      if (!res.ok) throw new Error(`the market answered ${res.status}`);
      out = await res.json();
    } catch (err) {
      if (disposed) return;
      pick(el, 'ticker').replaceChildren();
      pick(el, 'mErr').textContent = `Could not reach the market: ${err.message ?? err}`;
      return;
    }
    if (disposed) return;
    pick(el, 'mErr').textContent = '';

    html(pick(el, 'ticker'),
      statHtml('For sale', String(out.listed))
      + statHtml('Floor', out.floor ? formatEth(out.floor) : '—', out.floor ? ' ETH' : '')
      + statHtml('Sales', String(out.sales))
      + statHtml('Indexed to block', String(out.lastBlock)));

    const lots = pick(el, 'lots');
    lots.replaceChildren();
    pick(el, 'mEmpty').classList.toggle('hidden', out.listings.length > 0);
    listedIds = out.listings.map((l) => String(l.tokenId));
    for (const lot of out.listings) {
      let last;
      if (lot.lastSale) {
        const move = priceMove(lot.lastSale.price, lot.price);
        last = `last sold ${esc(formatEth(lot.lastSale.price))}`
          + (move && move.direction !== 'flat'
            ? ` <span class="${move.direction}">${move.direction === 'up' ? '▲' : '▼'} ${esc(move.percent)}%</span>` : '');
      } else {
        last = 'never sold';
      }
      lots.appendChild(lotCard({
        tokenId: String(lot.tokenId),
        title: lot.player?.name ?? `Player #${lot.tokenId}`,
        subtitle: lot.player ? `${lot.player.role} · OVR ${lot.player.overall}` : `#${lot.tokenId}`,
        bodyHtml: `<div class="lot-price">${esc(formatEth(lot.price))}<small>${esc(assetLabel(lot.asset))}</small></div>
                   <div class="lot-last">${last}</div>`,
      }));
    }
    await renderMine();
  }

  /** The squad you own, so putting a player up for sale has a door. Only
   *  on-chain squads carry token ids — a generated squad has nothing to sell. */
  async function renderMine() {
    const card = pick(el, 'mineCard');
    if (auth.state.status !== 'signed_in') { card.classList.add('hidden'); return; }
    let squad;
    try {
      const res = await auth.api('/squad');
      if (!res.ok) { card.classList.add('hidden'); return; }
      squad = await res.json();
    } catch { card.classList.add('hidden'); return; }
    if (disposed) return;
    const listed = new Set(listedIds);
    const owned = (squad.players ?? []).filter((p) => p.tokenId && !listed.has(String(p.tokenId)));
    card.classList.toggle('hidden', owned.length === 0);
    const mount = pick(el, 'mine');
    mount.replaceChildren();
    for (const p of owned) {
      mount.appendChild(lotCard({
        tokenId: String(p.tokenId),
        title: p.name,
        subtitle: `${p.role} · OVR ${p.overall ?? '—'}`,
        colors: squad.colors,
        bodyHtml: '<div class="lot-last">not for sale</div>',
      }));
    }
  }

  // ---- one player: the listing, the history, the trade -------------------
  async function showSheet(tokenId) {
    openToken = tokenId;
    html(sheet, '<p class="muted">Reading the chain…</p>');
    sheet.classList.add('on');
    sheet.setAttribute('aria-hidden', 'false');
    scrim.classList.remove('hidden');
    requestAnimationFrame(() => scrim.classList.add('on'));

    let out;
    try {
      const res = await api(`/market/${tokenId}`);
      if (!res.ok) throw new Error(String(res.status));
      out = await res.json();
    } catch {
      if (openToken === tokenId) html(sheet, '<p class="err">That player could not be read.</p>');
      return;
    }
    if (disposed || openToken !== tokenId) return;

    const ratings = out.player?.ratings
      ? `<div class="mratings">${Object.entries(out.player.ratings).map(([k, v]) =>
          `<div class="mrt"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`).join('')}</div>`
      : '';
    let previous = null;
    const history = out.history.map((sale) => {
      const move = previous ? priceMove(previous, sale.price) : null;
      previous = sale.price;
      const delta = move && move.direction !== 'flat'
        ? ` ${move.direction === 'up' ? '▲' : '▼'}${move.percent}%` : '';
      return `<div class="histRow"><span>block ${esc(String(sale.block))}</span>
        <span class="${move && move.direction !== 'flat' ? move.direction : ''}">${esc(priceLabel(sale.price, sale.asset))}${esc(delta)}</span></div>`;
    }).join('');

    html(sheet, `
      <button class="btn-quiet btn-sm sheet-close" id="mClose">Close</button>
      <h3>${esc(out.player?.name ?? `Player #${out.tokenId}`)}</h3>
      <p class="muted sheet-sub">${esc(out.player
        ? `${out.player.role} · overall ${out.player.overall} · level ${out.player.level} · token #${out.tokenId}`
        : `token #${out.tokenId}`)}</p>
      ${out.listing
        ? `<div class="lot-price sheet-price">${esc(priceLabel(out.listing.price, out.listing.asset))}</div>`
        : '<p class="muted sheet-price">Not for sale right now.</p>'}
      ${ratings}
      <p class="muted sheet-histTitle">${out.history.length ? 'What he has gone for' : 'Never sold — this would be his first transfer.'}</p>
      ${history}
      <div class="tradebox" id="tradeBox">
        <p class="muted" id="tradeLine"></p>
        <div id="tradeControls"></div>
        <div id="txMount" class="hidden"></div>
      </div>`);
    pick(el, 'mClose').addEventListener('click', () => closeSheetNav());
    renderTrade(out);
  }

  function renderTrade(out) {
    const tokenId = String(out.tokenId);
    const line = pick(el, 'tradeLine');
    const controls = pick(el, 'tradeControls');
    const choice = tradeChoice(auth.state.me, out);
    line.textContent = choice.line;
    controls.replaceChildren();

    const button = (cls, label) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      controls.appendChild(b);
      return b;
    };

    if (choice.kind === 'signin') {
      const b = button('btn-own', 'Sign in with wallet');
      b.addEventListener('click', async () => {
        const provider = /** @type {any} */ (globalThis).ethereum;
        if (!provider) { line.textContent = 'No wallet extension detected — install MetaMask to trade.'; return; }
        b.disabled = true;
        try { await auth.walletSignIn(provider); await showSheet(tokenId); }
        catch (err) { line.textContent = String(err?.message ?? err); }
        finally { b.disabled = false; }
      });
    } else if (choice.kind === 'cancel') {
      const b = button('btn-danger', 'Take him off the market');
      b.addEventListener('click', () => runTrade({ action: 'cancel', tokenId }, 'Cancel the listing', b, 'Settled — he is off the market.'));
    } else if (choice.kind === 'buy') {
      const b = button('btn-primary', `Buy for ${priceLabel(out.listing.price, out.listing.asset)}`);
      b.addEventListener('click', () => runTrade({ action: 'buy', tokenId }, `Sign ${out.player?.name ?? `player #${tokenId}`}`, b, "Settled — he's yours."));
    } else if (choice.kind === 'list') {
      const price = document.createElement('input');
      price.className = 'input';
      price.placeholder = 'price in ETH, e.g. 2.5';
      price.inputMode = 'decimal';
      price.setAttribute('aria-label', 'Listing price in ETH');
      controls.appendChild(price);
      const b = button('btn-own', 'Put him on the market');
      b.addEventListener('click', () => {
        const wei = ethToWei(price.value);
        if (wei === null) { line.textContent = 'Enter a price like 2.5'; line.className = 'err'; return; }
        line.className = 'muted';
        runTrade({ action: 'list', tokenId, price: wei }, `List ${out.player?.name ?? `player #${tokenId}`}`, b, 'Settled — he is on the market.');
      });
    }
  }

  // I2 — a trade: the server prepares calldata, YOUR wallet sends it, and
  // the chain decides. Every step is described before the popup opens.
  async function runTrade(body, action, trigger, settledLine) {
    const tokenId = body.tokenId;
    const mount = pick(el, 'txMount');
    const flow = createTxFlow({
      action,
      onChange: (snap) => renderTxPanel(mount, snap, {
        txStateLine, settledLine,
        onRetry: () => runTrade(body, action, trigger, settledLine),
      }),
    });
    trigger.disabled = true;
    try {
      const provider = /** @type {any} */ (globalThis).ethereum;
      if (!provider) throw new Error('no wallet extension detected');
      flow.preparing();
      const res = await auth.api('/market/prepare', { method: 'POST', body });
      const plan = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(plan.error ?? `the market refused that (${res.status})`);

      const [from] = await provider.request({ method: 'eth_requestAccounts' });
      for (const step of plan.steps) {
        flow.wallet(step.description);
        const txHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{
            from, to: step.to, data: step.data,
            ...(step.value ? { value: `0x${BigInt(step.value).toString(16)}` } : {}),
          }],
        });
        flow.submitted(txHash);
        flow.confirming();
        await waitReceipt(provider, txHash);
        flow.legDone();
      }
      flow.indexing();
      await api('/market?fresh=1');          // the shop window catches up
      flow.success();
      await load();
      // let the settled moment play (the eleven pips) — and give the
      // lobby's live chain reads a beat to agree with the receipt before
      // the sheet re-renders what you can do next
      await new Promise((r) => setTimeout(r, 1800));
      if (!disposed && openToken === tokenId) await showSheet(tokenId);
    } catch (err) {
      flow.failure(normalizeWalletError(err));
    } finally {
      trigger.disabled = false;
    }
  }

  async function waitReceipt(provider, txHash) {
    for (let i = 0; i < 90; i++) {
      const r = await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
      if (r) {
        if (r.status !== '0x1') throw new Error('the transaction reverted on-chain');
        return r;
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    throw new Error('not confirmed after three minutes — check your wallet');
  }

  // ---- the sheet is the URL ----------------------------------------------
  function closeSheetNav() { router.go('/market'); }
  function closeSheet() {
    openToken = null;
    sheet.classList.remove('on');
    sheet.setAttribute('aria-hidden', 'true');
    scrim.classList.remove('on');
    setTimeout(() => scrim.classList.add('hidden'), 220);
  }
  scrim.addEventListener('click', closeSheetNav);
  const onKeydown = (e) => {
    if (e.key === 'Escape' && sheet.classList.contains('on')) closeSheetNav();
  };
  document.addEventListener('keydown', onKeydown);

  // a sign-in/out changes what the sheet may offer — but the poll fires
  // every ~2s, so only an actual identity change re-renders anything
  let authKey = JSON.stringify([auth.state.status, auth.state.me?.wallet]);
  const onAuth = () => {
    const key = JSON.stringify([auth.state.status, auth.state.me?.wallet]);
    if (key === authKey) return;
    authKey = key;
    if (openToken) showSheet(openToken);
    renderMine();
  };
  auth.on('change', onAuth);

  load();
  if (params.tokenId) showSheet(params.tokenId);

  return {
    /** same view, new URL — the sheet follows the address bar */
    update(match) {
      const token = match.params.tokenId ?? null;
      if (token && token !== openToken) showSheet(token);
      else if (!token && openToken) closeSheet();
    },
    dispose() {
      disposed = true;
      auth.off('change', onAuth);
      document.removeEventListener('keydown', onKeydown);
    },
  };
}
