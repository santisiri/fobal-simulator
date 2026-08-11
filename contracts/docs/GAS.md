# Fobal Protocol — Gas Analysis

Measured with `forge test --gas-report` on Solidity 0.8.28, optimizer on
(200 runs), `via_ir = true`, EVM `cancun`. Figures are execution gas; add
~21k base per transaction. Base's low fees make every operation inexpensive
in absolute terms — the numbers below drove the "atomic beats Merkle"
decision for batch progression.

## Key operations

| Operation | Gas | Notes |
|---|---|---|
| mint 1 player (via `mintSquad` of 1) | ~249k | includes signature verification + generator overhead |
| mint 11-player squad | ~1.82M | one transaction, ~165k / player |
| mint 23-player squad | ~3.71M | one transaction, still one signature |
| transfer player | ~40k | plain ERC-721 with lock check |
| create team | ~98k | one struct write + event |
| enter match (`createMatch`, 11 players) | ~527k | stakes ETH + locks 11 players |
| join match (11 players) | ~327k | symmetric stake + locks 11 |
| settle match (no progression) | ~139k | signature verify + fund credit |
| **settle match, 22 players progressed** | **~1.51M** | atomic — result + all progression in one tx |
| apply progression, 1 player | ~63k | policy check + player invariant enforcement |
| list player | ~108k | one listing struct write |
| buy player (ETH) | ~167k | payment + fee + NFT transfer, atomic |
| render `tokenURI` | ~385k | view — on-chain JSON + base64 SVG; costs nothing on-chain |

## Most expensive storage operations
1. **Squad minting.** Each player writes 6 storage slots (core, dna, skills,
   appearance, career, name) + the ERC-721 mint. ~165k/player is dominated by
   cold `SSTORE`s. Names are the only variable-length write; kept ≤32 chars.
2. **Match entry.** Locking N players is N × (`SSTORE` lock slot). At 11
   players this is the bulk of `createMatch`.
3. **`tokenURI`.** Large but **view-only** — it never costs gas on-chain;
   wallets and indexers call it for free. String building dominates.

## The batch-progression decision (Section 13)

The brief asks: benchmark whether applying all 22 players' progression in one
transaction is practical on Base before reaching for a Merkle-claim design.

**Measured: a full 22-player settle is ~1.51M gas** (plus ~139k settle base =
~1.87M total). Base blocks are ~60M+ gas; at typical Base fees this settle
costs well under one US cent. That is comfortably practical.

**Decision: atomic settlement, no Merkle claims in v1.** One signed result
applies the whole match's progression in a single transaction. Rationale:
- 1.5M gas is cheap on Base and far below block limits;
- atomic settlement is dramatically simpler to audit than a Merkle-claim
  state machine with per-`(matchId, playerId)` consumption tracking + proofs;
- fewer moving parts = smaller attack surface for the money-touching contract.

**The door stays open.** The signed `MatchResult.progressionHash` already
commits to `keccak256(abi.encode(PlayerProgress[]))`. If a future mode needs
huge lineups or lazy claiming, that same commitment becomes a Merkle root
with no change to the signature scheme — the engine simply signs a root
instead of a flat-array hash, and a claim function verifies proofs against it.
We benchmarked first, chose the simpler architecture, and documented the
upgrade path rather than pre-building complexity.

## Reproduce
```bash
forge test --gas-report
forge snapshot            # writes .gas-snapshot for diffing
```
