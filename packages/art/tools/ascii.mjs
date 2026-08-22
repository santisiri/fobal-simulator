// Rasterize the reference renderer into a 32x32 character grid. The fastest
// honest look at the geometry: every rect, in draw order, at true resolution.
import { renderPlayerWithHead, renderPlayer, traitsOf, seedOf, HEADS } from '../src/render.js';
import { keccak_256 } from '@noble/hashes/sha3';
const idOf = (i) => { const b = keccak_256(new TextEncoder().encode(`fobal-v2-${i}`));
  const dna = '0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return { dna, appearance: (BigInt(dna) >> 96n) & 0xffffffffn }; };
const KIT = { primary: '2f6fd0', secondary: 'f2f4f8', accent: 'f2f4f8', pattern: 2 };

/** map each distinct fill to a legible glyph, in first-seen order */
export function ascii(svg) {
  const g = Array.from({ length: 32 }, () => Array(32).fill('.'));
  const glyphs = {}, order = [];
  const GL = ' .:-=+*#%@ABCDEFGHIJKLMNOP';
  let n = 0;
  for (const m of svg.matchAll(/<rect x="(-?\d+)" y="(-?\d+)" width="(\d+)" height="(\d+)" fill="#(\w+)"\/>/g)) {
    const [, x, y, w, h, c] = m;
    if (!(c in glyphs)) { glyphs[c] = GL[Math.min(n++, GL.length - 1)]; order.push(c); }
    for (let j = +y; j < +y + +h; j++) for (let i = +x; i < +x + +w; i++)
      if (i >= 0 && i < 32 && j >= 0 && j < 32) g[j][i] = glyphs[c];
  }
  const legend = order.map(c => `${glyphs[c]}=#${c}`).join(' ');
  return g.map((r, j) => String(j).padStart(2) + ' ' + r.join('')).join('\n')
    + '\n   ' + [...Array(32)].map((_, i) => i % 10).join('') + '\n   ' + legend;
}
if (import.meta.url === `file://${process.argv[1]}`) {
const which = process.argv[2] ?? 'heads';
if (which === 'heads') {
  for (let h = 0; h < HEADS.length; h++) {
    console.log(`\n=== ${HEADS[h].name} ===`);
    console.log(ascii(renderPlayerWithHead({ ...idOf(7), kit: KIT }, h)));
  }
} else {
  for (const i of which.split(',').map(Number)) {
    const t = traitsOf(seedOf(idOf(i).dna, idOf(i).appearance));
    console.log(`\n=== #${i} ${JSON.stringify(t)} ===`);
    console.log(ascii(renderPlayer({ ...idOf(i), kit: KIT })));
  }
}
}
