# The unified app — workstream J

One shell, one session, one navigation at `play.fobal.ai`. Eight proven
standalone pages become one application, slice by slice, each slice a PR
that leaves main shippable and DELETES the page it absorbs. Charter:
`docs/FULL_APP_BRIEF.md` (workstream J section); this file is the living
status + the decisions that bind the slices.

## Status

| Slice | Scope | Status |
|---|---|---|
| **J1** | the shell: routing, nav, auth machine, session, club claim; hub + onboarding absorbed | ✅ shipped |
| J2 | squad room + team sheet | — |
| J3 | market + wallet tx lifecycle | — |
| J4 | lobby + queue + invites + history | — |
| J5 | match hand-off + return, spectator links; play absorbed | — |
| J6 | parity audit, delete the remaining pages, single root remains | — |

## The shape (decided in J1 — later slices inherit it)

**Stack: framework-light, deliberately.** The repo's pure-logic modules are
framework-free ES modules; the app stays in that language — a route table,
a router, an auth machine, and views as plain modules under `apps/app/src`.
No bundler: `tools/build-client.mjs` keeps assembling the artifact with
asserted rewrites, and the golden reference ships byte-identical beside it,
untouched, as always.

**Routes** (`apps/app/src/routes.js` — the shapes `docs/CLUB_AND_MARKET.md`
committed to):

```
/            the club (entry takes over when this browser has no club yet)
/onboarding  found your club
/squad  /market  /market/:tokenId  /lobby  /play  /invite
```

Routes not yet absorbed carry a `legacy` field and HAND OFF to the
standalone page with a full navigation — root-absolute (`/lobby.html`),
because the app answers nested deep links where a relative URL would 404.
Absorbing a page in a later slice is a route-table edit.

**Two URL modes, detected once.** Behind a rewrite layer the app uses clean
paths; addressed directly as `/app.html` it routes via `?p=` — so deep
links survive a refresh on any static host, with zero infra dependency.
The rewrite rule (extensionless → `/app.html`) exists twice, deliberately
labeled twins: `tools/serve-client.mjs` (local) and
`infra/cloudfront/app-router-function.js` (staging; **not yet attached** —
attaching it is an imperative CloudFront step documented in that file).
The dev `?lobby=` override rides every href the app builds.

**One session, one identity.** `apps/app/src/authMachine.js` wraps the
tested `LobbyService` (still the ONLY transport boundary):
`signed_out → entering → signed_in`, reconnects surfaced as connection
state (never a logout), sign-out reasons kept for the product voice, and
the **club claim** run off the poll — `clubClaim.js` keeps owning the
safety rules (never clobber a named club, claim once per browser); the
machine owns *when*: retried after a transient failure, settled exactly
once, re-armed only by a fresh sign-in. The session stays in per-tab
`sessionStorage['fobal.lobby.session']` — two tabs are two managers, and
the legacy pages share it across every hand-off.

**Views** (`apps/app/src/views/`) render into the shell's `<main>` and
update NAMED REGIONS off the poll only when their state slice changes — no
flicker, no replayed animations, no stolen focus on a 2s cadence. The
eleven-pip ripple marks the claim settling; loading is skeletons; error
and empty states speak football.

## The dev loop

```
npm run lobby                                  # FOBAL_DEV_AUTH=1 FOBAL_CREATE_KEY=… for codes in-response
node tools/build-client.mjs --lobby-url http://localhost:8475 --match-ws ws://localhost:8787
node tools/serve-client.mjs                    # http://localhost:8470, SPA rewrites live
```

The build is file copies + asserted rewrites — fast enough to be the loop.
Tests: `apps/app/test/` (route table + URL modes, auth machine + claim
discipline) and the build assertions in `apps/match-client/test/build.test.ts`.

## Deploy note (J1)

The artifact is fully usable before any infra change: the app lives at
`/app.html` and routes via `?p=`. Attaching the CloudFront function flips
it to clean paths and makes the app the root — that step also supersedes
the default-root-object behavior for `/`. The match client stays reachable
at `/index.html` (every match URL names it explicitly).

## What J1 deleted

`apps/web/public/hub.html` and `apps/web/public/onboarding.html` — absorbed
as the club home and `/onboarding`. `play.html`'s back link, the lobby's
`← CLUB` link and `club.js#requireClub` now point at the app.
