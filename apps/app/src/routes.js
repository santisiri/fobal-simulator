// The unified app's route table — pure logic, no DOM, no history.
//
// One destination, clean routes (docs/CLUB_AND_MARKET.md fixed the shapes):
//
//   /            the club — home; onboarding takes over for first-timers
//   /onboarding  found your club (the wizard)
//   /squad       the squad room                    (absorbed in J2)
//   /market      the marketplace, /market/:tokenId (absorbed in J3)
//   /lobby       matchmaking                       (absorbed in J4)
//   /play        mode select                       (absorbed in J5)
//
// Routes not yet absorbed HAND OFF to the proven standalone pages — the
// `legacy` field names the file. A hand-off is a full navigation on
// purpose: the old page keeps working until its replacement ships in the
// same PR that deletes it (workstream J discipline). Session continuity is
// free — the lobby session lives in per-tab sessionStorage either way.
//
// Two URL modes, one route table:
//   'path'   — clean paths (/squad). Needs a host that rewrites
//              extensionless paths to /app.html: the CloudFront function in
//              infra/cloudfront/app-router-function.js, or
//              tools/serve-client.mjs locally.
//   'query'  — the app document addressed directly (…/app.html?p=/squad).
//              Works on any static host with zero rewrite support — the
//              honest fallback until the CloudFront function is attached.
// The mode is detected once from how the document was reached; every href
// the app renders is built for that mode, so deep links always survive a
// refresh.

/** @typedef {{ path: string | null, view?: string, legacy?: string, title: string }} Route */

/** @type {Route[]} */
export const ROUTES = [
  { path: '/', view: 'club', title: 'Club' },
  { path: '/onboarding', view: 'onboarding', title: 'Found your club' },
  { path: '/squad', legacy: 'squad.html', title: 'Squad' },
  { path: '/market/:tokenId', legacy: 'market.html', title: 'Market' },
  { path: '/market', legacy: 'market.html', title: 'Market' },
  { path: '/lobby', legacy: 'lobby.html', title: 'Lobby' },
  { path: '/play', legacy: 'play.html', title: 'Play' },
  { path: '/invite', legacy: 'invite.html', title: 'Match challenge' },
];

export const NOT_FOUND = Object.freeze(/** @type {Route} */ ({ path: null, view: 'notFound', title: 'Lost' }));

/** '/market/42/' → '/market/42'; '' or '/app.html' → '/' */
export function normalizePath(path) {
  let p = String(path ?? '').split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/app\.html$/, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/** Match one pattern ('/market/:tokenId') against a normalized path. */
export function matchPattern(pattern, path) {
  const ps = String(pattern).split('/').filter(Boolean);
  const xs = path.split('/').filter(Boolean);
  if (ps.length !== xs.length) return null;
  /** @type {Record<string, string>} */
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], x = xs[i];
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(x);
    else if (p !== x) return null;
  }
  return params;
}

/** The route (+ params) for a path, or NOT_FOUND — never throws. */
export function matchRoute(path) {
  const p = normalizePath(path);
  for (const route of ROUTES) {
    const params = matchPattern(route.path, p);
    if (params) return { route, params, path: p };
  }
  return { route: NOT_FOUND, params: {}, path: p };
}

/**
 * How this document is being served. A pathname that still ends in `.html`
 * means no rewrite layer sits in front of us — route via the query string.
 */
export function detectMode(pathname) {
  return /\.html$/.test(String(pathname ?? '')) ? 'query' : 'path';
}

/** The app path encoded in a document URL, for either mode. */
export function currentPath({ pathname, search }, mode = detectMode(pathname)) {
  if (mode === 'query') {
    const q = new URLSearchParams(search ?? '');
    return normalizePath(q.get('p') ?? '/');
  }
  return normalizePath(pathname);
}

/**
 * An href for an internal route, in the active mode. `keep` carries sticky
 * query params (the dev `?lobby=` override) through every navigation.
 * @param {string} path
 * @param {{ mode?: string, docPath?: string, keep?: Record<string, string|null|undefined> }} [options]
 */
export function hrefFor(path, { mode = 'path', docPath = '/app.html', keep = {} } = {}) {
  const p = normalizePath(path);
  const extras = Object.entries(keep).filter(([, v]) => v != null && v !== '');
  if (mode === 'query') {
    const q = new URLSearchParams();
    if (p !== '/') q.set('p', p);
    for (const [k, v] of extras) q.set(k, /** @type {string} */ (v));
    const qs = q.toString();
    return `${docPath}${qs ? `?${qs}` : ''}`;
  }
  const q = new URLSearchParams();
  for (const [k, v] of extras) q.set(k, /** @type {string} */ (v));
  const qs = q.toString();
  return `${p}${qs ? `?${qs}` : ''}`;
}

/** The hand-off URL for a legacy page (relative — pages ship side by side). */
export function legacyHref(file, { keep = {} } = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(keep)) if (v != null && v !== '') q.set(k, v);
  const qs = q.toString();
  return `${file}${qs ? `?${qs}` : ''}`;
}
