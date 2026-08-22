// Item 10, as a measurement. Colour is what flatters a weak silhouette, so
// the audit throws colour away: every non-background pixel becomes ink, and
// two masks a handful of pixels apart are one part wearing two names.
// gen-art.mjs GATES on this — a collision cannot reach a deploy.
//
// It runs on EVERY head, not one. The skull clamp is per-head, so a pair that
// separates cleanly on a wide skull can collapse on a narrow one: auditing
// head 0 alone reported PASS while Scrum Cap and Keeper Cap were rendering
// the IDENTICAL silhouette on the Long head, its ear flaps clipped away.
import { HAIR, HEADWEAR, BEARDS, ANCHOR, anchorsOf, HEAD_SPECS } from '../spec/parts.js';
// the RENDERER's clamp, not a copy of it. A second implementation here
// reported PASS while the real one was deleting scrum-cap flaps.
import { clampToSkull } from '../src/render.js';

/** local rects -> 32x32 mask, applying the renderer's own per-class skull
 *  clamp so the audit sees what actually ships rather than what was authored. */
export function mask(rects, ox, oy, margin, a) {
  const m = new Uint8Array(32 * 32);
  for (const [x, y, w, h] of clampToSkull(rects, a, margin)) {
    for (let j = y + oy; j < y + oy + h; j++) for (let i = x + ox; i < x + ox + w; i++)
      if (i >= 0 && i < 32 && j >= 0 && j < 32) m[j * 32 + i] = 1;
  }
  return m;
}
const area = (m) => m.reduce((s, v) => s + v, 0);
const dist = (p, q) => { let d = 0; for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) d++; return d; };

/** Where each audited class attaches, for a given head. */
export function originOf(label, a) {
  const cfg = ANCHOR[label];
  const oy = label === 'BEARDS' ? a.chinY : a.top;
  return [a.noseX, oy, cfg.clamp ?? 0];
}
export const LISTS = { HAIR, HEADWEAR, BEARDS };

export function audit(label, list, head, minPix, minDist) {
  const a = anchorsOf(head);
  const [ox, oy, margin] = originOf(label, a);
  const masks = list.map((p) => mask(p.rects, ox, oy, margin, a));
  const rows = [], collisions = [];
  list.forEach((p, i) => {
    let near = null, nd = 1e9;
    list.forEach((q, j) => { if (i === j) return; const d = dist(masks[i], masks[j]); if (d < nd) { nd = d; near = q.name; } });
    rows.push({ name: p.name, px: area(masks[i]), nearest: near, delta: nd });
    if (area(masks[i]) < minPix && p.name !== 'None' && p.name !== 'Bald')
      collisions.push(`on ${a.name}: ${p.name} has only ${area(masks[i])}px of silhouette`);
    if (nd < minDist) collisions.push(`on ${a.name}: ${p.name} ~ ${near} are ${nd}px apart`);
  });
  return { label, head, headName: a.name, rows, masks, collisions };
}

const SPEC = [['HAIR', 10, 8], ['HEADWEAR', 6, 6], ['BEARDS', 4, 5]];

/** Every audited class, on every head. */
export function auditAll() {
  const out = [];
  for (const [label, minPix, minDist] of SPEC) {
    for (let head = 0; head < HEAD_SPECS.length; head++) {
      out.push(audit(label, LISTS[label], head, minPix, minDist));
    }
  }
  return out;
}

/** Collapsed to one row per class, for reporting. */
export function auditSummary() {
  return SPEC.map(([label]) => {
    const reps = auditAll().filter((r) => r.label === label);
    const collisions = reps.flatMap((r) => r.collisions);
    const worst = reps.flatMap((r) => r.rows.map((x) => ({ ...x, head: r.headName })))
      .sort((p, q) => p.delta - q.delta)[0];
    return { label, collisions, worst };
  });
}
