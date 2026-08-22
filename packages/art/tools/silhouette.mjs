// Item 10 — the black-silhouette test, measured rather than eyeballed.
// Each hairstyle is rasterised on ONE head with colour discarded: every
// non-background pixel is ink. Two styles whose masks differ by only a few
// pixels are the same style wearing two names, and one of them should go.
import { writeFileSync } from 'node:fs';
import { HAIR, HEADWEAR, BEARDS, SLOT, anchorsOf } from '../spec/parts.js';

const HEAD = 0, a = anchorsOf(HEAD);
/** local-space rects -> a 32x32 boolean mask, applying the same skull clamp
 *  the renderer uses so the audit sees what actually ships. */
function mask(rects, ox, oy, clamp) {
  const m = new Uint8Array(32 * 32);
  const lo = a.headX - ox - 2, hi = a.headX + a.headW - ox + 2;
  for (let [x, y, w, h] of rects) {
    if (clamp) { const x1 = Math.min(x + w, hi); x = Math.max(x, lo); w = x1 - x; if (w <= 0) continue; }
    for (let j = y + oy; j < y + oy + h; j++) for (let i = x + ox; i < x + ox + w; i++)
      if (i >= 0 && i < 32 && j >= 0 && j < 32) m[j * 32 + i] = 1;
  }
  return m;
}
const area = (m) => m.reduce((s, v) => s + v, 0);
const dist = (p, q) => { let d = 0; for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) d++; return d; };

function audit(label, list, ox, oy, clamp, minPix, minDist) {
  const masks = list.map(p => mask(p.rects, ox, oy, clamp));
  const rows = [], collisions = [];
  list.forEach((p, i) => {
    let near = null, nd = 1e9;
    list.forEach((q, j) => { if (i === j) return; const d = dist(masks[i], masks[j]); if (d < nd) { nd = d; near = q.name; } });
    rows.push({ name: p.name, px: area(masks[i]), nearest: near, delta: nd });
    if (area(masks[i]) < minPix && p.name !== 'None' && p.name !== 'Bald')
      collisions.push(`${p.name}: only ${area(masks[i])}px of silhouette`);
    if (nd < minDist) collisions.push(`${p.name} ~ ${near}: ${nd}px apart`);
  });
  return { label, rows, collisions };
}
const reports = [
  audit('HAIR', HAIR, a.noseX, a.top, true, 10, 8),
  audit('HEADWEAR', HEADWEAR, a.noseX, a.top, true, 6, 6),
  audit('BEARDS', BEARDS, a.noseX, a.chinY, false, 4, 5),
];
const svgOf = (m) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">`
  + `<rect width="32" height="32" fill="#f2f4f8"/>`
  + [...m].map((v, k) => v ? `<rect x="${k % 32}" y="${(k / 32) | 0}" width="1" height="1" fill="#0f0b09"/>` : '').join('')
  + `</svg>`;
let body = '';
for (const rep of reports) {
  const list = rep.label === 'HAIR' ? HAIR : rep.label === 'HEADWEAR' ? HEADWEAR : BEARDS;
  const [ox, oy, cl] = rep.label === 'BEARDS' ? [a.noseX, a.chinY, false] : [a.noseX, a.top, true];
  body += `<h2>${rep.label} — pure silhouette</h2><div class="row">`
    + list.map((p, i) => `<div><div class="c">${svgOf(mask(p.rects, ox, oy, cl))}</div>`
      + `<div class="mono">${p.name}<br>${rep.rows[i].px}px · Δ${rep.rows[i].delta}</div></div>`).join('') + '</div>'
    + (rep.collisions.length ? `<p class="fail">${rep.collisions.join('<br>')}</p>` : `<p class="pass">no collisions</p>`);
  console.log(`${rep.label}: ${rep.collisions.length ? 'FAIL\n  ' + rep.collisions.join('\n  ') : 'PASS'}`);
}
writeFileSync(new URL('../out/silhouette.html', import.meta.url),
  `<!doctype html><meta charset="utf-8"><title>FOBAL — silhouette audit</title><style>
  body{margin:0;background:#0a0f18;color:#e8eef5;font:13px ui-sans-serif,system-ui;padding:22px}
  h2{font-size:11px;letter-spacing:2.4px;text-transform:uppercase;color:#7f8ea8;margin:26px 0 9px}
  .row{display:flex;gap:10px;flex-wrap:wrap} .c{width:72px;height:72px} .c svg{width:72px;height:72px;image-rendering:pixelated;display:block}
  .mono{font:9px ui-monospace,monospace;color:#5f6f8a;width:72px} .pass{color:#22c55e} .fail{color:#f87171}
  </style><h1>Silhouette audit — colour removed</h1>${body}`);
console.log('wrote out/silhouette.html');
