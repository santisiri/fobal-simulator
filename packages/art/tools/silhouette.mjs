// Renders the silhouette audit (tools/silhouette-lib.mjs) as a page you can
// look at. The audit itself is a build gate inside gen-art.mjs.
import { writeFileSync } from 'node:fs';
import { auditAll, mask, ORIGINS, LISTS } from './silhouette-lib.mjs';

const svgOf = (m) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">`
  + `<rect width="32" height="32" fill="#f2f4f8"/>`
  + [...m].map((v, k) => v ? `<rect x="${k % 32}" y="${(k / 32) | 0}" width="1" height="1" fill="#0f0b09"/>` : '').join('')
  + `</svg>`;
let body = '', ok = true;
for (const rep of auditAll()) {
  const list = LISTS[rep.label], [ox, oy, cl] = ORIGINS()[rep.label];
  body += `<h2>${rep.label} — pure silhouette</h2><div class="row">`
    + list.map((p, i) => `<div><div class="c">${svgOf(mask(p.rects, ox, oy, cl))}</div>`
      + `<div class="mono">${p.name}<br>${rep.rows[i].px}px · nearest Δ${rep.rows[i].delta}</div></div>`).join('') + '</div>'
    + (rep.collisions.length ? `<p class="fail">${rep.collisions.join('<br>')}</p>` : `<p class="pass">no collisions</p>`);
  if (rep.collisions.length) ok = false;
  console.log(`${rep.label}: ${rep.collisions.length ? 'FAIL\n  ' + rep.collisions.join('\n  ') : 'PASS'}`);
}
writeFileSync(new URL('../out/silhouette.html', import.meta.url),
  `<!doctype html><meta charset="utf-8"><title>FOBAL — silhouette audit</title><style>
  body{margin:0;background:#0a0f18;color:#e8eef5;font:13px ui-sans-serif,system-ui;padding:22px}
  h1{font-size:19px}h2{font-size:11px;letter-spacing:2.4px;text-transform:uppercase;color:#7f8ea8;margin:26px 0 9px}
  .row{display:flex;gap:10px;flex-wrap:wrap} .c{width:72px;height:72px} .c svg{width:72px;height:72px;image-rendering:pixelated;display:block}
  .mono{font:9px ui-monospace,monospace;color:#5f6f8a;width:72px} .pass{color:#22c55e} .fail{color:#f87171}
  </style><h1>Silhouette audit — colour removed</h1>
  <p>Two masks a few pixels apart are one part with two names. gen-art.mjs fails the build on any collision.</p>${body}`);
console.log('wrote out/silhouette.html');
process.exit(ok ? 0 : 1);
