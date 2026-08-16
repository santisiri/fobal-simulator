// PlayerCard — the reusable face of a footballer everywhere in the product.
// Renders from the GET /squad payload shape alone:
//   { playerId, name, role, shirtNumber, overall?, ratings?, tokenId? }
// The avatar today is an honest kit monogram (kit colors + shirt number);
// the tile is the seam where generative NFT art lands once appearance data
// is served (player-data-model workstream) — nothing else changes.

const GK_ROLES = new Set(['GK']);

/** last name, or the whole thing when it is short */
export function displayName(name) {
  const parts = String(name).trim().split(/\s+/);
  return parts.length > 1 && name.length > 12 ? parts[parts.length - 1] : name;
}

/** kit-colored monogram tile (shared by card + drawer) */
export function avatarTile(player, colors, { large = false } = {}) {
  const tile = document.createElement('div');
  tile.className = `tile${GK_ROLES.has(player.role) ? ' gk' : ''}`;
  if (colors?.primary) tile.style.setProperty('--k1', colors.primary);
  if (colors?.secondary) tile.style.setProperty('--k2', colors.secondary);
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = `${player.shirtNumber ?? ''}`;
  tile.appendChild(num);
  if (!large && player.overall) {
    const ovr = document.createElement('span');
    ovr.className = 'ovr';
    ovr.textContent = `${player.overall}`;
    tile.appendChild(ovr);
  }
  return tile;
}

/** an interactive on-pitch/bench card; onOpen(player) on click/Enter/Space */
export function playerCard(player, colors, { onOpen, revealDelay = 0 } = {}) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `pcard reveal${GK_ROLES.has(player.role) ? ' gk' : ''}`;
  el.style.animationDelay = `${revealDelay}ms`;
  el.setAttribute('aria-label', `${player.name}, ${player.role}, overall ${player.overall ?? '—'}`);
  el.appendChild(avatarTile(player, colors));
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = displayName(player.name);
  const rl = document.createElement('span');
  rl.className = 'rl';
  rl.textContent = player.role;
  el.append(nm, rl);
  if (onOpen) el.addEventListener('click', () => onOpen(player));
  return el;
}

/** a same-shape skeleton so the pitch never shifts while loading */
export function playerCardSkeleton() {
  const el = document.createElement('div');
  el.className = 'pcard skel-card';
  const tile = document.createElement('div');
  tile.className = 'tile skel';
  const nm = document.createElement('span');
  nm.className = 'nm skel';
  nm.textContent = '········';
  const rl = document.createElement('span');
  rl.className = 'rl skel';
  rl.textContent = '··';
  el.append(tile, nm, rl);
  return el;
}
