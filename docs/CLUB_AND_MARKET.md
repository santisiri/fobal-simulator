# The Club and the Market — workstreams H and I

> **Superseded surfaces (workstream J, 2026-09):** the standalone pages this
> document mentions (lobby.html, squad.html, market.html, …) were absorbed
> into the unified app — one shell at `/app.html` with routes `/`, `/squad`,
> `/market`, `/lobby`, `/play`. The CONTRACTS here (endpoints, state shapes,
> safety rules) remain the reference; for where each surface lives now, see
> `docs/UNIFIED_APP.md`.


Two features turn FOBAL from "a match you can join" into a game you
inhabit: a **squad + tactics room** where you shape the team that walks
out, and a **marketplace** where players have prices and owning them
means something. This is the charter for both — the shared contracts,
the on/off-chain split, and the honest scope of what today's deployed
contracts can actually do.

## The structural change that comes first

Everything currently lives inside `lobby.html`, and the URLs are file
names. Both stop here. The app becomes one destination with clean routes:

```
/            the club — your crest, squad strip, record, next match
/squad       the squad + tactics room        (workstream H)
/market      the marketplace                 (workstream I)
/play        find an opponent (today's lobby)
/match       the live match
```

Mechanically this is a CloudFront Function rewriting `/squad` →
`/squad.html` (≈10 lines, deployed the same imperative way as the
distribution itself) — no bundler, no framework, the static build
survives. It also gives the market real deep links (`/market/player/42`)
and finally kills the **identity schism**: one app, one session, the
server account canonical, the club a view of it.

## Workstream H — the Club (squad + tactics)

### The missing domain object

There is no persisted team sheet. `SquadCustomization` holds colours and
names; `formation` is hardcoded when the manifest is built; `buildTeam`
takes the first eleven in roster order. **The eleven you would choose and
the tactics you would set do not exist anywhere.**

New shared contract, in `packages/protocol` beside the rest:

```
TeamSheet = {
  version: 1,
  lineup:      PlayerId[11],        // slot order; slot 0 is the GK
  bench:       PlayerId[],          // up to 5
  tactics:     TacticalState,       // the 21 fields the engine ALREADY honors
  instructions?: { playerId, instruction }[],   // the G intents that bind
}
```

Two rules make this worth doing:

1. **`tactics` is `TacticalState` itself** — not a parallel model. The
   editor's sliders are the engine's own fields, so what you set is
   exactly what the simulation runs, and a tactic set in the room and one
   spoken mid-match ("press high") are the *same object*. This is the
   payoff of workstream G's compile table.
2. **Validated on write.** A team sheet is rejected if the lineup is not
   eleven owned players, has no keeper, or duplicates a shirt — the same
   "the protocol schema is the gate" discipline as `POST /squad`.

Then `buildTeam`/`buildManifest` consume it: the eleven you picked are
the eleven that walk out, wearing your tactics from the first whistle.

### The room itself

Browse your players as a squad list *and* on the pitch: full 13 ratings,
career record and level read from chain (`NormalizedPlayer` already
exists), the on-chain avatar, market value if listed. Assign the lineup
by slot, set the tactics, attach per-player instructions from the G
taxonomy — and see the squad's aggregate change as you do.

## Workstream I — the Market

### What the deployed contract actually does

`FobalMarketplace` (`0x35f0CF84…`, live on Base Sepolia) supports
**fixed-price listings only**:

| capability | status |
|---|---|
| `list(tokenId, asset, price, expiry)` — ETH or ERC-20 | ✅ deployed |
| `cancel(tokenId)` | ✅ deployed |
| `buy(tokenId)` — atomic, fee in bps to treasury | ✅ deployed |
| lock-aware (a player in escrow cannot be sold) | ✅ deployed |
| `PlayerListed` / `ListingCancelled` / `PlayerSold` events | ✅ **the price history** |
| offers / bids / auctions / **swaps** | ❌ **new contracts required** |

So v1 ships listing, cancelling, buying, and value-over-time **with no
contract work at all**. Swaps and offers are a later slice with their own
audit surface — worth naming as a separate decision rather than implying
the market already does it.

### Reads: an indexer, not a database

Value over time comes from replaying `PlayerSold` logs. The lobby already
owns chain access (`chain.ts`), so the indexer lives there: tail the three
events, keep an in-memory view (browse, filter, sort, per-player history),
mirror it to S3 like every other lobby document. **Rebuildable from the
chain at any time** — which is the property that matters.

### Writes: the wallet signs, never the server

Listing, cancelling and buying reuse the mint flow's proven shape: the
server prepares the transaction, **the player's own wallet sends it**, the
receipt drives the UI. No custody, no server-held keys, no approval the
player did not see. Reuse the existing transaction-lifecycle UX
(pending → confirming → done → error) rather than inventing a second one.

## On-chain vs off-chain — the decisions

The instinct is "as on-chain as possible", and that is right for
everything economic. It is *wrong* for one thing, for a gameplay reason:

**On-chain** — ownership, identity, progression/career, listings, sales,
prices, fees, and economically meaningful results. All of this exists.

**Off-chain** — the team sheet. Not because of cost, but because
**tactics are secret information**. A public ledger is the worst possible
place for a battle plan: if your opponent can read your eleven and your
pressing line before kickoff, competitive play is dead.

**The on-chain-maximalist answer that preserves the game**: commit–reveal.
Publish `keccak256(teamSheet ‖ salt)` before kickoff, reveal the sheet
after full time. One hash on chain, tactics stay hidden while they
matter, and the match becomes provably played with the sheet you
committed. That is *more* verifiable than storing tactics publicly, and
it is the right shape for ranked or staked play. Not needed for v1 —
worth building the sheet so the hash is trivial to add later.

## Does this need a database?

**No — not yet, and probably never for tactics.**

- A team sheet is a ~1KB document keyed by account. The existing
  `LobbyStore` pattern (JSON + S3 write-through, hydrate on boot) already
  carries accounts, invitations and match records. Tactics are the same
  shape. Adding a database buys nothing today.
- The marketplace index is the only query-shaped thing here, and its
  first version is an event replay held in memory.
- **The trigger for DynamoDB** (already the documented deferred choice):
  listings or sale history outgrow a single-task in-memory view, or
  multiple tasks need shared state. Revisit then, single-table, with the
  chain still the source of truth.

Standing rule either way: **any store is a cache. The chain is the truth
for anything economic; the index must be rebuildable by replaying
events.**

## Sequence

1. **H1 — `TeamSheet` contract + persistence + manifest wiring.** No UI.
   The eleven you pick are the eleven that play. (Unblocks everything.)
2. **H2 — the squad room.** Browse, inspect, assign, set tactics.
3. **I1 — market reads.** Indexer + browse + player price history.
4. **I2 — market writes.** List, cancel, buy through the player's wallet.
5. **Routes + the identity merge** — can land alongside H2.

Deliberately deferred, and named so nobody assumes otherwise: offers,
bids, auctions, swaps, commit–reveal, cross-account trade negotiation.
