# FOBAL — Current Engine Architecture (Golden Reference)

This document characterizes the simulation as it exists today in the single-file
[`index.html`](../index.html) (~8,700 lines, vanilla JS + Canvas, zero dependencies).
It is the baseline for the platform refactor: **behavior described here is contract**.
Any deviation introduced by the refactor must be explicitly documented in
`docs/behavior-changes.md` (which does not exist yet — that is intentional; it gets
created the first time a deviation is knowingly shipped).

`index.html` remains a working golden-reference demo throughout the migration and
must not be edited except for documented, deliberate reasons.

---

## 1. Simulation loop

- **Fixed timestep.** `SIM_STEP = 1/60` seconds. Sim time only ever advances inside
  `Game.step()`, which advances exactly one tick: `simTick++`, then match update,
  AI, physics, fatigue, referee, recorder hooks.
- **Live loop.** `Game.loop()` runs on `requestAnimationFrame` with an accumulator:
  `while (simAcc >= SIM_STEP) { this.step(); simAcc -= SIM_STEP; }` then renders one
  frame (`Renderer.frame(game)`). `simRate` scales accumulation for slow-motion
  (replays); `paused` stops accumulation but not rendering.
- **Headless drives.** `__simulate(seconds)` and the replay/seek machinery call
  `g.step()` in tight loops with no rendering. A tick is a tick: live play, headless
  runs and replays execute the identical code path.
- **Match clock.** `TIME_SCALE = (90*60)/CFG.MATCH_REAL_SECONDS` compresses a match
  into ~210 real seconds. `match.tMatch` accumulates scaled time; halves flip at
  45:00/90:00 with injury time.

## 2. Ball model (`class Ball`)

Independent 3D body, not attached to the pitch grid:

- **State:** `x, y` (meters, pitch space 105×68), `z` height, velocities `vx, vy, vz`,
  ground `spin` (roll), vertical-axis `spinZ` (Magnus curve), `roll`, `flightT`,
  `isShot`, `inNet`, previous-position `px/py/pz`, and possession refs
  (`controller`, `holder`, `intendedReceiver`, `lastToucher`, `lastKicker`,
  `lastTouchTeam`, `prevToucher/2` for assist chains).
- **Physics per tick:** gravity, drag, ground/skid friction (surface- and
  weather-scaled via `ENV` and `PitchSurfaceMap` local damage), bounce with
  restitution clamp, Magnus lateral drift from `spinZ`
  (`ENV.curveMul`-scaled), wind drift, post/bar collision, net first-contact
  rebound + `NET_FX` deformation state, spin/bounce interplay (backspin checks,
  topspin runs on).
- **Kicks:** all impulses go through `doKick(p, game, opt)` — power/height/curve
  derived from attributes, technique, foot, fatigue (`exert`), surface; emergent
  `spinZ` computed from kick side/foot unless the caller supplies explicit spin.
  Dribbling is knock-ahead touches (`touchCd`), not carrying.

## 3. Player model (`class Player`)

- **Identity (immutable per match):** `pid` (`home_10` style, *internal only*),
  name, `num`, `role` (GK/CB/LB/RB/CM/LM/RM/LW/RW/ST → `ROLE_LINE` DEF/MID/ATT),
  nationality `nat`/`flag` from `NATIONS`, `age`, `heightCm`, `weightKg`,
  appearance `app` (skin/hair/shirt — feeds sprites and avatars), `rarity`,
  market `value` (Ξ), token identity via `PlayerTokenMetadata`.
- **Attributes `p.a` (0..1 floats):** pace, accel, stamina, strength, passing,
  shooting, tackling, dribbling, vision, positioning, aggression, composure, gk.
  Age curves adjust pace/accel/composure/positioning at creation.
- **Mutable state:** the authoritative list is
  `SnapshotManager.PLAYER_FIELDS` (facing, runPhase, stamina, duty, think/decide
  timers, kick/touch/tackle/block cooldowns, action + actionT/Dur, walkOff, form,
  value, valueDelta, `_pvx/_pvy/_stamSampleT`, …) plus `pos`, `vel`, `target`.
  **Any new mutable sim field must be added there** or snapshots/replays desync.
- **Fatigue:** `fatigueStep(p, dt, game)` drains by activity (sprint/press/duel),
  `exert(p, base)` charges one-off actions; recovery below a relative-intensity
  threshold. Fatigue feeds think interval, acceleration, shot power/accuracy sigma,
  and positioning wobble. Age >29 drains faster. AI substitutions consume it.

## 4. Seeded randomness (determinism contract)

- **`RNG`** — a seeded generator with `state()`/`restore()`; `srand()` is the
  *only* legal randomness inside sim logic. Snapshots capture RNG state; restoring
  a snapshot and continuing is bit-identical to an uninterrupted run.
- **`Math.random` is cosmetic-only** (crowd phrasing, particles, stadium dressing,
  commentary wording). It must never influence positions, decisions, events,
  scores, or anything hashed.
- **`reset(seed)`** derives *everything official* from `matchSeed`: environment
  (pitch theme, weather, wind), squads (names, attributes, identities), stadium
  layout seed, referee profile. Same seed ⇒ same match.
- **Wall-clock is render-only.** `performance.now()`/`animT` feed animation and UI,
  never sim decisions. Recorded inputs are stamped with authoritative `tick`
  numbers (never rounded wall time) and re-injected at full float precision.

## 5. Match state machine (`class Match`)

States: `KICKOFF, PLAYING, THROWIN, CORNER, GOALKICK, FREEKICK, GOAL, RESET,
HALFTIME, FULLTIME`. Dead-ball states pin the ball to `restart.spot`.

- **Restarts** are phased (`RestartState`): choreography via `restart.spTargets`
  (Map player → {x,y,sw}) consumed by `offBallTarget`'s dead-ball branch;
  `spTargets2` merges delayed runs at `swapT`. `executeRestart()` must run
  **before** `setState('PLAYING')` (offside exemption). Human mode arms
  Space/Shift (or on-screen chips) as the restart trigger.
- **Set pieces:** walls (`WallFormationSystem` behavior inside free-kick staging),
  corner routines (7 delivery types with box crowds and late darts), throw-in
  lanes, goal-kick build-out vs launch, kickoff walk-back after goals (no
  teleporting).
- **Fouls & discipline:** `resolveTackles` computes foul chance (referee
  strictness-scaled), `registerFoul` applies advantage (profile-gated),
  `applyDiscipline` maps severity → yellow/red with referee personality
  thresholds and consistency wobble. Cards, send-offs (`sendOff`), and
  substitutions (`performSub`) remap any player refs held by `match.restart`.
- **Ceremonies:** `match.ceremonyHold = {p, kind}` gates restart firing until the
  player has genuinely left the pitch (sim-clock walk-offs in `Game.update`),
  with hard force-timeout caps (red +7s, sub +5s) so headless runs never hang.
  All waits in the state machine carry force timeouts — that is an invariant.

## 6. Tactics & AI decisions

- **`TacticalScript`** is the single tactics language; **`TacticalEngine`** is the
  single apply-funnel onto `team.tactics` (tempo, crossing, shootTendency,
  overlap, counter, timeWaste, pressAfterLoss, defAggression, gkLong, attackSide,
  markTarget, pressing, aggression, line, width, formation incl. `352`).
- **NL pipeline:** coach console → `parseCoach` (rule-based) or `LLMProvider`
  (OpenAI/Anthropic/Gemini/DeepSeek/OpenRouter/custom; credentials only in
  `localStorage['fobal-llm']`) → TacticalScript → TacticalEngine. **LLM output
  never touches the sim directly** — it can only emit script, so determinism
  holds once script is applied.
- **Decision core:** `carrierDecide` (utility scoring over pass/through/cross/
  shoot/dribble/shield/clear; captures `p.lastEval` for the Debug Decision View),
  `offBallTarget` (formation shape, duties, line-following `LINE_FOLLOW`,
  attack-side bias, set-piece targets), `DefensiveLineManager`, `OffsideSystem`
  (real offside + traps), pressing triggers with continuous scaling (no
  threshold cliffs), GK brain (sweeping, distribution respecting `gkLong`).
- Every attribute, tactic and fatigue level observably shifts these scores — the
  characterization suite pins several of these relationships.

## 7. Script recorder (`MatchRecorder`, `EventSerializer`)

- Records **as the match plays**: semantic events (passes, shots, tackles, fouls,
  cards, restarts, subs, tactic changes, calls), human inputs
  (`human_move/kick/select/mode`, `take_trigger`) at full precision with `tick`
  stamps, movement samples, and periodic full `SnapshotManager` snapshots (~5s).
- `EventSerializer.pid/tid` translate object refs ⇄ stable string ids
  (`home_10`); these ids are **internal** today — the refactor's protocol layer
  maps them to externally supplied ids at the boundary.
- Export: `__exportScript()` → versioned JSON document (`SCRIPT_VERSION = '1.0'`,
  kind `fobal-match-script`: metadata, match{seed,human}, teams, initialState,
  timeline, events, snapshots, finalState). Import: `ScriptParser` +
  `ScriptValidator` (never throws into the sim; returns errors/warnings) +
  `ScriptRunner`.

## 8. Snapshots (`SnapshotManager`)

Complete sim capture/restore: tick, seed, **RNG state**, env keys, counts, ball
fields + refs, match block (state/stateT/half/tMatch/score/restart Maps by pid/
pendingFoul/ceremonyHold/banner), referee kinematics, per-team tactics + stats +
GK ref, every player's `PLAYER_FIELDS` + position/velocity/target, human mode +
selection, kick buffer, celebration refs.

**Invariant:** restore → continue must equal an uninterrupted run (verified
empirically; it is what makes seek, goal replays and server-side recovery
possible).

## 9. Replay system

- **`ScriptRunner` strict mode:** re-injects only *exogenous* events (human
  inputs, take triggers, tactic changes, non-auto subs) at their recorded ticks
  and lets the deterministic sim regenerate everything else; a drift watchdog
  compares snapshots at `snapshot.tick === simTick - 1` (snapshots are post-tick)
  and resyncs on divergence (0 resyncs expected — that's a characterization test).
- **Adaptive mode:** treats the timeline as intent (possession grants, 3.5s
  grace) so hand-written scenarios play out on a living pitch.
- **`ReplayController`:** transport (play/pause/step by event or frame/seek via
  snapshot restore + silent catch-up/speed 0.25–4×/A-B loop) + script editor.
- **`GoalReplayManager`:** on goal, captures a live snapshot, rolls back to a
  pre-goal snapshot, re-simulates with the recorded human-input feed under
  cinematic cameras, then restores. `abort()` **discards** (never restores) —
  `reset()` owns fresh state. `game.replayMode` gates recorder/announcer/fx/
  stadium reactions and blocks live keyboard from reaching the sim.

## 10. Input handling

- **`class Input`:** keyboard state map + edge-triggered `pressed` set, consumed
  by `handleGlobalKeys` (UI toggles) and `humanControl` (WASD/arrows move, Space
  pass w/ held power via `kickBuffer`, Shift shoot, E switch).
- **`GestureInputManager`:** one pointer pipeline for mouse + touch — tap
  selects (zoom-aware hit test via `renderer.lastZoom/lastOx/lastOy`), drag pans
  the free camera, pinch/wheel zooms; `onPointerZones` (press) and
  `onPointerWorld` (release) callbacks.
- **Input-source composition** (highest wins): goal-replay recorded feed →
  `scriptRunner` feed → live keys. During script sessions and goal replays the
  live keyboard must never reach the sim.
- **UI hit zones:** canvas-drawn UI registers `game.ui.zones` each frame (wiped
  per frame, last registered wins, callbacks receive `(cx, cy)`).

## 11. Canvas rendering

- **`class Renderer`:** owns the single `<canvas>`, DPR-aware resize, pre-rendered
  static background (`this.bg` redrawn on env change), isometric projection
  `project(x, y, z)` (2:1-ish diamond), camera lerp toward
  `CameraSystem.frameTarget()` (replay cinematics > presentation focus > free
  camera > ball/player follow), zoom about screen center.
- **Draw order:** background → pitch damage/lines → stadium (`StadiumBuilder`
  modules, `CrowdSection` pre-rendered 12-frame kinds, sideline actors, props) →
  depth-sorted entities (players via pose sprite atlas `getSprite`, ball with
  trail/shadow, net deformation `drawGoalNet`) → FX → broadcast overlay
  (`BroadcastOverlay` banners, score bug) → panels (`UITheme`, `glassPanel`,
  `rrPath`) → replay letterbox (`BroadcastReplayOverlay`).
- **Render-only state:** `animT`, camera, crowd moods, particles. None of it may
  feed sim decisions; walk-off *movement* is sim-clock precisely because restarts
  wait on it.
- **Avatars:** `ProceduralAvatarGenerator` + `OnChainSVGEncoder` build
  deterministic SVGs from token ids; `AvatarCache` rasterizes them for canvas.

## 12. Console / QA API (headless contract)

`window.__reset(seed)`, `__simulate(seconds)`, `__exportScript()`,
`__downloadScript()`, `__loadScript(doc, {mode})`, `__validateScript(json)`,
`__setEnv/__unlockEnv`, `__coach(text)`, `__tactics`, `__llmConfig`,
`__tokenMetadata`, `__avatarSVG`, `__present(bool)`, and the `game` global.
These are the seams the characterization harness drives.

## 13. Known refactor seams

What the coming phases hook into, in dependency order:

1. **Characterization harness** boots this file in Node with DOM/canvas stubs and
   drives `__reset/step/__simulate/__exportScript` (Phase 1).
2. **Protocol** (`packages/protocol`) formalizes the script/snapshot/event shapes
   above with Zod and stable *external* ids (Phase 2).
3. **Engine** (`packages/engine`) wraps the identical sim core headlessly behind a
   manifest adapter — strangler-fig, not a rewrite: internal `home_N` pids become
   an implementation detail mapped at the boundary; 0–100 external ratings are
   normalized to the 0..1 attribute space in exactly one adapter function
   (Phase 3).
4. **Client** (`apps/match-client`) keeps this renderer, fed either by the local
   engine or by server snapshots/deltas (Phase 4); **server**
   (`apps/match-server`) runs the engine authoritatively (Phase 5).

Invariants worth repeating because every phase leans on them:

- `team.passCmp === Σ player passCmp` (single-credit stat attribution).
- Every ceremony/restart wait has a force timeout.
- `executeRestart()` before `setState('PLAYING')`.
- New mutable player fields go into `SnapshotManager.PLAYER_FIELDS`.
- Full-precision, tick-stamped input recording.
- Sim never reads wall-clock; cosmetics never call `srand()` *after* boot-time
  derivation is complete (and never mutate sim state).
