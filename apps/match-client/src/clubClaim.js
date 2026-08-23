// The one-club handoff.
//
// apps/web's onboarding is where a player NAMES their club and picks its
// kit; the lobby is where that club takes the field. Until this module the
// two were unrelated identities: you could christen SKY COMETS, meet your
// eleven, click PLAY ONLINE — and arrive as "SANTI FC" with a different
// squad and no way back.
//
// The bridge is deliberately ONE-WAY and ONE-SHOT. The server account is
// canonical: it is what opponents see, what the manifest is built from,
// and what survives a new device. The local record is a DRAFT, adopted
// once, the first time its author signs in:
//
//   onboarding writes localStorage['fobal.club']
//     → first successful lobby entry adopts name + kit onto the account
//     → the draft is marked claimed and never applied again
//
// Two rules keep adoption safe:
//   1. NEVER clobber a club the player already named on the server. A
//      returning manager owns their identity; a stale local draft does not
//      get to overwrite it.
//   2. Claim ONCE — not once per account. Two sign-ins in one browser
//      (email in one tab, wallet in another, which is how local two-player
//      testing works) must not mint two clubs with the same name.

export const CLUB_KEY = 'fobal.club';

/** The server's own default, mirrored from apps/lobby-server/src/hub.ts:
 *  a fresh account is named `${HANDLE} FC`, capped at 32 chars. Anything
 *  else means the player has already chosen, and we keep our hands off. */
export function defaultTeamName(handle){
  return `${String(handle ?? '').toUpperCase()} FC`.slice(0, 32);
}

// the server's HEX_COLOR, mirrored — a draft with junk colors should fail
// here (silently ignored) rather than at the endpoint
const HEX = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/;
const isHex = v => typeof v === 'string' && HEX.test(v);

/**
 * What should be adopted onto the server for this draft, if anything.
 * PURE — no storage, no network. Returns null when nothing should happen.
 */
export function planClubClaim(club, account){
  if (!club || club.claimed) return null;
  if (!account || typeof account.teamName !== 'string') return null;
  // rule 1 — the club was already named online; the draft yields
  if (account.teamName !== defaultTeamName(account.handle)) return null;

  const plan = {};
  const name = typeof club.name === 'string' ? club.name.trim() : '';
  if (name.length >= 2 && name.length <= 32 && name !== account.teamName) plan.teamName = name;

  const colors = club.colors ?? club.kit;
  if (colors && (isHex(colors.primary) || isHex(colors.secondary))){
    plan.colors = {};
    if (isHex(colors.primary)) plan.colors.primary = colors.primary;
    if (isHex(colors.secondary)) plan.colors.secondary = colors.secondary;
  }
  return (plan.teamName || plan.colors) ? plan : null;
}

const markClaimed = (storage, club) => {
  try {
    storage.setItem(CLUB_KEY, JSON.stringify({ ...club, claimed: true }));
  } catch { /* a full or blocked store only costs us a repeat attempt */ }
};

/**
 * The slice of Storage this needs — declared so a test (or any other
 * host) can pass a two-method stand-in instead of a whole Storage.
 * @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void }} ClubDraftStore
 */

/**
 * Adopt the local draft onto the signed-in account.
 *   api      the lobby's authenticated fetch (path, {method, body}) → Response
 *   account  the `me` payload from GET /lobby
 *   storage  localStorage by default; injectable for tests
 *
 * @param {{ api: Function, account: unknown, storage?: ClubDraftStore }} options
 *
 * Never throws. Returns:
 *   null                          nothing to adopt, or a TRANSIENT failure
 *                                 (the draft stays claimable — a network
 *                                 blip must not lose the club you named)
 *   {ok:true, teamName, colors}   adopted
 *   {ok:false, reason}            permanently refused (moderation, length);
 *                                 consumed so it cannot retry forever
 */
export async function claimPendingClub({ api, account, storage = localStorage }){
  let club = null;
  try { club = JSON.parse(storage.getItem(CLUB_KEY)); } catch { return null; }
  const plan = planClubClaim(club, account);
  if (!plan) return null;

  try {
    if (plan.teamName){
      const res = await api('/account/team', { method: 'POST', body: { teamName: plan.teamName } });
      if (!res.ok){
        const out = await res.json().catch(() => ({}));
        markClaimed(storage, club);
        return { ok: false, reason: out.error ?? 'that club name was not accepted' };
      }
    }
    if (plan.colors) await api('/squad', { method: 'POST', body: { colors: plan.colors } });
  } catch {
    return null;
  }
  markClaimed(storage, club);
  return { ok: true, teamName: plan.teamName ?? null, colors: plan.colors ?? null };
}
