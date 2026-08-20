# Player NFT data model

> **Updated for art v2.** The storage model below is unchanged — v2 did not
> touch `FobalPlayer`, which is not upgradeable and did not need to be. What
> changed is who draws the picture and where the jersey comes from. See
> `packages/art/README.md` for the art pipeline and
> `docs/ART_ROLLOUT.md` for the deployment sequence.
>
> - **Identity** is still exactly `(dna, appearance, name)`, immutable at mint.
> - **The jersey is NOT token state.** It comes from `FobalSquadRegistry`
>   (which club a player is at) and `FobalKitRegistry` (that club's colours).
>   Presentation only: outside the deterministic match state hash, outside
>   the signed `MatchResult`, irrelevant to settlement.
> - **A transfer changes the jersey, not the face** — and a sale changes
>   neither, because club membership is explicit state rather than a side
>   effect of ownership.
> - `tokenURI` remains 100% on-chain, now served through
>   `FobalRendererRouter` so a bad renderer can never take metadata down.

The canonical description of what a Fobal player IS, where each field
lives, how names are generated, and how a frontend reads a complete
player profile. Outcome of the player-data workstream audit: **the chain
architecture already carried names, stats, and fully on-chain metadata —
no contract changes were needed or made.** The work landed in the
generation and read layers.

## Storage model — one field, one home

| Field | Canonical home | Mutability |
|---|---|---|
| name | `PlayerSeed.name` → `FobalPlayer` storage (1–32 UTF-8 bytes, validated + control-chars rejected at mint) | **immutable forever** |
| dna, appearance | `FobalPlayer` storage | immutable |
| skills (12 × 8-bit lanes) | `FobalPlayer` storage | progression-capped writes only |
| position, country, generation, skillSchema | `PlayerCore` (1 slot) | immutable |
| xp, level | `PlayerCore` | progression only |
| career (matches/W/D/L/goals/assists/clean sheets) | `CareerStats` (1 slot) | progression only |
| owner, lockedBy | ERC-721 + escrow lock | transfer/lock flow |
| avatar | **generated on-chain** by `FobalAvatarRenderer` (24×24 SVG data-URI) | renderer swappable by admin, art deterministic from dna/appearance |

Nothing player-canonical lives in a frontend database. The lobby's
generated (pre-mint) squads are deterministic functions of the account —
recomputed, never stored.

## Naming — `apps/lobby-server/src/playerNames.ts`

Every generated player gets a plausible footballer name ("Mateo
Ferreyra", "Luca Moretti") from a **pure, deterministic** generator:

- **Algorithm**: FNV-1a hash of a string key → xorshift32 → pick a region
  (7 football cultures) → pick first + surname from that region's curated
  pools. Same key, same name, forever.
- **Keying**: generated squads use `teamKey:index`, so an account grows
  the same players on every device (the second-device invariant).
- **Squad uniqueness**: `squadNames(key, n)` retries colliding SURNAMES
  with a deterministic salt walk — a squad never fields two Morettis.
  (~700 surname pool; 16 draws.)
- **Tone constraints, enforced structurally**: First + Surname from
  curated pools (no comedy, no web3-isms); no pool pair reproduces a
  famous real footballer (shared surnames alone are normal football);
  ≤24 chars / ≤32 UTF-8 bytes (fits the custom-name UI, the protocol's
  48, and the contract's 32); passes the `names.ts` moderation gate.
- **Flow to the chain**: the in-app mint reads `/squad` and puts those
  exact names into `PlayerSeed.name` — so the generated name IS the
  on-chain name, with zero extra plumbing. Player-customized names
  (2–24 chars, moderated) override generated ones pre-mint and get
  minted instead — your renamed striker is renamed forever.

## NFT metadata (Feature 3 — preserved, already complete)

`tokenURI` is a fully on-chain `data:application/json;base64` document:
`name` (escaped), `description`, on-chain SVG `image`, and an
`attributes` array carrying Position, Level, XP, Country, Generation, all
12 skills, and the full career block. Any marketplace or third-party
client reads a complete football profile with zero off-chain
dependencies. **Do not move any of this off-chain.**

## Read API (Feature 4)

Two equivalent doors, both one call per player:

1. **Contract**: `playerView(tokenId)` — the aggregate view struct
   (core, stats, dna, skills, appearance, name, owner, lockedBy). One
   `eth_call`; no multicall needed.
2. **Lobby**: `GET /players/:tokenId` — public (chain state is public),
   session-free, normalized for game clients:

```json
{ "player": {
  "tokenId": "7", "name": "Mateo Ferreyra",
  "owner": "0x…", "lockedBy": null,
  "position": 3, "role": "ST",
  "generation": 1, "level": 3, "xp": 640,
  "career": { "matchesPlayed": 9, "wins": 5, "draws": 2, "losses": 2,
              "goals": 7, "assists": 3, "cleanSheets": 0 },
  "ratings": { "pace": 90, "accel": 90, "shooting": 80, "…": "…" },
  "overall": 61
} }
```

- `ratings` speaks the game's 13-rating schema via the documented D1
  lane mapping (accel rides pace, positioning rides technique) — the
  SIMULATION remains the source of truth for which stats matter; no new
  attributes were invented (no preferred foot, no age: not in the
  schema, so not in the API).
- `overall` is a presentation aggregate: mean of the 12 on-chain lanes —
  the same quantity the generator's power budget bounds.
- Squad association is contextual by design (the registry stores rosters
  as events; a per-player reverse lookup would be a log scan) — clients
  that have a team context already have the roster.
- Errors: 404 unknown token, 501 chain reads unconfigured, 502 RPC down.

## Backwards compatibility (Feature 5)

Names are immutable, so **existing tokens keep the names they were minted
with** — the runbook squad's "Player 1…11" and early staging mints with
handle-style names remain valid, just plain. They render, play, and trade
exactly as before. No redeployment: the contracts did not change, so
there is nothing to migrate. New mints simply inherit better defaults the
moment the lobby ships. (If a fresh testnet world is ever wanted for
cosmetic uniformity, the Base Sepolia runbook re-runs end to end — but
nothing here requires it.)

Accounts that saved custom names keyed by playerId keep them verbatim
(the override layer is untouched); accounts relying on generated defaults
see their squads gain real names — a cosmetic change with no gameplay or
determinism impact (manifests freeze at match creation).

## Deployment implications

Server + client only: lobby redeploy (same contexts) picks up generated
names and `GET /players/:tokenId`; no contract deploy, no ABI change, no
secret changes. Frontends: consume `/players/:tokenId` for profiles, or
call `playerView` directly with the existing ABI.
