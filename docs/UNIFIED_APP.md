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
| **J2** | squad room + team sheet at `/squad`; squad.html absorbed and deleted | ✅ shipped |
| **J3** | market + wallet tx lifecycle at `/market(/:tokenId)`; market.html absorbed and deleted | ✅ shipped |
| **J4** | the lobby at `/lobby` — presence, challenges, queue, invites, history; lobby.html absorbed and deleted; identity + mint moved to the club home | ✅ shipped |
| **J5** | `/play` absorbed (offline-vs-AI stage in the shell); the match client's full-time return bar; play.html deleted | ✅ shipped |
| **J6** | the parity audit: orphaned modules deleted, docs bannered, the final map below | ✅ shipped |

## The final map (J6 parity audit, 2026-09-02)

Eight pages went in; ONE app came out, plus two deliberate standalone
documents. Where everything lives now:

| Was | Now |
|---|---|
| onboarding.html | `/onboarding` (the wizard) |
| hub.html | `/` — the club home (+ identity card, on-chain card, last full time) |
| play.html | `/play` (+ the offline golden stage) |
| squad.html | `/squad` — the team sheet room |
| market.html | `/market`, `/market/:tokenId` — sheet-as-deep-link |
| lobby.html | `/lobby` — presence, challenges, queue, invites, history |
| index.html (match client) | **stays** — the live match experience; the app hands off (`views/matchLink.js`) and the FULL TIME header bar hands back |
| invite.html | **stays** — the email landing page; its links are baked into sent emails by the server (`<base>/invite.html?t=…`) and its join button lands inside the app |

Deleted as orphans in J6: `apps/match-client/src/ui/squadView.js`,
`apps/web/public/js/session.js`, `club.js#requireClub`,
`playerCard.js#playerCardSkeleton` — each had zero consumers once their
pages died.

**The five journeys** (docs/FULL_APP_BRIEF definition of done) all run
inside the one app and were each verified live during J1–J5: found→claim
(J1, the pips), wallet mint→NFT squad (J4, real three-leg mint on anvil),
market list/cancel/buy (J3, real chain), XI→queue/challenge→live
match→voice→result in history (J2/J4/J5, ridden to a real full time),
email invite→the app (J4; delivery on staging still needs the SES/Resend
follow-up in INTEGRATION_STATUS).

**The release step that makes the app the root**: attach
`infra/cloudfront/app-router-function.js` (runbook in the file) to
E35URO4KFESJYU's default behavior. Until then the app answers at
`/app.html` with `?p=` routing — fully usable either way.
`tools/serve-client.mjs` already mirrors the function locally.

**Standing follow-ups (server-side, out of client scope by constitution):**
- `/squad` does not serve `appearance`/`dna` — chain.ts decodes them and
  drops them. Shipping them (player-data-model workstream) lights up real
  NFT art in the tiles; `avatarTile` is the documented seam.
- Invite delivery on staging: SES production access or Resend secrets.
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

## What J2 absorbed (the squad room)

`apps/match-client/public/squad.html` → `apps/app/src/views/squad.js` at
`/squad`, deleted in the same PR; the lobby's SQUAD ROOM button points at
the app. Decisions added in J2, inherited by later slices:

- **The app's stylesheet is `ui.css`** (dev: `apps/match-client/src/ui/ui.css`,
  dist: `/src/ui/ui.css`) — the shared design-system block (byte-identical
  to fobal.css, proven by tokens.test) PLUS the product atoms the views
  reuse (player cards, the detail drawer, skeletons, tx flow). The app's
  own class names must not collide with ui.css atoms (`.pcard`, `.reveal`,
  `.pitch` are taken — J1's wizard classes were renamed `obcard`/`obreveal`).
- **`auth.api(path, init)`** is the session's authenticated raw fetch, for
  endpoints LobbyService doesn't carry (`/sheet`, player renames). Views
  never build their own fetch.
- **Unsaved work holds the door**: `router.setLeaveGuard(fn)` — the mounted
  view owns the one guard, the shell's route change consults it, dispose
  clears it; hard navigations stay on `beforeunload`.
- The placement rules (eleven stays eleven, placements trade places) are
  pure in `views/sheetOps.js` with their own tests; the room renders from
  the SAME `/squad` payload as everywhere else and joins `/sheet` by
  playerId. `playerDetail` gained an additive `destroy()` so SPA unmounts
  don't leak drawers.

## What J3 absorbed (the market)

`apps/match-client/public/market.html` → `apps/app/src/views/market.js` at
`/market` and `/market/:tokenId`, deleted in the same PR; the lobby's
MARKET button points at the app. Decisions added in J3:

- **The player sheet IS the deep link.** Opening a lot navigates to
  `/market/:tokenId`; back/forward and refresh land right. The shell's
  mount contract gained `update(match)` — same view, new URL reaches the
  mounted view instead of remounting it. `/market` and `/market/:tokenId`
  share one view name on purpose.
- **`views/txPanel.js` is the ONE transaction-lifecycle component**
  (mockup 3g): createTxFlow snapshot → action, shared state line, hash as
  explorer link, failure in plain words with one retry, and the settled
  state plays the eleven pips in ownership purple. Reuse it for every
  later on-chain flow (the mint moves onto it when the lobby is absorbed).
- **After a settled trade the sheet holds ~1.8s before re-rendering** — the
  pips play, AND the lobby's live chain reads catch up with the receipt
  (re-rendering instantly raced the owner read and showed a stale "not
  yours"; found live against anvil).
- Trade eligibility is pure in `views/marketOps.js` (`tradeChoice`) —
  seller match beats ownership (the escrowed token belongs to the
  marketplace while listed). `ethToWei` moved into the shared `money.js`
  (string maths, tested). Public browsing works signed out; the sheet
  offers the wallet door inline via `auth.walletSignIn`.

## What J4 absorbed (the lobby)

`apps/match-client/public/lobby.html` → `apps/app/src/views/lobby.js` at
`/lobby`, deleted in the same PR. The lobby view renders from the ONE
LobbyService state the auth machine already polls — no second transport.
Decisions added in J4:

- **Club identity moved home.** Rename + kit live on the club home's
  identity card; the on-chain card (link / unlink / MINT MY TEAM) is
  there too — the lobby is for finding a rival. The mint flow lives in
  `views/mint.js` (three legs on the shared txPanel, per-wallet resume in
  localStorage, receipt parsing by the server-named topics — pure parts
  tested), and a settled mint carries its eleven-pip moment across the
  poll's re-render (`mintSettledAt` window).
- **The auto-enter fuse is armed once per matchId** and the entered-latch
  (`fobal.lobby.entered`, via `views/matchLink.js`) survives the round
  trip — coming back from the match client never re-fires the fuse. The
  match client's LOBBY links and invite.html's join link now point INTO
  the app (`/app.html?p=/lobby`); the app captures `?invite=` at boot and
  the lobby view claims it after any sign-in.
- Countdowns on challenges tick with the poll; invitations degrade
  honestly on 501 (form hidden, plain words). `views/matchLink.js` is the
  one builder for match/replay hand-off URLs (root-absolute).
- Leftovers for J6: `src/ui/squadView.js` and `apps/web/public/js/session.js`
  no longer have a consuming page (they still ship, harmlessly).

## What J5 absorbed (play + the way back)

`apps/web/public/play.html` → `apps/app/src/views/play.js` at `/play`,
deleted in the same PR — the LAST web page; `apps/web/public` now ships
only `js/` (the generated avatar renderer + club helpers the app imports)
and `styles/fobal.css` (the design system's source of truth).

- The offline friendly boots the GOLDEN simulator in the app's full-bleed
  stage and dresses the home team from the local draft — or, new, from
  the signed-in account's server squad (names + kit) when no draft
  exists. The golden file stays golden; dressing is applied from outside,
  same seam as ever.
- **The full-time return** (the J5 polish): the match client's online flow
  now surfaces a FULL TIME bar in its HEADER on `onResult` — score,
  BACK TO THE LOBBY (into the app), and WATCH REPLAY built from the
  match's own server + token. In the header so it floats around the play
  area, never over it.
- `/invite` is the only hand-off left. J6 remains: parity audit, delete
  the orphaned modules (`squadView.js`, web `session.js`,
  `club.js#requireClub`), CloudFront function → app as the root.

**The local chain rig** (how J3 and J4's mint were verified end to end): `anvil` (a
launch.json entry) → `contracts/script/Deploy.s.sol` with anvil key 0 as
admin and keys 3/4 as generator/engine signers (writes
`deployments/31337.json`) → `MintSquad.s.sol` once per test wallet
(creates the registry team + generator-signed 11 + declared roster) →
`cast` for seeding listings/sales. Lobby env: `FOBAL_RPC_URL` +
`FOBAL_CHAIN_PLAYER/REGISTRY/MARKETPLACE` + `FOBAL_MARKET_FROM_BLOCK=1`
(+ `FOBAL_IDENTITY=0` to skip mainnet ENS; for the mint add
`FOBAL_CHAIN_GENERATOR` + `FOBAL_CHAIN_ID=31337` +
`FOBAL_GENERATOR_SIGNER_PK` = anvil key 3). Note: the lobby's session
secret is per-boot — restarting it signs every tab out (dev only). In the pane, a ~20-line
EIP-1193 shim over anvil's unlocked accounts stands in for MetaMask —
`personal_sign` and `eth_sendTransaction` are real.
