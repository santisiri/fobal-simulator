# Tactical execution — how GameCommands move the football

Workstream: FOOTBALL AI / TACTICAL EXECUTION. This document covers the
simulation side of the command pipeline: what a validated `GameCommand`
does to the authoritative match, why a command is never a guaranteed
outcome, and exactly which player attributes govern execution. Natural
language, microphones and interpretation live in the sibling workstream —
by the time anything reaches this layer it is a schema-validated command
addressed to canonical player ids.

## The execution model

```
validated GameCommand (protocol zod, closed enums, canonical ids)
  → MatchEngine.submit  (second validation: membership, roles, targets)
  → ordered command log (THE determinism artifact)
  → applied on its effective tick:
      team tactics   → golden TacticalEngine (the one legal funnel)
      player orders  → InstructionBook → station biases + mark binding
  → golden player AI reads stations/tactics EVERY tick
  → attributes bound every actual step, pass, tackle and sprint
```

**The manager moves a player's post; the player still walks there
himself.** Golden players position off a mutable formation station
(`p.slot = {x, y}`, re-read every tick by `formationWorld`) blended with
ball state, line duty, marking and pressing. A per-player instruction is a
deterministic bias of that station — never a teleport, never a scripted
path. "Shoot" doesn't exist as a command at all: shot selection stays
inside the player AI, where `a.shooting`, openness and composure decide.

No LLM output, no network call, and no non-deterministic input ever
enters the tick loop. Commands arrive pre-validated and are applied on
tick boundaries; the simulation is deterministic and LLM-independent by
construction (fallback chain: frontier model → keyword parser → typed
commands — the sim cannot tell the difference).

## The instruction set (v1 — everything here is engine-honored today)

| Instruction | Effect (slot space; base station is captured once) | Notes |
|---|---|---|
| `stay_wide` | station +0.16 toward the player's nearer touchline | |
| `stay_central` | station 0.16 toward the central corridor (never crossing) | |
| `push_forward` | station +0.12 toward the opposition goal | |
| `drop_back` | station −0.12 toward own goal | |
| `overlap` | +0.10 forward AND +0.14 wide — the classic outside run | usually sent with a `ttlTicks` |
| `underlap` | +0.10 forward AND 0.14 toward the half-space — the inside channel run | |
| `hold_position` | pin the exact formation station | |
| `mark_opponent` | golden marking machinery bound to THIS player (`team._marker`) + team `markTarget` | CM-role or DEF-line players only |
| `clear` | restore the station, drop the record | |

Stations clamp to `x ∈ [0.06, 0.93]`, `y ∈ [0.05, 0.95]` — no instruction
can station a player inside a goal. Goalkeepers reject every instruction
(the keeper keeps his post).

**Temporal rules (deterministic, tick-based — no wall clocks):**
- One active instruction per player. A new one **replaces** the old —
  contradictory accumulation is impossible by construction ("drop back"
  after "push forward" simply replaces it).
- Geometry always derives from the captured base station, so replacement
  chains never compound drift.
- `ttlTicks` expires on the tick boundary and restores the station
  (short-lived runs); omitted → persists until replaced/cleared.
- A **formation change deletes the team's spatial instructions** without
  restoring (the new shape just rebuilt every station). Marks survive —
  they are assignments, not geometry.
- Substituted/sent-off players lose their instructions automatically.

**Marking honesty:** golden has ONE marking machine per team. A second
`mark_opponent` on the same team replaces the first. And the machine has
football priorities: a **DEF-line marker subordinates marking to back-line
duty** (your center-back will not abandon the line to chase a roamer),
while a **CM shadows properly** (measured: mean distance to target 18.1 →
8.0). The midfield destroyer is the man-marking tool; this is the sim's
football wisdom, kept on purpose.

## Attribute audit — what the NFT stats actually do

From the golden source (line references into the extracted sim; formulas
paraphrased). External 0–100 ratings normalize once (`normalize.ts`) to
the internal 0..1 `p.a.*` space. The chain's 12 skill lanes map to these
via the documented D1 seam (`ratingsFromSkills`).

| Attribute | Primary mechanics (observed formulas) |
|---|---|
| `pace` | top speed: `BASE_SPEED + a.pace·3.5`, scaled by LIVE stamina |
| `accel` | acceleration: `BASE_ACCEL + a.accel·9` |
| `stamina` | endurance: scales how fast the LIVE stamina meter drains under movement, pressing and duels |
| `strength` | duel cost reduction: `drain·(1.25 − a.strength·0.5)`; throw/clearance power |
| `passing` | pass execution + option scoring (`0.48 + a.passing·0.5` per lane/space) |
| `shooting` | shot decision AND execution (`0.55 + a.shooting·0.8` on openness) |
| `tackling` | duel odds vs carrier: `0.42 + (a.tackling − their a.dribbling)·0.35` |
| `dribbling` | carry control, tackle resistance, touch radius |
| `vision` | pass confidence + option filtering (poor vision discounts far options) |
| `positioning` | back-line organization (line manager averages DEF positioning → trap/organization quality) |
| `aggression` | pressure radius, press speed, foul likelihood |
| `composure` | execution noise: error angle scales with `(2 − a.composure)`; decision confidence |
| `gk` | keeper control/handling (GK-only analog of dribbling) |

**The strategic interaction the product wants is real and measured**: a
high press raises movement and duel volume → LIVE stamina drains at a
rate scaled by `a.stamina` and `a.strength` → tired legs multiply
directly into top speed. Same press order, stamina-95 squad vs
stamina-15 squad: the low-stamina XI is measurably more degraded by the
4200-tick mark (scenario-tested). Fitness is a tactical budget.

## Multiplayer + observability

- Tactical state is authoritative server-side only; clients render.
- Active instructions ride the **snapshot** (`teams[].instructions`), so
  both controllers and spectators see the same tactical truth the sim
  uses; team tactics were already snapshot-synced.
- `GET /matches/:id/tactics` (any match token): both teams' tactics +
  active instructions + the last 20 tactical/instruction commands with
  seq/ticks for provenance. Dev-tool grade; no low-level AI internals.
- Crash-resume: station geometry rides the vm snapshot; the instruction
  book (expiry clocks, base stations, marker binding) rides
  `CapturedState.instructions` — resume-vs-replay hash equality is
  scenario-tested.

## Scenario results (deterministic; `packages/engine/test/tactics.test.ts`)

| Scenario | Measured |
|---|---|
| press_high vs baseline | defensive engagement line +9.7 / +7.7 world units (out-of-possession, per seed) |
| stay_wide CM | mean width vs center +>2 units over baseline |
| push_forward CB / drop_back ST | realized depth ±4.3 avg across 3 seeds (single seeds are chaos — a defender's depth is line-coupled) |
| overlap, pace 95 vs pace 25 | BOTH widen (intent honored); fast covers 1.13–1.31× the ground (capability bounds execution) |
| press vs low-stamina squad | stamina-15 XI measurably more drained than stamina-95 under the same order |
| mark_opponent (CM on their ST) | mean distance 18.1 → 8.0; assignment visible in snapshot |
| ttl / supersede / clear | station restored exactly; no compounding; report empty |
| formation change | spatial instructions cleared, mark survives |
| determinism | live == replay == crash-resume, bit-exact finalStateHash |

## The taxonomy binding (compile table, `packages/protocol/src/orders.ts`)

The language workstream's `GameCommand` player intents lower onto this
engine vocabulary: `stay_wide→stay_wide`, `cut_inside→stay_central`,
`overlap→overlap`, `underlap→underlap`, `hold_position→hold_position`,
`make_forward_runs→push_forward` (with `ttlTicks: 900` — a run is a
spell, not a lifestyle; the station restores itself, say it again for
another burst), `come_short→drop_back`, `mark_player→team markTarget`
("mark their nine" names no marker, so the machine elects one; the
two-player form — "Moretti, mark their nine" — awaits a richer taxonomy).
The compile table also answers what it already knows without a round
trip: instructions for THEIR players and orders to the goalkeeper reject
at compile.

## Deliberate limits (grow the enum only as fast as the sim can honor it)

- Still reserved, each rejecting with its specific reason:
  `press_player` (per-player pressing intensity has no engine binding —
  team pressing works), `shoot_more` / `dribble_more` (tendencies are
  team-level today; per-player needs new engine state). No set-piece
  roles yet.
- An instruction the engine cannot express is REJECTED with the real
  reason (surfaced through the voice-ack chip) — never silently
  approximated. The closed enum is the contract with the language
  workstream: grow it here, bindings first, then let the interpreter emit it.
