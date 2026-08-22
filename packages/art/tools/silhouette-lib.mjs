// Item 10, as a measurement. Colour is what flatters a weak silhouette, so
// the audit throws colour away: every non-background pixel becomes ink, and
// two masks a handful of pixels apart are one part wearing two names.
// gen-art.mjs GATES on this — a collision cannot reach a deploy.
import { HAIR, HEADWEAR, BEARDS, anchorsOf } from '../spec/parts.js';

const REF_HEAD = 0;

/** local rects -> 32x32 mask, applying the renderer's own skull clamp so the
 *  audit sees what actually ships rather than what was authored. */
export function mask(rects, ox, oy, clamp) {
  const a = anchorsOf(REF_HEAD);
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

export function audit(label, list, ox, oy, clamp, minPix, minDist) {
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
  return { label, rows, masks, collisions };
}

export function auditAll() {
  const a = anchorsOf(REF_HEAD);
  return [
    audit('HAIR', HAIR, a.noseX, a.top, true, 10, 8),
    audit('HEADWEAR', HEADWEAR, a.noseX, a.top, true, 6, 6),
    audit('BEARDS', BEARDS, a.noseX, a.chinY, false, 4, 5),
  ];
}
export const ORIGINS = () => { const a = anchorsOf(REF_HEAD); return {
  HAIR: [a.noseX, a.top, true], HEADWEAR: [a.noseX, a.top, true], BEARDS: [a.noseX, a.chinY, false] }; };
export const LISTS = { HAIR, HEADWEAR, BEARDS };
