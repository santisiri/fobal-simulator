// art spec -> everything downstream, from ONE source.
//
//   packages/art/spec/*  ->  gen/blobs/*.bin   SSTORE2 payloads
//                            gen/blobs/*.hex   the same, for forge fixtures
//                            gen/manifest.json class table + gate numbers
//                            ../../contracts/src/art/FobalArtConstants.sol
//                            gen/parts.web.js  the web module (retires the
//                                              hand-maintained port in P5)
//
// gen/ is COMMITTED on purpose: these bytes are the contract between the JS
// reference renderer and the chain, CI verifies they are current by
// regenerating and diffing, and the Solidity tests read them as fixtures.
//
// Three implementations of this art exist today (Solidity, the web port, the
// golden client). Generating them removes the drift by construction.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CLASSES, CANVAS, SLOT, ANCHOR } from '../spec/parts.js';
import { HEAD_SPECS, CX, HEAD_TOP, EYE_W, EAR_W, anchorsOf } from '../spec/anchors.js';
import { auditAll } from './silhouette-lib.mjs';
import { CUM, RAW, DENOM, MOUTH_ELIG, MOUTH_CUM, assertWeights } from '../spec/weights.js';
import { validatePalettes, SKIN, SKIN_BASE, HAIR, BG, ACCENT, INK, EYE_WHITE, IRIS, KEEPER_KIT } from '../spec/palettes.js';
import { encodeClass, decodePart, partCount, toHex, BIAS, BLOB_VERSION } from '../src/blob.js';
import { renderPlayer, seedOf, traitsOf, freeAgentKit, HEADWEAR_HAIR_FALLBACK, NECK_OF_BUILD, assertKitFits, assertShadingInsideHead } from '../src/render.js';
import { assertConnected } from './connectivity.mjs';
import { assertSquadsLegible, SAMPLE_CLUBS } from './squad-lib.mjs';
import { keccak_256 } from '@noble/hashes/sha3';


/** Strip whole `import …;` and `export { … };` STATEMENTS, not just their
 *  first lines. A line-based filter silently emitted the tail of a multi-line
 *  import into the browser bundle, which failed at parse time rather than at
 *  build time. */
function stripModulePlumbing(src) {
  const lines = src.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (!skipping && (/^import[\s{]/.test(line) || /^export\s*\{/.test(line))) {
      skipping = true;
    }
    if (skipping) {
      if (line.trimEnd().endsWith(';')) skipping = false;
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/^export /gm, '');
}

/** Every authored field, not a hand-listed subset. Listing three keys by hand
 *  silently dropped the mouths' width field, and the browser divided by an
 *  empty eligible set on the first render it attempted. */
const webPart = (p) => ({ ...p, rects: p.rects ?? [], tags: p.tags ?? [] });

const A = new URL('..', import.meta.url);
const blobDir = new URL('./gen/blobs/', A);
const genDir = new URL('./gen/', A);
mkdirSync(blobDir, { recursive: true });
mkdirSync(genDir, { recursive: true });

const MAX_BLOB = 24575;            // EIP-170 minus the SSTORE2 STOP prefix
const fail = [];

// ---- gates that must hold before anything is written
const pal = validatePalettes();
if (!pal.pass) fail.push('palette separation gate failed');
const wts = assertWeights();
if (!wts.pass) fail.push(`weight gate failed: ${wts.bad.join('; ')}`);
// Colour-blind silhouette separation: two parts whose masks are a handful of
// pixels apart are one part with two names, and must not reach a deploy.
const sil = auditAll();
for (const rep of sil) for (const c of rep.collisions) fail.push(`silhouette ${rep.label}: ${c}`);
// Every pattern on every build, exhaustively: 28 pairs, so a proof.
const kit = assertKitFits();
for (const b of kit.bad) fail.push(`kit geometry: ${b}`);
for (const [cls, parts] of Object.entries(CLASSES)) {
  const key = Object.keys(CUM).find(k => k === cls.toLowerCase() || k === cls.toLowerCase().replace(/s$/, ''));
  if (!key) continue;
  if (CUM[key].length !== parts.length) {
    fail.push(`${cls}: ${parts.length} parts but ${CUM[key].length} weights — `
      + (CUM[key].length < parts.length ? 'the extra parts can never be minted' : 'a weight selects nothing'));
  }
}
// Eleven players in ONE kit is the hardest case the product shows, and the
// only one where team colour does no work at all. A pair counts as confusable
// only when it is close on BOTH colour and construction.
// a SAMPLE here — the full 400-squad sweep is ~34s and belongs in its own CI
// step (tools/squad-sheet.mjs), not in a command developers run constantly
const squads = assertSquadsLegible(SAMPLE_CLUBS(60));
for (const b of squads.bad) fail.push(`squads: ${b}`);
const shade = assertShadingInsideHead();
for (const b of shade.bad.slice(0, 10)) fail.push(`shading: ${b}`);
// And the property a byte-parity harness structurally cannot see — a mistake
// made identically in both renderers is invisible to it. A player must be ONE
// connected figure; anything else is paint floating on the background.
const conn = assertConnected(200);
for (const b of [...new Set(conn.bad.map((x) => x.replace(/^seed \d+ /, '')))].slice(0, 10)) {
  fail.push(`detached paint: ${b}`);
}

// ---- encode every class, and prove the round trip immediately
const manifest = { version: BLOB_VERSION, canvas: CANVAS, bias: BIAS, denom: DENOM, classes: {} };
let totalBytes = 0;
for (const [name, parts] of Object.entries(CLASSES)) {
  const blob = encodeClass(parts);
  if (blob.length > MAX_BLOB) fail.push(`${name}: blob ${blob.length}B exceeds ${MAX_BLOB}B`);
  // round trip NOW: a blob that cannot be decoded back to its source rects
  // must never reach a deploy script
  if (partCount(blob) !== parts.length) fail.push(`${name}: partCount mismatch`);
  parts.forEach((part, i) => {
    const back = JSON.stringify(decodePart(blob, i));
    const want = JSON.stringify((part.rects ?? []).map(r => r.slice(0, 5)));
    if (back !== want) fail.push(`${name}[${i}] "${part.name}": round trip differs`);
  });
  writeFileSync(new URL(`./${name}.bin`, blobDir), blob);
  writeFileSync(new URL(`./${name}.hex`, blobDir), toHex(blob) + '\n');
  manifest.classes[name] = {
    parts: parts.length,
    bytes: blob.length,
    names: parts.map(p => p.name),
    // CUM keys are singular where the class name is plural ('NOSES' -> 'nose'),
    // so a bare toLowerCase() reported six classes as having no weight table.
    cum: CUM[name.toLowerCase()] ?? CUM[name.toLowerCase().replace(/s$/, '')] ?? null,
  };
  totalBytes += blob.length;
}

// ---- Solidity constants (indices + tables; NO art data — that lives in blobs)
const solLines = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity 0.8.28;',
  '',
  '/// @notice GENERATED by packages/art/tools/gen-art.mjs — do not edit.',
  '/// Class sizes, cumulative weight tables and palette values, kept in sync',
  '/// with the JS reference renderer by construction. The ART ITSELF lives in',
  '/// SSTORE2 blobs; nothing here is drawing data.',
  'library FobalArtConstants {',
  `    uint256 internal constant CANVAS = ${CANVAS};`,
  `    uint256 internal constant BIAS = ${BIAS};`,
  `    uint256 internal constant WEIGHT_DENOM = ${DENOM};`,
  `    uint8 internal constant BLOB_VERSION = ${BLOB_VERSION};`,
  '',
];
for (const [name, meta] of Object.entries(manifest.classes))
  solLines.push(`    uint256 internal constant ${name.toUpperCase()}_COUNT = ${meta.parts};`);
// The install list, GENERATED. It was hand-written in five places, and adding
// classes silently left the deploy script installing eight of thirteen — the
// missing ones degrading to nothing on chain rather than failing loudly.
solLines.push('',
  `    uint256 internal constant ART_CLASS_COUNT = ${Object.keys(manifest.classes).length};`,
  '',
  '    /// @notice Every art class, in blob order. Deploy scripts and tests',
  '    /// MUST iterate this rather than restating it. Dynamic on purpose: a',
  '    /// library constant is not accepted as a fixed-array length, and a',
  '    /// hand-written length is the very thing this function removes.',
  '    function classNames() internal pure returns (bytes32[] memory out) {',
  `        out = new bytes32[](${Object.keys(manifest.classes).length});`,
  ...Object.keys(manifest.classes).map((n, i) => `        out[${i}] = bytes32("${n}");`),
  '    }');
// headwear tag bitmasks — the constraint pass reads these, so they are
// generated from the same spec rather than restated by hand in Solidity
const b2 = (n) => n.toString(16).padStart(2, '0');
const maskOf = (tag) => CLASSES.HEADWEAR.reduce((m, p, i) => (p.tags ?? []).includes(tag) ? m | (1 << i) : m, 0);
solLines.push('', `    uint256 internal constant HEADWEAR_COVERS_MASK = ${maskOf('covers')};`,
  `    uint256 internal constant HEADWEAR_BAND_MASK = ${maskOf('band')};`);

// ---- the anchor system, generated so Solidity cannot drift from the spec.
// Only FOUR integers per head are stored; the other ten anchors are derived
// identically on both sides (see FobalFaceComposer.anchorsOf).
const ATTACH = { absolute: 0, eyes: 1, brows: 2, ears: 3, nose: 4, mouth: 5, chin: 6, top: 7 };
const classOrder = Object.keys(CLASSES);
solLines.push('',
  '    // ---- anchor system',
  `    uint256 internal constant CX = ${CX};`,
  `    uint256 internal constant HEAD_TOP = ${HEAD_TOP};`,
  `    uint256 internal constant EYE_W = ${EYE_W};`,
  `    uint256 internal constant EAR_W = ${EAR_W};`,
  '    /// @dev 4 bytes per head: width, chinY, eyeY, eyeGap. Everything else',
  '    /// (headX, brow/nose/mouth/ear lines, eye x, width class) is DERIVED.',
  `    bytes internal constant HEAD_GEOM = hex"${HEAD_SPECS.map(h => b2(h.w) + b2(h.bottom) + b2(h.eyeY) + b2(h.eyeGap)).join('')}";`,
  `    /// @dev one byte per class, in blob order: ${classOrder.join(', ')}`,
  `    bytes internal constant CLASS_ATTACH = hex"${classOrder.map(c => b2(ATTACH[ANCHOR[c].at])).join('')}";`,
  '    /// @dev mirror-box width per class; 0 means the part is drawn once',
  `    bytes internal constant CLASS_MIRROR = hex"${classOrder.map(c =>
      b2(!ANCHOR[c].mirror ? 0 : c === 'EARS' ? EAR_W : EYE_W)).join('')}";`,
  '    /// @dev skull-clamp margin per class; 0 means the class is never clipped',
  `    bytes internal constant CLASS_CLAMP = hex"${classOrder.map(c => b2(ANCHOR[c].clamp ?? 0)).join('')}";`);
// ---- cumulative weight tables, PACKED. One accessor replaces a family of
// fixed-size adapters that had to be edited by hand every time a class
// changed length — which is precisely the drift this generator exists to end.
const cumKeys = Object.keys(CUM);
const b4 = (n) => n.toString(16).padStart(4, '0');
let cumFlat = '', cumOff = '', cumLen = '', at = 0;
for (const k of cumKeys) {
  cumFlat += CUM[k].map(b4).join('');
  cumOff += b4(at); cumLen += b2(CUM[k].length);
  at += CUM[k].length;
}
solLines.push('',
  '    // ---- weight tables: 2 bytes per entry, indexed by CLS_* below',
  ...cumKeys.map((k, i) => `    uint256 internal constant CLS_${k.toUpperCase()} = ${i};`),
  `    uint256 internal constant CLS_COUNT = ${cumKeys.length};`,
  `    bytes internal constant CUM_DATA = hex"${cumFlat}";`,
  `    bytes internal constant CUM_OFFSET = hex"${cumOff}";`,
  `    bytes internal constant CUM_LEN = hex"${cumLen}";`,
  '',
  '    /// @notice The cumulative table for one class, unpacked.',
  '    function cumOf(uint256 cls) internal pure returns (uint16[] memory out) {',
  '        bytes memory off = CUM_OFFSET;',
  '        bytes memory len = CUM_LEN;',
  '        bytes memory data = CUM_DATA;',
  '        uint256 start = (uint256(uint8(off[cls * 2])) << 8) | uint256(uint8(off[cls * 2 + 1]));',
  '        uint256 n = uint256(uint8(len[cls]));',
  '        out = new uint16[](n);',
  '        for (uint256 k; k < n; ++k) {',
  '            uint256 j = (start + k) * 2;',
  '            out[k] = uint16((uint256(uint8(data[j])) << 8) | uint256(uint8(data[j + 1])));',
  '        }',
  '    }');

// ---- correlation + fallback tables, generated from the SAME functions the
// reference renderer calls, so the two can never state different rules.
const elig = MOUTH_ELIG;
solLines.push('',
  '    // ---- deterministic compatibility tables (item 16). Generated from the',
  '    // reference renderer, never restated by hand.',
  `    bytes internal constant HAIR_FALLBACK = hex"${HEADWEAR_HAIR_FALLBACK.map(b2).join('')}";`,
  `    bytes internal constant NECK_OF_BUILD = hex"${NECK_OF_BUILD.map(b2).join('')}";`,
  '    /// @dev mouths a head of each width class may wear, concatenated',
  `    bytes internal constant MOUTH_ELIG = hex"${elig.flat().map(b2).join('')}";`,
  `    bytes internal constant MOUTH_ELIG_LEN = hex"${elig.map(e => b2(e.length)).join('')}";`,
  '    /// @dev rarity RENORMALISED over each eligible set, 2 bytes per entry.',
  '    /// Picking uniformly inside the set left the mouth weights wired to',
  '    /// nothing while still shipping as bytes.',
  `    bytes internal constant MOUTH_ELIG_CUM = hex"${[0, 1, 2].map(wc =>
      MOUTH_CUM[wc].map(v => v.toString(16).padStart(4, '0')).join('')).join('')}";`,
  '    /// @dev x and width of each build\'s torso box, so the kit composer can',
  '    /// place a pattern from pure geometry without ever seeing a trait.',
  `    bytes internal constant BUILD_TORSO = hex"${CLASSES.BUILDS.map(b => b2(b.rects[1][0]) + b2(b.rects[1][2])).join('')}";`);
solLines.push('');
const hexArr = (name, arr) =>
  `    bytes internal constant ${name} = hex"${arr.join('')}";`;
solLines.push(
  '    // palettes, packed 3 bytes per colour',
  hexArr('SKIN_BASE', SKIN_BASE),
  // shade/light are PRECOMPUTED here: JS mixes them with floating point and
  // Solidity must never attempt to reproduce that rounding
  hexArr('SKIN_SHADE', SKIN.map(t => t[1])), hexArr('SKIN_LIGHT', SKIN.map(t => t[2])),
  hexArr('HAIR_COLOR', HAIR), hexArr('BG_COLOR', BG), hexArr('ACCENT_COLOR', ACCENT),
  hexArr('IRIS_COLOR', IRIS),
  `    bytes3 internal constant INK = hex"${INK}";`,
  `    bytes3 internal constant EYE_WHITE = hex"${EYE_WHITE}";`,
  '    // the goalkeeper\'s FREE-AGENT kit. A club kit always wins over it.',
  `    uint24 internal constant KEEPER_PRIMARY = 0x${KEEPER_KIT.primary};`,
  `    uint24 internal constant KEEPER_SECONDARY = 0x${KEEPER_KIT.secondary};`,
  `    uint24 internal constant KEEPER_ACCENT = 0x${KEEPER_KIT.accent};`,
  `    uint8 internal constant KEEPER_PATTERN = ${KEEPER_KIT.pattern};`,
  '}', '');
// written straight into the contracts tree — its only consumer. A second
// copy under gen/ would be one more thing that can silently drift.
writeFileSync(new URL('../../contracts/src/art/FobalArtConstants.sol', A), solLines.join('\n'));

// ---- the web avatar module. GENERATED, and self-contained: apps/web ships
// as plain ES modules with no bundler, so the keccak the chain hashes with is
// inlined rather than imported. Replacing the hand-written port is the point
// of P5 — a "faithful port" maintained by hand drifts, and did.
const web = [
  '// GENERATED by packages/art/tools/gen-art.mjs — do not edit.',
  '// The browser reads the SAME part data the chain stores, so the preview',
  '// can never drift from what gets minted.',
  `export const CANVAS = ${CANVAS};`,
  `export const ANCHOR = ${JSON.stringify(ANCHOR)};`,
  `export const HEAD_SPECS = ${JSON.stringify(HEAD_SPECS)};`,
  `export const SLOT = ${JSON.stringify(SLOT)};`,
  `export const CUM = ${JSON.stringify(CUM)};`,
  `export const PALETTES = ${JSON.stringify({ SKIN_BASE, HAIR, BG, ACCENT, IRIS, INK, EYE_WHITE })};`,
  `export const PARTS = ${JSON.stringify(
    Object.fromEntries(Object.entries(CLASSES).map(([k, v]) => [k, v.map(webPart)])))};`,
  '',
].join('\n');
writeFileSync(new URL('./parts.web.js', genDir), web);

// the runnable web renderer: data + keccak + the same render logic, emitted
// straight into apps/web so the preview and the chain cannot diverge
const keccakSrc = readFileSync(new URL('./src/keccak-web.js', A), 'utf8')
  .replace(/^export /gm, '');
// the anchor resolver is LOGIC, not data: inline the source rather than
// restating it, so the browser derives anchors exactly as the spec does
const anchorSrc = stripModulePlumbing(readFileSync(new URL('./spec/anchors.js', A), 'utf8'));
const renderSrc = readFileSync(new URL('./src/render.js', A), 'utf8');
// lift the body of the reference renderer, swapping its module imports for
// the inlined data above — the logic itself is copied verbatim, never retyped
// drop module plumbing: imports, and re-exports of things that are inlined
// above as plain consts. The RENDER LOGIC below is copied verbatim.
const renderBody = stripModulePlumbing(renderSrc);

const avatarJs = [
  '// GENERATED by packages/art/tools/gen-art.mjs — DO NOT EDIT.',
  '//',
  '// The browser draws players from the SAME part data, palettes, weight',
  '// tables and render logic the chain uses, with the same keccak. This file',
  '// replaces a hand-maintained port that had silently diverged (a goalkeeper',
  '// kit the chain never had, and a 24-bit appearance mask that hid every',
  '// accessory). Regenerate with: node packages/art/tools/gen-art.mjs',
  '',
  '// ---- keccak-256 (verified against @noble/hashes in packages/art/test)',
  keccakSrc,
  'const keccak_256 = keccak256;',
  '',
  '// ---- generated art data',
  `const SKIN_BASE = ${JSON.stringify(SKIN_BASE)};`,
  `const SKIN = ${JSON.stringify(SKIN)};`,
  `const HAIR_COL = ${JSON.stringify(HAIR)};`,
  `const BG = ${JSON.stringify(BG)};`,
  `const ACCENT = ${JSON.stringify(ACCENT)};`,
  `const INK = ${JSON.stringify(INK)};`,
  `const EYE_WHITE = ${JSON.stringify(EYE_WHITE)};`,
  `const IRIS = ${JSON.stringify(IRIS)};`,
  `const KEEPER_KIT = ${JSON.stringify(KEEPER_KIT)};`,
  `const CUM = ${JSON.stringify(CUM)};`,
  `const MOUTH_ELIG = ${JSON.stringify(MOUTH_ELIG)};`,
  `const MOUTH_CUM = ${JSON.stringify(MOUTH_CUM)};`,
  `const DENOM = ${DENOM};`,
  `const SLOT = ${JSON.stringify(SLOT)};`,
  `const ANCHOR = ${JSON.stringify(ANCHOR)};`,
  '',
  '// ---- the anchor resolver, verbatim from spec/anchors.js',
  anchorSrc,
  ...Object.entries(CLASSES).map(([k, v]) => `const ${k} = ${JSON.stringify(v.map(webPart))};`),
  'const pickFromCum = (cum, r) => { for (let i = 0; i < cum.length; i++) if (r < cum[i]) return i; return cum.length - 1; };',
  '',
  '// ---- the reference renderer, verbatim',
  renderBody,
  '',
  '// ---- the public API. Two names, because the distinction matters:',
  '// what the CHAIN renders, and what a club kit would look like.',
  '',
  '/** Exactly what tokenURI returns for this identity today (free agent). */',
  'export function avatarSvgOnchain({ dna, appearance, position = 2 }) {',
  '  return renderPlayer({ dna, appearance, position });',
  '}',
  '',
  '/** The app carries kits as CSS colours ("#22c55e") and often only two of',
  ' *  them. The renderer, like the chain, wants BARE hex and a full three',
  ' *  colour kit with a pattern. Normalising at the boundary is why a UI kit',
  ' *  can no longer reach the renderer half-formed: passing one straight',
  ' *  through emitted fill="##22c55e" — invalid, and black in every browser. */',
  'export function toRenderKit(kit) {',
  '  if (!kit) return undefined;',
  '  const hex = (v, fallback) => {',
  '    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(v ?? ""));',
  '    return m ? m[1].toLowerCase() : fallback;',
  '  };',
  '  const secondary = hex(kit.secondary, "f2f4f8");',
  '  return {',
  '    primary: hex(kit.primary, "2f6fd0"),',
  '    secondary,',
  '    accent: hex(kit.accent, secondary),',
  '    pattern: Number.isFinite(Number(kit.pattern)) ? Math.abs(Number(kit.pattern)) % 7 : 0,',
  '  };',
  '}',
  '',
  '/** The same identity wearing a specific club kit. */',
  'export function avatarSvgDressed({ dna, appearance, position = 2 }, kit) {',
  '  return renderPlayer({ dna, appearance, kit: toRenderKit(kit), position });',
  '}',
  '',
  'export function avatarDataUri(p, kit) {',
  '  const svg = kit ? avatarSvgDressed(p, kit) : avatarSvgOnchain(p);',
  "  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);",
  '}',
  '',
  'export { traitsOf, seedOf, freeAgentKit, anchorsOf, CANVAS };',
  '// the mint-time check: only whoever CHOOSES the dna can fix a clash,',
  '// and after the mint nobody can.',
  'export { comparePlayers, confusablePairs, dedupeSquad, CONFUSABLE_COLOUR, CONFUSABLE_STRUCTURE };',
  '',
].join('\n');
writeFileSync(new URL('../../apps/web/public/js/avatar.js', A), avatarJs);

// SELF-CHECK. The browser module is assembled by listing symbols by hand, and
// that list has now silently dropped a part field, a palette constant and the
// tail of a multi-line import — each time surfacing as a crash in the browser
// rather than a failure here. So: import what was just written and render
// through it. A missing symbol is a ReferenceError at BUILD time.
try {
  const mod = await import(new URL('../../apps/web/public/js/avatar.js', A).href
    + `?v=${keccak_256(new TextEncoder().encode(avatarJs))[0]}-${avatarJs.length}`);
  for (let i = 0; i < 8; i++) {
    const b = keccak_256(new TextEncoder().encode(`web-selfcheck-${i}`));
    const dna = '0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    const id = { dna, appearance: (BigInt(dna) >> 96n) & 0xffffffffn };
    const position = i % 4;
    const got = mod.avatarSvgOnchain({ dna: id.dna, appearance: id.appearance, position });
    const want = renderPlayer({ dna: id.dna, appearance: id.appearance, position });
    if (got !== want) fail.push(`web module diverges from the reference at self-check ${i} (position ${position})`);
  }
  const norm = mod.toRenderKit({ primary: '#22c55e', secondary: '#0d1428' });
  if (!/^[0-9a-f]{6}$/.test(norm.primary) || norm.accent === undefined) {
    fail.push('web module: toRenderKit does not normalise a UI kit');
  }
} catch (err) {
  fail.push(`web module does not load: ${err.message}. The browser bundle is`
    + ' assembled by listing symbols by hand — a name used by the render logic'
    + ' but missing from the emitted data will look exactly like this.');
}


// ---- parity fixtures: (dna, appearance) -> expected SVG hash. The forge
// test replays these through the Solidity renderer and compares hashes, so
// any divergence between the two implementations fails a build.
const FIXTURE_N = 64;
const hashOf = (str) => '0x' + [...keccak_256(new TextEncoder().encode(str))]
  .map(b => b.toString(16).padStart(2, '0')).join('');
const idFromTag = (tag) => {
  const dna = '0x' + [...keccak_256(new TextEncoder().encode(tag))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return { dna, appearance: (BigInt(dna) >> 96n) & 0xffffffffn };
};

// Which trait keys index which class, for the coverage sweep below.
const TRAIT_CLASS = {
  head: 'HEADS', eyes: 'EYES', brows: 'BROWS', nose: 'NOSES', mouth: 'MOUTHS',
  beard: 'BEARDS', hair: 'HAIR', headwear: 'HEADWEAR', ears: 'EARS',
  build: 'BUILDS', collar: 'COLLARS', neck: 'NECKS', shading: 'SHADING',
};

// The base set, plus whatever it takes to reach EVERY part index. Sixty-four
// arbitrary seeds left High Top, Mohawk, Undercut and Scrum Cap never rendered
// by the parity gate — so their placement, mirroring and skull clamping were
// unverified between the two implementations, and Scrum Cap is precisely the
// part whose clamping had just changed.
const tags = [];
for (let i = 0; i < FIXTURE_N; i++) tags.push(`fobal-fixture-${i}`);

const covered = Object.fromEntries(Object.keys(TRAIT_CLASS).map(k => [k, new Set()]));
const noteCoverage = (tag) => {
  const { dna, appearance } = idFromTag(tag);
  const t = traitsOf(seedOf(dna, appearance));
  let novel = false;
  for (const k of Object.keys(TRAIT_CLASS)) {
    if (!covered[k].has(t[k])) { covered[k].add(t[k]); novel = true; }
  }
  return novel;
};
tags.forEach(noteCoverage);

const missing = () => Object.entries(TRAIT_CLASS)
  .flatMap(([k, cls]) => [...Array(CLASSES[cls].length).keys()]
    .filter(i => !covered[k].has(i)).map(i => `${cls}[${i}] ${CLASSES[cls][i].name}`));

let probe = 0;
while (missing().length && probe < 200000) {
  const tag = `fobal-fixture-cover-${probe++}`;
  if (noteCoverage(tag)) tags.push(tag);
}
if (missing().length) fail.push(`fixtures cannot reach: ${missing().join(', ')}`);

const fx = {
  dna: [], appearance: [], position: [], svgHash: [], traits: [],
  // an EXPLICIT kit per fixture, so the club-kit path is proven byte-exact
  // too — not just the free-agent one
  kitPrimary: [], kitSecondary: [], kitAccent: [], kitPattern: [], svgKitHash: [],
};
tags.forEach((tag, i) => {
  const { dna, appearance } = idFromTag(tag);
  // cycle the positions so the GOALKEEPER free-agent path is exercised; it
  // existed only in the JS reference and no fixture had ever rendered it
  const position = i % 4;
  const t = traitsOf(seedOf(dna, appearance));
  fx.dna.push(dna);
  fx.appearance.push(appearance.toString());
  fx.position.push(String(position));
  fx.svgHash.push(hashOf(renderPlayer({ dna, appearance, position })));
  fx.traits.push([t.head, t.skin, t.eyes, t.brows, t.nose, t.mouth, t.hair, t.hairColor, t.beard,
    t.headwear, t.bg, t.accent, t.iris, t.ears, t.build, t.collar, t.neck, t.shading].join(','));
  const kh = BigInt(hashOf(`kit-${i}`));
  const kit = {
    primary: Number((kh >> 8n) & 0xffffffn).toString(16).padStart(6, '0'),
    secondary: Number((kh >> 40n) & 0xffffffn).toString(16).padStart(6, '0'),
    accent: Number((kh >> 72n) & 0xffffffn).toString(16).padStart(6, '0'),
    pattern: i % 7,
  };
  fx.kitPrimary.push(String(parseInt(kit.primary, 16)));
  fx.kitSecondary.push(String(parseInt(kit.secondary, 16)));
  fx.kitAccent.push(String(parseInt(kit.accent, 16)));
  fx.kitPattern.push(String(kit.pattern));
  fx.svgKitHash.push(hashOf(renderPlayer({ dna, appearance, kit, position })));
});

mkdirSync(new URL('./gen/fixtures/', A), { recursive: true });

// ---- EVERY part of EVERY class, flattened. The decode test replays this
// through the on-chain library, so the claim it proves is "the chain decodes
// the whole atlas to the exact JS rects", not "three parts I happened to
// pick still look right".
const rectFx = { className: [], partIndex: [], x: [], y: [], w: [], h: [], slot: [], partCount: [] };
for (const [name, parts] of Object.entries(CLASSES)) {
  rectFx.partCount.push(String(parts.length));
  parts.forEach((part, pi) => {
    for (const r of (part.rects ?? [])) {
      rectFx.className.push(name);
      rectFx.partIndex.push(String(pi));
      rectFx.x.push(String(r[0])); rectFx.y.push(String(r[1]));
      rectFx.w.push(String(r[2])); rectFx.h.push(String(r[3])); rectFx.slot.push(String(r[4]));
    }
  });
}
writeFileSync(new URL('./gen/fixtures/rects.json', A), JSON.stringify(rectFx, null, 1));
writeFileSync(new URL('./gen/fixtures/render.json', A), JSON.stringify(fx, null, 1));

// gate: the web data must carry every key the spec authored. A missing key
// is a silent render failure in a place with no test of its own.
for (const [name, parts] of Object.entries(CLASSES)) {
  parts.forEach((p, i) => {
    const emitted = Object.keys(webPart(p)).sort().join(',');
    const authored = [...new Set([...Object.keys(p), 'rects', 'tags'])].sort().join(',');
    if (emitted !== authored) fail.push(`${name}[${i}]: web data drops fields (${authored} -> ${emitted})`);
  });
}

manifest.anchors = HEAD_SPECS.map((h, i) => ({ ...h, ...anchorsOf(i) }));
manifest.headGeomBytes = HEAD_SPECS.length * 4;
manifest.totalBytes = totalBytes;
manifest.gates = { palettes: pal.pass, weights: wts.pass, maxBlobBytes: MAX_BLOB };
writeFileSync(new URL('./gen/manifest.json', A), JSON.stringify(manifest, null, 2));

console.log('class            parts   bytes');
for (const [k, m] of Object.entries(manifest.classes))
  console.log(`  ${k.padEnd(14)} ${String(m.parts).padStart(3)}  ${String(m.bytes).padStart(6)}`);
console.log(`  ${'TOTAL'.padEnd(14)}      ${String(totalBytes).padStart(6)} B of art data`);
console.log(`fixtures: ${tags.length} seeds (${FIXTURE_N} base + ${tags.length - FIXTURE_N} for coverage)`
  + ` -> gen/fixtures/render.json; every part index of every class rendered`);
console.log(`          ${rectFx.x.length} rects across ${Object.keys(CLASSES).length} classes -> gen/fixtures/rects.json`);
console.log(`  ${'head geometry'.padEnd(14)}       ${String(HEAD_SPECS.length * 4).padStart(5)} B (4 ints x ${HEAD_SPECS.length} heads; 10 more anchors derived)`);
console.log(`gates: palettes ${pal.pass ? 'PASS' : 'FAIL'} · weights ${wts.pass ? 'PASS' : 'FAIL'}`
  + ` · silhouette ${sil.every(r => !r.collisions.length) ? 'PASS' : 'FAIL'}`
  + ` · kit-fits ${kit.pass ? 'PASS' : 'FAIL'} · shading-inside ${shade.pass ? 'PASS' : 'FAIL'} · connectivity ${conn.pass ? 'PASS' : 'FAIL'} (${conn.checked} renders)`
  + ` · squads ${squads.pass ? 'PASS' : 'FAIL'} (${squads.squads} sampled, ${squads.cleanedWithPair} confusable after the check)`
  + ` · round-trip ${fail.length ? 'FAIL' : 'PASS'}`);
if (fail.length) { console.error('\nFAILURES:\n  ' + fail.join('\n  ')); process.exit(1); }
