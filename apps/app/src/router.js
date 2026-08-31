// The app's one router — History API over the pure route table.
//
// Internal routes render in place (pushState, no reload); routes still
// owned by a standalone page hand off with a full navigation. Both kinds
// come out of the SAME table, so absorbing a page in a later slice is a
// route-table edit, not a navigation rewrite.
import { currentPath, detectMode, hrefFor, legacyHref, matchRoute, normalizePath } from './routes.js';

/**
 * @param {{
 *   window: Window,
 *   onChange: (match: { route: any, params: Record<string,string>, path: string }) => void,
 *   keep?: Record<string, string|null|undefined>,
 * }} options
 */
export function createRouter({ window: win, onChange, keep = {} }) {
  const mode = detectMode(win.location.pathname);
  const docPath = mode === 'query' ? win.location.pathname : '/app.html';

  const href = (path) => hrefFor(path, { mode, docPath, keep });

  function resolve() {
    return matchRoute(currentPath(win.location, mode));
  }

  /** Navigate to an app path. Legacy routes leave the document on purpose. */
  function go(path, { replace = false } = {}) {
    const match = matchRoute(path);
    if (match.route.legacy) {
      win.location.assign(legacyHref(match.route.legacy, { keep }));
      return match;
    }
    const url = href(match.path);
    if (replace) win.history.replaceState({ p: match.path }, '', url);
    else win.history.pushState({ p: match.path }, '', url);
    onChange(match);
    return match;
  }

  function start() {
    win.addEventListener('popstate', () => onChange(resolve()));
    // one delegated listener; only links that opt in with data-nav are ours,
    // and modified clicks (new tab, download) keep their browser meaning
    win.document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = /** @type {Element|null} */ (e.target instanceof Element ? e.target.closest('a[data-nav]') : null);
      if (!a) return;
      const to = a.getAttribute('data-nav');
      if (!to) return;
      e.preventDefault();
      go(to);
    });
    const first = resolve();
    // a deep link to a page a later slice absorbs — hand off, don't 404
    if (first.route.legacy) {
      win.location.assign(legacyHref(first.route.legacy, { keep }));
      return first;
    }
    // normalize whatever URL we woke up on (…/app.html, trailing slash)
    win.history.replaceState({ p: first.path }, '', href(first.path));
    onChange(first);
    return first;
  }

  return { mode, href, go, start, resolve, normalizePath };
}
