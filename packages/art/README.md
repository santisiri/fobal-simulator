# @fobal/art — on-chain player art ("Anchored Atlas")

The spec is the source of truth. Everything downstream — SSTORE2 blobs, the
Solidity constants, the browser module, the parity fixtures, the budget
document — is GENERATED from it, and CI regenerates and diffs, so the four
implementations cannot drift apart.

    node tools/gen-art.mjs      # blobs, Solidity constants, web module, fixtures
    node tools/atlas-doc.mjs    # docs/ART_ATLAS_V2.md — budget + rect data
    node tools/silhouette.mjs   # the colour-blind separation audit
    node tools/ascii.mjs heads  # rasterise to 32x32 ASCII — the honest look
    npm run sheets              # out/*.html contact sheets
    npm run palettes            # re-solve palettes, print the separation report

## v3 — anchors: head choice restructures the face

Six heads no longer differ only in outline. Each carries an ANCHOR SET, and
every face part is authored ONCE in local space and translated onto it, so a
narrow skull gets close-set eyes, a higher mouth and a shorter ear line from
the same stored rects a wide one uses. Per-head facial architecture, at zero
extra atlas bytes.

Four integers per head reach the chain (width, chin row, eye row, eye gap);
ten more anchors are DERIVED identically in `spec/anchors.js` and
`contracts/src/art/FobalAnchors.sol`. `mouthY = chinY - 3` is derived rather
than authored on purpose — pinning the mouth a fixed distance above the chin
is what lets one authored beard clear the mouth on all six skulls.

Full budget, anchor tables, the compatibility matrix and every rect:
**[docs/ART_ATLAS_V2.md](../../docs/ART_ATLAS_V2.md)** (generated).

## Why the redesign exists (measured, not asserted)

v1 emits 1,966,080 nominal combinations; strip provably-invisible cues and it
is 54,272; at a perceptual distance of dE>=15 it is **5,952** — a 330x
collapse. 88.2% of its 576 pixels hold the same role in every avatar that can
ever be minted, the background owns ~65% of the canvas across only 4 usable
clusters, and of dna's 256 bits exactly one is read. Simulating the owner's
100-player grid test on v1 gives a **36.3% sibling rate**.

The fix is canvas allocation, not combinatorics.

## The four decisions

1. **32x32 bust.** The product displays avatars at 36-62px with
   `image-rendering: pixelated`. A 64-unit canvas at 48px deletes 25% of its
   rows in a fixed comb; 32 units is lossless at every shipping size and
   costs a quarter of the corpus.
2. **6:1 weight cap on silhouette classes.** Uniform weights give 0.3%
   siblings; a conventional collectible curve gives 5.3%; 36:1 gives 20.95%,
   which is v1's failure. Rarity belongs only in channels that do not change
   the silhouette. ("None" is exempt — it is the absence of a feature.)
3. **Budget follows perception.** Six heads, purely geometric — and since
   v3 they move every feature on the face, which is the best variety-per-byte
   in the system. Silhouette is what survives downscaling, so hair and
   headwear get the budget; but only where the silhouettes actually differ
   (see gate 3 below).
4. **A per-player accent that survives the team kit** (collar + cuffs). Team
   ownership otherwise collapses a squad's colour to cardinality 1.

## Structure (mirrors the planned Solidity exactly)

    spec/palettes.js   solved palettes + the dE gate
    spec/parts.js      the authored atlas: every part is [x,y,w,h,paletteSlot] DATA
    src/render.js      lanes -> weighted CDF -> constraint pass -> palette -> layer splice
    tools/             the palette solver and the contact sheets

`faceRects()` takes no kit parameter and `kitRects()` takes no identity — the
"a transfer changes the jersey, not the face" rule expressed structurally, so
the Solidity `FobalFaceComposer` physically cannot read a jersey.

## The gates (out/gate.html)

The primary gate is the owner's own test at production size: **100 players at
exactly 48px, nearest-neighbour**, plus two harder variants — the same 100 in
ONE kit (the hub strip, where team colour stops helping) and the same 100 with
colour removed entirely (pure silhouette). Reviewing at 120px flatters exactly
the detail that vanishes in production, which is why the 120px squad sheet is
explicitly secondary.

Machine gates, all green:

1. **Palette separation** (dE76 — ramps on adjacent steps, categorical sets
   on all pairs).
2. **The 6:1 silhouette weight ratio.**
3. **Silhouette separation** (`tools/silhouette.mjs`): colour is what
   flatters a weak silhouette, so the audit throws it away and measures every
   pair of hair, headwear and beard masks. It found Cornrows and Undercut
   **pixel-identical**, and Shaved, Crop and Widow Peak each within 7px of a
   neighbour — three names for one haircut is not variety, it is a bigger
   atlas. Hair is 21 styles that differ rather than 24 that mostly do not.
4. **Web field coverage**: the generated browser data must carry every
   authored field. Hand-listing three keys silently dropped the mouths' width
   field and the browser divided by an empty set on its first render.

## The three implementations, and which is which (P5)

Art existed in three places and had already drifted. It is now one
implementation with one generated copy per runtime:

| where | what it is | kept honest by |
|---|---|---|
| `packages/art/src/render.js` | the REFERENCE. Every change starts here. | the palette + weight gates |
| `contracts/src/art/*` | the chain. Reads the same SSTORE2 bytes. | `RendererParity.t.sol` + `KitParity.t.sol` assert byte-identity over 64 fixtures; `ArtLibrary.t.sol` replays every rect of every class |
| `apps/web/public/js/avatar.js` | the browser. **Generated**, never hand-edited — it inlines its own keccak because apps/web has no bundler. | `apps/web/test/parity.test.ts` compares its bytes to the reference AND to the hashes the Solidity test uses |

The hand-maintained port that used to live in the browser had invented a
goalkeeper kit the chain never had, and masked `appearance` to 24 bits so no
accessory could ever appear — while onboarding told users they were seeing
"the exact art the chain mints". Generating it is what makes that claim true.

**A fourth renderer exists and is deliberately untouched**: the golden
reference `index.html` draws its own 16x16 in-match player sprites. That file
is byte-frozen — the characterization goldens hash its source — and those
sprites serve a different purpose (a player at match scale, seen in motion,
not a portrait). It is out of scope by design, not by oversight.

## Regenerating

    node packages/art/tools/gen-art.mjs

writes the SSTORE2 blobs, the Solidity constants, the parity fixtures and the
browser module; `tools/atlas-doc.mjs` writes the budget document. CI
regenerates BOTH and diffs all four artefact sets, so a stale one fails the
build.

The install list is generated too (`FobalArtConstants.classNames()`). It used
to be hand-written in five places, and when the atlas grew to thirteen classes
the deploy script still installed eight — the missing five degrading silently
to nothing on chain rather than failing. Deploy scripts and tests MUST iterate
`classNames()`, never restate it.
