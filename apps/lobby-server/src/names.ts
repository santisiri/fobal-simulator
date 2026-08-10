// Name moderation (M2 abuse pass) — team and player names are free text
// shown to strangers. This is a deliberately SMALL, unambiguous deny list
// with basic leet-speak normalization, not a censorship engine: the goal is
// keeping obvious slurs off the pitch, and false positives out of the way.
const SUBS: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '9': 'g',
  '$': 's', '@': 'a', '!': 'i', '|': 'i', '+': 't',
};

const BLOCKED = [
  'nigger', 'nigga', 'faggot', 'kike', 'spic', 'wetback', 'chink',
  'tranny', 'raghead', 'coon',
  'hitler', 'nazi',
];

function normalize(s: string): string {
  return s.toLowerCase()
    .split('')
    .map(c => SUBS[c] ?? c)
    .join('')
    .replace(/[^a-z]/g, '');
}

/** true when the name is acceptable to show to other players */
export function nameAllowed(name: string): boolean {
  const n = normalize(name);
  return !BLOCKED.some(term => n.includes(term));
}
