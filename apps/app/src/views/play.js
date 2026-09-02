// Play — /play. Absorbs play.html: choose your match. Online rides the
// lobby loop; offline boots the GOLDEN simulator in an iframe, dressed as
// YOUR club — same seam the online puppet uses to dress the golden bodies,
// applied here so a friendly reads as your team. The golden file itself is
// untouched, always.
import { esc, html, pick } from '../ui.js';

/**
 * @param {HTMLElement} el
 * @param {{ auth: any, lobby: any, router: any, deps: any, config: any }} ctx
 * @returns {{ dispose(): void }}
 */
export function mountPlay(el, { auth, lobby, router, deps, config }) {
  const goldenUrl = config?.goldenUrl ?? '/golden/index.html';
  let bootTimer = null;
  let disposed = false;

  /** the club that takes the field offline: the local draft first, else the
   *  signed-in account's squad (names + kit), else nobody — found a club */
  async function clubForOffline() {
    const draft = deps.loadClub();
    if (draft) return { name: draft.name, kit: draft.kit, players: draft.squad.players };
    if (auth.state.status !== 'signed_in') return null;
    try {
      const squad = await lobby.getSquad();
      return {
        name: squad.teamName ?? auth.state.me?.teamName ?? 'YOUR CLUB',
        kit: { primary: squad.colors?.primary ?? '#22c55e', secondary: squad.colors?.secondary ?? '#0d1428' },
        players: squad.players ?? [],
      };
    } catch { return null; }
  }

  html(el, `
    <div class="playwrap">
      <div class="play-intro">
        <span class="label green">Kick off</span>
        <h1 class="display">Choose your match.</h1>
        <p class="muted">Take your club online against a live manager — or run a friendly
          against the AI to learn your squad.</p>
      </div>
      <div class="modes">
        <a class="panel mode mode--online" data-nav="/lobby" href="${esc(router.href('/lobby'))}">
          <span class="chip green mode-tag"><span class="dot"></span>Live</span>
          <span class="mode-ico" aria-hidden="true">🛰️</span>
          <h2 class="display">Play online</h2>
          <p>Find a live opponent in the lobby. Lineups lock, the engine settles the
            result — and you coach by voice while it plays.</p>
          <span class="mode-go label green">Find a rival →</span>
        </a>
        <button class="panel mode mode--offline" id="offlineBtn" type="button">
          <span class="chip purple mode-tag">VS AI</span>
          <span class="mode-ico" aria-hidden="true">🎮</span>
          <h2 class="display">Play offline</h2>
          <p>A friendly against the AI, right now — no opponent, no stake. Your club,
            your kit, on the golden pitch.</p>
          <span class="mode-go label">Kick off →</span>
        </button>
      </div>
      <p class="muted play-note" id="playNote"></p>
    </div>
    <div class="stage" id="stage" hidden>
      <div class="stagebar">
        <button class="btn-quiet btn-sm" id="exitMatch">‹ Leave</button>
        <span class="crest" id="stageCrest"><i id="stageStripe"></i><b></b></span>
        <span class="stage-vs" id="stageVs"></span>
        <span class="stagebar-spacer"></span>
        <span class="label" id="stageTip">click the pitch to take control · space to sprint</span>
      </div>
      <iframe id="goldenFrame" title="FOBAL offline match"></iframe>
    </div>`);

  const code3 = (name) => (String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'FOB').padEnd(3, 'X');

  // Apply the club's identity to the golden home team (teams[0]) — kit,
  // code, name and player names. The instruction is applied from OUTSIDE;
  // the golden file stays golden.
  function dressHomeTeam(win, club) {
    const g = win.game;
    if (!g || !g.teams || g.teams.length < 2) return false;
    const t = g.teams[0];
    t.name = club.name.toUpperCase();
    t.code = code3(club.name);
    t.kit.shirt = club.kit.primary; t.kit.socks = club.kit.primary;
    t.kit.shorts = club.kit.secondary; t.kit.trim = club.kit.secondary;
    for (const gp of [...t.players, ...(t.bench || [])]) {
      if (gp.isGK || !gp.app) continue;
      gp.app.shirt = club.kit.primary; gp.app.socks = club.kit.primary;
      gp.app.shorts = club.kit.secondary; gp.app.trim = club.kit.secondary;
    }
    club.players.forEach((p, i) => { if (t.players[i]) t.players[i].name = p.name; });
    g.teams[1].name = 'RIVALS AI'; g.teams[1].code = 'AI';
    return true;
  }

  async function startOffline() {
    const note = pick(el, 'playNote');
    const club = await clubForOffline();
    if (disposed) return;
    if (!club) {
      note.innerHTML = `A friendly needs a club to play as — <a data-nav="/onboarding" href="${esc(router.href('/onboarding'))}">found yours first</a>, or sign in.`;
      return;
    }
    note.textContent = '';
    const stage = pick(el, 'stage');
    stage.hidden = false;
    pick(el, 'stageStripe').style.background =
      `linear-gradient(135deg, ${club.kit.primary} 0 50%, ${club.kit.secondary} 50% 100%)`;
    html(pick(el, 'stageVs'), `${esc(club.name.toUpperCase())} <span class="muted">vs AI</span>`);
    const iframe = /** @type {HTMLIFrameElement} */ (pick(el, 'goldenFrame'));
    iframe.src = goldenUrl;
    // poll for the golden game to boot, then dress our team (re-apply
    // briefly in case the sim reshuffles at kickoff)
    let applied = 0;
    clearInterval(bootTimer);
    bootTimer = setInterval(() => {
      const win = iframe.contentWindow;
      if (win && win.game && dressHomeTeam(win, club)) {
        applied++;
        if (applied === 1) {
          win.game.humanMode = true;
          win.game.selected = win.game.nearestToBall?.(win.game.teams[0]) ?? null;
        }
        if (applied >= 6) clearInterval(bootTimer);
      }
    }, 500);
  }

  function exitMatch() {
    clearInterval(bootTimer);
    /** @type {HTMLIFrameElement} */ (pick(el, 'goldenFrame')).src = 'about:blank';
    pick(el, 'stage').hidden = true;
  }

  pick(el, 'offlineBtn').addEventListener('click', startOffline);
  pick(el, 'exitMatch').addEventListener('click', exitMatch);
  const onKey = (e) => { if (e.key === 'Escape' && !pick(el, 'stage').hidden) exitMatch(); };
  window.addEventListener('keydown', onKey);

  return {
    dispose() {
      disposed = true;
      clearInterval(bootTimer);
      window.removeEventListener('keydown', onKey);
    },
  };
}
