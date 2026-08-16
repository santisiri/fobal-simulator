# Next-iteration architecture — live AI-directed football

**The product north star:** fobal.ai is not an NFT minting app or a
traditional web3 manager. Its core experience is a LIVE multiplayer match
where two human managers bring their owned NFT squads onto a pitch and
direct them in real time by natural language and voice.

```
HUMAN VOICE
  → SPEECH-TO-TEXT
  → LANGUAGE / INTENT INTERPRETATION
  → STRUCTURED FOOTBALL COMMAND
  → VALIDATION
  → AUTHORITATIVE MATCH SIMULATION
  → PLAYER AI
  → LIVE VISUALIZATION
```

This document maps that model onto the codebase, names the seams, defines
the workstream that closes the gaps, and records the principles no future
slice may violate. The honest headline: **the pipeline above already runs
in production** (M4 voice v2) — what remains is widening the command
language from team-level to player-level and keeping the seams clean as it
grows.

---

## The critical design principle (already the constitution)

**The LLM never mutates match state.** It interprets human intent into a
structured command; the protocol schema validates it; only the validated
command enters the ordered log; the authoritative simulation applies it on
a tick boundary. This has been the determinism rule since C2: *the model
is an input transformer* — manifest + command log = bit-exact replay,
whether the command came from a keyboard, a keyword parser, or a frontier
model. A dead LLM degrades to the keyword parser; a hallucinating LLM can
produce at worst a *valid but unwise* command.

The simulation alone owns physics, movement, ball state, possession,
rules, collisions, player capability, tactical execution, randomness, and
outcomes. **A manager ASKS; the player's attributes decide how well it
happens.** Order a slow defender to sprint the wing and the sim respects
his pace, stamina, and positioning — the instruction is accepted, the
execution is earned. This capability-respect is inherent, not enforced by
review: commands can only set *intent* fields (tactics, assignments,
targets); execution flows through the engine's per-player attribute model,
which reads ratings that came from the manifest — and for NFT squads,
from the chain.

## Blockchain vs live state (already the deployed split)

| Layer | Owns | Exists as |
|---|---|---|
| **On-chain** (Base) | player ownership + identity, canonical attributes/progression, squad ownership, economically meaningful results, staking/rewards | `contracts/` — FobalPlayer/Registry/Escrow/Progression/Marketplace, live on Base Sepolia |
| **Authoritative server** (real-time) | ball/player positions, tactical state, live commands, sim ticks, temporary stamina, possession, clock, events | `apps/match-server` — vm-wrapped golden engine, ordered command log, Ed25519-signed results |
| **Post-match bridge** | validated results → controlled progression/rewards | `FobalMatchEscrow.settle` verifies an engine-signed EIP-712 `MatchResult` whose `progressionHash` binds every player's capped deltas — one signature covers score AND progression. Wiring the live match server's signer to it is future work; the contracts and caps are done |

Frame-by-frame state never touches the chain. Replays are server
recordings; verification is signature-based (results Ed25519 today,
EIP-712 for settlement), never re-simulation.

## Component map — target interfaces vs what exists

| Target interface | Today | Status |
|---|---|---|
| `SpeechToTextProvider` | `apps/match-server/src/stt.ts` `createTranscriber` — OpenAI-compatible wire shape; provider swapped by env (`FOBAL_STT_URL/MODEL/API_KEY`: OpenAI, Groq, anything speaking the shape); browser SpeechRecognition as automatic fallback | ✅ abstraction exists; rename-in-place candidate |
| `VoiceSession` | `puppet.js` `enableVoice` — MediaRecorder capture, push-to-talk lifecycle, the voice-ack chip state machine (listening→transcribing→thinking→sent→**applied on server ack**) | ✅ exists informally; extract when a second surface (apps/web) needs it |
| `CommandInterpreter` | `hub.ts` `interpretFor` — LLM with live match context → JSON via structured outputs → protocol-validated patch. Provider seam = injectable `coach.client`; the OUTPUT SCHEMA is provider-independent (zod in `packages/protocol`) | ✅ exists; second-provider adapter proves the seam when needed |
| `GameCommand` | protocol commands: `coach_text`, tactical patch, substitution | ⚠️ team-scoped only — **the widening is workstream G's core** |
| `CommandValidator` | protocol zod schemas + `room.rejectCommand` chokepoint (rate limits, role gates, state gates) | ✅ two-layer validation exists |
| `TacticalCommandBus` | the WS command path: client → hub → validate → persist → apply; acks/rejections per command id | ✅ exists |
| `MatchSimulationAdapter` | `packages/engine` MatchEngine — the vm-wrapped golden sim behind a typed apply/step/snapshot surface | ✅ exists; per-player instruction bindings are the gap |
| `PlayerAgent` | the golden engine's per-player AI (decision-making from attributes; `spTargets` choreography hook and `markTarget` prove per-player steerability) | ✅ exists inside the engine |
| `TeamTacticalState` | golden tactics block, snapshot-synced to clients | ✅ exists |
| `MatchEvent` | protocol event stream (seq-ordered, replayed on resume) | ✅ exists |
| `MatchCommandLog` | persisted ordered `commands.jsonl` — THE determinism artifact | ✅ exists |

No component needs a rewrite; the lobby, the NFTs, and the simulator are
already isolated behind these seams. Workstream G grows the middle
(command language + interpreter + engine bindings) without touching them.

## Command taxonomy v1 (workstream G's first deliverable)

Three scopes. Every example from the product brief maps:

**TEAM** — one tactical state, patched:
- "Press them high" → pressing ✅ *(works today)*
- "Drop the defensive line" → line height ✅
- "Play more direct" / "Slow the tempo down" → directness/tempo ✅
- "Move to a 4-3-3" → formation ✅
- "Switch the attack to the right" → attacking-side bias ⚠️ *(new field)*
- "Counterattack when we recover the ball" → transition trigger ⚠️ *(new field)*

**PLAYER** — instructions addressed to one of YOUR players by name/number
(resolved against the manifest — the interpreter already has it in
context), or targeting one of THEIRS:
- "Mark their number nine" → marking assignment ⚠️ *(engine `markTarget` exists; needs the command path)*
- "Ferreyra, overlap on the left" → positional instruction ⚠️
- "Moretti, stay inside the box" → positional discipline ⚠️

**MATCH** — squad operations:
- Substitutions ✅ *(works today)*

Schema plan: a versioned `PlayerInstruction` command in
`packages/protocol` — `{ playerId, instruction, params? }` with a CLOSED
instruction enum (mark, overlap, hold-position, push-forward, stay-back,
…), validated against the manifest's roster. Closed enums are the
provider-independence guarantee: any interpreter, any model, any language
in the microphone — the same small command surface comes out, or nothing
does. Instructions the engine cannot express yet are REJECTED with the
real reason (surfaced through the voice-ack chip), never silently
approximated — the vocabulary grows only as fast as the sim can honor it.

## Latency (the budget is a product feature)

Voice-to-acknowledgment budget: **≤ 3s** (brief M4; alarmed in CloudWatch).

| Stage | Measured today | Gap |
|---|---|---|
| audio capture | — | client stamp at record-stop (G4) |
| transcription | `SttMs` ✅ | |
| LLM interpretation | `CoachInterpretMs` ✅ | |
| command validation | sub-ms, inside accept path | expose if it ever matters |
| simulation application | next tick, ≤100ms at 10Hz | |
| **end to end** | — | `VoiceToAckMs`: capture-stop → server `command_ack`, client-measured, reported once per command (G4) |

Critical-path rules already in force: STT + interpretation ride ONE server
round trip (`/coach/voice`); nothing blocks the sim loop (interpretation
is pre-command, async); acks are pushed, not polled. Future levers when
the budget tightens: streaming STT (partial transcripts into the chip),
speculative interpretation on interim text, provider selection by
measured latency (Groq's whisper tier exists behind the same env seam).

## Workstream G — AI Gameplay / Voice Command Architecture

Parallel to existing workstreams; incremental by design. Nothing here
rewrites lobby, NFTs, or the simulator.

- **G1 — taxonomy + schema**: the closed command taxonomy above lands in
  `packages/protocol` (versioned; log-forward-compatible so old replays
  stay valid). No engine change.
- **G2 — text-command prototype**: the typed coach console (exists) plus
  the interpreter prompt extended to emit player-scoped commands. Ships
  behind validation: until G3, player commands validate then no-op with
  an honest "not yet on the pitch" rejection — the full loop is testable
  before the engine binds.
- **G3 — engine bindings**: per-player instructions applied through the
  established choreography seams (`markTarget`/`spTargets` precedent),
  attribute-respecting by construction. Golden reference untouched;
  bindings live in the adapter layer. Goldens/characterization guard.
- **G4 — latency instrumentation**: client capture stamps, `VoiceToAckMs`,
  dashboard row per stage, per-provider comparison.
- **G5 — session polish**: streaming partial transcripts, interim-text
  display in the chip, multi-command utterances ("press high and mark
  their nine" → two commands, two acks).

**Non-goals this iteration**: the complete football AI, new engine
behaviors beyond instruction bindings, on-chain per-match state, provider
lock-in of any kind.

## Standing invariants (checklist for every G slice)

1. Interpreter output validates against `packages/protocol` or it does not
   exist. No free-form patches, ever.
2. Only validated commands enter the log; replay stays bit-exact.
3. The golden reference `index.html` is never modified.
4. Providers (STT and LLM) stay swappable by config; the command schema
   never imports a provider type.
5. Rejections are honest and surfaced to the speaking manager (the
   voice-ack chip is the contract: green only on server ack).
6. Capability-respect: commands set intent; attributes decide execution.
