# Fobal Protocol (contracts)

On-chain ownership and consequential state for **Fobal** — an agent-native
Web3 football game. Players are persistent ERC-721 footballers with fully
on-chain identity, appearance, skills and career; matches are simulated
off-chain by the Fobal engine, which signs authoritative results the chain
verifies. **Gameplay off-chain, ownership and consequential state on-chain.**

Optimized for **Base**, portable to any EVM chain. Solidity 0.8.28, Foundry,
OpenZeppelin 5.x. Base Sepolia first; **not deployed to mainnet**.

## Contracts

| Contract | Responsibility |
|---|---|
| `FobalPlayer` | Canonical ERC-721. Ownership + immutable identity (DNA/appearance/name) + bounded, evolving skills/XP/career. The smallest, most conservative contract; no upgradeability. |
| `FobalAvatarRenderer` | Deterministic on-chain `tokenURI`: JSON metadata + generative pixel SVG from immutable traits. Versioned, swappable; never alters identity. |
| `FobalPlayerGenerator` | The only mint path. EIP-712 signed squad generation, per-recipient nonces, per-player power budget. |
| `FobalTeamRegistry` | Logical team identity + roster events. Never custodies player NFTs. |
| `FobalAssetRegistry` | Governance allowlist of payment assets (ETH + approved ERC-20s, e.g. a future SAIRI) with per-asset stake bounds. |
| `FobalMatchEscrow` | Stakes, player locks, EIP-712 result verification, one-time settlement, pull-payment funds ledger. PROGRESSION + PRIZE modes. |
| `FobalProgression` | Policy-capped, consume-once progression driven only by settled results. |
| `FobalMarketplace` | Fixed-price player sales in ETH / approved ERC-20s. Atomic, lock-aware, pull-payment. |

Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
Trust boundary: [`docs/TRUST_MODEL.md`](docs/TRUST_MODEL.md) ·
Permissions: [`docs/SECURITY.md`](docs/SECURITY.md) ·
Data split: [`docs/ONCHAIN_OFFCHAIN_BOUNDARY.md`](docs/ONCHAIN_OFFCHAIN_BOUNDARY.md) ·
Gas: [`docs/GAS.md`](docs/GAS.md) ·
Deploy: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

## Quickstart

Dependencies are pinned but not vendored (`lib/` is gitignored). Install them
once with the exact versions this repo was built against:

```bash
cd contracts
forge install --no-git foundry-rs/forge-std@v1.16.2
forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.4.0

forge build
forge test              # 87 tests: unit + fuzz + invariant
forge test -vvv         # with traces
forge coverage          # coverage report
forge fmt --check       # formatting
slither . --filter-paths "lib|test|script|mocks"   # static analysis

# full lifecycle on a local node:
anvil                                                   # terminal 1
forge script script/DemoLifecycle.s.sol \
  --rpc-url http://localhost:8545 --broadcast           # terminal 2
```

## The vertical slice (Definition of Done)

`test/VerticalSlice.t.sol` proves the whole economy end to end, and
`script/DemoLifecycle.s.sol` runs the same flow against a live Anvil node:

> Alice generates Fobal FC (11 unique on-chain players, each with DNA,
> appearance, position, skills and a fully on-chain SVG/metadata). She creates
> a match vs Bob; both stake ETH; their players lock. The off-chain engine
> produces a result and signs it; the contract verifies it and settles exactly
> once. Players gain XP and skills, their metadata changes, their career stats
> persist. Players unlock. Alice lists an evolved player; Bob buys it; the NFT
> moves to Bob and the player's DNA, avatar, abilities, XP and career survive
> the transfer unchanged.

## Test coverage

- **Unit** (`test/unit/`): player, generator, escrow, progression,
  marketplace, access control — including every invariant the brief enumerates.
- **Fuzz** (`test/fuzz/`): skill packing round-trips, progression caps, level
  monotonicity, ETH-stake conservation, fee bounds.
- **Invariant** (`test/invariant/`): escrow balance == live stakes +
  un-withdrawn credits, held over 128k randomized calls.

## Payment assets & SAIRI

SAIRI is **not** hardcoded. Payment assets are generic: `address(0)` is native
ETH; any governance-approved ERC-20 is enabled via `FobalAssetRegistry.setAsset`.
A future SAIRI token becomes usable with a single config call. A `MockSairi`
lives in `src/mocks/` **for testing only** — it is not the real SAIRI.

Fee-on-transfer, rebasing and other non-standard tokens are **rejected** by
balance-delta checks; only well-behaved approved assets are supported.
