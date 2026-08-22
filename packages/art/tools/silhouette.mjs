// Renders the silhouette audit (tools/silhouette-lib.mjs) as a page you can
// look at. The audit itself is a build gate inside gen-art.mjs; this exists so
// a failure names the colliding pair and shows you the two masks.
import { mkdirSync, writeFileSync } from 'node:fs';
import { auditAll, auditSummary, mask, originOf, LISTS } from './silhouette-lib.mjs';
import { anchorsOf, HEAD_SPECS } from '../spec/parts.js';

// out/ is gitignored, so on a clean checkout it does not exist and the write
// below throws ENOENT — which is how this passed locally and failed in CI.
const OUT = new URL('../out/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const svgOf = (m) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">`
  + `<rect width="32" height="32" fill="#f2f4f8"/>`
  + [...m].map((v, k) => v ? `<rect x="${k % 32}" y="${(k / 32) | 0}" width="1" height="1" fill="#0f0b09"/>` : '').join('')
  + `</svg>`;

let body = '', ok = true;
for (const rep of auditAll()) {
  const a = anchorsOf(rep.head);
  const [ox, oy, margin] = originOf(rep.label, a);
  body += `<h2>${rep.label} on ${rep.headName} <span class="mono">(head ${rep.head}, w${a.headW})</span></h2><div class="row">`
    + LISTS[rep.label].map((p, i) => `<div><div class="c">${svgOf(mask(p.rects, ox, oy, margin, a))}</div>`
      + `<div class="mono">${p.name}<br>${rep.rows[i].px}px · nearest Δ${rep.rows[i].delta}</div></div>`).join('')
    + '</div>'
    + (rep.collisions.length ? `<p class="fail">${rep.collisions.join('<br>')}</p>` : '');
  if (rep.collisions.length) ok = false;
}
for (const r of auditSummary()) {
  console.log(`${r.label}: ${r.collisions.length
    ? 'FAIL\n  ' + r.collisions.join('\n  ')
    : `PASS — closest pair ${r.worst.name} ~ ${r.worst.nearest} at Δ${r.worst.delta}px (on ${r.worst.head})`}`);
}
writeFileSync(new URL('silhouette.html', OUT),
  `<!doctype html><meta charset="utf-8"><title>FOBAL — silhouette audit</title><style>
  body{margin:0;background:#0a0f18;color:#e8eef5;font:13px ui-sans-serif,system-ui;padding:22px}
  h1{font-size:19px}h2{font-size:11px;letter-spacing:2.4px;text-transform:uppercase;color:#7f8ea8;margin:26px 0 9px}
  .row{display:flex;gap:10px;flex-wrap:wrap} .c{width:72px;height:72px} .c svg{width:72px;height:72px;image-rendering:pixelated;display:block}
  .mono{font:9px ui-monospace,monospace;color:#5f6f8a;width:72px} .fail{color:#f87171}
  </style><h1>Silhouette audit — colour removed, on all ${HEAD_SPECS.length} heads</h1>
  <p>Two masks a few pixels apart are one part with two names. The skull clamp is
  per-head, so a pair that separates on a wide skull can collapse on a narrow one —
  auditing head 0 alone reported PASS while Scrum Cap and Keeper Cap were identical
  on the Long head. gen-art.mjs fails the build on any collision.</p>${body}`);
console.log('wrote out/silhouette.html');
process.exit(ok ? 0 : 1);
