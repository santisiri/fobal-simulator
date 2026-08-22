import { writeFileSync } from 'node:fs';
import { renderPlayer, seedOf, traitsOf, freeAgentKit } from '/Users/santisiri/AI/fobal-simulator/.claude/worktrees/clever-swartz-f49901/packages/art/src/render.js';
import { keccak_256 } from '@noble/hashes/sha3';

const hashOf = (str) => '0x' + [...keccak_256(new TextEncoder().encode(str))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

const N = 3000;
const fx = { dna: [], appearance: [], svgHash: [] };
const seen = new Set();
const trait = new Set();
for (let i = 0; i < N; i++) {
  // deterministic pseudo dna
  const h = keccak_256(new TextEncoder().encode('bigfx:' + i));
  const dna = '0x' + [...h].map(b => b.toString(16).padStart(2,'0')).join('');
  const appearance = BigInt(i) * 7919n;
  const s0 = seedOf(BigInt(dna), appearance);
  const t = traitsOf(s0);
  trait.add([t.head,t.mouth,t.hair,t.headwear,t.beard,t.ears,t.eyes,t.brows,t.nose,t.build,t.collar].join(','));
  const svg = renderPlayer({ dna: BigInt(dna), appearance, kit: freeAgentKit(s0) });
  fx.dna.push(dna);
  fx.appearance.push(appearance.toString());
  fx.svgHash.push(hashOf(svg));
}
writeFileSync('/private/tmp/claude-501/-Users-santisiri-AI-fobal-simulator--claude-worktrees-clever-swartz-f49901/6ec41b56-60ce-405c-b53a-3c1c17b0d1c3/scratchpad/bigfx.json', JSON.stringify(fx));
console.log('distinct trait vectors', trait.size);
