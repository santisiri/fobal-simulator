# FOBAL product roadmap

Status date: 2026-08-02. Staging is live and formally accepted
(`https://matches-staging.fobal.ai`, 20/20 acceptance including bit-exact
local re-execution of a staging replay and mid-match task-replacement
durability).

## North star

Online matches between two humans who find each other on a matchmaking
platform, watch and steer the SAME game they know from Local Mode — same
graphics, same feel — and coach their teams **by voice**: speech becomes
text, text becomes tactical instructions on the field. Eventually, teams
themselves are fed from web3 NFTs that carry the players' identities and
ratings.

## Principles (carried forward, non-negotiable)

1. **The golden reference stays golden.** `index.html` remains the visual
   and behavioral truth. Online Mode reaches parity by REUSING golden code
   against networked state, never by reimplementing the look by hand.
2. **The determinism boundary is sacred.** Voice, LLMs, matchmaking, and
   chains are INPUT DEVICES. Only validated protocol commands and manifests
   cross into the engine; `manifest + command log` must always reproduce
   the match bit-for-bit. No model call, chain read, or microphone ever
   lives inside the sim.
3. **Proof-gated phases.** Every phase ships with its own acceptance
   checks, in the tradition of the five proofs and the 20-check staging
   acceptance. A phase is done when its proofs pass, not when it demos well.
4. **Agent split.** Repo-side work (engine, client, protocol, tools) is
   Claude Code's; AWS-side work is the infra agent's, under the
   FobalStaging/boundary guardrails. Permission changes remain explicit
   human-granted diffs to `infra/iam/`.

---

## Phase A — One game, two transports (visual parity for Online Mode)

**Goal:** a spectator or controller in Online Mode cannot tell the
presentation apart from Local Mode.

**Strategy — puppet the golden presentation.** The strangler-fig pattern
that gave us the headless engine, run in reverse: boot the golden script in
the browser with its SIMULATION disabled and its presentation driven by a
state adapter fed from the server stream (snapshots + deltas through the
existing interpolation buffer). Same code ⇒ same pixels, by construction.
`apps/match-client/src/render.js` (the deliberate 131-line minimal
renderer) already documents this as the intended endgame.

Work items:

- A1. **Puppet seam in the golden script**: a boot flag that skips sim
  stepping while keeping render loop, stadium, crowd, avatars, HUD, and
  audio alive. Extraction stays byte-identical (`tools/extract-inline-script.mjs`);
  the seam must be additive and inert in Local Mode.
- A2. **State adapter**: map protocol `StateSnapshot`/`StateDelta` (+
  manifest) onto the golden runtime's object shapes — players, ball
  (position/velocity incl. z), score, clock, match state. External ids →
  golden entities via the manifest.
- A3. **Cosmetic state audit**: enumerate what the golden presentation
  reads that the protocol does not carry (celebrations, card ceremony
  cues, kit colors, avatar seeds…). Close gaps either derivably
  (deterministic avatar seed from playerId) or with a small additive
  protocol version bump. Keep cosmetic data OUT of the deterministic hash.
- A4. **Goal replays online**: play the server's re-simulated clips
  (`/replays/goals`) through the golden cinematic presentation as pure
  playback — the authoritative engine never rewinds (hard rule).
- A5. **Controller UX**: the Local Mode tactical panel wired to protocol
  commands (`tactical` patch + `coach_text`), with ack/reject feedback.

**Proofs:** same-seed side-by-side (Local vs puppet driven by a local
server) screenshot comparison across match beats (kickoff, goal, halftime,
card, full time); a parity checklist per golden feature; reconnect and
resume replay through the puppet renderer; existing characterization suite
untouched.

## Phase B — Matchmaking platform + hosted client

**Goal:** players log in at `play-staging.fobal.ai`, see who's online,
challenge someone, and both drop into the same authoritative match.

Work items:

- B1. **Lobby service** (`apps/lobby-server`): accounts (start with email
  magic-link; wallet auth arrives with Phase D and both can coexist),
  presence, challenge → accept flow, player team storage. It holds the
  match-server create key server-side, builds the manifest from both
  players' teams, creates the match, and hands each player their
  controller token (spectator links shareable).
- B2. **Hub hardening for browsers**: CORS on the HTTP endpoints, WS
  origin checks, per-IP connection limits (per-team command rate limits
  already exist).
- B3. **Hosted client**: static client on S3 + CloudFront at
  `play-staging.fobal.ai` (ACM cert in us-east-1 for CloudFront — note the
  region difference from the ALB cert), pointed at the staging WSS.
- B4. **Infra** (infra agent): CloudFront + client bucket, DynamoDB for
  accounts/presence/challenges, lobby service deployment (second small
  Fargate service or Lambda — decide by lobby's WS needs for presence),
  extending the same `fobal-staging-*` scoping and IAM package pattern.
- B5. **Match lifecycle UX**: rematch, match history per account (results
  are already signed and replayable — the lobby stores result pointers,
  never authors results).

**Proofs:** two fresh accounts on two machines complete a full
challenge → play → signed result → replay loop on staging; a third browser
spectates via link; lobby cannot mint results (only the match server signs);
acceptance script extended with a lobby section.

## Phase C — Voice coaching (speech → text → field)

**Goal:** hold a button, say "press higher and switch to a back three,"
and watch the team obey — with the instruction visible in the event feed.

**Head start:** the protocol ALREADY carries `coach_text` commands (≤280
chars, rate-limited, sequenced, logged) and the engine ALREADY parses them
through the golden `parseCoach` inside the deterministic boundary. Voice
v0 is transport, not invention.

Work items:

- C1. **v0 — speech to coach_text**: push-to-talk in the client; STT via
  hosted Whisper-class API (or browser speech recognition where
  acceptable); transcript sent as the existing `coach_text` command;
  parseCoach's acks/messages surfaced in the UI. Ships against today's
  server unchanged.
- C2. **v1 — LLM tactical interpreter**: a Claude call maps free speech
  (any language) to either a structured `tactical` patch or a refined
  coach_text, plus a natural-language confirmation ("Pressing high,
  compact back three — done"). Runs in the lobby/api layer with keys in
  Secrets Manager — this replaces the golden-era pattern of provider keys
  in browser localStorage, which must not survive into the platform.
- C3. **Latency + safety budget**: end-to-end voice→ack target ≤ 3s;
  the LLM output is schema-constrained (Zod-validated command or
  rejection), so prompt injection can at worst produce a legal tactical
  command; per-team rate limits already cap the blast radius.
- C4. **Replay transparency**: the command log records the structured
  command (and the transcript in command metadata if we choose) — replays
  reproduce exactly what the voice caused, never re-invoke a model.

**Proofs:** spoken instruction (in at least two languages) produces an
acked command whose effect is visible in team behavior; replay of a
voice-coached match is bit-identical; kill the STT/LLM provider mid-match
and the match is unaffected (inputs fail soft, sim never notices).

## Phase D — Web3: NFT-fed teams

**Goal:** a team's players — names, appearance, ratings — come from NFTs a
player owns; match results are verifiable artifacts.

Work items:

- D1. **Team registry adapter**: chain read (ERC-721/1155 metadata) →
  `PlayerSnapshot` via the single rating-normalization seam → validated
  `MatchManifest`. Chain access lives in the lobby layer only; the match
  server continues to see nothing but manifests.
- D2. **Wallet auth** in the lobby (coexists with email accounts).
- D3. **Verifiability story**: manifests referenced by content hash;
  results are already Ed25519-signed with first-write-wins idempotency —
  publishable/anchorable if we later want on-chain records. A stable
  signing key (see backlog) becomes a prerequisite here.
- D4. **Decisions to make when we get here**: which chain; who mints and
  what the metadata schema is; whether ratings are immutable-at-mint or
  evolve (evolution belongs off-chain with periodic anchoring); whether
  results anchor on-chain at all in v1.

**Proofs:** a manifest built from testnet NFTs plays a full staging match;
the same wallet on a second device reconstructs the identical manifest;
result signature verifies against the published server key.

---

## Cross-cutting backlog (slot between phases as capacity allows)

- **Observability PR** (deliberately deferred from the extraction
  sequence): structured logs + CloudWatch metrics for rooms, connections,
  rejected commands, snapshot/result writes. Do this EARLY in Phase B —
  matchmaking multiplies concurrent matches.
- **Stable result-signing key**: generate once, store in Secrets Manager,
  inject via `FOBAL_SIGNING_KEY` (env plumbing already exists). Required
  before Phase D's verifiability story; cheap any time.
- **GitHub Actions OIDC deploy pipeline**: image build/push + `cdk diff`
  on PR, deploy on merge — per the constraints already written into
  `docs/IAM_ACCESS_REQUEST.md` (no static keys, scoped role).
- **EC2 runner egress flakiness**: diagnose or replace the infra agent's
  box; it has salted two acceptance runs.

## Sequencing rationale

A → B → C → D, with C1 (voice v0) as a deliberate early cheat: it can ship
during Phase B since the server side already exists — and it is the
single most demo-able feature of the whole vision. Phase A comes first
because every user-facing phase inherits its client, and because the
cosmetic-state audit (A3) is the last protocol-shaping work — better to
version the protocol once, early. Phase D is last because it changes
where teams COME FROM, which only matters once matches, matchmaking, and
the experience are worth owning.

## Open decisions (flagged now, decided later)

1. Auth for launch: email magic-link only, or wallet-first from day one?
2. Lobby transport: does presence justify a WS lobby service on Fargate,
   or is polling + Lambda enough for staging-scale?
3. STT provider: hosted Whisper API vs browser-native speech recognition
   (cost/quality/privacy trade).
4. Transcript retention: store voice transcripts in command metadata
   (replay transparency) or discard after parsing (privacy)?
5. Chain + metadata schema for Phase D.
