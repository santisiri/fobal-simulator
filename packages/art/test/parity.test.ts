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
// @ts-expect-error
import { CUM, DENOM, RAW, toCumulative, pickFromCum, assertWeights } from '../spec/weights.js';
// @ts-expect-error
import { encodeClass, decodePart, partCount, BIAS, BLOB_VERSION } from '../src/blob.js';
// @ts-expect-error
import { validatePalettes } from '../spec/palettes.js';
// @ts-expect-error
import { renderPlayer, traitsOf } from '../src/render.js';

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

  test('renders are deterministic and stable across repeated calls', () => {
    for (let i = 0; i < 50; i++) {
      const seed = `parity-${i}`;
      expect(renderPlayer({ seed, kit: KIT })).toBe(renderPlayer({ seed, kit: KIT }));
    }
  });

  test('a seed selects the same traits every time (the chain relies on this)', () => {
    for (let i = 0; i < 50; i++) {
      expect(traitsOf(`parity-${i}`)).toEqual(traitsOf(`parity-${i}`));
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

  test('Solidity constants carry the same class sizes and weight tables', () => {
    const sol = gen('FobalArtConstants.sol');
    for (const [name, parts] of Object.entries(CLASSES) as [string, any[]][]) {
      expect(sol).toContain(`${name.toUpperCase()}_COUNT = ${parts.length};`);
    }
    expect(sol).toContain(`WEIGHT_DENOM = ${DENOM};`);
    expect(sol).toContain(`BIAS = ${BIAS};`);
    // spot-check a full table round-trips into Solidity syntax
    expect(sol).toContain(CUM.hair.map((v: number) => `uint16(${v})`).join(', '));
  });

  test('the web module carries the same part data (no hand-port drift)', () => {
    const web = gen('parts.web.js');
    const afro = (CLASSES as any).HAIR.find((h: any) => h.name === 'Afro');
    expect(web).toContain(JSON.stringify(afro.rects));
    expect(web).toContain(`export const CANVAS = 32;`);
  });
});
