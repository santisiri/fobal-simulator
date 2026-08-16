# Wallet identity — verified ENS names

`santi.eth` instead of `0x8A3f…91Bd` — but only when it's true.

## Where it lives, and why

Resolution is **server-side, in the lobby** (`apps/lobby-server/src/identity.ts`),
the layer where chain access already lives by constitution. One resolver,
one cache, shared by every player — and because it decorates
`publicAccount`, every surface gets names at once: your header chip, the
coaches roster, incoming/outgoing challenges, match setup. Clients ship no
web3 stack for this; they render what the poll delivers. The raw address
stays reachable everywhere via hover (`title`) and the on-chain card.

## Two networks, deliberately separate

| | network | why |
|---|---|---|
| **Game execution** | Base Sepolia | squads, minting, rosters |
| **Identity resolution** | Ethereum mainnet | where ENS lives |

A testnet wallet keeps its mainnet name — identity must not disappear
because the game runs on an L2 testnet. Mainnet resolution transitively
covers `*.base.eth` basenames set as mainnet primaries (their L1 resolver
CCIP-reads into Base; viem's universal resolver follows ERC-3668).
**Chain-native L2 primary names (ENSIP-19)**: the `source` field reserves
`'ens-base'`; the installed viem (2.55) ships no ENS deployment for the
Base chain, so that rung activates when the maintained library supports
it — never via hand-pinned contract addresses.

## Resolution + verification strategy

`resolveWalletIdentity` ≙ `IdentityResolver.resolve(address)` →

```
{ address, displayName, ensName?, ensAvatar?, verified, source }
```

1. Reverse-resolve the address (viem `getEnsName`, mainnet universal
   resolver — CCIP-read capable, so offchain-resolver names work).
2. **Verify**: forward-resolve the claimed name (`getEnsAddress`) and
   require it to map back to the exact same address (case-insensitive).
   A reverse record is a claim anyone can point anywhere; only the
   round-trip makes it identity. `ensName`/`verified: true` appear ONLY
   after this passes.
3. Avatar (`getEnsAvatar`) is best-effort decoration on a verified name —
   its failure never affects the identity.
4. Anything else — no name, mismatch, empty forward record, RPC failure —
   falls back to the shortened address (`0x1234…abcd`), `verified: false`,
   `source: 'address'`.

Fallback order: verified L2 primary *(reserved)* → verified mainnet
primary → shortened address.

## Performance contract

- **Never blocks**: `resolve()` never rejects; the hub calls it
  fire-and-forget and reads `peek()` synchronously. The first poll after a
  wallet connects may show the shortened address; the name rides the next
  poll (~2s) once the async resolve lands — that interim address IS the
  loading state.
- **Cache**: 10 min TTL for resolved identities (verified or not);
  **45 s TTL for RPC-failure fallbacks** so an outage degrades gracefully
  but recovery is quick.
- **Dedup**: concurrent resolves for one address share a single lookup.
- **Timeout**: 4 s transport timeout per call — a slow RPC can only ever
  delay a name, never a lobby response.
- Failure to reach any ENS RPC never prevents playing: measured live, a
  cold verified resolve ≈ 2.7 s in the background, a cached one 0 ms.

## RPC strategy

Default: viem's maintained public mainnet transport (no key, no config).
Override with `FOBAL_IDENTITY_RPC_URL` (a keyed URL is a secret →
Secrets Manager, not code). Disable entirely with `FOBAL_IDENTITY=0`.

## Security

**An ENS name is presentation identity, not authorization.** The server
only attaches `identity` for display; every ownership and security
decision — sessions, squad linking, minting, match tokens — keys on the
wallet address or accountId, exactly as before. The client renders
verified names in the on-chain purple with the raw address on hover;
nothing anywhere gates on a name.

## Frontend integration points

`lobby.html`: header who-chip (`nameOf(me)` + address in `title`), roster
rows, incoming/outgoing challenge rows (all through `nameHtml()` — the
`.ens` class marks verified names). History rows show club names (already
identity-bearing). Email accounts are untouched — no identity block is
ever attached to them.

## Tests

`apps/lobby-server/test/identity.test.ts` (10): verified mainnet name,
no-ENS fallback, forward/reverse mismatch refusal (the security case),
empty forward record, RPC failure + short-TTL retry, avatar failure
isolation, cache behavior (case-insensitive, no re-dial), concurrent
dedup, wallet switching, and hub integration (identity on `/lobby` for me
AND the roster; email accounts clean). The ENS client is injectable; the
live path was additionally proven against real mainnet
(`vitalik.eth`, verified, avatar, then 0 ms cached).
