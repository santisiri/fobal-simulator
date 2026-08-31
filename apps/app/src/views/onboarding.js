// Found your club — the onboarding wizard, absorbed from onboarding.html.
// Three steps: name + kit → signed generation moment → meet your team.
// Writes the local draft (localStorage['fobal.club']); the auth machine's
// club claim adopts it onto the account on first sign-in — or on the very
// next poll when the founder is already signed in.
import { esc, html, pick } from '../ui.js';

/**
 * @param {HTMLElement} el
 * @param {{ router: any, deps: any }} ctx
 */
export function mountOnboarding(el, { router, deps }) {
  const state = { name: '', kit: { primary: '#22c55e', secondary: '#0d1428' }, squad: null };

  html(el, `
    <div class="onb">
      <div class="rail" id="rail">
        <div class="rail-step active" data-step="1"><div class="rail-bar"></div><span class="rail-n">01</span><span class="rail-t">Create club</span></div>
        <div class="rail-step" data-step="2"><div class="rail-bar"></div><span class="rail-n">02</span><span class="rail-t">Generate squad</span></div>
        <div class="rail-step" data-step="3"><div class="rail-bar"></div><span class="rail-n">03</span><span class="rail-t">Meet your team</span></div>
      </div>

      <section class="stepview on" id="step1">
        <div class="onb-create">
          <div>
            <span class="label green">01 · Enter the tunnel</span>
            <h1 class="display">Found your club.</h1>
            <p class="muted">Name it, choose your colors. Your kit becomes the on-chain appearance of
              every player you own — the identity your squad carries for its whole career.</p>
            <div class="field-row">
              <label class="label" for="obName">Club name</label>
              <input class="input" id="obName" maxlength="24" placeholder="e.g. Fobal FC" autocomplete="off">
            </div>
            <div class="field-row">
              <span class="label">Kit colors</span>
              <div class="kits">
                <div class="kitpick"><span class="muted">Primary — shirt</span>
                  <div class="swatchrow"><input type="color" id="obPrimary" value="#22c55e"><span class="mono muted" id="obPrimaryHex">#22c55e</span></div></div>
                <div class="kitpick"><span class="muted">Secondary — shorts</span>
                  <div class="swatchrow"><input type="color" id="obSecondary" value="#0d1428"><span class="mono muted" id="obSecondaryHex">#0d1428</span></div></div>
              </div>
            </div>
            <button class="btn-primary btn-lg" id="toStep2" disabled>Enter the tunnel →</button>
          </div>
          <div class="panel crestcard">
            <span class="label">Club preview</span>
            <div class="crestbig" id="obCrest"><div class="crestbig-stripe" id="obStripe"></div><span id="obInitials">FC</span></div>
            <div class="crestcard-name" id="obCrestName">Your Club</div>
            <div class="label" id="obCrestKit">— · —</div>
          </div>
        </div>
      </section>

      <section class="stepview" id="step2">
        <div class="onb-generate">
          <span class="label purple">02 · Signed generation</span>
          <h1 class="display">Minting your starter XI.</h1>
          <p class="muted">The Fobal generation engine signs your squad — eleven footballers, each with
            unique DNA, appearance and abilities, bounded by protocol so no two clubs start alike.</p>
          <div class="scan">
            <div class="scan-track"><i id="scanBar"></i></div>
            <div class="scan-log mono" id="scanLog">awaiting signature…</div>
          </div>
        </div>
      </section>

      <section class="stepview" id="step3">
        <div class="onb-meet">
          <span class="label green">03 · Team sheet</span>
          <h1 class="display" id="meetTitle">Meet your team.</h1>
          <p class="muted onb-meet-sub">Eleven NFTs, dealt onto the pitch in a 4-3-3. Tap any footballer to read
            their card. Every avatar here is drawn by the same code, from the same data, as the art the chain mints.</p>
          <div class="obreveal">
            <div class="pitchwrap"><div class="obpitch">
              <div class="obpitch-lines"></div><div class="obpitch-box top"></div><div class="obpitch-box bottom"></div>
              <div id="obTokens"></div>
            </div></div>
            <div class="panel obcard" id="obCard"><div class="pcard-hint muted">Tap a player to scout them.</div></div>
          </div>
          <div class="footer-cta">
            <button class="btn-primary btn-lg" id="enterClub">Enter your club →</button>
            <span class="label">preview build — squad is deterministic from your club name</span>
          </div>
        </div>
      </section>
    </div>`);

  const $ = (id) => pick(el, id);

  function goStep(n) {
    for (const s of [1, 2, 3]) {
      $(`step${s}`).classList.toggle('on', s === n);
      const rs = el.querySelector(`.rail-step[data-step="${s}"]`);
      rs?.classList.toggle('active', s === n);
      rs?.classList.toggle('done', s < n);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- step 1: create ----
  function refreshCreate() {
    state.name = /** @type {HTMLInputElement} */ ($('obName')).value.trim();
    state.kit.primary = /** @type {HTMLInputElement} */ ($('obPrimary')).value;
    state.kit.secondary = /** @type {HTMLInputElement} */ ($('obSecondary')).value;
    $('obPrimaryHex').textContent = state.kit.primary;
    $('obSecondaryHex').textContent = state.kit.secondary;
    $('obStripe').style.background = `linear-gradient(135deg, ${state.kit.primary} 0 50%, ${state.kit.secondary} 50% 100%)`;
    $('obInitials').textContent = deps.crestInitials(state.name || 'FC');
    $('obCrestName').textContent = state.name || 'Your Club';
    $('obCrestKit').textContent = `${state.kit.primary} · ${state.kit.secondary}`;
    /** @type {HTMLButtonElement} */ ($('toStep2')).disabled = state.name.length < 2;
  }
  for (const id of ['obName', 'obPrimary', 'obSecondary']) $(id).addEventListener('input', refreshCreate);
  refreshCreate();
  /** @type {HTMLInputElement} */ ($('obName')).focus();

  // ---- step 2: the generation moment ----
  const LOG = [
    'requesting generation…',
    'engine signing SquadMint (EIP-712)…',
    'checking power budget…',
    'rolling DNA · appearance · abilities…',
    'squad signed ✓',
  ];
  function runGeneration() {
    goStep(2);
    state.squad = deps.generateSquad({ clubName: state.name, kit: state.kit });
    const bar = $('scanBar'); const log = $('scanLog');
    const dur = 2100; const start = Date.now();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { bar.style.width = '100%'; log.textContent = LOG[LOG.length - 1]; setTimeout(showTeam, 400); return; }
    // setInterval, not rAF: timers still fire (throttled) in a backgrounded
    // tab, so a founder who tabs away mid-generation still lands on their team
    const timer = setInterval(() => {
      const pct = Math.min(1, (Date.now() - start) / dur);
      bar.style.width = `${pct * 100}%`;
      log.textContent = LOG[Math.min(LOG.length - 1, Math.floor(pct * LOG.length))];
      if (pct >= 1) { clearInterval(timer); setTimeout(showTeam, 450); }
    }, 60);
  }
  $('toStep2').addEventListener('click', runGeneration);

  // ---- step 3: meet your team ----
  function showTeam() {
    goStep(3);
    $('meetTitle').textContent = `Meet ${state.name}.`;
    const tokens = $('obTokens');
    tokens.innerHTML = '';
    state.squad.players.forEach((p, i) => {
      const t = document.createElement('div');
      t.className = 'obtoken';
      t.style.left = `${p.x}%`;
      t.style.top = `${100 - p.y}%`;
      t.innerHTML = deps.avatarSvgDressed({ appearance: BigInt(p.appearance), dna: p.dna, position: p.position }, state.kit)
        + `<span class="obtoken-nm">${esc(p.name.split(' ')[1] || p.name)}</span>`;
      t.tabIndex = 0;
      t.setAttribute('role', 'button');
      t.setAttribute('aria-label', `${p.name}, ${p.role}, overall ${p.overall}`);
      const sel = () => { scout(p); for (const x of tokens.children) x.classList.remove('sel'); t.classList.add('sel'); };
      t.addEventListener('click', sel);
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel(); } });
      tokens.appendChild(t);
    });
    scout(state.squad.players[9]);
    tokens.children[9]?.classList.add('sel');
  }

  const barColor = (v) => (v >= 75 ? 'var(--green)' : v >= 55 ? '#e0c04a' : '#e08a3a');
  function scout(p) {
    const face = deps.ratingFace(p.skills);
    const rows = face.map(([lb, v]) =>
      `<div class="rating"><span class="lb">${lb}</span><span class="bar"><i style="width:${v}%;background:${barColor(v)}"></i></span><span class="val">${v}</span></div>`).join('');
    html($('obCard'), `
      <div class="pcard-kitbar" style="background:linear-gradient(90deg, ${state.kit.primary}, ${state.kit.secondary})"></div>
      <div class="pcard-top">
        <img class="pcard-av avatar-hero" alt=""
          src="${'data:image/svg+xml;utf8,' + encodeURIComponent(deps.avatarSvgDressed({ appearance: BigInt(p.appearance), dna: p.dna, position: p.position }, state.kit))}">
        <div class="pcard-who"><div class="pcard-nm">${esc(p.name)}</div><div class="pcard-meta mono">#${p.shirt} · ${esc(p.role)} · ${esc(state.name)}</div></div>
        <div class="pcard-ovr"><div class="v">${p.overall}</div><div class="l">OVR</div></div>
      </div>
      <div class="pcard-ratings">${rows}</div>
      <div class="pcard-dna mono">DNA ${esc(p.dna.replace(/^0x/, '').slice(0, 24))}…</div>`);
  }

  // ---- persist + enter the club ----
  $('enterClub').addEventListener('click', () => {
    deps.saveClub({ name: state.name, kit: state.kit, squad: state.squad, createdAt: Date.now() });
    router.go('/');
  });
}
