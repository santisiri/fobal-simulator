# Platform refactor — state & roadmap

The repo is now a monorepo housing an authoritative football simulation
platform. The single-file demo (`index.html`) is preserved **byte-for-byte**
at the root as the golden reference; every layer above it is proven against
its behavior.

## What exists (this branch)

```
index.html                 golden-reference demo (untouched, still works from file://)
docs/architecture-current.md   characterization of the golden engine
tools/extract-inline-script.mjs  pulls the game script out of index.html
tools/update-goldens.mjs         regenerates characterization goldens
tests/characterization/    29 node:test specs pinning golden behavior (zero deps)
packages/protocol          @fobal/protocol — Zod schemas: manifests, commands,
                           events, snapshots, deltas, results, replays, WS messages
packages/engine            @fobal/engine — headless authoritative MatchEngine
                           (hermetic vm wrap of the golden core, manifest adapter,
                           external ids, single-point rating normalization,
                           effective-tick commands, deterministic hashing,
                           replay-from-log, internal snapshot recovery)
apps/match-client          Local Mode (golden demo embedded) + Online Mode
                           (MatchConnection, InterpolationBuffer, SpectatorRenderer)
apps/match-server          token-authed HTTP+WS service: one engine per match,
                           sequenced/rate-limited commands, append-only persistence,
                           crash recovery, goal replays, Ed25519-signed idempotent results
```

Proven invariants (all in CI-runnable tests, `npm test`):

- Engine ≡ golden demo, bit-for-bit (parity vs independently captured goldens,
  including the automatic goal-replay rollback sequence).
- `manifest + ordered command log` fully reproduces a match (hash-equal).
- Restore-from-snapshot → continue ≡ uninterrupted run (engine and server level).
- Local run ≡ server run ≡ replay-file run; two clients see one truth;
  malformed input is inert; reconnection converges. (The five proofs.)

## Deliberate strangler-fig posture

`packages/engine` executes the **same** simulation source as the demo,
extracted at load time and run in a hermetic `node:vm` sandbox. That is the
point: zero behavioral drift while the platform contract (protocol, ids,
commands, persistence, signing) hardens around it. Nothing outside the engine
package knows how the core is hosted.

## Next steps (in dependency order)

1. **Peel subsystems out of the golden script** into `packages/engine/src/core/`
   modules (RNG → ball physics → player/attributes → match rules → AI), each
   move guarded by the characterization suite + parity hashes. The extractor
   dies when the last subsystem moves; `index.html` then becomes a build
   artifact of the client (and only then may it be regenerated — never removed
   until the client reproduces it feature-for-feature).
2. **Full-fidelity online rendering**: drive the golden renderer from server
   state via freewheel prediction (client runs the engine locally between
   authoritative snapshots, reconciling on arrival). The lean spectator
   renderer stays as the low-bandwidth fallback.
3. **Controller UX in the client**: tactics panel + coach console wired to
   TacticalCommands with ack/redo affordances.
4. **Server hardening for production**: multi-process room sharding, WS
   heartbeats/timeouts, durable store backend (the `MatchStore` API is the
   seam), key management for result signing, structured logs/metrics.
5. **Adaptive/scripted scenarios over the protocol** (the golden adaptive
   ScriptRunner has no protocol surface yet).

## Behavior changes

None. `docs/behavior-changes.md` is intentionally absent — it gets created by
the first PR that knowingly alters golden behavior, together with regenerated
goldens (`npm run goldens`).
