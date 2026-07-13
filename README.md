# FOBAL SIMULATOR

A complete retro-isometric football simulation in **one self-contained HTML file** — no libraries, no assets, no server. Inspired by the camera and pacing of early-90s classics (FIFA International Soccer, Sensible Soccer) with modern physics and AI underneath.

The repo is also a **simulation platform** built around that file as its golden reference: a headless authoritative engine, a versioned protocol, an online match server and a network client — see [Platform](#platform-monorepo) below. The demo itself stays exactly as it always was.

## Run it

Open `index.html` in any browser. That's it. (Or serve the folder: `python3 -m http.server 8471`.)

An AI vs AI match kicks off immediately — 90 compressed minutes in ~3.5 real minutes, with a different pitch, weather, wind, wear pattern and squads every match.

## Controls

| Key / action | Effect |
|---|---|
| **click / tap a player** | Profile card: on-chain pixel avatar, Ξ valuation + token ID, rating ring, dense match stats, grouped attributes with tap-tips; FOLLOW camera |
| **drag / middle-drag** | Free camera — pan anywhere (stands, benches, off-ball runs); auto-returns to the ball after 5s idle, or tap RETURN TO BALL |
| **wheel / pinch** | Zoom 0.55–2.4× (tap-to-select still works while zoomed) |
| **TACTICS / BENCH / FEED** chips | Tactics panel · substitutions · live commentary feed (also **Y** / **L**) |
| **C** or **Enter** | Coach console — plain English: "press high", "offside trap", "park the bus" |
| **H** | Take control of RED (WASD/arrows move, **Space** pass — hold for power, **Shift** shoot, **E** switch) |
| **Space / Shift** at your set piece | Trigger the restart: safe option / attack option (or tap the on-screen chips) |
| **G** / **N** | Cycle 15 pitch themes / 14 weather conditions |
| **B** / **U** | Stadium theme (local / classic 90s / modern) / crowd density |
| **M** / **T** / **D** | Minimap · stats card · debug overlay (AI intents, defensive lines, trap calls) |
| **P** / **R** | Pause · new match |

## What's inside

- **Simulation**: utility-based AI (pass/dribble/shoot/cross/clear/shield), duties that prevent swarming, formations (4-4-2 / 4-3-3), real offside rule with traps, flat defensive lines, man/zonal marking, pressing forwards, sweeper keepers, transitions, per-player attributes and stamina.
- **Physics**: independent 3D ball (gravity, bounce, skid, Magnus spin, wind drift, post/bar collisions), knock-ahead dribbling, surface-aware friction — mud grabs, puddles stop, hard ground kicks bounces sideways.
- **Match rules**: kickoffs, throw-ins, corners (7 delivery types), goal kicks, staged free kicks with defensive walls, fouls with advantage, yellow/red cards and send-offs, substitutions (manual + AI, 5-sub limit), halftime side swap.
- **Set-piece choreography**: every restart plays out as a short broadcast-style sequence (~2–5s) — players jog into tactical shape (walls, box crowds with late darts, throw-in lanes, build-out or launch shapes), markers pick up runners, the taker steps back and runs up, then play resumes automatically; after goals both teams walk back for the kickoff instead of teleporting. In human mode you pull the trigger on your own set pieces.
- **Broadcast UI**: TV-style overlay — score bug, animated event banners (goal, cards, subs, corners, free kicks, throw-ins, goal kicks, offside, kickoff) with team colors and icons, glass panels, minimal typography. Never obscures play; works on phones.
- **Environment**: 15 procedural pitch themes (checkerboard, mowing rings, mud bath, winter-worn…), organic field damage that drives both visuals and physics, 14 weather conditions (night matches, storms with lightning, fog, wind…).
- **Stadium**: individualized generative crowd (~2,400 fans) reacting to momentum with moods, mexican waves and speech bubbles; linesmen, photographers, TV crews, VAR station, ball kids, medics, security, benches with warm-ups.
- **Meta**: per-player match stats and ratings, market values with rarity tiers (collectible/NFT-style, no chain logic), match commentary feed, event animations (sub boards, coach shouts, celebrations).

## Scripting, recording & replays

Every match is **deterministic** (one seed drives environment, squads and every sim die; fixed 1/60s timestep) and **recorded** as it plays: semantic events (passes, tackles, restarts, cards, calls for the ball, tactic changes, human inputs…), movement samples, and periodic full-state snapshots.

- **REPLAY chip / V key** — transport panel: play/pause, step by event or frame, seek bar with bookmarks, speed 0.25–4×, A-B loop, plus a script editor (delete/duplicate/retime/reassign/adjust power) and import/export.
- **Match → script**: EXPORT downloads the match as versioned JSON (`fobal-match-script`). **Script → match**: IMPORT plays it back — *strict* mode reproduces the run exactly (human matches included; snapshots auto-resync if anything drifts), *adaptive* mode treats the timeline as intent and lets the live AI fill the gaps, so hand-written scenarios play out on a living pitch.
- **Broadcast goal replays**: every goal automatically rolls back ~5–10s (configurable) and re-runs the real sim in slow motion under cinematic cameras (wide/sideline/tracking/behind-goal/scorer close-up) with letterbox + REPLAY graphic. Space/tap skips.

## Dev / QA harness

Open the console:

```js
__simulate(210)        // fast-forward a full match headless, returns stats
__reset(seed)          // new match (same seed → same match)
__exportScript()       // the current recording as a MatchScript object
__downloadScript()     // …as a .json download
__loadScript(doc, { mode: 'strict' | 'adaptive' })
__validateScript(json) // errors/warnings without loading
__setEnv('mud','storm')// pin pitch/weather (deterministic QA); __unlockEnv()
__coach('press high and attack the wings') // natural-language tactics API
game                   // everything lives here
```

Invariant worth keeping: `team.passCmp === Σ player passCmp` — stat attribution is single-credit by design.

`archive/retro-soccer-v1.html` is the original first version, kept for history.

## Platform (monorepo)

`index.html` is the **golden reference** for a full platform stack (npm
workspaces, TypeScript, zero changes to the demo itself):

| Where | What |
|---|---|
| `tests/characterization/` | 29 dependency-free tests pinning golden behavior (`npm run test:characterization`) |
| `packages/protocol` | `@fobal/protocol` — Zod-validated manifests, commands, events, snapshots, deltas, signed results, replay files, WS messages |
| `packages/engine` | `@fobal/engine` — headless authoritative `MatchEngine`: hermetic wrap of the golden core, external ids, 0–100 rating adapter, commands at effective ticks, deterministic hashes, replay-from-log, snapshot recovery. Proven bit-identical to the demo |
| `apps/match-server` | authoritative Node service: token auth, sequenced + rate-limited commands, append-only persistence, crash recovery, goal replays from recorded data, Ed25519-signed idempotent results |
| `apps/match-client` | Local Mode (the golden demo, embedded) + Online Mode (interpolated authoritative spectator client with reconnection recovery) |

```sh
npm install
npm test          # characterization suite + all package/app tests (63 tests)
npm run demo      # serve the golden demo on :8471
npm start -w @fobal/match-server   # run the authoritative server
```

Docs: [docs/architecture-current.md](docs/architecture-current.md) (how the
golden engine works), [docs/refactor-plan.md](docs/refactor-plan.md) (platform
state and roadmap).
