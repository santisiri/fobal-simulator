# @fobal/art — on-chain player art v2 ("Anchored Atlas"), phase P0

**P0 is art direction with zero Solidity.** Nothing here touches a contract;
the deliverable is a spec plus the gates that decide whether the art is good
enough to be worth writing Solidity for.

    npm run sheets      # regenerate out/*.html (the gates)
    npm run palettes    # re-solve the palettes and print the separation report

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
3. **Budget follows perception.** Head shapes are the worst variety-per-byte
   in the system, so there are six, purely geometric. Hair (24, heading to
   32) and headwear (10, heading to 14) get the budget because silhouette is
   what survives downscaling.
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

Machine gates, both green: palette separation (dE76 — ramps on adjacent
steps, categorical sets on all pairs) and the 6:1 silhouette weight ratio.

## The three implementations, and which is which (P5)

Art existed in three places and had already drifted. It is now one
implementation with one generated copy per runtime:

| where | what it is | kept honest by |
|---|---|---|
| `packages/art/src/render.js` | the REFERENCE. Every change starts here. | the palette + weight gates |
| `contracts/src/art/*` | the chain. Reads the same SSTORE2 bytes. | `RendererV2Parity.t.sol` + `KitParity.t.sol` assert byte-identity over 64 fixtures |
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
browser module. CI regenerates and diffs, so a stale artefact fails the build.
