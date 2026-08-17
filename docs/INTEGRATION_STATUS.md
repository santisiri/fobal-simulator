# Integration status

Operational snapshot for parallel workstreams. Owner: the integration
lead session. Architecture contract: `docs/NEXT_ITERATION_ARCHITECTURE.md`.
Updated: 2026-08-17 (second sweep — full project review).

**Health: main is green.** typecheck clean · 241 passed / 1 skipped
(a deliberate live-model smoke, gated on `ANTHROPIC_API_KEY`, never in
CI) · 36 test files · zero open PRs.

## Workstreams

| Workstream | Status | Integrated? |
|---|---|---|
| Player NFT data model | player read API, footballer names, `NormalizedPlayer` | ✅ main (#58) |
| Wallet identity (ENS) | resolver + `WalletIdentity`, degrades to short addresses | ✅ main (#59) |
| Lobby / matchmaking | presence states, challenge lifecycle, `LobbyService` boundary | ✅ main (#60) |
| Email invitations | `EmailProvider` seam, `Invitation` ladder, landing page | ✅ main (#62) |
| Squad / product UI | player cards, detail drawer, pitch view, tx-flow + error UX | ✅ main (#61) |
| Voice/LLM — GameCommand | closed taxonomy, `PlayerRef` resolution, compile boundary | ✅ main (#64) |
| Football AI — tactical execution | per-player instructions bound to the engine | ✅ main (#69/#70/#71) |

The #63/#64 contract conflict from the first sweep is **resolved**:
`PlayerInstructionCommand` + `ActiveInstruction` now live in
`packages/protocol/src/match.ts`, and `compileGameCommand` lowers seven
player intents onto them (`SPATIAL_BINDINGS`). Remaining reserved intents
each carry their own honest reason.

## Architecture audit — clean

- **One definition per shared concept.** `Account`, `WalletIdentity`,
  `NormalizedPlayer`, `Invitation`, `PlayerSnapshot`, `GameCommand`,
  `ActiveInstruction` — each has exactly one home. No duplicates found.
- **One chain config.** Addresses + chainId + RPC exist only in
  `infra/cdk/lib/envs.ts`; no hardcoded addresses anywhere in app code.
- **One web3 stack.** `viem` appears in `identity.ts` and one test.
  Chain reads/mint hand-roll JSON-RPC + `@noble` by design (documented).
- **Authority intact.** Interpreters compile to wire commands; the room
  re-validates on arrival; no client authority, no LLM state mutation,
  no chain calls in the sim loop.
- **The north star is proven, not just designed.** `tactics.test.ts`:
  *"overlap: intent honored for both, but PACE bounds the execution"*,
  *"a high press punishes a low-stamina squad harder"*, and
  *"instructed matches replay AND resume bit-exactly"*.

## ⚠️ The one real product-coherence defect: the identity schism

**Two disconnected identity systems. A player who onboards loses their
club the moment they play online.**

| | `apps/web` (front door) | `apps/match-client` (the game) |
|---|---|---|
| Identity | `localStorage['fobal.club']` | server `Account` (email/wallet session) |
| Club name | what the player typed in onboarding | `HANDLE FC`, auto-generated |
| Squad | deterministic preview squad | server-generated or chain-linked |
| Knows the other? | never calls the lobby server | **0 references to `fobal.club`** |

Journey today: onboarding → name your club, pick a kit, meet 11 players →
hub → **PLAY ONLINE** → a plain `<a href="lobby.html">` → sign in *again*
→ you are now "SANTI FC" with a different squad, and **no link back to
the hub** (`hub.html`: 0 references in lobby.html).

This is exactly the "disconnected demos" failure the north star forbids.
Everything else in the product is coherent (vocabulary is consistent —
SQUAD everywhere; brand is unified since the lobby revamp).

**Recommended fix (smallest coherent step, for whoever owns product UI):**
make the **server account canonical** and the web club a *view* of it —
onboarding's club name + kit POST to `/account/team` + `/squad` on first
sign-in, hub reads the lobby session instead of localStorage, and the
lobby gains a "← CLUB" link. Onboarding stays the delightful front door;
it just stops being a separate universe.

## Deploy drift — a redeploy is due

Staging runs image `38b964e`; main is **42 commits ahead**, 31 of them
touching server/client code (invitations, identity, squad UI, the whole
G workstream). Nothing on staging exercises player instructions or
invitations yet. Next integration action: server image + client sync.

## Shared contracts — where they live

| Concept | Canonical location |
|---|---|
| GameCommand, intents, PlayerRef, compile table | `packages/protocol/src/orders.ts` |
| PlayerInstructionCommand, ActiveInstruction, TacticalPatch, MatchEvent | `packages/protocol/src/match.ts` |
| NormalizedPlayer (chain read shape) | `apps/lobby-server/src/chain.ts` + `docs/PLAYER_DATA_MODEL.md` |
| WalletIdentity / IdentityResolver | `apps/lobby-server/src/identity.ts` |
| Invitation / EmailProvider | `apps/lobby-server/src/store.ts` + `email.ts` |
| LobbyParticipant / challenge lifecycle | `docs/LOBBY_MATCHMAKING.md` + `apps/match-client/src/lobbyService.js` |
| Chain config (ids, addresses, RPC) | `infra/cdk/lib/envs.ts` — deploys; `contracts/deployments/<chainId>.json` — local tooling |

## Standing rules (learned by incident)

- **One agent, one worktree.** Stranded uncommitted work nearly died
  twice; everything recovered is on `rescue/stranded-g-and-lobby-work`.
- Deployed artifacts are built from committed main only; a failing smoke
  is reported, never patched locally.
- Staging deploys carry `-c aiSecrets=1 -c mintSigner=1`.
- The engine stays authoritative (see the architecture doc's invariants).

## Open follow-ups (not blockers)

- The identity schism above — the highest-value product work available.
- Same-surname ambiguity: `resolvePlayerRef` answers "Moretti or
  Moretti?"; should carry shirt numbers when surnames collide.
- `production.chain` + prod generator-signer secret = prod activation.
- SES production access (AWS case) — invitations stay sandbox-limited.
- P7 two-match public-key stability check (agent errand, unreported).
