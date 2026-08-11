# Fobal Protocol — Security & Permissions

## Threat model summary

The protocol may custody economically meaningful assets (ETH, ERC-20 stakes,
sale proceeds). The two most powerful *operational* keys — the generator
signer and the engine signer — are deliberately **not administrators**: they
attest to game facts and can do nothing else. A full compromise of either
signer produces bounded damage (plausible players / plausible results within
protocol caps), never fund theft or NFT seizure.

## Permissions table

Every privileged function, its contract, and the single role that may call it.

| Contract | Function | Role required |
|---|---|---|
| FobalPlayer | `mint` | `MINTER_ROLE` (→ FobalPlayerGenerator) |
| FobalPlayer | `applyProgression` | `PROGRESSION_ROLE` (→ FobalProgression) |
| FobalPlayer | `lock` | `LOCK_ROLE` (→ FobalMatchEscrow) |
| FobalPlayer | `unlock` | the locking contract (address-checked, not a role) |
| FobalPlayer | `setRenderer` | `DEFAULT_ADMIN_ROLE` |
| FobalPlayer | `grantRole`/`revokeRole` | `DEFAULT_ADMIN_ROLE` |
| FobalPlayerGenerator | `mintSquad` | anyone with a valid engine signature (permissionless submit) |
| FobalPlayerGenerator | `setSigner` | `SIGNER_ADMIN_ROLE` |
| FobalPlayerGenerator | `setPerPlayerPowerBudget` | `DEFAULT_ADMIN_ROLE` |
| FobalPlayerGenerator | `pause`/`unpause` | `PAUSER_ROLE` |
| FobalProgression | `applyMatch` | `ESCROW_ROLE` (→ FobalMatchEscrow) |
| FobalProgression | `setPolicy` | `DEFAULT_ADMIN_ROLE` |
| FobalAssetRegistry | `setAsset` | `ASSET_ADMIN_ROLE` |
| FobalMatchEscrow | `createMatch`/`joinMatch` | anyone (owns the staked players) |
| FobalMatchEscrow | `settle` | anyone with a valid engine signature |
| FobalMatchEscrow | `cancelOpen`/`cancelExpired` | match participants |
| FobalMatchEscrow | `withdraw` | anyone (their own ledger balance) |
| FobalMatchEscrow | `setSigner` | `SIGNER_ADMIN_ROLE` |
| FobalMatchEscrow | `setTreasury`/`setFeeBps` | `TREASURY_ADMIN_ROLE` |
| FobalMatchEscrow | `pause`/`unpause` | `PAUSER_ROLE` |
| FobalMarketplace | `list`/`cancel`/`buy` | token owner / listing seller / anyone |
| FobalMarketplace | `setTreasury`/`setFeeBps` | `TREASURY_ADMIN_ROLE` |
| FobalMarketplace | `withdraw` | anyone (their own ledger balance) |
| FobalTeamRegistry | `createTeam` | anyone |
| FobalTeamRegistry | `transferTeam`/`declareRoster` | team owner |

`DEFAULT_ADMIN_ROLE` on every contract is intended for a **multisig** at
mainnet. It is a configuration + role authority only; it never gains custody
of user NFTs or ledger balances by virtue of being admin.

### What the game engine signer CANNOT do
- seize or transfer NFTs (holds no `PROGRESSION_ROLE`/`LOCK_ROLE`/approval);
- withdraw treasury or any ledger funds (holds no ledger credit, no admin);
- change marketplace or escrow fees (no `TREASURY_ADMIN_ROLE`);
- change payment-asset configuration (no `ASSET_ADMIN_ROLE`);
- promote itself (no `DEFAULT_ADMIN_ROLE`, cannot `grantRole`).

The same holds for the generator signer. Both are addresses checked inside
signature verification, replaceable by their respective `SIGNER_ADMIN`.

## Mitigations by threat

| Threat | Mitigation |
|---|---|
| Reentrancy | `ReentrancyGuard` on every value-moving path (`FundsLedger.withdraw`, `settle`, `buy`, `createMatch`, `joinMatch`); checks-effects-interactions; pull-payments so no external call happens mid-settlement |
| Signature replay | EIP-712 with sequential per-recipient nonces (generation) and one-shot state machine + per-match `resultNonce` + deadline (settlement) |
| Cross-chain replay | `chainId` in every EIP-712 domain |
| Cross-contract replay | `verifyingContract` in every domain; distinct typehashes |
| Double settlement | status flips to `SETTLED` before any external effect; `WrongStatus` on re-entry |
| Duplicate progression | `consumed[matchId][playerId]` one-shot map in FobalProgression |
| Stale listings | `buy` re-checks live ownership, approval, lock and expiry against the chain, not the stored listing |
| Arithmetic errors | Solidity 0.8 checked math; explicit `uint256` casts in fee math; packing masks validated |
| Unauthorized updates | per-contract `AccessControl`; player invariants re-enforced independent of caller |
| Stuck match locks | every lock has a release: `settle`, `cancelOpen`, or `cancelExpired` (engine no-show) |
| Stuck stakes | pull-ledger credits on every terminal path; `cancelExpired` refunds both sides after `resultDeadline` |
| Malicious ERC-20 | governance allowlist + balance-delta checks reject fee-on-transfer / rebasing / non-standard tokens |
| Compromised engine/generator signer | bounded blast radius (see above); rotatable via `SIGNER_ADMIN` |
| Incorrect role configuration | deploy script wires roles deterministically; permissions table is the audit reference |

## Explicitly out of scope / accepted risks
- **Off-chain fairness.** The chain cannot prove the simulation was fair —
  see TRUST_MODEL.md. The signature attests *authorship*, not correctness.
- **Exotic tokens rejected, not supported.** Fee-on-transfer, rebasing,
  and hook-heavy tokens revert on stake/purchase by design.
- **No upgradeability on FobalPlayer.** A bug in the core NFT would require a
  migration; we accept this in exchange for permanent, immutable identity.
- **MEV on `buy`/`joinMatch`.** Fixed-price and fixed-stake, so front-running
  yields no advantage beyond ordering; no auctions in v1.

## Static analysis (Slither)

Run before every audit checkpoint:
```bash
slither . --filter-paths "lib|test|script|mocks"
```

High/medium detectors are clean. One `reentrancy-no-eth` informational
finding remains and is a **reviewed false positive**:

- `FobalProgression.applyMatch` — Slither's loop analysis reports
  `consumed[matchId][playerId] = true` as "written after an external call"
  because iteration *i+1*'s write follows iteration *i*'s
  `player.applyProgression`. Within each iteration the `consumed` flag is set
  **before** that player's external call (correct CEI), the external call
  targets the protocol's own `FobalPlayer` (which exposes no callback into
  the progression module), and `applyMatch` is `nonReentrant` and gated to
  `ESCROW_ROLE`. There is no reentrancy path. Left as-is rather than
  restructured because the code is already correct and clearer this way.

All `_safeMint` / `safeTransferFrom` paths that could trigger an
`onERC721Received` callback (`mintSquad`, `buy`) are `nonReentrant` with
effects committed before the transfer.

## Prohibited patterns (verified absent)
- `tx.origin` — not used anywhere.
- Predictable randomness (`block.timestamp`/`blockhash`/`msg.sender` as
  entropy) — not used; DNA arrives in signed payloads.
- Custom signature cryptography — only OpenZeppelin `ECDSA`/`SignatureChecker`.
