// Weighted trait tables in the SOLIDITY form.
//
// Solidity walks a constant cumulative table and compares against
// `lane % 4096`; JS must walk the SAME table or the two renderers disagree
// on which part a seed selects. So the cumulative tables are computed once,
// here, from the raw weights, and both sides consume the result — rather
// than JS using floats and Solidity using integers and hoping they round the
// same way.
//
// 4096 is the denominator because it is a power of two (no modulo bias worth
// worrying about at these magnitudes) and leaves room for 1/4096 rarity.
export const DENOM = 4096;

/** Raw editorial weights. Silhouette classes are capped at 6:1 among PRESENT
 *  variants — see assertWeights(). Index 0 of hair/beard/headwear is "None". */
export const RAW = {
  head:      [100, 100, 100, 100, 100, 100],
  eyes:      [100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
  brows:     [100, 100, 100, 100, 100, 100, 100, 100],
  nose:      [100, 100, 100],
  mouth:     [100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
  hair:      [40, 45, 90, 100, 110, 100, 95, 80, 90, 95, 70, 60, 55, 40, 65, 60, 50, 85, 70, 55, 70, 75, 80, 75],
  beard:     [220, 120, 90, 85, 70, 110, 95, 60],
  headwear:  [900, 90, 70, 80, 60, 40, 45, 35, 55, 60],
  hairColor: [130, 120, 110, 100, 90, 80, 70, 60, 70],
  skin:      [100, 100, 100, 100, 100, 100, 100, 100],
  bg:        [100, 100, 100, 100, 100, 100, 100, 100],
  accent:    [100, 100, 100, 100, 100, 100, 100, 100],
  iris:      [100, 100, 100, 100],
};

/** raw -> cumulative, summing to exactly DENOM. Largest bucket absorbs the
 *  rounding remainder, so the table always terminates at 4096 and the last
 *  entry can never be unreachable. */
export function toCumulative(raw) {
  const total = raw.reduce((a, b) => a + b, 0);
  const scaled = raw.map(w => Math.max(1, Math.floor((w * DENOM) / total)));
  let drift = DENOM - scaled.reduce((a, b) => a + b, 0);
  const biggest = scaled.indexOf(Math.max(...scaled));
  scaled[biggest] += drift;
  const cum = [];
  let acc = 0;
  for (const w of scaled) { acc += w; cum.push(acc); }
  return cum;
}

export const CUM = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, toCumulative(v)]));

/** Index for `lane % DENOM`, identical in shape to the Solidity loop. */
export function pickFromCum(cum, r) {
  for (let i = 0; i < cum.length; i++) if (r < cum[i]) return i;
  return cum.length - 1;   // unreachable while cum[N-1] === DENOM
}

/** CI gate. Two invariants:
 *   - every table terminates at exactly DENOM (or the last variant is dead)
 *   - silhouette classes keep max/min <= 6 among PRESENT variants ("None" is
 *     the absence of a feature, not a variant competing to be seen) */
const HAS_NONE = new Set(['hair', 'beard', 'headwear']);
const SILHOUETTE = ['head', 'hair', 'headwear', 'beard'];
export function assertWeights() {
  const bad = [], rows = [];
  for (const [k, cum] of Object.entries(CUM)) {
    if (cum[cum.length - 1] !== DENOM) bad.push(`${k} cum[N-1]=${cum[cum.length - 1]} != ${DENOM}`);
  }
  for (const k of SILHOUETTE) {
    const raw = HAS_NONE.has(k) ? RAW[k].slice(1) : RAW[k];
    const ratio = Math.max(...raw) / Math.min(...raw);
    rows.push({ class: k, presentRatio: +ratio.toFixed(2),
      none: HAS_NONE.has(k) ? `${((RAW[k][0] / RAW[k].reduce((a, b) => a + b, 0)) * 100).toFixed(0)}%` : '—' });
    if (ratio > 6) bad.push(`${k} present-variant ratio ${ratio.toFixed(1)} > 6`);
  }
  return { pass: bad.length === 0, bad, rows };
}
