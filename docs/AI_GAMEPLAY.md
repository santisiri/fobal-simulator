# AI Gameplay — the natural-language command architecture (workstream G)

The first production-quality path from human tactical intent to the
authoritative simulation. Companion to `docs/NEXT_ITERATION_ARCHITECTURE.md`
(the charter); this documents what is BUILT.

```
TEXT or VOICE
  → [SpeechToTextProvider]        apps/match-server/src/stt.ts  (voice only)
  → CommandInterpreter            apps/match-server/src/coach.ts
  → GameCommand (canonical)       packages/protocol/src/orders.ts
  → resolve + compile             orders.ts (deterministic, manifest-bound)
  → wire Command over WS          the EXISTING transport, validated again
  → authoritative simulation      packages/engine (untouched)
  → acks / events / feed / chip   observable result
```

## The taxonomy (canonical, closed, versioned)

`packages/protocol/src/orders.ts`. Three scopes; every intent either maps
to a REAL engine capability or is explicitly reserved.

**TEAM (21 intents — all bind today)**: `press_high` `press_medium`
`drop_deep` `push_higher` `increase_tempo` `decrease_tempo` `play_direct`
`play_short` `retain_possession` `counterattack` `attack_left`
`attack_right` `attack_center` `increase_width` `decrease_width`
`waste_time` `all_out_attack` `park_the_bus` `shoot_on_sight`
`work_it_into_the_box` `cross_more` — each compiles to a `TacticalPatch`
over the engine's existing tactical surface (pressing, defLine, tempo,
width, style, attackSide, …). Absolute values by design: "press high"
means the same thing in every match. Comparative language ("press a BIT
harder") flows through the interpreter's free-form numeric patch instead,
relative to current tactics.

**PLAYER (11 intents — 1 binds, 10 reserved)**: `mark_player` binds NOW
(compiles to the engine's man-marking assignment: `markTarget` +
`scheme:'man'`). `stay_wide` `cut_inside` `overlap` `underlap`
`hold_position` `make_forward_runs` `come_short` `press_player`
`shoot_more` `dribble_more` are reserved: they validate, resolve their
target (so a typo'd name is a NAME error, not a fake "unsupported"), and
reject honestly — *"Ferreyra: not on the pitch yet"*. G3 binds them
through the engine's choreography seams without touching this layer.

**MATCH (2 intents — both bind)**: `change_formation` (442|433|352),
`substitution` (compiles to the existing wire substitution; the engine
stays the authority on bench membership and sub limits).

## GameCommand schema

Provider-independent zod (`GameCommand` in orders.ts): `{version, scope,
intent, target?, formation?, sub?, intensity?}`. The transport envelope —
`commandId`, `teamId`, `matchId` (the room), server `seq`,
`effectiveTick`, timestamps — is supplied by the EXISTING wire `Command`
the order compiles into, so nothing is duplicated and the command log
(`commands.jsonl`) remains the single authoritative record. No LLM
implementation detail exists anywhere in the domain model.

**References, never ids.** Interpreters emit `PlayerRef {side, name?,
shirtNumber?}`. `resolvePlayerRef` maps refs to canonical manifest
playerIds deterministically: shirt number exact → normalized surname token
match (diacritics folded) → substring → ambiguity is a terse question
(*"Moretti or Costa?"*), zero matches is an error. **A model cannot invent
a player that survives — there is no id field to hallucinate into.**

## Validation (layered, all deterministic)

1. Structured-output JSON schema at the model boundary (closed intent enums).
2. `GameCommand.safeParse` per order — malformed shapes dropped.
3. `resolvePlayerRef` — targets must exist on the correct side.
4. `compileGameCommand` — semantic rules (marking targets opponents;
   reserved intents refused with reasons).
5. The room, on command arrival — controller token, team ownership, match
   state, rate limits, sequencing: the same authority every command has
   always faced. Interpreter output NEVER reaches the simulation directly.

## Provider abstractions

- **LLM**: `createCoachInterpreter({client?, apiKey?, model?})` — the
  client is injectable (tests run a fake; a second vendor is an adapter
  implementing `.messages.create`). The output contract is the JSON
  schema + protocol zod — provider-free.
- **STT**: `createTranscriber({url, model, apiKey})` — any endpoint
  speaking the OpenAI-compatible multipart shape (OpenAI `whisper-1`,
  Groq `whisper-large-v3-turbo`, …). Browser SpeechRecognition remains
  the automatic fallback. Mic permission handling, push-to-talk record
  state, cancel (Escape), and device-failure fallback live in
  `puppet.enableVoice`. Raw audio is never stored — it is transcribed and
  discarded in one request.

## Context (compact by design)

The interpreter receives: instruction, team name, score, minute, current
tactics, opponent's formation/style/pressing, and `rosterDigest` of both
sides — shirt/name/role, ~15 rows per side. Nothing else. No positions,
no ball state, no sim internals.

## Command lifetime

- **Instant**: substitutions.
- **Persistent-until-replaced**: every compiled tactical intent — orders
  patch the team's tactical state; the next order touching the same
  fields overwrites (last wins per field, no contradiction accumulation).
- **Cancellation** = issue the counter-order.
- **Timed instructions** ("for five minutes") are a documented non-goal
  until the engine can expire state.

## Attributes decide execution

Orders set INTENT fields only (tactics, marking assignments). Execution
flows through the engine's per-player attribute model — ratings that came
from the manifest, and for NFT squads from the chain. A slow defender
ordered to press does so at his own pace, stamina, and judgment. This
workstream reads players through the shared manifest interface and never
touches canonical NFT stats.

## Multiplayer fairness

Interpretation endpoints never mutate a match. The client sends every
compiled command over its own authorized WebSocket; the room validates,
sequences, logs, and applies at an effective tick; both players receive
the same snapshots/deltas. The command log answers: what was asked
(`coach_voice`/`coach_interpreted` telemetry carries transcript size and
order counts), what the system understood (the compiled command IS the
log entry), whether it was accepted (acks/rejections per commandId), and
when it affected the simulation (`effectiveTick`). No chain-of-thought or
hidden model reasoning is ever stored.

## Feedback to the player

Short by design (live play, glance-speed): per-order golden announcements
(`PRESS HIGH ✓`, `MARK #9 ÖZ ✓`, `SUB BA → MAN1`), rejections with the
real reason (`✗ Moretti or Costa?`), the voice-ack chip green only on the
server's `command_ack`, and the assistant coach's one-line `say` in the
speaker's language. The events are exposed through `puppet.voiceHooks`
and `puppet.inspectorHook` — the UI workstream owns the visuals.

## Latency instrumentation

Server: `SttMs`, `CoachInterpretMs` (EMF metrics + dashboard + the 3s
budget alarm), and both now ride the HTTP response as `latency: {sttMs?,
interpretMs}`. Client: the `?inspector=1` panel stamps command send →
server ack per commandId (end-to-end the manager cares about). Nothing in
the critical path blocks the sim loop; STT + interpretation share one
round trip.

## The developer command inspector

`index.html?inspector=1` — a dev-only panel (never rendered otherwise):
transcript/input → each order (scope/intent/ack) → rejections with
reasons → patch fields → server latency → per-command ack round-trip with
`effectiveTick`. This is STEP 5's text-command prototype surface: type
into the golden coach console (or call
`__puppet.interpretAndSend(__conn, 'press high')`) and watch the whole
pipeline.

## Testing strategy

- `packages/protocol/test/orders.test.ts` — the deterministic core:
  resolver (surnames, shirts, diacritics, ambiguity, sides, invented
  names), schema closure, the full compile table, determinism.
- `apps/match-server/test/coach-orders.test.ts` — the endpoint with a
  FAKE model: multi-order compile, invented-player death, reserved
  rejection, malformed-order dropping, substitutions, say-only
  degradation. Plus `PHRASE_DATASET` (the representative phrasings →
  expected intents) and a live-model smoke that runs ONLY when
  `ANTHROPIC_API_KEY` is present — the suite never depends on paid calls.

## Known limitations (honest list)

- 10 of 11 player intents are reserved pending G3 engine bindings; only
  marking reaches the pitch today.
- One `markTarget` per team (the engine's model) — "mark their nine AND
  their seven" keeps the last.
- Ambiguity between two players sharing a surname produces a degenerate
  question ("Moretti or Moretti?") — first-name disambiguation is queued.
- The voice chip tracks the LAST command of a multi-order utterance; the
  summary line carries all acks.
- No timed/conditional instructions ("until we score", "for 5 minutes").
- Clarification is one-way (the question is shown; the answer is a new
  utterance) — no dialogue state is kept.
