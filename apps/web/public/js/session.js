// The lobby session, as the web surfaces see it.
//
// lobby.html owns the session (sessionStorage, per-tab ON PURPOSE so two
// tabs are two managers during local testing). The club pages only READ
// it, so that the club shown at home is the club that takes the field —
// the server account is canonical, and these pages are its view.
//
// Every call degrades to null: signed out, offline, or a lobby that is not
// there yet must never stop the hub from rendering.

const SESSION_KEY = 'fobal.lobby.session';

/** {url, token} when a lobby session exists in THIS tab, else null. */
export function lobbySession(){
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    return s && typeof s.url === 'string' && typeof s.token === 'string' ? s : null;
  } catch { return null; }
}

async function get(session, path){
  const res = await fetch(`${session.url}${path}`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/**
 * The signed-in club, straight from the lobby: the name opponents see, the
 * real record, the kit that will be worn. Null when signed out or the
 * lobby cannot be reached.
 */
export async function fetchClubView(){
  const session = lobbySession();
  if (!session) return null;
  try {
    const [lobby, squad] = await Promise.all([get(session, '/lobby'), get(session, '/squad')]);
    return {
      teamName: squad?.teamName ?? lobby?.me?.teamName ?? null,
      record: lobby?.me?.record ?? null,
      colors: squad?.colors ?? null,
      players: Array.isArray(squad?.players) ? squad.players.length : null,
    };
  } catch { return null; }
}
