// The club — home. Absorbs hub.html into the shell.
//
// Renders instantly from whatever this browser already knows (the local
// draft), then lets the server correct it: when a session is live, the
// lobby account is CANONICAL — the name opponents see, the real record,
// the kit that walks out (the identity rule since the schism closed).
//
// The view renders its frame once and updates named regions off the poll,
// so nothing flickers and no input loses focus on a 2-second cadence.
import { ago, crestHtml, elevenPips, esc, html, pick } from '../ui.js';
import { ENTERED_KEY, matchClientUrl, replayClientUrl } from './matchLink.js';
import { MINT_LEGS, runMintFlow } from './mint.js';
import { mountSignIn } from './signin.js';
import { renderTxPanel } from './txPanel.js';

/**
 * @param {HTMLElement} el
 * @param {{ auth: any, lobby: any, router: any, deps: any }} ctx
 * @returns {{ dispose(): void }}
 */
export function mountClub(el, { auth, lobby, router, deps }) {
  const draft = deps.loadClub();
  let serverSquad = null;      // GET /squad once signed in
  let lastResult = null;       // most recent finished match from /history
  let wasInMatch = false;
  let claimFlash = null;       // the adoption moment, shown once with the pips

  html(el, `
    <div class="club">
      <div class="club-main">
        <div class="bezel"><div class="bezel-in clubhead" id="clubhead"></div></div>
        <div id="kickoff"></div>
        <section class="panel squadpanel">
          <div class="squadpanel-head">
            <h2 class="display">Your squad</h2>
            <span class="label" id="squadCount"></span>
          </div>
          <div class="strip" id="strip" role="list"></div>
          <p class="squadpanel-note muted" id="squadNote"></p>
        </section>
      </div>
      <aside class="club-rail">
        <div id="railSignin"></div>
        <section class="panel needs">
          <h2 class="label">What needs you</h2>
          <div id="needs"></div>
        </section>
        <section class="panel identity" id="identityCard" hidden></section>
        <section class="panel chaincard" id="chainCard" hidden></section>
        <section class="panel lastft" id="lastft" hidden></section>
      </aside>
    </div>`);

  // ---- identity: draft first, server the moment it exists ----------------
  const identity = () => {
    const me = auth.state.me;
    const name = serverSquad?.teamName ?? me?.teamName ?? draft?.name ?? 'Your club';
    const colors = serverSquad?.colors ?? draft?.kit ?? null;
    const record = me?.record ?? draft?.record ?? { w: 0, d: 0, l: 0 };
    return { name, colors, record };
  };

  const overallOf = () => {
    if (draft) return deps.clubOverall(draft);
    const ps = serverSquad?.players?.slice(0, 11) ?? [];
    if (!ps.length) return null;
    return Math.round(ps.reduce((a, p) => a + (p.overall ?? 0), 0) / ps.length);
  };

  function renderHead() {
    const { name, colors, record } = identity();
    const players = serverSquad?.players?.length ?? draft?.squad?.players?.length ?? null;
    const ovr = overallOf();
    html(pick(el, 'clubhead'), `
      ${crestHtml(colors, deps.crestInitials(name), { size: 'crest--hero' })}
      <div class="clubhead-who">
        <span class="label green">Your club · Season 01</span>
        <h1 class="display">${esc(name)}</h1>
        <div class="clubhead-meta">
          ${colors ? `<span class="chip">${esc(colors.primary ?? '—')} · ${esc(colors.secondary ?? '—')}</span>` : ''}
          ${serverSquad?.source === 'chain' ? '<span class="chip purple">◆ On-chain squad</span>' : ''}
          <span class="chip">Founded this season</span>
        </div>
      </div>
      <div class="statrow">
        <div class="stat"><span class="v green">${ovr ?? '—'}</span><span class="l">SQUAD OVR</span></div>
        <div class="stat"><span class="v">${players ?? '—'}</span><span class="l">PLAYERS</span></div>
        <div class="stat"><span class="v">${record.w}-${record.d}-${record.l}</span><span class="l">W-D-L</span></div>
      </div>`);
  }

  // ---- the kick-off card: match > challenge > queue > find a rival -------
  function renderKickoff() {
    const s = lobby.state;
    const box = pick(el, 'kickoff');
    if (auth.state.status !== 'signed_in') {
      html(box, `
        <div class="panel kickoff">
          <span class="label green">Next kick-off</span>
          <p class="kickoff-line">A friendly vs the AI is always on — live rivals arrive when you sign in.</p>
          <div class="kickoff-cta">
            <a class="btn-primary" data-nav="/play" href="${esc(router.href('/play'))}">Kick off vs AI</a>
          </div>
        </div>`);
      return;
    }
    if (s.match) {
      html(box, `
        <div class="panel kickoff kickoff--live">
          <span class="label green"><span class="dot-live"></span> Match ready</span>
          <p class="kickoff-line">The tunnel is open — your rival is waiting.</p>
          <div class="kickoff-cta">
            <button class="btn-primary" id="tunnelBtn">To the tunnel</button>
            <button class="btn-quiet" id="specBtn">Copy spectator link</button>
            <button class="btn-danger" id="leaveBtn">Leave</button>
          </div>
          <p class="muted kickoff-note" id="kickNote"></p>
        </div>`);
      pick(el, 'tunnelBtn').addEventListener('click', () => {
        try { sessionStorage.setItem(ENTERED_KEY, s.match.matchId); } catch { /* still enter */ }
        location.assign(matchClientUrl(s.match, s.match.token));
      });
      pick(el, 'specBtn').addEventListener('click', async () => {
        const link = new URL(matchClientUrl(s.match, s.match.spectatorToken), location.href).href;
        try { await navigator.clipboard.writeText(link); pick(el, 'kickNote').textContent = 'Spectator link copied — anyone can watch.'; }
        catch { prompt('Spectator link:', link); }
      });
      pick(el, 'leaveBtn').addEventListener('click', async () => {
        try { await lobby.leaveMatch(); } catch { /* the next poll tells the truth */ }
      });
      return;
    }
    const incoming = s.incomingChallenges?.[0];
    if (incoming) {
      html(box, `
        <div class="panel kickoff kickoff--live">
          <span class="label green">Challenged you</span>
          <p class="kickoff-line"><b>${esc(incoming.from?.teamName ?? 'A rival')}</b> wants a match.</p>
          <div class="kickoff-cta">
            <a class="btn-primary" data-nav="/lobby" href="${esc(router.href('/lobby'))}">Answer in the lobby</a>
          </div>
        </div>`);
      return;
    }
    if (s.queue?.status === 'searching' || s.queue?.status === 'matching') {
      html(box, `
        <div class="panel kickoff">
          <span class="label green">Quick match</span>
          <p class="kickoff-line">Searching for a rival — the lobby will call you through.</p>
          <div class="kickoff-cta">
            <a class="btn-quiet" data-nav="/lobby" href="${esc(router.href('/lobby'))}">To the lobby</a>
          </div>
        </div>`);
      return;
    }
    html(box, `
      <div class="panel kickoff">
        <span class="label green">Next kick-off</span>
        <p class="kickoff-line">No fixture yet — find a rival, or warm up against the AI.</p>
        <div class="kickoff-cta">
          <a class="btn-primary" data-nav="/lobby" href="${esc(router.href('/lobby'))}">Find a rival</a>
          <a class="btn-quiet" data-nav="/play" href="${esc(router.href('/play'))}">Friendly vs AI</a>
        </div>
      </div>`);
  }

  // ---- squad strip: pixel heroes from the draft, kit tiles from the server
  function renderStrip() {
    const strip = pick(el, 'strip');
    const note = pick(el, 'squadNote');
    if (draft?.squad?.players?.length) {
      const kit = draft.kit;
      pick(el, 'squadCount').textContent = `${draft.squad.players.length} players`;
      html(strip, draft.squad.players.map((p) => `
        <div class="strip-p" role="listitem" title="${esc(p.name)} · ${esc(p.role)}">
          <span class="avatar-disc avatar-disc--own avatar-hero">${deps.avatarSvgDressed({ appearance: BigInt(p.appearance), dna: p.dna, position: p.position }, kit)}</span>
          <span class="strip-nm">${esc(p.name.split(' ')[1] || p.name)}</span>
          <span class="strip-ov">${p.overall}</span>
        </div>`).join(''));
      note.textContent = 'Every avatar is drawn by the same code, from the same data, as the art the chain mints.';
      return;
    }
    if (auth.state.status === 'signed_in') {
      if (!serverSquad) {
        html(strip, Array.from({ length: 11 }, () =>
          '<div class="strip-p"><span class="strip-skel skeleton"></span><span class="strip-nm">&nbsp;</span></div>').join(''));
        note.textContent = '';
        return;
      }
      const colors = serverSquad.colors ?? {};
      pick(el, 'squadCount').textContent = `${serverSquad.players.length} players`;
      html(strip, serverSquad.players.slice(0, 11).map((p) => `
        <div class="strip-p" role="listitem" title="${esc(p.name)} · ${esc(p.role)}">
          <span class="strip-tile${p.role === 'GK' ? ' gk' : ''}" style="--k1:${esc(colors.primary ?? '#22c55e')};--k2:${esc(colors.secondary ?? '#0d1428')}">${p.shirtNumber ?? ''}</span>
          <span class="strip-nm">${esc(p.name.split(' ').pop() || p.name)}</span>
          <span class="strip-ov">${p.overall ?? ''}</span>
        </div>`).join(''));
      note.textContent = serverSquad.source === 'chain'
        ? 'Your on-chain eleven — the shirts your NFTs wear.'
        : 'Your academy squad — rename, re-kit and pick the XI in the squad room.';
      return;
    }
    html(strip, '');
    pick(el, 'squadCount').textContent = '';
    note.textContent = 'Sign in to meet your squad — or found a club to mint one.';
  }

  // ---- the rail: what needs you + last full time -------------------------
  function renderNeeds() {
    const s = lobby.state;
    const me = auth.state.me;
    const items = [];
    if (claimFlash?.ok) {
      items.push(`
        <div class="need need--settled">
          <div class="need-copy"><b>${esc(claimFlash.teamName ?? 'Your club')}</b> is now your club online.</div>
          <div class="need-pips">${elevenPips(true)}</div>
        </div>`);
    } else if (claimFlash?.reason) {
      items.push(`
        <div class="need">
          <span class="need-dot need-dot--warn"></span>
          <div class="need-copy">${esc(claimFlash.reason)} Your online club keeps its current name.</div>
        </div>`);
    }
    if (auth.state.status === 'signed_out') {
      items.push(`
        <div class="need">
          <span class="need-dot need-dot--green"></span>
          <div class="need-copy">Sign in and your club takes the field with the name you chose.</div>
        </div>`);
      if (auth.state.reason && auth.state.reason !== 'logout') {
        items.push(`
          <div class="need">
            <span class="need-dot"></span>
            <div class="need-copy">${esc(sighOffLine(auth.state.reason))}</div>
          </div>`);
      }
    }
    if (auth.state.status === 'signed_in' && auth.state.connection === 'reconnecting') {
      items.push(`
        <div class="need">
          <span class="need-dot need-dot--warn"></span>
          <div class="need-copy">Signal lost — the lobby plays on. Reconnecting…</div>
        </div>`);
    }
    if (me?.wallet && !me?.chainTeamId) {
      items.push(`
        <a class="need need--link" data-nav="/lobby" href="${esc(router.href('/lobby'))}">
          <span class="need-dot need-dot--own"></span>
          <div class="need-copy">Mint your team on-chain — your NFTs take the field.</div>
          <span class="need-go">→</span>
        </a>`);
    }
    for (const c of (s.incomingChallenges ?? []).slice(0, 2)) {
      items.push(`
        <a class="need need--link" data-nav="/lobby" href="${esc(router.href('/lobby'))}">
          <span class="need-dot need-dot--green"></span>
          <div class="need-copy"><b>${esc(c.from?.teamName ?? 'A rival')}</b> challenged you.</div>
          <span class="need-go">→</span>
        </a>`);
    }
    if (auth.state.status === 'signed_in' && !items.length) {
      items.push(`
        <a class="need need--link" data-nav="/squad" href="${esc(router.href('/squad'))}">
          <span class="need-dot"></span>
          <div class="need-copy">All quiet. Set your eleven in the squad room.</div>
          <span class="need-go">→</span>
        </a>`);
    }
    html(pick(el, 'needs'), items.join('') || '<p class="muted">All quiet.</p>');
    if (claimFlash) {
      // arm the pips one frame later so the stagger actually plays
      requestAnimationFrame(() => el.querySelector('.need--settled .ripple')?.classList.add('ripple--go'));
    }
  }

  const sighOffLine = (reason) =>
    reason === 'session expired' ? 'Your session expired — sign back in to pick up where you left off.'
      : reason === 'wallet account changed' ? 'Your wallet switched accounts, so the session closed. Sign in with the new one.'
        : 'You are signed out.';

  // ---- club identity: the name opponents see, the kit that walks out ----
  // (moved from lobby.html in J4 — identity belongs at home). Renders once
  // per session so the poll never clobbers typing; saves through the same
  // endpoints the club claim uses.
  function renderIdentity() {
    const card = pick(el, 'identityCard');
    if (auth.state.status !== 'signed_in') { card.hidden = true; return; }
    card.hidden = false;
    const { name, colors } = identity();
    html(card, `
      <h2 class="label">Club identity</h2>
      <form id="idForm" novalidate>
        <label class="label" for="idName">Club name</label>
        <input class="input" id="idName" maxlength="32" value="${esc(name)}" autocomplete="off">
        <div class="identity-kit">
          <span class="label">Kit</span>
          <input type="color" id="idPrimary" value="${esc(colors?.primary ?? '#22c55e')}" title="Primary — shirt and socks">
          <input type="color" id="idSecondary" value="${esc(colors?.secondary ?? '#0d1428')}" title="Secondary — shorts and trim">
          <button class="btn-quiet btn-sm" type="submit">Save</button>
        </div>
        <p class="muted identity-note" id="idNote"></p>
      </form>`);
    pick(el, 'idForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const note = pick(el, 'idNote');
      const newName = /** @type {HTMLInputElement} */ (pick(el, 'idName')).value.trim();
      const primary = /** @type {HTMLInputElement} */ (pick(el, 'idPrimary')).value;
      const secondary = /** @type {HTMLInputElement} */ (pick(el, 'idSecondary')).value;
      note.textContent = 'Saving…';
      try {
        if (newName && newName !== identity().name) {
          const res = await auth.api('/account/team', { method: 'POST', body: { teamName: newName } });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) { note.textContent = out.error ?? 'that name was not accepted'; return; }
        }
        const res = await auth.api('/squad', { method: 'POST', body: { colors: { primary, secondary } } });
        if (!res.ok) { note.textContent = 'the kit did not save — try again'; return; }
        note.textContent = 'Saved — your next match wears it.';
        fetchedFor = null; serverSquad = null;
        await fetchServerBits();
      } catch { note.textContent = 'The lobby is out of reach — nothing was changed.'; }
    });
  }

  // ---- the on-chain team (wallet accounts): link, unlink, MINT MY TEAM ---
  let mintSettledAt = 0;   // keeps the settled moment alive across the poll's re-render
  function renderChain() {
    const card = pick(el, 'chainCard');
    const me = auth.state.me;
    if (!me?.wallet) { card.hidden = true; return; }
    card.hidden = false;
    if (me.chainTeamId) {
      const justSettled = Date.now() - mintSettledAt < 8000;
      html(card, `
        <h2 class="label purple">On-chain team</h2>
        ${justSettled ? `<div class="txSettled">${elevenPips(true)}<span>Settled — your NFTs take the field.</span></div>` : ''}
        <p class="muted chain-line">Linked: team ${esc(String(me.chainTeamId))} — your NFTs take the field.</p>
        <button class="btn-danger btn-sm" id="chainUnlink">Unlink</button>
        <p class="muted identity-note" id="chainNote"></p>`);
      if (justSettled) requestAnimationFrame(() => card.querySelector('.ripple')?.classList.add('ripple--go'));
      pick(el, 'chainUnlink').addEventListener('click', async () => {
        try {
          await auth.api('/squad/chain', { method: 'DELETE' });
          pick(el, 'chainNote').textContent = 'Unlinked — back to your generated squad.';
          fetchedFor = null; serverSquad = null;
        } catch { pick(el, 'chainNote').textContent = 'The lobby is out of reach — still linked.'; }
      });
      return;
    }
    html(card, `
      <h2 class="label purple">On-chain team</h2>
      <p class="muted chain-line">Mint your squad as NFTs — or link a registry team you already own.</p>
      <div class="chain-row">
        <input class="input chain-id" id="chainTeamId" placeholder="team id" inputmode="numeric" aria-label="Registry team id">
        <button class="btn-quiet btn-sm" id="chainLink">Link</button>
      </div>
      <button class="btn-own" id="mintBtn">⛓ Mint my team</button>
      <div id="mintMount" class="hidden"></div>
      <p class="muted identity-note" id="chainNote"></p>`);
    pick(el, 'chainLink').addEventListener('click', async () => {
      const note = pick(el, 'chainNote');
      note.textContent = 'Reading the chain…';
      try {
        const teamId = Number(/** @type {HTMLInputElement} */ (pick(el, 'chainTeamId')).value.trim());
        if (!Number.isInteger(teamId) || teamId <= 0) throw new Error('Enter your registry team id (a number).');
        const res = await auth.api('/squad/chain', { method: 'POST', body: { teamId } });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error ?? res.status);
        note.textContent = `${out.team.name} — ${out.team.players.length} players take the field.`;
        fetchedFor = null; serverSquad = null;
        await fetchServerBits();
      } catch (err) { note.textContent = String(err?.message ?? err); }
    });
    pick(el, 'mintBtn').addEventListener('click', async () => {
      const btn = /** @type {HTMLButtonElement} */ (pick(el, 'mintBtn'));
      const mount = pick(el, 'mintMount');
      const flow = deps.createTxFlow({
        action: 'Mint my team',
        onChange: (snap) => renderTxPanel(mount, snap, {
          txStateLine: deps.txStateLine, legs: MINT_LEGS,
          settledLine: 'Settled — your NFTs take the field.',
          onRetry: () => pick(el, 'mintBtn')?.click(),   // resumes from saved progress
        }),
      });
      btn.disabled = true;
      try {
        const out = await runMintFlow({ auth, flow });
        mintSettledAt = Date.now();
        pick(el, 'chainNote').textContent = `${out.teamName} — your NFTs take the field.`;
        fetchedFor = null; serverSquad = null;
        await fetchServerBits();
      } catch (err) {
        flow.failure(deps.normalizeWalletError(err));
      } finally {
        btn.disabled = false;
      }
    });
  }

  function renderLastFt() {
    const box = pick(el, 'lastft');
    if (!lastResult) { box.hidden = true; return; }
    const m = lastResult;
    const mine = m.score ? `${m.score[0]} – ${m.score[1]}` : '· – ·';
    box.hidden = false;
    html(box, `
      <h2 class="label">Last full time</h2>
      <div class="lastft-line">
        <span class="badge badge--${esc(m.outcome ?? 'D')}">${esc(m.outcome ?? '—')}</span>
        <b class="lastft-score">${mine}</b>
        <span class="muted">vs ${esc(m.opponent?.teamName ?? '?')}</span>
        <span class="lastft-ago label">${esc(ago(m.finishedAt ?? m.createdAt))}</span>
      </div>
      <button class="btn-quiet lastft-watch" id="watchBtn">▶ Watch replay</button>`);
    pick(el, 'watchBtn').addEventListener('click', () => {
      location.assign(replayClientUrl(m));
    });
  }

  // ---- data that arrives once a session is live --------------------------
  let fetchedFor = null;
  async function fetchServerBits() {
    if (auth.state.status !== 'signed_in') return;
    const key = auth.state.me?.accountId ?? 'me';
    if (fetchedFor === key) return;
    fetchedFor = key;
    try {
      serverSquad = await lobby.getSquad();
      drawAll();
    } catch { fetchedFor = null; /* the next poll retries */ }
    try {
      const h = await lobby.history();
      lastResult = (h?.matches ?? []).find((m) => m.outcome) ?? null;
      drawAll();
    } catch { /* history is decoration — next visit retries */ }
  }

  async function refreshAfterFullTime() {
    try {
      const h = await lobby.history();
      lastResult = (h?.matches ?? []).find((m) => m.outcome) ?? null;
      drawAll();
    } catch { /* next cycle */ }
  }

  // ---- wiring -------------------------------------------------------------
  // The poll fires every ~2s; each region re-renders ONLY when the slice of
  // state it draws actually changed — no flicker, no replayed animations,
  // no stolen focus.
  /** @type {Record<string, string>} */
  const drawn = {};
  const whenChanged = (region, slice, draw) => {
    const key = JSON.stringify(slice);
    if (drawn[region] === key) return;
    drawn[region] = key;
    draw();
  };

  const drawAll = () => {
    const s = lobby.state;
    const me = auth.state.me;
    whenChanged('railSignin', [auth.state.status === 'signed_out'], () => {
      const box = pick(el, 'railSignin');
      if (auth.state.status === 'signed_out') mountSignIn(box, { auth, compact: true });
      else html(box, '');
    });
    whenChanged('head', [identity(), serverSquad?.source, serverSquad?.players?.length, draft?.squad?.players?.length, overallOf()], renderHead);
    whenChanged('kickoff', [auth.state.status, s.match?.matchId, s.incomingChallenges?.map((c) => c.id), s.queue?.status], renderKickoff);
    whenChanged('needs', [auth.state.status, auth.state.reason, auth.state.connection, me?.wallet, me?.chainTeamId,
      s.incomingChallenges?.map((c) => c.from?.teamName), claimFlash], renderNeeds);
    whenChanged('strip', [auth.state.status, !!draft, serverSquad?.teamName, serverSquad?.colors, serverSquad?.players?.length], renderStrip);
    // identity renders once per session (typing must survive the poll);
    // chain re-renders only when linkage or the wallet itself changes
    whenChanged('identity', [auth.state.status === 'signed_in', me?.accountId], renderIdentity);
    whenChanged('chain', [me?.wallet, me?.chainTeamId], renderChain);
    whenChanged('lastft', [lastResult?.matchId], renderLastFt);
  };

  const onChange = () => {
    const ended = wasInMatch && !lobby.state.match;
    wasInMatch = !!lobby.state.match;
    if (auth.state.status === 'signed_in') fetchServerBits();
    else { serverSquad = null; fetchedFor = null; }
    drawAll();
    if (ended) refreshAfterFullTime();
  };
  const onClaimed = (out) => {
    claimFlash = out ?? null;
    if (out?.ok) { fetchedFor = null; serverSquad = null; }
    drawAll();
    if (out?.ok) fetchServerBits();
  };
  auth.on('change', onChange);
  auth.on('claimed', onClaimed);

  drawAll();
  fetchServerBits();

  return {
    dispose() {
      auth.off('change', onChange);
      auth.off('claimed', onClaimed);
    },
  };
}
