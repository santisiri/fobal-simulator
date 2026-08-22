// The squad sheet. Eleven players, one kit, in formation — the view the hub
// actually shows, and the hardest case the art has to survive, because team
// colour stops doing any work the moment everyone is wearing it.
//
// Also renders the WORST squad the audit can find, which is the only cell on
// the page worth arguing about.
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderPlayer } from '../src/render.js';
import {
  CLUBS, POSITIONS, appSquadIds, confusablePairs, assertSquadsLegible,
  auditSquad, GATE_CLUBS, kitFor,
} from './squad-lib.mjs';

const OUT = new URL('../out/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const ROLES = ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CM', 'LW', 'ST', 'RW'];
/** 4-3-3, as a percentage of the pitch, matching apps/web's FORMATION_433 */
const SPOTS = [
  [50, 6], [16, 26], [38, 20], [62, 20], [84, 26],
  [30, 50], [50, 46], [70, 50], [22, 78], [50, 84], [78, 78],
];

const cell = (id, i, kit, cls = 'c') =>
  `<div class="${cls}">${renderPlayer({ ...id, kit: kitFor(kit, i), position: POSITIONS[i] })}</div>`;

function lineup(name, kit) {
  const ids = appSquadIds(name);
  const flagged = new Set(confusablePairs(ids, kit).flatMap((f) => [f.i, f.j]));
  const r = auditSquad(ids, kit);
  const row = ids.map((id, i) =>
    `<div class="p${flagged.has(i) ? ' flag' : ''}">${cell(id, i, kit)}`
    + `<div class="cap">${i + 1} ${ROLES[i]}${i === 0 ? ' &middot; gk kit' : ''}</div></div>`).join('');
  const pitch = ids.map((id, i) =>
    `<div class="onpitch" style="left:${SPOTS[i][0]}%;bottom:${SPOTS[i][1]}%">${cell(id, i, kit, 'c s')}</div>`).join('');
  return `<section>
    <h2>${name} <em>${r.worst}px closest pair · ${r.median}px median</em></h2>
    <div class="row">${row}</div>
    <div class="pitch">${pitch}</div>
  </section>`;
}

const gate = assertSquadsLegible();
// the squad the audit likes least, shown deliberately rather than hidden
let worstName = GATE_CLUBS[0], worstKit = CLUBS[0], worstScore = Infinity;
GATE_CLUBS.forEach((n, i) => {
  const kit = CLUBS[i % CLUBS.length];
  const r = auditSquad(appSquadIds(n), kit);
  const score = r.worstInk * 3 + r.worst;
  if (score < worstScore) { worstScore = score; worstName = n; worstKit = kit; }
});

const css = `
 body{margin:0;background:#0c1110;color:#e7ece9;font:14px/1.5 ui-sans-serif,system-ui;padding:26px 22px 70px}
 h1{font-size:22px;margin:0 0 6px} h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;
   color:#9fb2ab;margin:34px 0 12px;display:flex;gap:12px;align-items:baseline}
 h2 em{font:11px ui-monospace,monospace;color:#7c8f89;letter-spacing:0;font-style:normal}
 p.sub{color:#a8b8b2;max-width:78ch;margin:0 0 4px}
 .row{display:flex;gap:8px;flex-wrap:wrap}
 .p{width:64px} .c{width:64px;height:64px;background:#121a18}
 .c svg{width:100%;height:100%;image-rendering:pixelated;display:block}
 .cap{font:10px ui-monospace,monospace;color:#7c8f89;margin-top:4px}
 .flag .c{outline:2px solid #e0483f;outline-offset:1px}
 .flag .cap{color:#e0483f}
 .pitch{position:relative;height:340px;width:460px;margin-top:14px;
   background:#101a15;border:1px solid #1f2b28}
 .pitch::after{content:"";position:absolute;left:0;right:0;top:50%;border-top:1px solid #1f2b28}
 .onpitch{position:absolute;transform:translate(-50%,50%)}
 .c.s{width:40px;height:40px;background:transparent}
 .gate{border:1px solid #1f2b28;padding:12px 16px;margin:18px 0;font:12px ui-monospace,monospace}
 .pass{color:#3fa863} .fail{color:#e0483f}
`;

writeFileSync(new URL('squads.html', OUT), `<!doctype html><meta charset="utf-8">
<title>FOBAL — squad sheet</title><style>${css}</style>
<h1>Squad sheet — eleven players, one kit</h1>
<p class="sub">The hardest case the art has to survive: a lineup all wearing the same shirt,
where team colour stops doing any work. A pair is flagged only when it is close on BOTH
axes — colour and construction — because either alone is a bad test.</p>
<div class="gate">
  <span class="${gate.pass ? 'pass' : 'fail'}">${gate.pass ? 'PASS' : 'FAIL'}</span>
  &nbsp;${gate.squadsWithPair}/${gate.squads} squads contain a confusable pair
  (${(gate.rate * 100).toFixed(2)}%)
  ${gate.examples.length ? '<br>&nbsp;&nbsp;' + gate.examples.join('<br>&nbsp;&nbsp;') : ''}
</div>
${CLUBS.map((c) => lineup(c.name, c)).join('')}
<h2>The worst squad the audit can find <em>shown on purpose</em></h2>
${lineup(worstName, worstKit)}
`);

console.log(`squad legibility: ${gate.pass ? 'PASS' : 'FAIL'}`
  + ` — ${gate.squadsWithPair}/${gate.squads} squads with a confusable pair (${(gate.rate * 100).toFixed(2)}%)`);
gate.examples.forEach((e) => console.log('  ' + e));
console.log(`worst squad: ${worstName}`);
console.log('wrote out/squads.html');
process.exit(gate.pass ? 0 : 1);
