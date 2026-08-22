import { keccak_256 } from '@noble/hashes/sha3';
import { renderPlayer, seedOf, traitsOf } from './src/render.js';
import { CLASSES } from './spec/parts.js';

const N = 64;
const seen = {};
for (const k of Object.keys(CLASSES)) seen[k] = new Set();
const kitPatterns = new Set();
for (let i = 0; i < N; i++) {
  const dnaBytes = keccak_256(new TextEncoder().encode(`fobal-fixture-${i}`));
  const dna = '0x' + [...dnaBytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const appearance = (BigInt(dna) >> 96n) & 0xffffffffn;
  const t = traitsOf(seedOf(dna, appearance));
  seen.HEADS.add(t.head); seen.SHADING.add(t.shading); seen.EARS.add(t.ears);
  seen.EYES.add(t.eyes); seen.BROWS.add(t.brows); seen.NOSES.add(t.nose);
  seen.MOUTHS.add(t.mouth); seen.BEARDS.add(t.beard); seen.HAIR.add(t.hair);
  seen.HEADWEAR.add(t.headwear); seen.NECKS.add(t.neck); seen.BUILDS.add(t.build);
  seen.COLLARS.add(t.collar);
  kitPatterns.add(i % 7);
}
for (const [k, v] of Object.entries(CLASSES)) {
  const all = new Set(v.map((_, i) => i));
  const missing = [...all].filter(i => !seen[k].has(i));
  console.log(k.padEnd(9), 'n=' + v.length, 'covered=' + seen[k].size,
    missing.length ? 'MISSING ' + missing.map(i => `${i}:${v[i].name}`).join(', ') : 'full');
}
