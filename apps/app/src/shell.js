// The application shell — one chrome, one session, one navigation.
//
// createApp wires the three machines together: the router (URL → view),
// the auth machine (session → snapshot), and the LobbyService (transport).
// Views mount into <main>; the chrome (topbar identity, nav rail) redraws
// from the same auth snapshot every view reads, so the whole app can never
// disagree with itself about who is signed in.
import { createAuthMachine } from './authMachine.js';
import { createRouter } from './router.js';
import { crestHtml, esc, html, pick } from './ui.js';
import { mountClub } from './views/club.js';
import { mountEntry } from './views/entry.js';
import { mountOnboarding } from './views/onboarding.js';
import { mountSquad } from './views/squad.js';

/**
 * @param {{
 *   root: HTMLElement,
 *   window: Window,
 *   config: { lobbyUrl?: string },
 *   deps: Record<string, any>,   // the shared pure modules, injected by app.html
 * }} options
 */
export function createApp({ root, window: win, config, deps }) {
  const params = new URLSearchParams(win.location.search);
  const devLobby = params.get('lobby');
  const lobbyUrl = devLobby ?? config.lobbyUrl ?? 'http://localhost:8475';

  const lobby = deps.createLobbyService({ lobbyUrl });
  const auth = createAuthMachine({ lobby, claimClub: deps.claimPendingClub });

  // ---- chrome -------------------------------------------------------------
  html(root, `
    <div class="shell">
      <header class="shellbar">
        <a class="brand" data-nav="/" href="#">FOBAL<span class="ai">.ai</span></a>
        <span class="chip shellbar-season">Season 01</span>
        <span class="shellbar-spacer"></span>
        <span id="connChip"></span>
        <span id="whoChip"></span>
        <button class="btn-quiet btn-sm" id="signOutBtn" hidden>Sign out</button>
      </header>
      <div class="shellbody">
        <nav class="shellnav" aria-label="Main">
          <a class="shellnav-item" data-nav="/" href="#" id="nav-club"><span aria-hidden="true">🏠</span><b>Club</b></a>
          <a class="shellnav-item" data-nav="/squad" href="#" id="nav-squad"><span aria-hidden="true">👕</span><b>Squad</b></a>
          <a class="shellnav-item" data-nav="/market" href="#" id="nav-market"><span aria-hidden="true">💱</span><b>Market</b></a>
          <a class="shellnav-item" data-nav="/lobby" href="#" id="nav-lobby"><span aria-hidden="true">🛰️</span><b>Lobby</b></a>
          <a class="shellnav-item" data-nav="/play" href="#" id="nav-play"><span aria-hidden="true">⚽</span><b>Play</b></a>
        </nav>
        <main class="shellmain" id="view" tabindex="-1"></main>
      </div>
    </div>`);

  const view = pick(root, 'view');
  let mounted = { name: null, dispose: /** @type {null | (() => void)} */ (null) };

  // ---- routing ------------------------------------------------------------
  const router = createRouter({
    window: win,
    keep: { lobby: devLobby },
    onChange: (match) => renderRoute(match),
  });

  for (const [id, path] of [['nav-club', '/'], ['nav-squad', '/squad'], ['nav-market', '/market'], ['nav-lobby', '/lobby'], ['nav-play', '/play']]) {
    pick(root, id).setAttribute('href', router.href(path));
  }
  root.querySelector('.brand')?.setAttribute('href', router.href('/'));

  /** '/' belongs to the club — or to the entry until a club exists here. */
  const viewNameFor = (match) => {
    if (match.route.view !== 'club') return match.route.view;
    const hasClub = !!deps.loadClub() || auth.state.status !== 'signed_out';
    return hasClub ? 'club' : 'entry';
  };

  let current = null;
  function renderRoute(match) {
    current = match;
    const name = viewNameFor(match);
    if (mounted.name === name) return;
    mounted.dispose?.();
    mounted = { name, dispose: null };
    win.document.title = `FOBAL — ${name === 'entry' ? 'Say the word' : match.route.title}`;
    view.classList.remove('view-enter');
    // restart the enter transition (transform/opacity only; reduced motion
    // collapses it via CSS)
    void view.offsetWidth;
    view.classList.add('view-enter');
    if (name === 'club') {
      const handle = mountClub(view, { auth, lobby, router, deps });
      mounted.dispose = handle?.dispose ?? null;
    } else if (name === 'squad') {
      const handle = mountSquad(view, { auth, router, deps });
      mounted.dispose = handle?.dispose ?? null;
    } else if (name === 'entry') {
      mountEntry(view, { auth, router });
    } else if (name === 'onboarding') {
      mountOnboarding(view, { router, deps });
    } else {
      html(view, `
        <div class="panel notfound">
          <span class="label">Off the pitch</span>
          <h1 class="display">This corridor leads nowhere.</h1>
          <p class="muted">The page you asked for is not part of the ground.</p>
          <a class="btn-primary" data-nav="/" href="${esc(router.href('/'))}">Back to the club</a>
        </div>`);
    }
    for (const [id, path] of [['nav-club', '/'], ['nav-squad', '/squad'], ['nav-market', '/market'], ['nav-lobby', '/lobby'], ['nav-play', '/play']]) {
      pick(root, id).classList.toggle('active', match.path === path || (path !== '/' && match.path.startsWith(path)));
    }
  }

  // ---- chrome updates from the one snapshot --------------------------------
  const nameOf = (me) => me?.identity?.displayName ?? me?.handle ?? '?';
  let chromeKey = '';
  function renderChrome() {
    const s = auth.state;
    const key = JSON.stringify([s.status, s.connection, s.me?.teamName, nameOf(s.me), s.me?.identity?.ensName]);
    if (key === chromeKey) return;
    chromeKey = key;
    const conn = pick(root, 'connChip');
    const who = pick(root, 'whoChip');
    const out = pick(root, 'signOutBtn');
    if (s.status === 'signed_in') {
      conn.innerHTML = s.connection === 'reconnecting'
        ? '<span class="chip">RECONNECTING…</span>'
        : '<span class="chip green"><span class="dot"></span>LIVE</span>';
      const label = s.me?.identity?.ensName
        ? `<span class="ens">${esc(s.me.identity.ensName)} ✓</span>`
        : esc(nameOf(s.me));
      who.innerHTML = `<span class="chip who-chip" title="${esc(s.me?.wallet ?? '')}">${label}<i>·</i>${esc(s.me?.teamName ?? '')}</span>`;
      out.hidden = false;
    } else if (s.status === 'entering') {
      conn.innerHTML = '<span class="chip">ENTERING…</span>';
      who.innerHTML = '<span class="chip"><span class="skeleton who-skel"></span></span>';
      out.hidden = true;
    } else {
      conn.innerHTML = '';
      who.innerHTML = '';
      out.hidden = true;
    }
  }
  pick(root, 'signOutBtn').addEventListener('click', () => auth.signOut());

  auth.on('change', () => {
    renderChrome();
    // '/' can flip between entry and club as the session comes and goes
    if (current && viewNameFor(current) !== mounted.name) renderRoute(current);
  });

  // ---- boot ----------------------------------------------------------------
  auth.resume();
  renderChrome();
  router.start();

  return { router, auth, lobby };
}
