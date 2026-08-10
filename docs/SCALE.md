# SCALE.md — match-server concurrency: measurements and the decision

Status date: 2026-08-10. M2 slice 1 of docs/FULL_APP_BRIEF.md: measure how
far ONE match-server process actually goes, then choose the scaling design
from data. Rig: `tools/load-test.mjs` (fresh server subprocess per stage,
N realtime autoDrive rooms, 2 WS spectators per room, 25s steady-state
sampling after a settle window).

## Measurements

Hardware: Apple Silicon dev machine (Node 23, tsx). Every stage on a fresh
server process; caps lifted for probing; port verified free (see "rig
lessons" — the first four ramps died teaching us how to measure honestly).

| rooms | tickRate avg/min | delta gap p95/max (ms) | ping p95 (ms) | RSS (MB) |
|------:|-----------------:|-----------------------:|--------------:|---------:|
|     5 |      58.9 / 58.9 |              105 / 115 |           3.7 |      279 |
|    10 |      59.0 / 58.9 |              104 / 130 |           3.3 |      276 |
|    20 |      58.8 / 58.8 |              104 / 136 |           4.8 |      353 |
|    40 |      58.8 / 58.8 |              104 / 122 |           2.9 |      483 |
|    80 |      58.7 / 58.7 |              104 / 164 |           5.2 |      851 |
|   120 |      57.4 / 57.4 |              109 / 163 |           5.1 |    1,163 |

(Healthy = 60 ticks/sec — the ~59 ceiling is setInterval drift, present even
at 5 rooms. Delta cadence is nominally 100ms.)

## Findings

1. **CPU does not knee on this hardware.** Tick rate is flat through 80
   rooms and drops only ~2.5% at 120. Latency (delta gaps, ping RTT) never
   degrades. The event loop is nowhere near saturation.
2. **Memory is the linear constraint: ~7.7 MB per room** on a ~275 MB base
   (each room is a full golden-engine vm sandbox; the base includes tsx +
   the golden source). 120 rooms = 1.16 GB.
3. Extrapolating to the deployed task (Fargate 0.25 vCPU / **512 MB**):
   memory bounds first. ~250 MB base + N×7.7 MB against ~450 MB usable →
   **~25 rooms**. CPU on ¼ of a weak vCPU vs. a dev perf-core plausibly
   lands in the same 15–40 band — the two constraints agree on the order of
   magnitude, and memory gives the hard, predictable number.

## Decision

**Vertical scaling with a hard room cap + lobby backpressure.** No match
placement layer at this scale — 25 concurrent matches means 50+
simultaneous players, far beyond current staging reality, and the placement
layer's costs (a registry, per-task routing, multi-task ops) buy nothing
until the cap is actually felt.

Implemented in this slice:

- `maxRooms` on the match server (default **25**, from the table above;
  `FOBAL_MAX_ROOMS` env). Creations beyond it: HTTP 503 `server_full`,
  metered as `RoomCapacityRejected`. `/health` now advertises
  `activeRooms / maxRooms / rssMb` so anything (lobby, dashboards, humans)
  can watch capacity.
- The lobby maps 503 to a plain-language "servers are full — try again in a
  minute" **and keeps the challenge alive**, so accepting again later just
  works. Finished rooms free their slot on finalize (rooms were already
  evicted at full time).

### Raising capacity later, in order of cost

1. **One env var**: bigger Fargate task (0.5 vCPU / 1 GB ≈ +$15/mo) →
   `FOBAL_MAX_ROOMS≈90`. This is the whole story until ~90 concurrent
   matches.
2. Slim the per-room sandbox (share the parsed golden source between vm
   contexts; measurable but engineering-heavy).
3. The placement layer (matchId → task registry, per-task target groups).
   **Revisit trigger:** sustained peaks above ~60% of the deployed cap, or
   the product decision to run tournaments.

## Lobby durability (brief item, decided here)

The lobby stays **single-task** with S3-mirrored accounts/matches and
in-memory presence/challenges. Presence and challenges are seconds-to-
minutes state whose loss on a task replacement costs one re-poll and one
re-challenge; accounts and history survive via the mirror. DynamoDB is not
worth its machinery until the lobby needs >1 task, which the numbers above
put far away.

## Rig lessons (paid for in four failed ramps; encoded in tools/load-test.mjs)

- `spawn('npx', …)` + `kill` murders the WRAPPER; the real node server
  survives and squats the port, silently serving the next stage's
  measurements. Spawn `detached` and kill the process **group**. The rig
  also refuses to run if the port already answers.
- **The B2 per-IP connection cap (default 20) sheds load-test spectators** —
  all rig sockets share 127.0.0.1. The rig lifts the caps via env. This is
  a real-world foot-gun too: a NAT'd venue (one office/LAN party, one
  public IP) hits the same shed at 20 concurrent sockets — raise
  `FOBAL_MAX_CONN_PER_IP` if that audience materializes.
- Warmup pollutes the first seconds (tsx compile, vm boots): settle, then
  zero the counters before the measurement window.
- Ambient load (other dev servers on the same machine) skews stages —
  compare curves, not absolute single runs.

## Chaos check (M2 proof — `tools/chaos-check.mjs`)

SIGKILL the match-server process group with 10 realtime matches under
spectator load, restart on the same store, real `MatchConnection` clients
doing their own backoff:

```
{"matches":10,"statusesDuringOutage":["reconnecting"],"reconnected":10,
 "advancing":10,"rewindTicks":{"max":330,"avg":320,"withinInternalCadence":true}}
```

Every client saw the outage as `reconnecting`, every one reconnected, every
match resumed and kept advancing. Resume rewound ~5.5s of match time (the
distance to the last persisted internal snapshot; bounded by the 30s
`internalEvery` cadence). That bound is the durability price of
snapshot-cadence persistence — acceptable, and now measured rather than
assumed.
