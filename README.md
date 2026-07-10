# FOBAL SIMULATOR

A complete retro-isometric football simulation in **one self-contained HTML file** — no libraries, no assets, no server. Inspired by the camera and pacing of early-90s classics (FIFA International Soccer, Sensible Soccer) with modern physics and AI underneath.

## Run it

Open `index.html` in any browser. That's it. (Or serve the folder: `python3 -m http.server 8471`.)

An AI vs AI match kicks off immediately — 90 compressed minutes in ~3.5 real minutes, with a different pitch, weather, wind, wear pattern and squads every match.

## Controls

| Key / action | Effect |
|---|---|
| **click / tap a player** | Profile panel: live stats, match rating, market value; FOLLOW camera toggle |
| **TACTICS / BENCH / FEED** chips | Tactics panel · substitutions · live commentary feed (also **Y** / **L**) |
| **C** or **Enter** | Coach console — plain English: "press high", "offside trap", "park the bus" |
| **H** | Take control of RED (WASD/arrows move, **Space** pass — hold for power, **Shift** shoot, **E** switch) |
| **G** / **N** | Cycle 15 pitch themes / 14 weather conditions |
| **B** / **U** | Stadium theme (local / classic 90s / modern) / crowd density |
| **M** / **T** / **D** | Minimap · stats card · debug overlay (AI intents, defensive lines, trap calls) |
| **P** / **R** | Pause · new match |

## What's inside

- **Simulation**: utility-based AI (pass/dribble/shoot/cross/clear/shield), duties that prevent swarming, formations (4-4-2 / 4-3-3), real offside rule with traps, flat defensive lines, man/zonal marking, pressing forwards, sweeper keepers, transitions, per-player attributes and stamina.
- **Physics**: independent 3D ball (gravity, bounce, skid, Magnus spin, wind drift, post/bar collisions), knock-ahead dribbling, surface-aware friction — mud grabs, puddles stop, hard ground kicks bounces sideways.
- **Match rules**: kickoffs, throw-ins, corners (7 delivery types), goal kicks, staged free kicks with defensive walls, fouls with advantage, yellow/red cards and send-offs, substitutions (manual + AI, 5-sub limit), halftime side swap.
- **Environment**: 15 procedural pitch themes (checkerboard, mowing rings, mud bath, winter-worn…), organic field damage that drives both visuals and physics, 14 weather conditions (night matches, storms with lightning, fog, wind…).
- **Stadium**: individualized generative crowd (~2,400 fans) reacting to momentum with moods, mexican waves and speech bubbles; linesmen, photographers, TV crews, VAR station, ball kids, medics, security, benches with warm-ups.
- **Meta**: per-player match stats and ratings, market values with rarity tiers (collectible/NFT-style, no chain logic), match commentary feed, event animations (sub boards, coach shouts, celebrations).

## Dev / QA harness

Open the console:

```js
__simulate(210)        // fast-forward a full match headless, returns stats
__reset()              // new match
__setEnv('mud','storm')// pin pitch/weather (deterministic QA); __unlockEnv()
__coach('press high and attack the wings') // natural-language tactics API
game                   // everything lives here
```

Invariant worth keeping: `team.passCmp === Σ player passCmp` — stat attribution is single-credit by design.

`archive/retro-soccer-v1.html` is the original first version, kept for history.
