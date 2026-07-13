# Characterization suite (golden reference: `index.html`)

These tests pin the **current** behavior of the single-file engine so the
platform refactor cannot silently change it. They run the real game script in
pure Node (no browser, no build step):

```sh
node --test 'tests/characterization/*.test.mjs'
```

## How it works

- `tools/extract-inline-script.mjs` pulls the inline `<script>` out of
  `index.html`.
- `harness/sandbox.mjs` + `harness/boot.mjs` boot it in a hermetic `node:vm`
  context with stub DOM/canvas/localStorage. `requestAnimationFrame` is queued
  but never fired — tests drive `game.step()` (the fixed 1/60s tick) directly.
- `goldens.json` holds pinned hashes, statistics, state-machine timelines and
  NL-coach mappings captured from the current engine. `util.mjs#fullHash` is an
  FNV-1a digest over official sim state (tick, score, clock, RNG cursor, ball
  kinematics, every player's position/velocity/stamina/action) — cosmetic
  state is deliberately excluded.

## Coverage

| Spec | Pins |
|---|---|
| 01-fixed-timestep | tick-only time, chunked ≡ monolithic stepping |
| 02-seeded-rng | seed → squads/env/referee, RNG state round trip, cosmetic isolation |
| 03-player-movement | 22-player kinematics hashes, bounds, GK discipline |
| 04-passing-shooting | pinned pass/shot stats, single-credit attribution invariant |
| 05-goal-detection | first natural goal tick + scorer, line-crossing geometry |
| 06-set-pieces | exact state-machine path, ball pinned to restart spot, resumption |
| 07-tactical-changes | tactics defaults, NL phrase mappings, observable divergence |
| 08-script-roundtrip | export shape, strict replay bit-exactness (0 resyncs), malformed rejection |
| 09-goal-replay | auto replay engages/returns, whole sequence deterministic |
| 10-identical-io | same seed + same inputs ⇒ same hash; inputs and seeds both matter |

## When a test fails

That is the suite doing its job: `index.html` changed behavior. Either fix the
regression, or — if the change is intentional — regenerate the goldens and
document it:

```sh
node tools/update-goldens.mjs   # rewrites goldens.json from current index.html
```

and add an entry to `docs/behavior-changes.md` explaining what changed and why.
`01-fixed-timestep` verifies `goldens.json` was generated from the exact
current script (source hash), so stale goldens are caught immediately.

Note: pinned hashes are exact floating-point captures. They are stable across
runs and machines for a given V8 build; a major Node/V8 upgrade can in theory
perturb transcendental functions — if the suite fails after a Node upgrade
with no repo changes, regenerate goldens and note the environment change.
