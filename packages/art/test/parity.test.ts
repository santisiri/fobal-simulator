import { auditAll } from '../tools/silhouette-lib.mjs';
// @ts-expect-error — plain JS module
import { assertSquadsLegible } from '../tools/squad-lib.mjs';
import { assertConnected, detached } from '../tools/connectivity.mjs';
// The parity harness. Three claims, each one a place the pipeline could
// silently drift between the JS reference renderer and the chain:
//   1. the blob codec is an exact inverse (encode -> decode -> same rects)
//   2. rendering from DECODED blob data equals rendering from the spec, so
//      the bytes we ship are the bytes the art was designed from
//   3. the generated artefacts (Solidity constants, web module) agree with
//      the spec they were generated from
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error — plain JS modules, deliberately unbuilt
import { CLASSES } from '../spec/parts.js';
import { HEAD_SPECS } from '../spec/anchors.js';
// @ts-expect-error — plain JS module
import { footprint } from '../spec/parts.js';
// @ts-expect-error
import { CUM, DENOM, RAW, toCumulative, pickFromCum, assertWeights } from '../spec/weights.js';
// @ts-expect-error
import { encodeClass, decodePart, partCount, BIAS, BLOB_VERSION } from '../src/blob.js';
// @ts-expect-error
import { validatePalettes } from '../spec/palettes.js';
// @ts-expect-error
import { renderPlayer, traitsOf, seedOf, freeAgentKit , assertKitFits, assertShadingInsideHead, freeAgentKit, mouthEligible, mouthCum, renderPlayer, MOUTHS } from '../src/render.js';
import { keccak_256 } from '@noble/hashes/sha3';

const KIT = { primary: '2f6fd0', secondary: 'f2f4f8', accent: 'f2f4f8', pattern: 2 };

describe('blob codec', () => {
  test('encode -> decode is an exact inverse for every part of every class', () => {
    for (const [name, parts] of Object.entries(CLASSES) as [string, any[]][]) {
      const blob = encodeClass(parts);
      expect(blob[0], `${name} version byte`).toBe(BLOB_VERSION);
      expect(partCount(blob), `${name} part count`).toBe(parts.length);
      parts.forEach((part, i) => {
        expect(decodePart(blob, i), `${name}[${i}] ${part.name}`).toEqual(
          (part.rects ?? []).map((r: number[]) => r.slice(0, 5)),
        );
      });
    }
  });

  test('the whole atlas fits one SSTORE2 blob with room to spare', () => {
    let total = 0;
    for (const parts of Object.values(CLASSES) as any[][]) {
      const blob = encodeClass(parts);
      expect(blob.length).toBeLessThanOrEqual(24575);
      total += blob.length;
    }
    expect(total).toBeLessThan(24575);   // size is not the binding constraint
  });

  test('negative coordinates survive the bias (hair draws above the canvas)', () => {
    const hair = (CLASSES as any).HAIR;
    const afro = hair.find((h: any) => h.name === 'Afro');
    expect(afro.rects.some((r: number[]) => r[1] < 0)).toBe(true);
    const blob = encodeClass(hair);
    const back = decodePart(blob, hair.indexOf(afro));
    expect(back).toEqual(afro.rects.map((r: number[]) => r.slice(0, 5)));
  });

  test('the encoder refuses data it cannot represent, rather than truncating', () => {
    expect(() => encodeClass([{ name: 'bad', rects: [[-100, 0, 1, 1, 0]] }])).toThrow(/biased byte range/);
    expect(() => encodeClass([{ name: 'bad', rects: [[0, 0, 0, 1, 0]] }])).toThrow(/outside 1..255/);
    expect(() => encodeClass([{ name: 'bad', rects: [[0, 0, 1, 1, 99]] }])).toThrow(/palette slot/);
  });
});

describe('rendering from blob bytes', () => {
  /** rebuild CLASSES from decoded blob data, exactly as the chain will */
  const fromBlobs = () => Object.fromEntries(Object.entries(CLASSES).map(([name, parts]) => {
    const blob = encodeClass(parts as any[]);
    return [name, (parts as any[]).map((p, i) => ({ ...p, rects: decodePart(blob, i) }))];
  }));

  test('decoded parts are identical objects to the spec parts', () => {
    const rebuilt = fromBlobs();
    for (const [name, parts] of Object.entries(CLASSES) as [string, any[]][]) {
      parts.forEach((part, i) => {
        expect((rebuilt as any)[name][i].rects).toEqual(part.rects.map((r: number[]) => r.slice(0, 5)));
      });
    }
  });

  /** identities in the shape FobalPlayer stores them */
  const idOf = (i: number) => {
    const bytes = keccak_256(new TextEncoder().encode(`parity-${i}`));
    const dna = '0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return { dna, appearance: (BigInt(dna) >> 96n) & 0xffffffffn };
  };

  test('renders are deterministic and stable across repeated calls', () => {
    for (let i = 0; i < 50; i++) {
      const id = idOf(i);
      expect(renderPlayer({ ...id, kit: KIT })).toBe(renderPlayer({ ...id, kit: KIT }));
    }
  });

  test('identity is a pure function of (dna, appearance)', () => {
    for (let i = 0; i < 50; i++) {
      const { dna, appearance } = idOf(i);
      expect(traitsOf(seedOf(dna, appearance))).toEqual(traitsOf(seedOf(dna, appearance)));
    }
  });

  test('the free-agent kit is derived from the seed, not from any team', () => {
    const { dna, appearance } = idOf(7);
    const k = freeAgentKit(seedOf(dna, appearance));
    expect(k.pattern).toBeGreaterThanOrEqual(0);
    expect(k.pattern).toBeLessThan(7);
    expect(k.primary).toMatch(/^[0-9a-f]{6}$/);
  });

  /** THE CROSS-LANGUAGE GUARD: the fixtures the Solidity test replays must
   *  match what this renderer produces right now, or the forge parity test is
   *  asserting against a stale file and proves nothing. */
  test('committed fixtures match the current renderer output', () => {
    const fx = JSON.parse(readFileSync(new URL('../gen/fixtures/render.json', import.meta.url), 'utf8'));
    expect(fx.dna.length).toBeGreaterThanOrEqual(64);
    for (let i = 0; i < fx.dna.length; i++) {
      // the position matters now: fixtures cycle it so the GOALKEEPER
      // free-agent path is exercised, and rendering at the default would
      // compare an outfielder against a keeper's recorded hash
      const svg = renderPlayer({
        dna: fx.dna[i], appearance: BigInt(fx.appearance[i]), position: Number(fx.position[i]),
      });
      const hash = '0x' + [...keccak_256(new TextEncoder().encode(svg))]
        .map((b: number) => b.toString(16).padStart(2, '0')).join('');
      expect(hash, `fixture ${i} is stale — re-run gen-art.mjs`).toBe(fx.svgHash[i]);
    }
  });
});

describe('weight tables (the Solidity form)', () => {
  test('every cumulative table terminates at exactly the denominator', () => {
    for (const [k, cum] of Object.entries(CUM) as [string, number[]][]) {
      expect(cum[cum.length - 1], `${k}`).toBe(DENOM);
    }
  });

  test('no variant is unreachable — every index is selected by some residue', () => {
    for (const [k, cum] of Object.entries(CUM) as [string, number[]][]) {
      const hit = new Set<number>();
      for (let r = 0; r < DENOM; r++) hit.add(pickFromCum(cum, r));
      expect(hit.size, `${k}: ${hit.size}/${cum.length} variants reachable`).toBe(cum.length);
    }
  });

  test('normalisation is exact even with awkward totals', () => {
    for (const raw of [[1, 1, 1], [7, 13, 29, 3], [1000, 1], [5]]) {
      const cum = toCumulative(raw);
      expect(cum[cum.length - 1]).toBe(DENOM);
    }
  });

  test('silhouette classes stay inside the 6:1 cap', () => {
    const { pass, bad } = assertWeights();
    expect(bad).toEqual([]);
    expect(pass).toBe(true);
  });
});

describe('palette gate', () => {
  test('all palettes pass their separation thresholds', () => {
    const { pass, report } = validatePalettes();
    expect(report.filter((r: any) => !r.pass)).toEqual([]);
    expect(pass).toBe(true);
  });
});

describe('generated artefacts agree with the spec', () => {
  const gen = (f: string) => readFileSync(new URL(`../gen/${f}`, import.meta.url), 'utf8');
  const sol = () => readFileSync(
    new URL('../../../contracts/src/art/FobalArtConstants.sol', import.meta.url), 'utf8');

  test('Solidity constants carry the same class sizes and weight tables', () => {
    const solSrc = sol();
    for (const [name, parts] of Object.entries(CLASSES) as [string, any[]][]) {
      expect(solSrc).toContain(`${name.toUpperCase()}_COUNT = ${parts.length};`);
    }
    expect(solSrc).toContain(`WEIGHT_DENOM = ${DENOM};`);
    expect(solSrc).toContain(`BIAS = ${BIAS};`);
    // EVERY table, in the packed form Solidity now reads: 2 bytes per entry,
    // concatenated in CUM key order. A spot check of one class let the other
    // fifteen drift.
    const b4 = (n: number) => n.toString(16).padStart(4, '0');
    const keys = Object.keys(CUM);
    expect(solSrc).toContain(`CUM_DATA = hex"${keys.map((k) => (CUM as any)[k].map(b4).join('')).join('')}"`);
    expect(solSrc).toContain(`CUM_LEN = hex"${keys.map((k) => (CUM as any)[k].length.toString(16).padStart(2, '0')).join('')}"`);
    keys.forEach((k, i) => expect(solSrc).toContain(`CLS_${k.toUpperCase()} = ${i};`));

    // the install list must name every class, in blob order — the omission
    // that would otherwise ship five classes short
    Object.keys(CLASSES).forEach((name, i) => expect(solSrc).toContain(`out[${i}] = bytes32("${name}");`));
    expect(solSrc).toContain(`ART_CLASS_COUNT = ${Object.keys(CLASSES).length};`);
  });

  test('the anchor table is generated, and the derived anchors are not stored', () => {
    const solSrc = sol();
    const b2 = (n: number) => n.toString(16).padStart(2, '0');
    // FOUR integers per head reach the chain; the other ten anchors are
    // recomputed on both sides (item 20)
    expect(solSrc).toContain(
      `HEAD_GEOM = hex"${HEAD_SPECS.map((h: any) => b2(h.w) + b2(h.bottom) + b2(h.eyeY) + b2(h.eyeGap)).join('')}"`
    );
    expect(solSrc).not.toContain('MOUTH_Y');
    expect(solSrc).not.toContain('BROW_Y');
    // and every class declares how it attaches and whether it mirrors
    expect(solSrc).toMatch(/CLASS_ATTACH = hex"[0-9a-f]+"/);
    expect(solSrc).toMatch(/CLASS_MIRROR = hex"[0-9a-f]+"/);
  });

  test('the web module carries the same part data (no hand-port drift)', () => {
    const web = gen('parts.web.js');
    const afro = (CLASSES as any).HAIR.find((h: any) => h.name === 'Afro');
    expect(web).toContain(JSON.stringify(afro.rects));
    // the anchor table travels with the part data, or the browser cannot place it
    expect(web).toContain('export const ANCHOR =');
    expect(web).toContain('export const HEAD_SPECS =');
    expect(web).toContain(`export const CANVAS = 32;`);
  });
});

describe('image-level properties the byte-parity harness cannot see', () => {
  // Parity compares JS to Solidity. A mistake made IDENTICALLY in both is
  // invisible to it — which is exactly how four kit stripes at a fixed pitch
  // shipped a detached 3x7 block of colour beside the Slim build's shoulder
  // with every test green. These assert properties of the IMAGE instead.

  test('every kit pattern paints inside its own torso, on every build', () => {
    const r = assertKitFits();
    expect(r.bad).toEqual([]);
    expect(r.pass).toBe(true);
  });

  test('a player is one connected figure — no paint floats on the background', () => {
    const r = assertConnected(120);
    expect(r.bad.slice(0, 5)).toEqual([]);
    expect(r.pass).toBe(true);
  });

  test('the detachment check is not vacuous', () => {
    const body =
      '<rect x="0" y="0" width="32" height="32" fill="#111111"/>' +
      '<rect x="7" y="25" width="18" height="7" fill="#2f6fd0"/>';
    expect(detached(body).orphan).toBe(0);
    // the exact rect the old fourth stripe emitted on the Slim build
    expect(detached(body + '<rect x="27" y="25" width="3" height="7" fill="#f2f4f8"/>').orphan).toBe(21);
  });

  test("a head's shading never paints outside that head", () => {
    const r = assertShadingInsideHead();
    expect(r.bad).toEqual([]);
  });

  test('silhouettes separate on EVERY head, not just the first', () => {
    // auditing head 0 alone reported PASS while Scrum Cap and Keeper Cap
    // rendered the identical mask on the Long head, ear flaps clipped away
    const reports = auditAll();
    expect(reports.length).toBe(3 * HEAD_SPECS.length);
    expect(reports.flatMap((r) => r.collisions)).toEqual([]);
  });

  test('eleven players in one kit stay tellable apart', () => {
    // the hub's actual view, and the only one where team colour does no work.
    // A pair counts as confusable only when it is close on BOTH colour and
    // construction — an earlier attempt measured ink line-work alone and
    // scored two players 3px apart who differ in hair, brows, nose and mouth,
    // because ink covers the outline but not hair or beard.
    const r = assertSquadsLegible();
    expect(r.examples.length).toBeLessThanOrEqual(5);
    expect(r.bad).toEqual([]);
    expect(r.pass).toBe(true);
  });

  test('the fixtures render EVERY part index, so parity has no holes', () => {
    // 64 arbitrary seeds left High Top, Mohawk, Undercut and Scrum Cap never
    // rendered by the parity gate — their placement, mirroring and skull
    // clamping unverified between the two implementations. Scrum Cap was
    // precisely the part whose clamping had just changed.
    const fx = JSON.parse(readFileSync(new URL('../gen/fixtures/render.json', import.meta.url), 'utf8'));
    const TRAIT_CLASS: Record<string, string> = {
      head: 'HEADS', eyes: 'EYES', brows: 'BROWS', nose: 'NOSES', mouth: 'MOUTHS',
      beard: 'BEARDS', hair: 'HAIR', headwear: 'HEADWEAR', ears: 'EARS',
      build: 'BUILDS', collar: 'COLLARS', neck: 'NECKS', shading: 'SHADING',
    };
    const seen: Record<string, Set<number>> = {};
    for (const k of Object.keys(TRAIT_CLASS)) seen[k] = new Set();
    for (let i = 0; i < fx.dna.length; i++) {
      const t: any = traitsOf(seedOf(fx.dna[i], BigInt(fx.appearance[i])));
      for (const k of Object.keys(TRAIT_CLASS)) seen[k].add(t[k]);
    }
    const holes: string[] = [];
    for (const [k, cls] of Object.entries(TRAIT_CLASS)) {
      const list = (CLASSES as any)[cls];
      for (let i = 0; i < list.length; i++) {
        if (!seen[k].has(i)) holes.push(`${cls}[${i}] ${list[i].name}`);
      }
    }
    expect(holes).toEqual([]);
  });

  test('every mouth fits the heads it is eligible for, by its REAL footprint', () => {
    // Slight and Downturned were hand-labelled 5 while spanning 6 columns, so
    // the rule keeping a wide mouth off a narrow skull was handed the wrong
    // number by its own metadata.
    for (const m of MOUTHS as any[]) expect(m.w).toBe(footprint(m.rects));
    for (let wc = 0; wc < 3; wc++) {
      const maxW = wc === 0 ? 4 : wc === 1 ? 5 : 6;
      for (const i of mouthEligible(wc)) expect((MOUTHS as any)[i].w).toBeLessThanOrEqual(maxW);
      // and the rarity table must actually be consulted
      expect(mouthCum(wc).length).toBe(mouthEligible(wc).length);
      expect(mouthCum(wc).at(-1)).toBe(DENOM);
    }
  });

  test('a free-agent goalkeeper does not look like an outfielder', () => {
    const s0 = seedOf('0x' + 'ab'.repeat(32), 1234n);
    expect(freeAgentKit(s0, 0)).not.toEqual(freeAgentKit(s0, 2));
    // ...but a club kit still wins over the keeper fallback
    const club = { primary: 'c8322b', secondary: '1b1b1f', accent: 'f2f4f8', pattern: 1 };
    const id = { dna: '0x' + 'ab'.repeat(32), appearance: 1234n };
    expect(renderPlayer({ ...id, kit: club, position: 0 }))
      .toBe(renderPlayer({ ...id, kit: club, position: 2 }));
  });

  test('the fixtures cover every build x pattern pair, so parity carries the proof to the chain', () => {
    const fx = JSON.parse(readFileSync(new URL('../gen/fixtures/render.json', import.meta.url), 'utf8'));
    const seen = new Set<string>();
    for (let i = 0; i < fx.dna.length; i++) {
      const s0 = seedOf(fx.dna[i], BigInt(fx.appearance[i]));
      const t = traitsOf(s0);
      seen.add(`${t.build}/${fx.kitPattern[i]}`);
      seen.add(`${t.build}/${freeAgentKit(s0).pattern}`);
    }
    const missing: string[] = [];
    for (let b = 0; b < 4; b++) {
      for (let p = 0; p < 7; p++) if (!seen.has(`${b}/${p}`)) missing.push(`${b}/${p}`);
    }
    expect(missing).toEqual([]);
  });
});
