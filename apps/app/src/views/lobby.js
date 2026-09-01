// The lobby — /lobby. Absorbs lobby.html's matchday loop into the shell:
// presence, challenges, the quick-match queue, email invitations, match
// history, and the tunnel card when a match is ready.
//
// The view renders from the ONE LobbyService state the auth machine
// already polls — no second transport, no second poll. Regions re-render
// only when their slice changes; history and invitations refresh on the
// service's cadence (every fifth poll, and immediately at full time).
//
// Club identity (rename, kit) and the on-chain card moved to the club
// home in the same slice — the lobby is for finding a rival.
import { ago, esc, html, pick } from '../ui.js';
import { ENTERED_KEY, matchClientUrl, replayClientUrl } from './matchLink.js';
import { mountSignIn } from './signin.js';

const INVITE_CHIP = { created: '…', sent: 'SENT', delivered: 'DELIVERED', opened: 'OPENED', accepted: '✓ JOINED', expired: 'EXPIRED', failed: 'FAILED' };

/** "4:51" until an ISO deadline, never negative */
export function countdown(expiresAt, now = Date.now()) {
  const s = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * @param {HTMLElement} el
 * @param {{ auth: any, lobby: any, router: any }} ctx
 * @returns {{ dispose(): void }}
 */
export function mountLobby(el, { auth, lobby, router }) {
  let disposed = false;
  let booted = false;
  let history = null;          // null until first fetch; [] is honestly empty
  let invitations = null;
  let invitesOff = false;      // 501 — this lobby has no email backend
  let pollCount = 0;
  let wasInMatch = false;
  let errHoldUntil = 0;
  let autoEnterFor = null;
  let autoEnterTimer = null;

  // ---- the door ----------------------------------------------------------
  function renderGate() {
    if (auth.state.status === 'signed_in') { boot(); return; }
    if (auth.state.status === 'entering') {
      html(el, `<div class="lobbygate"><section class="panel roomcard">
        <div class="room-skel"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>
      </section></div>`);
      return;
    }
    booted = false;
    html(el, `
      <div class="lobbygate">
        <section class="panel roomcard roomgate-card">
          <span class="label green">Matchday lobby</span>
          <h1 class="display">It's <span class="kickword">matchday</span>.</h1>
          <p class="muted">Two coaches, one pitch, live orders by voice. Sign in and find a rival.</p>
          <div id="gateSignin"></div>
        </section>
      </div>`);
    mountSignIn(pick(el, 'gateSignin'), { auth, compact: true });
  }

  // ---- the room ----------------------------------------------------------
  function boot() {
    if (booted) return;
    booted = true;
    html(el, `
      <div class="lobbywrap">
        <div class="lobby-main">
          <div id="matchCard"></div>
          <section class="panel roomcard" id="queueCard">
            <h2 class="label green">Quick match</h2>
            <div id="queueBody"></div>
          </section>
          <section class="panel roomcard">
            <h2 class="label">Challenges</h2>
            <div id="challenges"></div>
          </section>
          <section class="panel roomcard">
            <div class="lobbyhead">
              <h2 class="label">Coaches in the lobby</h2>
              <span class="pill pill--live" id="presencePill"><span class="dot-live"></span><span>—</span></span>
            </div>
            <div id="roster"></div>
          </section>
          <p class="err" id="lobbyErr" role="alert"></p>
        </div>
        <aside class="lobby-rail">
          <section class="panel roomcard">
            <h2 class="label green">Invite a rival by email</h2>
            <form id="inviteForm" novalidate>
              <div class="signin-row">
                <input class="input" id="inviteEmail" type="email" placeholder="friend@example.com" autocomplete="off" aria-label="Rival's email">
                <button class="btn-primary btn-sm" type="submit">Send</button>
              </div>
              <input class="input invite-msg" id="inviteMessage" placeholder="optional message — &quot;bring your best XI&quot;" maxlength="200" aria-label="Optional message">
            </form>
            <p class="muted invite-note" id="inviteNote"></p>
            <div id="inviteList"></div>
          </section>
          <section class="panel roomcard">
            <h2 class="label">Match history</h2>
            <div id="history"></div>
          </section>
        </aside>
      </div>`);

    pick(el, 'inviteForm').addEventListener('submit', sendInvite);
    el.addEventListener('click', onAction);
    void claimPendingInvite();
    void refreshSide();
    drawAll(true);
  }

  // ---- regions -----------------------------------------------------------
  /** @type {Record<string, string>} */
  const drawn = {};
  const whenChanged = (region, slice, draw) => {
    const key = JSON.stringify(slice);
    if (drawn[region] === key) return;
    drawn[region] = key;
    draw();
  };

  function renderMatch() {
    const box = pick(el, 'matchCard');
    const match = lobby.state.match;
    if (!match) {
      clearTimeout(autoEnterTimer);
      autoEnterFor = null;
      html(box, '');
      return;
    }
    const entered = sessionStorage.getItem(ENTERED_KEY) === match.matchId;
    html(box, `
      <div class="panel kickoff kickoff--live">
        <span class="label green"><span class="dot-live"></span> Kick-off — your match is ready</span>
        <p class="kickoff-line">${esc(auth.state.me?.teamName ?? 'Your club')} — walk the tunnel.</p>
        <div class="kickoff-cta">
          <button class="btn-primary" data-enter="1">Enter match</button>
          <button class="btn-quiet" data-spectate="1">Copy spectator link</button>
          <button class="btn-danger" data-leave="1">Leave</button>
        </div>
        <p class="muted kickoff-note" id="enterNote">${entered
          ? 'Re-enter any time, or share the spectator link.'
          : 'Entering in 3 seconds…'}</p>
      </div>`);
    // fresh match (not one we already entered and came back from): auto-
    // enter, armed ONCE per match — the poll re-renders faster than the
    // fuse, so re-arming here would mean never firing (the old lobby's
    // hard-won lesson, kept)
    if (!entered && autoEnterFor !== match.matchId) {
      autoEnterFor = match.matchId;
      clearTimeout(autoEnterTimer);
      autoEnterTimer = setTimeout(() => enterMatch(match), 3000);
    }
  }

  function enterMatch(match) {
    try { sessionStorage.setItem(ENTERED_KEY, match.matchId); } catch { /* still enter */ }
    location.assign(matchClientUrl(match, match.token));
  }

  function renderQueue() {
    const q = lobby.state.queue ?? { status: 'idle', waiting: 0 };
    const body = pick(el, 'queueBody');
    if (q.status === 'searching' || q.status === 'matching') {
      html(body, `
        <p class="queue-line"><span class="skeleton queue-pulse"></span>
          ${q.status === 'matching' ? 'Rival found — building the match…' : 'Searching for a rival…'}</p>
        <div class="kickoff-cta">
          <button class="btn-quiet btn-sm" data-queue-leave="1"${q.status === 'matching' ? ' disabled' : ''}>Leave the queue</button>
        </div>
        ${q.error ? `<p class="err">${esc(q.error)}</p>` : ''}`);
      return;
    }
    html(body, `
      <p class="muted queue-line">First manager waiting takes your challenge — no picking, no waiting room.</p>
      <div class="kickoff-cta">
        <button class="btn-primary" data-queue-join="1">Join the queue</button>
        ${q.waiting ? `<span class="label">${q.waiting} waiting</span>` : ''}
      </div>`);
  }

  function renderChallenges() {
    const s = lobby.state;
    const rows = [
      ...s.incomingChallenges.map((c) => `
        <div class="player-row player-row--live">
          <span class="row-name"><b>${esc(c.from?.teamName ?? '?')}</b> — ${nameHtml(c.from)} ${c.rematch ? 'wants a rematch' : 'challenges you'}</span>
          ${c.expiresAt ? `<span class="tag" data-count="${esc(c.expiresAt)}">${countdown(c.expiresAt)}</span>` : ''}
          <button class="btn-primary btn-sm" data-accept="${esc(c.id)}">Accept</button>
          <button class="btn-danger btn-sm" data-decline="${esc(c.id)}">Decline</button>
        </div>`),
      ...s.outgoingChallenges.map((c) => `
        <div class="player-row">
          <span class="row-name muted">Waiting for ${nameHtml(c.to)}…</span>
          ${c.expiresAt ? `<span class="tag" data-count="${esc(c.expiresAt)}">${countdown(c.expiresAt)}</span>` : ''}
          <button class="btn-quiet btn-sm" data-decline="${esc(c.id)}">Cancel</button>
        </div>`),
    ].join('');
    html(pick(el, 'challenges'), rows
      || '<p class="muted">No challenges yet — pick a rival below, or join the queue.</p>');
  }

  // Wallet identity: displayName is a VERIFIED ens name or the shortened
  // address; the raw address stays reachable on hover. Names are typed by
  // OTHER people — escaped, always.
  const nameOf = (a) => a?.identity?.displayName ?? a?.handle ?? '?';
  const nameHtml = (a) => a?.identity?.ensName
    ? `<span class="ens" title="${esc(a.wallet ?? '')}">${esc(a.identity.ensName)}</span>`
    : `<span title="${esc(a?.wallet ?? '')}">${esc(nameOf(a))}</span>`;
  const rec = (r) => r ? `<span class="rec label">${r.w}W ${r.d}D ${r.l}L</span>` : '';

  function renderRoster() {
    const players = [...lobby.state.participants]
      .sort((a, b) => (b.online - a.online) || String(a.handle ?? '').localeCompare(String(b.handle ?? '')));
    const present = players.filter((p) => p.online).length + 1;
    pick(el, 'presencePill').lastElementChild.textContent =
      present === 1 ? 'you hold the ground alone' : `${present} managers present`;
    html(pick(el, 'roster'), players.map((p) => `
      <div class="player-row">
        <span class="presence-dot${p.online ? ' on' : ''}"></span>
        <span class="row-name">${nameHtml(p)} ${rec(p.record)}</span>
        <span class="row-team muted">${esc(p.teamName ?? '')}</span>
        ${p.inMatch ? '<span class="tag">In match</span>'
          : p.online ? `<button class="btn-primary btn-sm" data-challenge="${esc(p.accountId)}">Challenge</button>` : ''}
      </div>`).join('')
      || '<p class="muted">Nobody else is online. Open a second tab to warm up against yourself, or invite a friend →</p>');
  }

  function renderHistory() {
    const box = pick(el, 'history');
    if (history === null) {
      html(box, '<div class="room-skel"><span class="skeleton"></span><span class="skeleton"></span></div>');
      return;
    }
    html(box, history.map((m) => `
      <div class="player-row">
        ${m.outcome ? `<span class="badge badge--${esc(m.outcome)}">${esc(m.outcome)}</span>` : '<span class="tag tag--live">Live</span>'}
        <span class="row-name">${m.score ? `<b>${m.score[0]} – ${m.score[1]}</b>` : '· – ·'}
          vs ${esc(m.opponent?.teamName ?? '?')}</span>
        <span class="row-team label">${esc(ago(m.finishedAt ?? m.createdAt))}</span>
        ${m.outcome ? `<button class="btn-quiet btn-sm" data-watch="${esc(m.matchId)}">Watch</button>` : ''}
        ${m.outcome && m.opponent ? `<button class="btn-quiet btn-sm" data-rematch="${esc(m.opponent.accountId)}" data-rematch-of="${esc(m.matchId)}">Rematch</button>` : ''}
      </div>`).join('')
      || '<p class="muted">No matches yet — your first result lands here.</p>');
  }

  function renderInvites() {
    const note = pick(el, 'inviteNote');
    if (invitesOff) {
      pick(el, 'inviteForm').classList.add('hidden');
      note.textContent = 'This lobby has no email delivery configured — share a challenge in person instead.';
      return;
    }
    html(pick(el, 'inviteList'), (invitations ?? []).slice(0, 6).map((v) => `
      <div class="player-row">
        <span class="tag">${esc(INVITE_CHIP[v.status] ?? v.status)}</span>
        <span class="row-name">${esc(v.recipientEmail)}</span>
        <span class="row-team label">${esc(ago(v.createdAt))}</span>
      </div>`).join(''));
  }

  function drawAll(force = false) {
    if (!booted) return;
    const s = lobby.state;
    if (force) for (const k of Object.keys(drawn)) delete drawn[k];
    whenChanged('match', [s.match?.matchId, s.match?.status, auth.state.me?.teamName], renderMatch);
    whenChanged('queue', [s.queue], renderQueue);
    whenChanged('challenges', [s.incomingChallenges.map((c) => [c.id, c.expiresAt && countdown(c.expiresAt)]),
      s.outgoingChallenges.map((c) => [c.id, c.expiresAt && countdown(c.expiresAt)])], renderChallenges);
    whenChanged('roster', [s.participants.map((p) => [p.accountId, p.online, p.inMatch, p.teamName, nameOf(p), p.record])], renderRoster);
    whenChanged('history', [history?.map((m) => [m.matchId, m.outcome])], renderHistory);
    whenChanged('invites', [invitesOff, invitations?.map((v) => [v.id ?? v.recipientEmail, v.status])], renderInvites);
  }

  // ---- actions -----------------------------------------------------------
  const sayErr = (line) => {
    const box = pick(el, 'lobbyErr');
    if (!box) return;
    box.textContent = line;
    errHoldUntil = Date.now() + 6000;
  };

  async function onAction(e) {
    const btn = /** @type {HTMLElement|null} */ (e.target instanceof Element ? e.target.closest('button') : null);
    if (!btn || !booted) return;
    const d = btn.dataset;
    try {
      if (d.challenge) await lobby.challenge(d.challenge);
      else if (d.accept) await lobby.accept(d.accept);
      else if (d.decline) await lobby.decline(d.decline);
      else if (d.queueJoin) await lobby.joinQueue();
      else if (d.queueLeave) await lobby.leaveQueue();
      else if (d.enter) { const m = lobby.state.match; if (m) { clearTimeout(autoEnterTimer); enterMatch(m); } }
      else if (d.leave) {
        clearTimeout(autoEnterTimer);
        try { sessionStorage.removeItem(ENTERED_KEY); } catch { /* gone anyway */ }
        await lobby.leaveMatch();
      }
      else if (d.spectate) {
        const m = lobby.state.match;
        if (!m) return;
        const link = new URL(matchClientUrl(m, m.spectatorToken), location.href).href;
        try { await navigator.clipboard.writeText(link); pick(el, 'enterNote').textContent = 'Spectator link copied — anyone can watch.'; }
        catch { prompt('Spectator link:', link); }
      }
      else if (d.watch) {
        const m = history?.find((x) => x.matchId === d.watch);
        if (m) location.assign(replayClientUrl(m));
      }
      else if (d.rematch) await lobby.challenge(d.rematch, d.rematchOf);
      else return;
      drawAll();
    } catch (err) {
      sayErr(String(err?.message ?? err));
    }
  }

  async function sendInvite(e) {
    e.preventDefault();
    const note = pick(el, 'inviteNote');
    const email = /** @type {HTMLInputElement} */ (pick(el, 'inviteEmail')).value.trim();
    const message = /** @type {HTMLInputElement} */ (pick(el, 'inviteMessage')).value.trim();
    if (!email) { note.textContent = 'Their email opens the door — type it first.'; return; }
    note.textContent = 'Sending…';
    try {
      const res = await auth.api('/invites', { method: 'POST', body: { email, ...(message ? { message } : {}) } });
      const out = await res.json().catch(() => ({}));
      if (res.status === 501) { invitesOff = true; drawAll(); return; }
      if (!res.ok) throw new Error(out.error ?? res.status);
      /** @type {HTMLInputElement} */ (pick(el, 'inviteEmail')).value = '';
      /** @type {HTMLInputElement} */ (pick(el, 'inviteMessage')).value = '';
      note.textContent = `Invitation sent to ${email}. They get an email with a join link.`;
      await refreshSide();
    } catch (err) {
      note.textContent = String(err?.message ?? err);
    }
  }

  async function refreshSide() {
    try {
      const h = await lobby.history();
      history = h?.matches ?? [];
    } catch { /* next cycle */ }
    if (!invitesOff) {
      try {
        const res = await auth.api('/invites');
        if (res.status === 501) invitesOff = true;
        else if (res.ok) invitations = (await res.json()).invitations ?? [];
      } catch { /* next cycle */ }
    }
    if (!disposed) drawAll();
  }

  // an invitation token rides in from invite.html and SURVIVES the whole
  // sign-in journey in sessionStorage — claimed on the first lobby entry
  async function claimPendingInvite() {
    let token = null;
    try { token = sessionStorage.getItem('fobal.invite'); } catch { return; }
    if (!token) return;
    try {
      const res = await auth.api(`/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', body: {} });
      const out = await res.json().catch(() => ({}));
      pick(el, 'inviteNote').textContent = res.ok
        ? `Challenge sent to ${out.inviter?.teamName ?? 'your rival'} — the match starts when they accept.`
        : (out.error ?? 'could not claim the invitation');
      // consumed either way — a used/expired token must not retry forever
      sessionStorage.removeItem('fobal.invite');
    } catch { /* network blip — the token stays for the next entry */ }
  }

  // ---- wiring ------------------------------------------------------------
  const onState = () => {
    if (!booted) return;
    if (Date.now() > errHoldUntil) { const b = pick(el, 'lobbyErr'); if (b) b.textContent = ''; }
    const ended = wasInMatch && !lobby.state.match;
    wasInMatch = !!lobby.state.match;
    if (ended || pollCount++ % 5 === 0) void refreshSide();
    drawAll();
  };
  const onAuth = () => {
    if (auth.state.status === 'signed_in' && !booted) renderGate();
    if (auth.state.status !== 'signed_in' && booted) { booted = false; renderGate(); }
  };
  lobby.on('state', onState);
  auth.on('change', onAuth);
  renderGate();

  return {
    dispose() {
      disposed = true;
      clearTimeout(autoEnterTimer);
      lobby.off('state', onState);
      auth.off('change', onAuth);
    },
  };
}
