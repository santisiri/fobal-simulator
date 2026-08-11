# Fobal Protocol v1 — Architecture

Gameplay off-chain, ownership and consequential state on-chain. The chain is
canonical for: player ownership, current attributes, cumulative progression,
team identity, match commitments, stakes, settlement, marketplace trades, and
cryptographic commitments to authoritative results. Everything else (telemetry,
replays, search, leaderboards) lives in the indexer/database, keyed to on-chain
commitments (`replayHash`, `statsRoot`, `progressionHash`).

This mirrors the off-chain engine's own constitution: *the engine decides what
happened; the protocol decides what is allowed.* The same determinism boundary
that governs the Fobal simulator (manifest + command log, signed results,
Ed25519 result signatures server-side) extends here as EIP-712 attestations
verified on-chain.

## Contract map

```
                        ┌────────────────────┐
   GENERATOR_SIGNER ───▶│ FobalPlayerGenerator│──mint──▶┌──────────────┐
   (EIP-712 squads)     └────────────────────┘         │  FobalPlayer  │◀─ tokenURI ── FobalAvatarRenderer
                                                       │   (ERC-721)   │
                        ┌────────────────────┐ progress└──────┬───────┘
   ENGINE_SIGNER ──────▶│  FobalMatchEscrow  │──apply──▶┌─────┴────────┐
   (EIP-712 results)    │  (stakes + locks)  │          │FobalProgression│
                        └─────────┬──────────┘          └──────────────┘
                                  │ asset config
                        ┌─────────┴──────────┐          ┌──────────────┐
                        │ FobalAssetRegistry │◀────────▶│FobalMarketplace│
                        └────────────────────┘          └──────────────┘
                                  ▲
                        ┌─────────┴──────────┐
                        │ FobalTeamRegistry  │  (identity + events; no custody)
                        └────────────────────┘
```

## Contracts and responsibilities

### FobalPlayer (ERC-721) — the conservative core
The smallest, most conservative contract: ownership, canonical player state,
and hard protocol invariants. **No proxy upgradeability** — persistence of the
collection is the product; renderers and modules version around it.

Storage per token (tightly packed):
- `PlayerCore` — one slot: `generation u32 | xp u32 | level u16 | country u16 |
  position u8 | skillSchema u8` (14 bytes spare for future schema use).
- `dna bytes32` — immutable, set at mint, never rewritable by anyone.
- `skills uint256` — schema 1 packs 12 skills × 8 bits (0–100 each);
  indices 0..11 = pace, finishing, passing, dribbling, defending, physical,
  stamina, vision, technique, aggression, composure, goalkeeping.
- `appearance uint256` — immutable packed visual traits (bg, skin, hair color,
  hair style, face, eyes, accessory, shirt palette; low 32 bits used, rest
  reserved).
- `CareerStats` — one slot: 7 × u32 monotonic counters.
- `name string` — short, set at mint.

Privileged surfaces (all role-gated, all narrow):
- `mint` — MINTER_ROLE (held by FobalPlayerGenerator only). Validates schema
  bounds (skills ≤ 100, position ≤ FW, name 1–32 chars).
- `applyProgression` — PROGRESSION_ROLE (held by FobalProgression only).
  Enforces the *last-line* invariants regardless of caller policy: skills
  capped at 100, non-negative deltas only, XP and career counters monotonic,
  DNA/appearance/name untouchable, level derived from XP. Emits
  `PlayerProgressed` + ERC-4906 `MetadataUpdate`.
- `lock/unlock` — LOCK_ROLE (held by FobalMatchEscrow only). A locked player
  cannot transfer (enforced in `_update`). Locks carry the locker's identity;
  only the locker can unlock; escrow guarantees a release path for every lock.
- `setRenderer` — DEFAULT_ADMIN. Swapping renderers can never alter
  DNA/appearance; emits `BatchMetadataUpdate`.

### FobalAvatarRenderer — deterministic on-chain identity
Pure/view. Builds a full `data:application/json;base64` tokenURI: name,
description, generation, position, country, level, XP, skills, career stats,
DNA, renderer version, attributes array, and an inline `data:image/svg+xml`
pixel avatar derived **only** from `appearance` + `dna` + position. Same
inputs ⇒ same bytes, forever, no server. Richer art can live off-chain; the
canonical representation cannot be taken away.

### FobalPlayerGenerator — the only mint path
EIP-712 gateway (`SquadMint(recipient, teamId, generation, nonce, deadline,
playersHash)`) signed by GENERATOR_SIGNER (EOA or ERC-1271 contract via
OpenZeppelin `SignatureChecker`). The contract recomputes `playersHash` from
the submitted seeds, checks sequential per-recipient nonces + deadline +
domain (chain, contract), enforces squad size 1–23 and a configurable **power
budget** (total skill points ≤ perPlayerBudget × squadSize) so a compromised
generator cannot mint twelve 100-everything players, then mints. Signer is
replaceable/revocable by SIGNER_ADMIN without touching the NFT collection.

### FobalTeamRegistry — identity, not custody
`createTeam(name, teamDna)` → sequential teamId, owner, timestamps.
Roster membership is **logical**: assignment events (`RosterUpdated`) are the
canonical history; the current-roster view is an indexer concern. Players are
never custodied; selling a player breaks nothing historical. Lineups for
matches are validated at escrow time against live ERC-721 ownership — the only
check that actually secures anything.

### FobalAssetRegistry — money is config
`address(0)` = native ETH; any governance-approved ERC-20 otherwise. Per-asset
`AssetConfig{enabled, minStake, maxStake, progressionMultiplierBps}`. A future
SAIRI token is one `setAsset` call. Exotic tokens (fee-on-transfer, rebasing,
hooks) are **rejected by construction**: escrow and marketplace verify exact
balance deltas on pull, so any token that doesn't move face value reverts.

### FobalMatchEscrow — stakes, locks, and the one settlement
State machine per `matchId` (bytes32, derived from chain + contract + counter):

```
OPEN ──join──▶ LOCKED ──settle(signed result)──▶ SETTLED
  │                │
  └──cancel────────┴──cancel after resultDeadline──▶ CANCELLED
```

- Create: mode (PROGRESSION | PRIZE), asset + stake (registry-validated),
  rulesHash, optional designated opponent, joinDeadline, lineup ownership
  verified and players locked.
- Join: symmetric stake, players locked, `resultDeadline` armed.
- Settle: EIP-712 `MatchResult(matchId, resultNonce, teamA, teamB, scoreA,
  scoreB, replayHash, statsRoot, progressionHash, deadline)` signed by
  ENGINE_SIGNER. The submitted progression array must hash to
  `progressionHash` — one signature covers result *and* progression, applied
  atomically (see GAS.md for why atomic beats Merkle at Base costs). Status
  flips to SETTLED before any external effect; a match settles exactly once.
- Funds: **pull-payments ledger**. PROGRESSION mode credits the pot to the
  treasury; PRIZE mode credits winner (pot − feeBps) and treasury (fee), draws
  refund both sides. Nobody's receive() can brick settlement; `withdraw`
  is the only outbound transfer.
- Every lock has a release path: settle, cancel while OPEN, or cancel by
  either participant after `resultDeadline` (engine no-show). No permanently
  stuck player, no stranded stake.

### FobalProgression — engine discretion vs protocol policy
Only callable by the escrow (per settled match), consumed-once per
`(matchId, playerId)`. Policy caps live here, versioned and admin-tunable
within hard bounds: max XP per match, max delta per skill per match, max total
skill points per match, plausibility caps on per-match counters. The player
contract then enforces its own invariants again — two independent layers
between the engine signer and player state.

### FobalMarketplace — simple, atomic, honest
Stored fixed-price listings (one active per token): seller, asset, price,
expiry. Buy is atomic checks-effects-interactions: listing validity (seller
still owner, marketplace still approved, player not match-locked, not
expired, asset still enabled), exact payment (ETH value or ERC-20 balance
delta), fee (bps, hard-capped at 10%) and seller proceeds credited to the
pull ledger, NFT transferred. Interfaces are shaped so a later v2 can move to
signed EIP-712 orders without changing the Player contract.

## Access control

Per-contract OpenZeppelin `AccessControl` (5.x). Chosen over a central
`AccessManager` because six small contracts with two or three roles each are
easier to audit than one indirection layer; the permissions table in
SECURITY.md is the single source of truth. `DEFAULT_ADMIN_ROLE` is only a
role-admin and configuration authority, intended for a multisig. The engine
and generator signers are *data* (addresses checked in signature paths), not
role holders — they can sign game facts and nothing else: no seizure, no
treasury, no fees, no config, no self-promotion.

## Signatures

EIP-712 everywhere, one domain per verifying contract (name, version "1",
chainId, verifyingContract) — cross-chain and cross-contract replay are
structurally impossible. `SignatureChecker` supports EOA and ERC-1271 signers
(multisig-ready). Replay protection: sequential nonces (generation), one-shot
state machine + per-match resultNonce + deadline (settlement). No on-chain
randomness anywhere; DNA arrives in signed payloads from the generator.

## Explicit non-goals in v1
- No proxy upgrades on FobalPlayer (persistence over convenience).
- No on-chain simulation of any kind.
- No Merkle progression claims (atomic settlement is cheap on Base; the
  signed `progressionHash` slot keeps the door open — see GAS.md).
- No exotic ERC-20 support (rejected via balance-delta checks).
- No ERC-2981 royalties (marketplace fee only; external markets unforced).
- No signed-order marketplace (interface-compatible v2 path documented).
