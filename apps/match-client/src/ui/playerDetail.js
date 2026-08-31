// Player detail drawer — the footballer first, the NFT second.
// Slides from the right (bottom sheet on mobile). Shows the full 13
// ratings as grouped animated bars, position badge, overall, rename (for
// generated squads — chain names are immutable by design), and a QUIET
// on-chain line (token id + explorer link) only when the player is an NFT.
import { avatarTile } from './playerCard.js';

const GROUPS = [
  ['Pace & engine', ['pace', 'accel', 'stamina']],
  ['Attack', ['shooting', 'dribbling', 'positioning']],
  ['Play', ['passing', 'vision', 'composure']],
  ['Defence', ['tackling', 'strength', 'aggression']],
  ['Goalkeeping', ['gk']],
];

const barColor = v => v >= 80 ? 'var(--green)' : v >= 60 ? '#eab308' : v >= 45 ? '#f97316' : 'var(--red, #f87171)';

export function createPlayerDetail({ explorerBase = 'https://sepolia.basescan.org', onRename } = {}) {
  const scrim = document.createElement('div');
  scrim.className = 'drawerScrim hidden';
  const drawer = document.createElement('aside');
  drawer.className = 'drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-label', 'Player details');
  document.body.append(scrim, drawer);

  let lastFocus = null;
  const close = () => {
    drawer.classList.remove('on');
    scrim.classList.remove('on');
    setTimeout(() => scrim.classList.add('hidden'), 220);
    lastFocus?.focus?.();
  };
  scrim.addEventListener('click', close);
  const onKeydown = e => {
    if (e.key === 'Escape' && drawer.classList.contains('on')) close();
  };
  document.addEventListener('keydown', onKeydown);

  /** Remove the drawer from the document entirely — for hosts that mount
   *  and unmount views (the unified app). The standalone pages never call
   *  this; for them the drawer lives as long as the document. */
  const destroy = () => {
    document.removeEventListener('keydown', onKeydown);
    scrim.remove();
    drawer.remove();
  };

  function open(player, { colors, source } = {}) {
    lastFocus = document.activeElement;
    drawer.replaceChildren();

    const closeBtn = document.createElement('button');
    closeBtn.className = 'dClose sm ghost';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Close player details');
    closeBtn.addEventListener('click', close);

    const head = document.createElement('div');
    head.className = 'dHead';
    head.appendChild(avatarTile(player, colors, { large: true }));
    const id = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'dName';
    name.textContent = player.name;
    const meta = document.createElement('div');
    meta.className = 'dMeta';
    const badge = document.createElement('span');
    badge.className = `roleBadge${player.role === 'GK' ? ' gk' : ''}`;
    badge.textContent = player.role;
    const shirt = document.createElement('span');
    shirt.className = 'muted';
    shirt.style.fontFamily = 'var(--mono)';
    shirt.textContent = `#${player.shirtNumber}`;
    meta.append(badge, shirt);
    id.append(name, meta);
    const ovr = document.createElement('div');
    ovr.className = 'dOvr';
    ovr.innerHTML = `<b>${player.overall ?? '—'}</b><span>OVERALL</span>`;
    head.append(id, ovr);
    drawer.append(closeBtn, head);

    // ratings — grouped bars, revealed on the next frame so widths animate
    const bars = [];
    for (const [label, keys] of GROUPS) {
      if (label === 'Goalkeeping' && player.role !== 'GK' && (player.ratings?.gk ?? 0) < 30) continue;
      const h = document.createElement('h3');
      h.textContent = label;
      drawer.appendChild(h);
      for (const key of keys) {
        const v = player.ratings?.[key];
        if (v === undefined) continue;
        const row = document.createElement('div');
        row.className = 'statRow';
        row.innerHTML = `<span class="sl">${key}</span><span class="bar"><i></i></span><span class="sv">${v}</span>`;
        const fill = row.querySelector('i');
        fill.style.background = barColor(v);
        bars.push([fill, v]);
        drawer.appendChild(row);
      }
    }
    // timeouts, not rAF: background/hidden tabs starve rAF (the repo's
    // documented landmine) and the reveal must not depend on frame timing
    setTimeout(() => {
      for (const [fill, v] of bars) fill.style.width = `${v}%`;
    }, 60);

    // identity actions — rename only where identity is editable
    if (onRename && source !== 'chain') {
      const h = document.createElement('h3');
      h.textContent = 'Name';
      const row = document.createElement('div');
      row.className = 'renameRow';
      const input = document.createElement('input');
      input.value = player.name;
      input.maxLength = 24;
      input.setAttribute('aria-label', 'Player name');
      const save = document.createElement('button');
      save.className = 'sm primary';
      save.textContent = 'SAVE NAME';
      const note = document.createElement('span');
      note.className = 'muted';
      save.addEventListener('click', async () => {
        save.disabled = true;
        note.textContent = 'saving…';
        try {
          await onRename(player, input.value);
          note.textContent = 'Saved.';
        } catch (err) {
          note.textContent = String(err.message ?? err);
        } finally { save.disabled = false; }
      });
      drawer.append(h, row);
      row.append(input, save);
      drawer.append(note);
    }

    // the on-chain line — present, quiet, never dominant
    if (player.tokenId) {
      const h = document.createElement('h3');
      h.textContent = 'On-chain';
      const info = document.createElement('div');
      info.className = 'chainInfo';
      const tok = document.createElement('span');
      tok.textContent = `TOKEN #${player.tokenId}`;
      info.append(tok);
      const contract = window.FOBAL_CONFIG?.playerContract;
      if (contract) {
        const link = document.createElement('a');
        link.href = `${explorerBase}/token/${contract}?a=${player.tokenId}`;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'View on explorer ↗';
        info.append(link);
      }
      const note = document.createElement('span');
      note.textContent = 'name & identity are permanent';
      info.append(note);
      drawer.append(h, info);
    }

    scrim.classList.remove('hidden');
    setTimeout(() => { scrim.classList.add('on'); drawer.classList.add('on'); }, 10);
    closeBtn.focus();
  }

  return { open, close, destroy };
}
