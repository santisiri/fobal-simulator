// Squad experience — an 11 you can read at a glance.
// Pitch with positional rows, bench, team overall, and the player detail
// drawer. Consumes the lobby's GET /squad payload through a tiny adapter
// so the data source can move (richer chain reads land in the data-model
// workstream) without touching this presentation.
import { playerCard, playerCardSkeleton } from './playerCard.js';
import { createPlayerDetail } from './playerDetail.js';

const ROW_OF = role =>
  role === 'GK' ? 0 :
  ['CB', 'LB', 'RB'].includes(role) ? 1 :
  ['CM', 'LM', 'RM'].includes(role) ? 2 : 3;

/** left-to-right order inside a row: LB … CBs … RB, LM … CMs … RM */
const SIDE_OF = role => role.startsWith('L') ? 0 : role.startsWith('R') ? 2 : 1;

export function createSquadView(mount, { api, onSquadSaved } = {}) {
  const detail = createPlayerDetail({
    onRename: async (player, name) => {
      const res = await api('/squad', { method: 'POST', body: { players: [{ playerId: player.playerId, name }] } });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? 'rename failed');
      await load();                      // re-render with the saved name
      onSquadSaved?.();
    },
  });

  function skeleton() {
    mount.replaceChildren();
    const pitch = document.createElement('div');
    pitch.className = 'pitch';
    for (const count of [1, 4, 4, 2]) {
      const row = document.createElement('div');
      row.className = 'prow';
      for (let i = 0; i < count; i++) row.appendChild(playerCardSkeleton());
      pitch.appendChild(row);
    }
    mount.appendChild(pitch);
  }

  async function load() {
    const res = await api('/squad');
    if (!res.ok) {
      mount.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'muted', textContent: 'Your squad did not load. It will retry the next time you open it.',
      }));
      return null;
    }
    render(await res.json());
    return true;
  }

  function render(squad) {
    mount.replaceChildren();
    const xi = squad.players.slice(0, 11);
    const bench = squad.players.slice(11);
    const colors = squad.colors ?? undefined;
    const openDetail = p => detail.open(p, { colors, source: squad.source });

    // header: team overall + provenance, quietly
    const stats = document.createElement('div');
    stats.className = 'squadStats';
    const overall = Math.round(xi.reduce((s, p) => s + (p.overall ?? 0), 0) / xi.length);
    const big = document.createElement('div');
    big.className = 'ovrBig';
    big.innerHTML = `${overall}<small>TEAM OVERALL — STARTING XI</small>`;
    const src = document.createElement('span');
    src.className = `srcChip${squad.source === 'chain' ? ' chain' : ''}`;
    src.textContent = squad.source === 'chain' ? 'ON-CHAIN SQUAD' : 'ACADEMY SQUAD';
    stats.append(big, src);
    mount.appendChild(stats);

    // the pitch — GK at the top of the markup (own goal end), forwards last
    const pitch = document.createElement('div');
    pitch.className = 'pitch';
    const rows = [[], [], [], []];
    for (const p of xi) rows[ROW_OF(p.role)].push(p);
    for (const row of rows) row.sort((a, b) => SIDE_OF(a.role) - SIDE_OF(b.role) || a.shirtNumber - b.shirtNumber);
    let delay = 0;
    for (const row of rows) {
      if (!row.length) continue;
      const el = document.createElement('div');
      el.className = 'prow';
      for (const p of row) {
        el.appendChild(playerCard(p, colors, { onOpen: openDetail, revealDelay: delay }));
        delay += 40;
      }
      pitch.appendChild(el);
    }
    if (bench.length) {
      const el = document.createElement('div');
      el.className = 'bench';
      for (const p of bench) {
        el.appendChild(playerCard(p, colors, { onOpen: openDetail, revealDelay: delay }));
        delay += 30;
      }
      pitch.appendChild(el);
    }
    mount.appendChild(pitch);
  }

  return { skeleton, load, closeDetail: () => detail.close() };
}
