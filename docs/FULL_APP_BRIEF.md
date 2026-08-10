# FOBAL — Full Multiplayer Platform Build Brief

You are building the production FOBAL platform: two humans anywhere on earth
open play.fobal.ai, sign in, find an opponent, and coach a live authoritative
football match BY VOICE, in any language — then keep the signed result, the
bit-exact replay, and the rivalry. Repo: santisiri/fobal-simulator (monorepo).
Work slice by slice: one PR per slice, tests green, verified live, then stop
for "merged, next slice". Never bundle unrelated slices.

## WHAT EXISTS — DO NOT REBUILD
- packages/engine: the golden single-file sim (repo-root index.html, 8787
  lines) wrapped headless in node:vm; bit-exact vs characterization goldens.
- packages/protocol: zod v3 wire contracts (manifest/commands/events/
  snapshots/results). protocol pins zod 3 — the SDK's zodOutputFormat needs
  v4; hand-write JSON schemas instead.
- apps/match-server: authoritative rooms, HMAC tokens, S3-mirrored store,
  Ed25519-signed idempotent results, goal-clip re-sim, CORS, WS origin
  allowlist, per-IP caps, EMF telemetry, C2 Claude coach interpreter
  (structured outputs, app-level fallback chain).
- apps/lobby-server: magic-code auth (SES delivery + secret test-login-key
  backdoor for acceptance), polling presence, challenge→accept→manifest→
  match creation with the server-held create key, full-time detection from
  signed results, history with W/D/L, rematch. S3 write-through store.
- apps/match-client: GoldenPuppet — the untouched golden file driven as a
  puppet (sim frozen via game.simRate=0), pixel parity incl. replays/reel,
  dugout mirage for away controllers, browser-STT voice (C1), lobby pages.
- infra: CDK service stack (ECS Fargate sa-east-1, ALB, host-routed lobby),
  imperative CloudFront distribution E35URO4KFESJYU (see AWS_ARCHITECTURE.md
  runbook — CFN+exec-role CANNOT create enabled distributions with ACM
  certs; documented quirk, don't retry), IAM: engineer permission-set inline
  policy + FobalAgentBoundary + cfn-exec inline policy, all in infra/iam/.
- tools: build-client.mjs (hash-verified golden relocation), lobby-acceptance
  (--test-key, --full rides a match to FT), staging-acceptance (20 checks,
  pass --server explicitly).
- Staging URLs: play-staging.fobal.ai (CloudFront), lobby-staging.fobal.ai +
  matches-staging.fobal.ai (ALB). Wildcard *.fobal.ai certs in sa-east-1 AND
  us-east-1 (CloudFront needs us-east-1). DNS at iwantmyname (human-managed).

## CONSTITUTION — NON-NEGOTIABLE
1. The golden reference stays golden: repo-root index.html is NEVER edited;
   visual parity comes from REUSING golden code (puppet/strangler-fig), and
   build artifacts must carry it byte-identical (hash-verified).
2. The determinism boundary is sacred: manifest + ordered command log
   reproduces every match bit-for-bit. Voice, LLMs, matchmaking, chains are
   INPUT TRANSFORMERS: only validated protocol commands enter the log. The
   authoritative engine NEVER rewinds (cinematic goal replay stays disabled
   in authority; replays are playback, never re-simulation in place).
3. Proof-gated: every slice ships acceptance (tests + live verification);
   staging changes end with the acceptance scripts green. A slice is done
   when its proofs pass, not when it demos well.
4. Trust boundaries: the create key lives server-side in the lobby only;
   the match server is the sole author/signer of results (lobby caches
   pointers); tokens are role- and match-scoped; provider keys (Anthropic,
   any STT) live in Secrets Manager/env — never in a browser.
5. Division of labor: repo-side work here; AWS-side work by the user's
   OpenClaw agent via paste-ready phase prompts (SSO FobalStaging role only,
   sa-east-1 + us-east-1 ACM/CloudFront exceptions, fobal-staging-*/Fobal-*
   only, STOP on AccessDenied, never work around denials, NEVER root creds);
   the human does: Identity Center/boundary pastes, DNS at iwantmyname,
   email verification clicks. IAM changes are explicit diffs to infra/iam/
   (engineer policy fits ONLY as permission-set inline; boundary must stay
   ≤6144 non-ws chars; never grant the agent policy-version rights on
   Fobal* — the boundary itself matches that pattern).

## THE GAP — WHAT "FULL BLOWN" ADDS
M1 PRODUCT-COMPLETE CORE LOOP (repo-only)
  - Team identity: name/edit players and team colors (protocol already
    carries names/kits in TeamSnapshot; lobby stores squads per account —
    replace the deterministic generator with stored, editable squads,
    validated by the existing manifest schema). Keep generated squads as the
    default for new accounts.
  - Replay theater: load a ReplayFile (GET /matches/:id/replay) into the
    puppet OFFLINE — watch any finished match from history end to end.
    Playback only; wire a WATCH button into history rows.
  - Client polish: mobile layout pass for lobby + match shell, connection
    status/reconnect UX, sensible empty states, favicon/meta.
  Proofs: edit squad → next match uses it (manifest validates, names on
  pitch); watch a history match full-through offline; mobile viewport sane.
M2 SCALE + ROBUSTNESS (design doc FIRST, then implement)
  - Concurrency model: rooms are in-process; decide and document how far
    one task scales (load test with turbo rooms + synthetic WS clients),
    then EITHER vertical scaling with a hard room cap + lobby-side backpressure
    ("servers full") OR a match-placement layer (registry mapping matchId →
    task, per-task target groups). Do not guess — measure, write
    docs/SCALE.md, implement the chosen design.
  - Lobby durability: presence/challenges are in-memory (single task);
    either accept + document single-task lobby with S3-mirrored accounts, or
    move hot state to DynamoDB. Decide by measured need, not fashion.
  - Per-account abuse limits (challenge spam, team-name moderation pass).
  Proofs: N concurrent matches with M spectators each on staging without
  degradation (numbers from the design doc); chaos check: kill the match
  task mid-load → resumed matches + reconnected clients.
M3 PRODUCTION ENVIRONMENT
  - fobal-prod-* parallel stack set: play.fobal.ai + matches.fobal.ai +
    lobby.fobal.ai, separate secrets, FOBAL_WS_ORIGINS pinned to prod origin
    only, stable Ed25519 signing key in Secrets Manager (FOBAL_SIGNING_KEY
    plumbing exists), SES production access + prod from-address.
  - CI/CD: GitHub Actions with OIDC (no static keys): test+typecheck on PR,
    image build/push + cdk diff on merge, deploy gated manually. Extend
    infra/iam for the OIDC role following the boundary pattern.
  - Observability: CloudWatch dashboard from the EMF metrics (rooms,
    connections, rejects, coach latency), alarms wired to email/Slack.
  Proofs: full acceptance suite green against PROD urls; a PR-to-prod dry
  run documented; dashboard screenshot in the PR.
M4 VOICE V2 (C3/C4 completion)
  - Hosted STT endpoint (Whisper-class) behind the hub, same key pattern as
    C2 (server-side, Secrets Manager); browser records audio → POST →
    transcript → existing C2 interpret path. Browser-native SR stays as
    fallback. End-to-end voice→ack budget ≤3s, measured via CoachInterpretMs
    + a new SttMs metric; decide transcript retention (command metadata vs
    discard) and document in ROADMAP open decisions.
  Proofs: two languages spoken → correct tactical effect on staging; replay
  of a voice-coached match bit-identical; provider killed mid-match → match
  unaffected.
M5 PHASE D — NFT TEAMS (per docs/ROADMAP.md D1-D4)
  - Wallet auth beside email; testnet ERC-721 registry → PlayerSnapshot via
    the single rating-normalization seam → validated manifests; publishable
    result verification against the stable signing key. Chain reads live in
    the lobby layer ONLY.
  Proofs: testnet-NFT manifest plays a staging match; same wallet on a
  second device reconstructs the identical manifest; signature verifies.

## KNOWN LANDMINES (hard-won; respect them)
- Browser-pane tabs starve rAF when hidden: verify with JS probes, not
  screenshots; the puppet has a visibility-aware pump.
- python http.server caches modules: bust with fetch(url,{cache:'reload'}).
- .claude/launch.json gets externally reset; rewrite for verification
  (static 8474 / match 8483 / lobby 8485, pinned dev secrets), git checkout
  it before commits.
- Sample squads are chronically goalless; rig manifests (99-rated attackers
  vs 1-rated GK) when a goal is needed for verification.
- vitest fileParallelism:false is load-bearing (WS suites starve).
- staging-acceptance defaults to localhost — always pass --server.
- SES sandbox until production access approved; test-login-key keeps
  acceptance working regardless.
- The engineer permission set must be FULL-REPLACED from main on every IAM
  change (stale hand-merges have burned hours); pbcopy the file for the
  human.

## METHOD
Branch per slice from origin/main; conventional PR with what/why/proofs and
(when infra changes) the agent phase-prompt + explicit human actions; run
npm test (characterization + vitest) and typecheck before every PR; verify
live in the browser pane; update the project memory file after each slice;
keep responses to the user outcome-first.

## FIRST ACTION
Commit this brief as docs/FULL_APP_BRIEF.md, then take M1 slice 1 (team
identity: stored, editable squads) and proceed on "merged, next slice".
