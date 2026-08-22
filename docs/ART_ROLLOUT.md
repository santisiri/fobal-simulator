# Art v2 rollout runbook

Putting the new renderer in front of the live Base Sepolia collection, in
steps that are each individually revertible. Nothing here is irreversible
except where it says so.

**Current live state** (see `docs/ONCHAIN_DEPLOYMENTS.md`): `FobalPlayer`
`0x52F5828d…`, renderer `0xB103DCe9…` (v1), 11 tokens, admin
`0x26250e47…`. That renderer address is the rollback target for every step
below.

## What you are deploying

| contract | role |
|---|---|
| `FobalRendererRouter` | the safety valve — `tokenURI` becomes total |
| `FobalArtLibrary` + 13 SSTORE2 blobs | the art atlas, 1,797 bytes total — see [ART_ATLAS_V2.md](ART_ATLAS_V2.md) |
| `FobalTraitEngine` / `FobalAnchors` / `FobalFaceComposer` / `FobalKitComposer` | pure rendering |
| `FobalSquadRegistry` / `FobalKitRegistry` | which club, and its colours |
| `FobalRendererV2_1` | the renderer that ties them together |
| `TimelockController` (48h) | holds routing + art-admin rights |

## Order, and why

Each phase is a separate transaction set with its own rollback. Do not batch
them: the point of the sequence is that a mistake is visible before the next
step depends on it.

### 1 — Install the router as a proven no-op

Full procedure in `docs/ROUTER_INSTALL.md`. Prove parity on a fork first:

```bash
cd contracts && forge test --match-contract RouterParityFork --fork-url https://sepolia.base.org -vv
```

Then deploy and install. **Output does not change by a byte.** Verify by
diffing `tokenURI(1)` before and after.

Rollback: `setRenderer(0xB103DCe9f0A45c0FDE4d34AdB53836e9c43aB5dF)`.

### 2 — Deploy the art atlas (inert)

```bash
FOBAL_ART_ADMIN=<timelock> forge script script/DeployArtLibrary.s.sol \
  --rpc-url base_sepolia --account fobal-admin --broadcast --verify
```

The script installs every class in `FobalArtConstants.classNames()` — the
GENERATED list — and verifies each blob by read-back before reporting success.
Confirm the log shows **13 classes**: the list used to be hand-written, and a
short list does not fail, it deploys an atlas with silently missing classes
that the composer's try/catch degrades to nothing.

**Do not `seal()` yet** — sealing is permanent, and it should follow visual
inspection of real rendered output, not precede it.

Rollback: nothing points at it; abandon the addresses.

### 3 — Deploy the renderer stack (inert)

```bash
FOBAL_PLAYER=0x52F5828dA509D6043c2619F048687BEdfA4789d4 \
FOBAL_TEAM_REGISTRY=0x22d6518ee6f80d9D772f56D52b0EA9E08A9aad90 \
FOBAL_ART_LIBRARY=<from step 2> \
forge script script/DeployKits.s.sol --rpc-url base_sepolia \
  --account fobal-admin --broadcast --verify
```

Now inspect the output **before** any token points at it — the renderer reads
the live collection, so it is fully functional standalone:

```bash
cast call <RENDERER_V2_1> "imageOf(uint256,bytes32,uint256,uint8)(string)" \
  1 $(cast call $PLAYER "dnaOf(uint256)(bytes32)" 1 --rpc-url https://sepolia.base.org) \
  $(cast call $PLAYER "appearanceOf(uint256)(uint256)" 1 --rpc-url https://sepolia.base.org) \
  2 --rpc-url https://sepolia.base.org
```

Save the SVG and look at it. This is the last completely free checkpoint.

### 4 — Canary: ONE token

```bash
cast send <ROUTER> "pin(uint256,address)" 1 <RENDERER_V2_1> \
  --account fobal-admin --rpc-url https://sepolia.base.org
```

Token 1 renders v2; tokens 2–11 are untouched. Check it on
sepolia.basescan.org and in any marketplace that indexes the collection.
Leave it for as long as you like — there is no pressure to widen.

Rollback: `pin(1, 0x0)`.

### 5 — Cohort: the rest

```bash
cast send <ROUTER> "setCohort(uint256,uint256,address)" 1 11 <RENDERER_V2_1> \
  --account fobal-admin --rpc-url https://sepolia.base.org
```

Rollback: `clearCohorts()`.

### 6 — Default, and refresh

```bash
cast send <ROUTER> "setDefaultRenderer(address)" <RENDERER_V2_1> --account fobal-admin --rpc-url https://sepolia.base.org
cast send $PLAYER "setRenderer(address)" <ROUTER> --account fobal-admin --rpc-url https://sepolia.base.org
```

The second call re-installs the address that is **already** installed. It
changes no state, and exists only to re-emit `BatchMetadataUpdate(1, 11)` so
marketplaces re-pull. `setRenderer` has no same-address guard — this is a
supported way to issue a refresh.

### 7 — Hand routing to the timelock

Deploy a 48h `TimelockController`, grant it `ROUTER_ADMIN_ROLE` and
`ART_ADMIN_ROLE`, then renounce your own. From then on every art change is
announced 48 hours ahead and can be cancelled while it waits
(`contracts/test/unit/Governance.t.sol` proves the wiring).

**`FobalPlayer`'s own `DEFAULT_ADMIN_ROLE` stays on your key, deliberately.**
Moving it is irreversible, and keeping it separate guarantees the timelock
can never lock you out of the one-transaction rollback in step 1.

### 8 — Seal the art (IRREVERSIBLE)

Only after the collection has rendered correctly for a while:

```bash
cast send <ART_LIBRARY> "seal(bytes32)" $(cast format-bytes32-string HAIR) ...
```

Sealing makes a class permanently unrepointable — art becomes as immutable as
bytecode. There is no unseal. Do this when you are certain, not before.

## Clubs and kits (permissionless, any time)

No coordination and no flag day. Until a club configures a kit it wears one
derived from its own `teamDna`; until a player joins a club they wear a
free-agent kit. Nothing is ever blank.

```bash
# a club owner sets their colours (home slot, striped)
cast send <KIT_REGISTRY> "setKit(uint64,uint8,uint24,uint24,uint24,uint8)" \
  <teamId> 0 0x2f6fd0 0xf2f4f8 0xf2f4f8 2 --account <club-owner>

# a player's OWNER puts them in that club
cast send <SQUAD_REGISTRY> "join(uint256,uint64)" <tokenId> <teamId> --account <nft-owner>
```

## If something looks wrong

The router makes every failure recoverable and none of them urgent:

| symptom | action |
|---|---|
| one token renders badly | `pin(<id>, <old renderer>)` |
| the whole collection looks wrong | `clearCohorts()` + `setDefaultRenderer(<v1>)` |
| the router itself is suspect | `setRenderer(0xB103DCe9…)` on FobalPlayer |
| metadata is blank in a marketplace | re-issue `setRenderer(<router>)` to re-emit the refresh |

`tokenURI` cannot revert: a failing renderer degrades to the fallback, and a
failing fallback degrades to an inline identity card.
