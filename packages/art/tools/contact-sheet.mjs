// The P0 exit gate. The adversarial review's core process finding: reviewing
// art at 120px flatters exactly the sub-pixel detail that vanishes in
// production, so the PRIMARY sheet is the owner's own test run at the size
// the product actually displays — 100 cells at 48px, nearest-neighbour, no
// smoothing. Two mandatory variants follow: one squad in ONE kit (the hub
// strip, and the harder case, because team colour stops helping), and a
// silhouette-only sheet with colour removed entirely.
import { writeFileSync } from 'node:fs';
import { renderPlayer, traitsOf, seedOf, assertWeights, HAIR, HEADWEAR, BEARDS, HEADS, EYES, MOUTHS } from '../src/render.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { validatePalettes } from '../spec/palettes.js';

const TEAMS = [
  { name: 'SKY CITY FC',   primary: '2f6fd0', secondary: 'f2f4f8', accent: 'f2f4f8', pattern: 2 },
  { name: 'RED BULLS FC',  primary: 'c8322b', secondary: '1b1b1f', accent: 'f2f4f8', pattern: 1 },
  { name: 'GOLDEN UNITED', primary: 'e0b024', secondary: '1b1b1f', accent: '1b1b1f', pattern: 3 },
  { name: 'VIOLET TOWN',   primary: '7b46c4', secondary: 'f2f4f8', accent: 'e0b024', pattern: 5 },
  { name: 'PINE ROVERS',   primary: '1f7a4d', secondary: 'f2f4f8', accent: 'f2f4f8', pattern: 4 },
  { name: 'IRON HARBOUR',  primary: '2b3038', secondary: 'e8712f', accent: 'e8712f', pattern: 6 },
];

const css = `
 body{margin:0;background:#0a0f18;color:#e8eef5;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;padding:22px 18px 60px}
 h1{font-size:19px;margin:0 0 3px} h2{font-size:11px;letter-spacing:2.4px;text-transform:uppercase;color:#7f8ea8;margin:26px 0 9px}
 p.sub{color:#7f8ea8;margin:0 0 16px;max-width:80ch}
 /* the gate: EXACT device size, nearest-neighbour, no smoothing */
 .g{display:grid;gap:6px;width:max-content}
 .g svg{image-rendering:pixelated;display:block}
 .c48{width:48px;height:48px} .c96{width:96px;height:96px} .c120{width:120px;height:120px}
 .g10{grid-template-columns:repeat(10,auto)}
 .g14{grid-template-columns:repeat(14,auto)}
 .mono{font:10px ui-monospace,monospace;color:#5f6f8a}
 .pass{color:#22c55e} .fail{color:#f87171}
 table{border-collapse:collapse;font:11px ui-monospace,monospace;margin:8px 0}
 td,th{border:1px solid #1e2942;padding:3px 8px;text-align:left}
 .row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}
 .desat{filter:saturate(0) contrast(1.15)}
`;
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>${css}</style>${body}`;

/** identities in the SAME shape the chain stores: a 32-byte dna and a
 *  uint256 appearance, hashed exactly as FobalPlayer would supply them */
const idOf = (i) => {
  const bytes = keccak_256(new TextEncoder().encode(`fobal-v2-${i}`));
  const dna = '0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return { dna, appearance: (BigInt(dna) >> 96n) & 0xffffffffn };
};
const traitsAt = (i) => { const { dna, appearance } = idOf(i); return traitsOf(seedOf(dna, appearance)); };
const cell = (i, team, size = 48, pos = 2) =>
  `<div class="c${size}">${renderPlayer({ ...idOf(i), kit: team, position: pos })}</div>`;

// ---- gates
const pal = validatePalettes();
const wts = assertWeights();
const gates = `<table><tr><th>gate</th><th>result</th></tr>
<tr><td>palette separation (dE76)</td><td class="${pal.pass ? 'pass' : 'fail'}">${pal.pass ? 'PASS' : 'FAIL'}</td></tr>
<tr><td>silhouette weight ratio &le; 6:1</td><td class="${wts.pass ? 'pass' : 'fail'}">${wts.pass ? 'PASS' : 'FAIL ' + wts.bad.join('; ')}</td></tr>
<tr><td>part counts</td><td>${HEADS.length} heads · ${HAIR.length} hair · ${HEADWEAR.length} headwear · ${BEARDS.length} beards · ${EYES.length} eyes · ${MOUTHS.length} mouths</td></tr>
</table>`;

// ---- 1. THE GATE SHEET: 100 players, 48px, mixed teams
let grid = '';
for (let i = 0; i < 100; i++) grid += cell(i, TEAMS[i % TEAMS.length], 48, i % 11 === 0 ? 0 : 2);
// ---- 2. the harder case: same 100 in ONE kit
let oneKit = '';
for (let i = 0; i < 100; i++) oneKit += cell(i, TEAMS[0], 48, 2);
// ---- 3. colour removed: silhouette only
let silh = '';
for (let i = 0; i < 100; i++) silh += cell(i, TEAMS[0], 48, 2);

writeFileSync(new URL('../out/gate.html', import.meta.url), page('FOBAL v2 — P0 exit gate', `
<h1>P0 exit gate — the owner's test, at production size</h1>
<p class="sub">100 players, rendered at <b>exactly 48px</b> with nearest-neighbour scaling — the size and sampling the product actually uses. Reviewing at 120px flatters detail that vanishes in the hub strip.</p>
${gates}
<h2>1 · 100 players, mixed teams (the grid test)</h2>
<div class="g g10">${grid}</div>
<h2>2 · the same 100 in ONE kit — the hub-strip case, and the harder one</h2>
<p class="sub">Team colour stops doing any work here. Whatever identity survives is carried by the player alone.</p>
<div class="g g10">${oneKit}</div>
<h2>3 · colour removed entirely — pure silhouette</h2>
<p class="sub">If players are distinguishable here, the silhouette grammar is doing its job.</p>
<div class="g g10 desat">${silh}</div>`));

// ---- 4. squad sheet at 120px (detail review, explicitly secondary)
let squads = '';
for (const team of TEAMS) {
  let row = '';
  for (let i = 0; i < 14; i++) row += cell(i + team.name.length * 37, team, 120, i === 0 ? 0 : 2);
  squads += `<h2>${team.name} — pattern ${team.pattern}</h2><div class="g g14">${row}</div>`;
}
writeFileSync(new URL('../out/teams.html', import.meta.url), page('FOBAL v2 — team test', `
<h1>Team test — six clubs, fourteen players each, at 120px</h1>
<p class="sub">Detail review only. The gate is gate.html at 48px.</p>${squads}`));

// ---- 5. transfer test + size ladder
const tId = idOf(415);
let transfer = '';
for (const team of TEAMS)
  transfer += `<div><div class="c120">${renderPlayer({ ...tId, kit: team })}</div><div class="mono">${team.name}</div></div>`;
const ladder = [48, 96, 120].map(px =>
  `<div><div class="c${px === 120 ? 120 : px}" style="width:${px}px;height:${px}px">${renderPlayer({ ...tId, kit: TEAMS[0] })}</div><div class="mono">${px}px</div></div>`).join('');
writeFileSync(new URL('../out/transfer.html', import.meta.url), page('FOBAL v2 — transfer', `
<h1>Transfer test — one identity, six clubs</h1>
<p class="sub">The face is token state and immutable; the kit is team state. A transfer changes the jersey, not the player.</p>
<div class="row">${transfer}</div>
<h2>Size ladder</h2><div class="row">${ladder}</div>`));

// ---- 6. stratified sheets (find collisions systematically)
let strat = '';
for (const [label, list, key] of [['Hair', HAIR, 'hair'], ['Headwear', HEADWEAR, 'headwear'], ['Facial hair', BEARDS, 'beard']]) {
  let row = '';
  list.forEach((part, idx) => {
    // find a seed whose trait matches, so every variant is actually shown
    let found = null;
    for (let i = 0; i < 40000 && found === null; i++) if (traitsAt(i)[key] === idx) found = i;
    row += `<div><div class="c96">${found !== null ? renderPlayer({ ...idOf(found), kit: TEAMS[0] }) : ''}</div><div class="mono">${part.name}</div></div>`;
  });
  strat += `<h2>${label} — every variant</h2><div class="row">${row}</div>`;
}
writeFileSync(new URL('../out/strata.html', import.meta.url), page('FOBAL v2 — strata', `
<h1>Stratified sheets — every variant of every class</h1>
<p class="sub">Collision hunting: clipping, layering faults, and variants that read identically.</p>${strat}`));

// ---- diversity measurement (the sibling metric the reviews used)
const sig = (i) => { const t = traitsAt(i); return `${t.bg}|${t.hair}|${t.hairColor}|${t.skin}|${t.headwear}`; };
const seen = new Map();
for (let i = 0; i < 100; i++) seen.set(sig(i), (seen.get(sig(i)) ?? 0) + 1);
const siblings = [...seen.values()].filter(v => v > 1).reduce((a, v) => a + v, 0);
console.log(`palettes ${pal.pass ? 'PASS' : 'FAIL'} · weights ${wts.pass ? 'PASS' : 'FAIL'}`);
console.log(`dominant-channel clusters in 100: ${seen.size} · players sharing a cluster: ${siblings} (${siblings}%)`);
console.log('wrote out/gate.html, out/teams.html, out/transfer.html, out/strata.html');
