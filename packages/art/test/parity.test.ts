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
// @ts-expect-error
import { CUM, DENOM, RAW, toCumulative, pickFromCum, assertWeights } from '../spec/weights.js';
// @ts-expect-error
import { encodeClass, decodePart, partCount, BIAS, BLOB_VERSION } from '../src/blob.js';
// @ts-expect-error
import { validatePalettes } from '../spec/palettes.js';
// @ts-expect-error
import { renderPlayer, traitsOf, seedOf, freeAgentKit } from '../src/render.js';
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
      const svg = renderPlayer({ dna: fx.dna[i], appearance: BigInt(fx.appearance[i]) });
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
