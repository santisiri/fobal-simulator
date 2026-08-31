// Tiny DOM vocabulary for the app views — no framework, one idiom.

/** Escape untrusted text (team names, handles are typed by OTHER players). */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));

/** Render an HTML string into a container. */
export function html(el, markup) {
  el.innerHTML = markup;
  return el;
}

/** getElementById scoped to a root — views never reach outside their mount. */
export const pick = (root, id) => /** @type {HTMLElement} */ (root.querySelector(`#${id}`));

/** The eleven-pip acknowledgment — the product's signature "settled" moment.
 *  Returns markup; arm it by adding .ripple--go (transform/opacity only,
 *  reduced-motion collapses to a single fade via the shared system CSS). */
export const elevenPips = (own = false) =>
  `<span class="ripple${own ? ' ripple--own' : ''}" aria-hidden="true">${'<i></i>'.repeat(11)}</span>`;

/** Crest markup — the kit worn as identity, everywhere the club appears. */
export function crestHtml(colors, initials, { size = '' } = {}) {
  const c1 = colors?.primary || '#22c55e';
  const c2 = colors?.secondary || '#0d1428';
  return `<span class="crest ${size}" aria-hidden="true">
    <i style="background:linear-gradient(135deg, ${esc(c1)} 0 50%, ${esc(c2)} 50% 100%)"></i>
    <b>${esc(initials)}</b>
  </span>`;
}

/** "2m ago" for history rows — matches the lobby's voice. */
export function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}
