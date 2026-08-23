# Integration status

Operational snapshot for parallel workstreams. Owner: the integration
lead session. Architecture contract: `docs/NEXT_ITERATION_ARCHITECTURE.md`.
Updated: 2026-08-18 (third sweep).

**Health: main is green** at `3c00e6b`. typecheck clean · **296 passed /
1 skipped** across 40 files (the skip is a deliberate live-model smoke
gated on `ANTHROPIC_API_KEY`) · client build asserts pass, golden
byte-identical · **zero open PRs**.

## Workstreams

| Workstream | Status | Integrated? |
|---|---|---|
| Player NFT data model | player read API, names, `NormalizedPlayer` | ✅ main |
| Wallet identity (ENS) | resolver, degrades to short addresses | ✅ main |
| Lobby / matchmaking | presence, challenge lifecycle, `LobbyService` | ✅ main |
| Email invitations | `EmailProvider` seam, `Invitation` ladder, landing page | ✅ main |
| Squad / product UI | player cards, drawer, tx-flow + error UX | ✅ main |
| Voice/LLM — GameCommand | closed taxonomy, resolution, compile boundary | ✅ main |
| Football AI — tactical execution | 7 player intents move real footballers | ✅ main |
| **Art v2/v3** | `packages/art` single source → generated JS + Solidity; router, atlas, rollout runbook | ✅ **in repo — NOT on chain** |

## Architecture audit — still clean

- **One definition per shared concept** (`Account`, `WalletIdentity`,
  `NormalizedPlayer`, `GameCommand`, `Invitation` — 1 each).
- **One chain config**: addresses live only in `infra/cdk/lib/envs.ts`
  (deploys) and `docs/ONCHAIN_DEPLOYMENTS.md` (the recovered ledger).
- **Authority intact**: interpreters compile to wire commands, the room
  re-validates, no client authority, no chain calls in the sim loop.
- The art workstream **removed** a divergence class rather than adding
  one: `apps/web/public/js/avatar.js` is now GENERATED from
  `packages/art/spec`, replacing a hand-port that had silently drifted.

## ⚠️ Finding 1 — art version skew (new, deploy-relevant)

The repo renders **v2/v3 anchored-atlas art** (browser + Solidity, one
generated source). The chain still runs **v1**: `FobalPlayer`
`0x52F5828d…` → `renderer()` = `0xB103DCe9…`, unchanged since the
2026-08-14 deploy.

**Consequence of an AWS-only deploy:** the web app shows v2/v3 art while
every minted token's `tokenURI` (Basescan, wallets, marketplaces) still
renders v1. A visible mismatch — staging-only, and temporary.

**This is not a blocker for the AWS deploy**, and the two tracks are
deliberately separate:

| Track | Who | Vehicle |
|---|---|---|
| AWS staging (server + client) | Sairi (SSO, no keys) | the phase prompt below |
| On-chain renderer swap | **the human** (admin key `0x26250e47…`) | `docs/ART_ROLLOUT.md` — 8 phases, each revertible; rollback target recorded in `docs/ONCHAIN_DEPLOYMENTS.md` |

Do not batch the art phases, and do not `seal()` before visual
inspection — the runbook says both, and both are irreversible mistakes.

## ⚠️ Finding 2 — the identity schism (unchanged, still open)

Still true, one sweep later: `apps/web`'s `localStorage['fobal.club']`
and the lobby's server `Account` are disconnected universes.
`lobby.html` has **0** references to `fobal.club` and **0** links back to
`hub.html`; `apps/web` never calls the lobby server. A player names a
club, meets 11 players, clicks PLAY ONLINE, and becomes a different
manager with a different squad and no way home.

Smallest coherent fix (unclaimed by any workstream): make the server
account canonical and the web club a *view* of it — onboarding's name +
kit POST to `/account/team` + `/squad` on first sign-in, hub reads the
lobby session, lobby gains a "← CLUB" link.

## Deploy state

**Staging is LIVE on `40326b0`** (deployed 2026-08-22, from `38b964e` —
44 commits of catch-up). Both services rolled cleanly: match-server task
def `:9`, lobby-server `:7`, each `1/1` running, rollout `COMPLETED`.
Client rebuilt, synced, CloudFront invalidation completed.

All six smokes passed: both `/health` endpoints, wallet-auth challenge,
the three boot markers (`chain_reader` · `mint_service` ·
`identity_resolver`), the lobby title marker, and `invite.html`.

**Verified:** the deployed tree is byte-for-byte the code reviewed green
at `3c00e6b` — the intervening commits touched only contract tests and
docs. No unreviewed application code is serving staging.

Drift since the deploy is `packages/art` tooling and CI only; nothing
client-facing, so no redeploy is owed.

**Standing staging contexts**: `-c aiSecrets=1 -c mintSigner=1`.
**Do NOT pass `-c emailSecrets=1`** — it injects Resend secrets that do
not exist (`<prefix>/lobby-server/resend-api-key`), which crash-loops the
lobby task at boot. Without it the lobby stays on the SES backend.

## Shared contracts — where they live

| Concept | Canonical location |
|---|---|
| GameCommand, intents, PlayerRef, compile table | `packages/protocol/src/orders.ts` |
| PlayerInstruction, ActiveInstruction, TacticalPatch, MatchEvent | `packages/protocol/src/match.ts` |
| Art spec (parts, palettes, weights, anchors) → JS + Solidity | `packages/art/spec` (generated: `apps/web/public/js/avatar.js`) |
| NormalizedPlayer | `apps/lobby-server/src/chain.ts` + `docs/PLAYER_DATA_MODEL.md` |
| WalletIdentity / IdentityResolver | `apps/lobby-server/src/identity.ts` |
| Invitation / EmailProvider | `apps/lobby-server/src/store.ts` + `email.ts` |
| Chain config | `infra/cdk/lib/envs.ts` (deploys) · `docs/ONCHAIN_DEPLOYMENTS.md` (live ledger + rollback target) |

## Standing rules (learned by incident)

- One agent, one worktree; commit early (stranded work nearly died twice).
- Deployed artifacts are built from committed main only; a failing smoke
  is **reported, never patched locally**.
- Staging carries `-c aiSecrets=1 -c mintSigner=1`.
- The engine stays authoritative.

## Open follow-ups

- Art rollout on Base Sepolia (human, admin key) — `docs/ART_ROLLOUT.md`.
- The identity schism — highest-value product work available.
- Invitations for arbitrary recipients: SES production access (AWS case)
  **or** create the two Resend secrets and redeploy with `-c emailSecrets=1`.
- `production.chain` + prod generator-signer secret = prod activation.
- Same-surname ambiguity in `resolvePlayerRef` ("Moretti or Moretti?").
