# Integration status

Operational snapshot for parallel workstreams. Owner: the integration
lead session. Read `docs/NEXT_ITERATION_ARCHITECTURE.md` for the
architecture contract. Updated: 2026-08-16 (first sweep).

## Workstreams

| Workstream | Status | Integrated? | Next action |
|---|---|---|---|
| Player NFT data model | player read API + footballer names shipped | ✅ PR #58 on main | — |
| Wallet identity (ENS) | resolver + WalletIdentity shipped | ✅ PR #59 on main | — |
| Lobby / matchmaking | presence states, challenge lifecycle, LobbyService boundary | ✅ PR #60 on main | — |
| Squad / product UI | in progress on `feat/squad-experience` (worktree infallible-merkle) | ⬜ no PR yet | review at PR time |
| Email invitations | complete per its docs; EmailProvider abstraction + Invitation model + landing page | ⬜ **PR #62 open** | integration review (next in queue) |
| Voice/LLM — GameCommand taxonomy | was STRANDED uncommitted in a shared worktree; rescued, tested, landed | ⬜ **PR #64 open** | merge FIRST (see order below) |
| Football AI — tactical execution | per-player engine bindings + taxonomy wired (compile table lowers 7 player intents onto `player_instruction`; `underlap` binding added; 3 intents remain reserved with specific reasons) | ✅ #63 + #66 on main; binding PR follows | grow bindings (press_player, tendencies) |

## The one live conflict (resolve architecture before merging)

**PR #63 imports `PlayerInstructionCommand` and `ActiveInstruction` from
`@fobal/protocol` — types that exist NOWHERE** (not on main, not in #63's
own diff, not in #64's taxonomy). They were evidently part of the G
workstream's stranded work that never reached a branch. #63 and #64 are
two halves of one contract, built against different drafts of it:

- **#64 (interpretation half)**: `GameCommand` taxonomy — closed enums,
  `PlayerRef` resolution, `compileGameCommand` lowering onto EXISTING wire
  commands; player intents beyond `mark_player` are reserved-and-honest.
- **#63 (execution half)**: engine bindings that give ten of those player
  intents real on-pitch meaning via formation-station biasing — but
  carried by a NEW wire command type that was never committed.

**Resolution (canonical decision):**
1. Merge **#64 first** — the taxonomy is the canonical interpretation
   contract and stands alone (reserved intents reject honestly).
2. Rebase **#63 on top**; the integration lead adds the missing protocol
   piece TO #63: a `player_instruction` wire command
   (`PlayerInstructionCommand` + `ActiveInstruction`) in
   `packages/protocol`, and flips `compileGameCommand`'s reserved player
   intents to lower onto it — deleting the reserved-rejection path for
   exactly the intents #63 executes. The compile table is the single
   place that changes; interpreters and clients are untouched.
3. `docs/NEXT_ITERATION_ARCHITECTURE.md` G3 section updates when it lands.

## Merge queue (recommended order)

1. **#64** — GameCommand taxonomy (contract; tested; standalone)
2. **#62** — email invitations (independent surface; review pending)
3. **#63** — tactical execution (after the rebase + protocol reconciliation above)

## Shared contracts — where they live

| Concept | Canonical location |
|---|---|
| GameCommand / intents / PlayerRef / compile | `packages/protocol/src/orders.ts` (#64) |
| Player, PlayerStats, TeamSnapshot, TacticalPatch, MatchEvent | `packages/protocol/src/match.ts` |
| NormalizedPlayer (chain read shape) | `apps/lobby-server/src/chain.ts` + `docs/PLAYER_DATA_MODEL.md` |
| WalletIdentity / IdentityResolver | `apps/lobby-server/src/identity.ts` |
| LobbyParticipant / challenge lifecycle | `docs/LOBBY_MATCHMAKING.md` + `apps/match-client/src/lobbyService.js` |
| Invitation / EmailProvider | PR #62 (`apps/lobby-server/src/email.ts`, `store.ts`) |
| Chain config (ids, addresses, RPC) | `infra/cdk/lib/envs.ts` `chain` blocks — THE source of truth for deploys; `contracts/deployments/<chainId>.json` for local tooling |

## Standing rules (learned by incident)

- **One agent, one worktree.** Uncommitted work stranded in a shared
  worktree nearly died twice; everything found there is preserved on
  `rescue/stranded-g-and-lobby-work`. Commit early, push branches.
- Deployed artifacts are built from committed main only; failing smokes
  are reported, never patched locally.
- Staging deploys carry `-c aiSecrets=1 -c mintSigner=1` — omitting
  either silently disarms a live feature.
- The engine stays authoritative: no client authority, no LLM state
  mutation, no chain calls in the sim loop. (See the architecture doc's
  standing invariants.)

## Environment / deploy drift

- Staging runs image `38b964e` + client synced at the same commit.
  Main has since gained #58/#59/#60 (+ open PRs). **A staging redeploy
  (server image + client sync) is due once the merge queue above lands.**
- SES production access still pending (AWS case) — email invitations
  will inherit the sandbox limitation until then.

## Known follow-ups (not blockers)

- Same-surname ambiguity: `resolvePlayerRef` answers "Moretti or
  Moretti?" — should carry shirt numbers when surnames collide (G).
- `production.chain` + prod generator-signer secret = prod activation of
  chain reads + mint, pending the user's word.
- P7 two-match public-key stability check (agent errand, still unreported).
