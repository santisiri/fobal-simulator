# Lobby / presence / matchmaking — the staging-area contract

The lobby workstream's reference: transport, presence model, challenge
protocol, match state machine, authentication, reliability behavior, the
frontend integration API, and how to run two local clients. The charter's
journey — wallet in, presence out, scout, challenge, accept, one canonical
match, both clients into the game — is covered end to end and tested by
`apps/match-client/test/lobbyService.test.ts`.

## Transport

**HTTP + polling (~2s), stateless.** A deliberate choice (roadmap open
decision 2): at current scale presence does not justify a WS fan-out, and
statelessness buys the reliability section below for free. The transport
is fully hidden behind the client `LobbyService` boundary — a socket lobby
can replace it later by changing one file (`lobbyService.js`) and zero UI.

## Wallet authentication

SIWE-flavored challenge/response (D2): `POST /auth/wallet {address}` →
one-shot nonce message (5-min TTL, per-address rate limit) → the wallet
`personal_sign`s it (EIP-191, no gas) → `POST /auth/wallet/verify`
recovers the signer offline and mints the same stateless HMAC session an
email login gets (30-day TTL). No client claim is trusted: the session is
the recovered signature, squad ownership is verified against live
on-chain state at link time (`/squad/chain` re-reads ERC-721 owners at a
pinned block), and match tokens are minted server-side per account.
Replay: nonces are single-use; a failed verify does not burn the
challenge; a settled one cannot be replayed. Email magic-code auth
coexists unchanged.

## Identity — the normalized participant

Every roster entry (and `me`) is:

```
{ accountId, walletAddress,        // null for email accounts
  displayName,                     // the ENS workstream's verified name
                                   // when resolved, else the handle
  squadId, squadName, teamOverall, // scouting: mean of the XI's rating
                                   // means, from the SAME buildTeam that
                                   // builds the manifest
  status, joinedAt, record,        // + online/inMatch (back-compat) }
```

## Presence model

Heartbeat = the authenticated poll itself; TTL 12s (~6 missed polls).
Ghost users age out by TTL — there is nothing to clean up, so a crashed
tab, a dropped network, or a killed server never leaves a phantom.
`joinedAt` marks the current visit (returning after a TTL gap starts a
new one).

**Status is derived, never stored** — one function (`statusOf`), no sweeps:

```
match exists?  ── age < 45s ──→  preparing_match
       │       ── else ──────→  in_match        (even if the lobby tab
       │                                         closed — they're playing)
  no match, TTL expired ─────→  disconnected
  party to a live challenge ─→  challenged
  searching for a quick match → queued
  otherwise ─────────────────→  available
```

## Challenge protocol

```
created ──(target's next poll)──→ delivered ──→ accepted → match_created
   │                                   │  └───→ declined   (idempotent)
   └────────────(TTL 2min)────────────┴──────→ expired
```

- Stable ids (`ch-<hex>`); `status`, `deliveredAt`, `expiresAt` in every
  view — the challenger literally sees "seen".
- **Idempotent by design**: re-challenging the same player returns the
  SAME pending challenge; a double-click on accept returns the SAME match
  (a 5-min settled-memory answers for just-settled ids); declining twice
  is a clean no-op. Reverse-direction duplicates get told to accept the
  existing invite instead.
- Guards: target must be online; neither side already in a match;
  per-account creation cap (8/10min rolling) against spam; rematch
  references must be a match both actually played.

## Opponent scouting

`GET /coaches/:accountId` (session-required) — the card a coach reads
before accepting a challenge: the normalized identity + form (`record`,
`status`, `teamOverall`), kit colors, a `chainTeam` flag, and the XI as
`{ name, role, shirtNumber, overall }`. **The 13-rating spreadsheet is
deliberately withheld** — scouting shows shape and strength; the full
numbers reveal themselves on the pitch (the manifest is only ever served
to match participants). Client: `lobby.inspect(accountId)`.
(`/players/:tokenId` is the separate, public NFT read — different
namespace on purpose.)

## Quick match (the queue)

`POST /queue` joins, `DELETE /queue` leaves, `lobby.joinQueue()` /
`lobby.leaveQueue()` on the client; `state.queue` is
`{ status: 'idle'|'searching'|'matching', since?, waiting, error? }`.
For the roster, a searching coach reads `status: 'queued'` (still
challengeable by name — the queue is a second path to a game, not a
mode).

Pairing happens on the poll (and immediately on join, so a waiting
opponent means no wait at all): the longest-waiting eligible coach is
chosen, and **the longer wait gets the home dugout**.

**The race, and why it is safe.** Two coaches poll concurrently, so both
can see each other as pairable in the same instant. The pair is
therefore **claimed synchronously** — both removed from the queue and
marked `pairing` — *before* the first `await`. Node's single-threaded
turn boundary guarantees the other poll then finds nobody to pair with;
it simply waits for the match record. One pair, one match, always.

The queue is ephemeral and presence-backed, exactly like challenges:
- Closing the tab stops the poll, presence goes stale, the sweep removes
  you — there is no "leave" anyone can forget to press, and no ghost to
  be paired against.
- Finding a game elsewhere (accepting a challenge) drops you from the
  queue automatically.
- A full match server (503) puts **both** coaches back in the queue with
  their original wait preserved, and the reason arrives once in
  `queue.error`; the next poll retries.
- A pairing claim that never produced a match (server died mid-create)
  expires after 30s rather than stranding anyone in `matching`.
- `DELETE /queue` refuses only once your pair is claimed (409) — by then
  the match is seconds away.

## Match state machine

Challenge-accept and quick-match pairing both create matches through the
SAME function, so both produce identical canonical records: manifest built from BOTH accounts' squads (chain-verified for
NFT teams) → authoritative match server creates the room → canonical
`matchId` + per-side tokens recorded → challenge settled. Both clients
converge on the same `matchId` via their next poll — there is no
client-side agreement step to get wrong.

```
preparing (<45s) → live → result cached on a later poll → players FREED
                            automatically at full time (no LEAVE needed)
        └── abandoned? matchActiveMs (10min) frees both regardless
```

`match` in lobby state carries `{ matchId, matchUrl, token,
spectatorToken, teamId, status }` — each side receives only its own
controller token; ownership claims never ride the client.

## Reliability & reconnection

| Failure | Behavior |
|---|---|
| network drop / sleep | polls fail → `connectionStatus: 'reconnecting'`; next success heals; nothing to re-handshake |
| browser refresh | `resume()` restores the stored session and polls |
| lobby server restart | sessions are stateless HMAC, accounts/matches persist (file/S3); presence & challenges are deliberately ephemeral seconds-scale state — the client just reconnects (tested) |
| wallet account switch | `accountsChanged` ends the session (`logout` event, reason `wallet account changed`) — the client never keeps acting as the previous wallet |
| opponent vanishes pre-accept | challenge expires (2min) |
| opponent vanishes post-accept | match auto-frees at full time via cached result, or at `matchActiveMs`; LEAVE available any time |
| session expiry | 401 on poll → `logout` event, reason `session expired` |

## Frontend integration API

`apps/match-client/src/lobbyService.js` — framework-free ES module, the
ONLY thing a UI should import:

```js
const lobby = createLobbyService({ lobbyUrl });
lobby.on('state', s => render(s));       // full state on every change
lobby.on('challenge', c => toast(c));    // a NEW incoming challenge
lobby.on('match', m => enterSoon(m));    // a match appeared
lobby.on('logout', ({ reason }) => showLogin(reason));

lobby.resume()                            // browser refresh
await lobby.loginWallet(window.ethereum)  // or loginEmailRequest/Verify
await lobby.challenge(accountId)          // idempotent
await lobby.accept(id) / lobby.decline(id)
lobby.matchEntry()                        // { matchId, wsUrl, token, teamId … }
// plus: rename, getSquad/saveSquad, linkChainTeam/unlinkChainTeam,
//       history, leaveMatch, logout, dispose
```

`state`: `{ connectionStatus, me, participants, incomingChallenges,
outgoingChallenges, match, error }`.

## Local two-client testing

Automated (the charter matrix, 8 tests):

    npx vitest run lobbyService

Manual: run `npm run lobby` (dev auth) + the match server + a static
server, open `lobby.html?lobby=http://localhost:8475` in TWO tabs —
sessions are per-tab (sessionStorage) on purpose, so two tabs are two
players. Sign in with two emails (codes auto-fill), challenge from one
tab, accept in the other, and both auto-enter the same match.
