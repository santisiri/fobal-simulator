# Fobal Protocol — Trust Model

Fobal's philosophy is **gameplay off-chain, ownership and consequential state
on-chain**. That split defines exactly what the blockchain does and does not
guarantee. This document is deliberately blunt about the boundary.

## What the blockchain guarantees

These are enforced by contract code and are true regardless of what any
server, operator, or engine claims:

- **Ownership.** Every player is an ERC-721 with standard semantics. Who owns
  token N is settled on-chain; no off-chain system can override it.
- **Authorization.** Only the roles in SECURITY.md can invoke privileged
  functions. The game engine cannot seize NFTs, move funds, or self-promote.
- **Settlement rules.** A match settles exactly once, against exactly one
  signed result, with funds credited by a conservation-preserving ledger.
- **Current canonical progression.** Skills, XP, level and career stats are
  on-chain, bounded by protocol invariants, and travel with the NFT forever.
- **Economic balances.** Stakes and proceeds are accounted per-wei; the
  escrow's balance always equals live stakes plus un-withdrawn credits
  (proven by an invariant test over 128k randomized calls).

## What the Fobal engine is trusted for

These are **not** provable on-chain in v1. The engine signer attests to them,
and the protocol trusts that attestation:

- **Correctness of the simulated result.** That the final score, goals and
  assists reflect a fair simulation of the committed lineups.
- **Correctness of performance evaluation.** That the progression deltas
  (which players improved, by how much) reflect what actually happened.
- **Fair player generation.** That minted squads' DNA/skills are generated
  honestly (within the power budget the contract enforces).

**The protocol cannot prove an off-chain football match was fair merely
because its result was signed.** A signature proves *who authored* the result
(the holder of the engine key), not that the result is *correct*. This is the
central trust assumption of Fobal v1, and we state it plainly rather than
implying cryptographic guarantees the system does not provide.

What the contract *does* constrain, even against a dishonest engine:
- results settle once, bind to the committed teams, and expire;
- progression is capped per-match (XP, per-skill delta, total points) and
  consumed once per (match, player);
- generation is bounded by a per-player power budget and per-seed skill caps;
- no result or generation can ever move an NFT or withdraw funds.

So a compromised engine key can produce *plausible-but-wrong* games and
*plausible-but-unearned* progression — bounded, reversible-by-governance-policy
mischief — but not theft.

## Decentralization path (without re-issuing the NFT)

The engine signer is an **address checked in signature verification**, not a
hardcoded assumption. That single indirection lets the trust model evolve
while the ERC-721 collection, player identities, and career histories stay
exactly where they are:

1. **Multisig signer.** Point `engineSigner` at a Safe; results require M-of-N
   engine operators. `SignatureChecker` already supports ERC-1271, so no code
   change is needed.
2. **Multiple independent result signers.** Add a settlement path requiring
   K distinct authorized signatures over the same result digest.
3. **Optimistic challenge window.** Accept a signed result into a pending
   state, allow a fraud-proof challenge before funds/progression finalize.
4. **Verifiable simulation (ZK).** Replace the signature with a proof that the
   committed lineups + seed produce the claimed result under the published
   engine rules.
5. **Decentralized engine consensus.** A network of simulators reaching
   agreement, with the aggregate attestation verified on-chain.

Each is a change to *how a result becomes canonical* — the
`SignatureChecker.isValidSignatureNow(engineSigner, digest, sig)` line and its
surroundings — never a change to `FobalPlayer`. The persistence of the
footballer across every future trust model is the point.

## Governance trust

`DEFAULT_ADMIN_ROLE` (a multisig at mainnet) can retune policy (progression
caps, fees within the hard 10% cap, asset allowlist, signer rotation) and set
the renderer. It cannot rewrite player identity (DNA/appearance/name have no
write path), cannot decrease career stats, and cannot seize NFTs or ledger
balances. Governance is trusted for *tuning and key management*, not custody.
