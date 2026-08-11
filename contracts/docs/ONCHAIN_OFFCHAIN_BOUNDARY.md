# Fobal — On-chain / Off-chain Data Boundary

The rule: **the game never depends on the database to determine who owns a
player or what their canonical state is.** The chain is authoritative for
ownership and consequential state; the database is authoritative for
high-volume derived and telemetry data, always keyed to an on-chain
commitment.

## ON-CHAIN CANONICAL
The blockchain is the source of truth. If the database and chain disagree,
the chain wins.

| Field | Where |
|---|---|
| tokenId, owner | FobalPlayer (ERC-721) |
| DNA (immutable) | `FobalPlayer.dnaOf` |
| appearance (immutable, packed) | `FobalPlayer.appearanceOf` |
| name (immutable) | `FobalPlayer.nameOf` |
| skills (0–100, packed) | `FobalPlayer.skillsOf` |
| generation, position, country, XP, level | `FobalPlayer.coreOf` |
| cumulative career stats | `FobalPlayer.statsOf` |
| active match lock | `FobalPlayer.lockedBy` |
| team identity (id, owner, dna, name) | FobalTeamRegistry |
| match state, mode, teams, scores | `FobalMatchEscrow.matches` |
| stake asset + amount, ledger balances | FobalMatchEscrow / FundsLedger |
| the canonical result digest that settled a match | `MatchData.resultDigest` |
| replayHash / statsRoot / progressionHash commitments | settlement events |
| listings (token, asset, price, expiry) | FobalMarketplace |
| asset allowlist + stake bounds | FobalAssetRegistry |
| tokenURI + on-chain SVG | FobalAvatarRenderer (derived, deterministic) |

## OFF-CHAIN INDEXED
Reconstructed by decoding events. Fast to query, cheap to rebuild, never
authoritative — a full re-index from genesis reproduces it exactly.

- decoded event log (PlayerMinted, PlayerProgressed, MatchSettled, PlayerSold…)
- owner → portfolio mappings
- searchable current rosters (from `RosterUpdated`)
- match history caches and per-account W/D/L
- leaderboards, rankings, market activity feeds
- current-roster view (declared, not custodied on-chain)

## OFF-CHAIN GAME DATA
Lives only in Fobal's systems, referenced by an on-chain commitment. The chain
stores the *hash*; the database stores the *blob* and proves it matches.

- every touch, pass, coordinate, frame of the simulation
- tactical decisions and agent reasoning
- replay video / animation state / 3D models
- commentary, telemetry, derived analytics
- richer avatar renders beyond the canonical on-chain SVG

The link: `MatchResult.replayHash` and `statsRoot` are signed and stored
on-chain at settlement. The database associates its detailed record with that
commitment; anyone can verify the off-chain blob hashes to the on-chain value.
`progressionHash` similarly binds the exact per-player progression the engine
signed to what the contract applied.

## Boundary invariant
If Fobal's entire database and servers vanished:
- every player still exists, owned, with full DNA/appearance/skills/XP/career;
- every player still renders a complete avatar + metadata from `tokenURI`;
- every stake still settles or refunds by its on-chain rules;
- every listing still executes or expires on-chain.
What would be lost: replays, telemetry, search, leaderboards, and rich art —
all reconstructible or re-derivable, none of it consequential to ownership.
