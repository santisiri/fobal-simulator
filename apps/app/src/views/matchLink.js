// The hand-off into the golden match client — one builder, used by the
// club home, the lobby, and match history. The live match experience IS
// the existing match client; the app only addresses it.

// Root-absolute like every cross-page URL the app emits — a view can be
// rendered at a deep link (/lobby, /market/42), where a relative file
// name would resolve under the link and 404.

/** controller/spectator entry for a live match */
export function matchClientUrl(match, token) {
  const ws = match.matchUrl.replace(/^http/, 'ws');
  return `/index.html?ws=${encodeURIComponent(ws)}&match=${encodeURIComponent(match.matchId)}&token=${encodeURIComponent(token)}`;
}

/** replay entry for a finished match (history rows) */
export function replayClientUrl(m) {
  return `/index.html?replayUrl=${encodeURIComponent(m.matchUrl)}`
    + `&match=${encodeURIComponent(m.matchId)}&token=${encodeURIComponent(m.spectatorToken)}`;
}

/** the armed-once auto-enter key — per-tab, same as the lobby always used */
export const ENTERED_KEY = 'fobal.lobby.entered';
