// Shared club state — the localStorage record the onboarding wizard writes
// and every game surface reads. (When the Base Sepolia deploy lands, this
// becomes a chain read keyed by the connected wallet; the shape stays.)
import { overall } from './squad.js';

const KEY = 'fobal.club';

export function loadClub() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY));
    return c && c.squad && Array.isArray(c.squad.players) ? c : null;
  } catch { return null; }
}

export function saveClub(club) {
  localStorage.setItem(KEY, JSON.stringify(club));
}

/** Squad-average overall, rounded. */
export function clubOverall(club) {
  const ps = club.squad.players;
  return Math.round(ps.reduce((a, p) => a + (p.overall ?? overall(p.skills)), 0) / ps.length);
}

/** Two-letter club crest initials, matching the wizard. */
export function crestInitials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'FC';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Career record (0-0-0 until matches settle and write back here). */
export function clubRecord(club) {
  return club.record ?? { w: 0, d: 0, l: 0 };
}
