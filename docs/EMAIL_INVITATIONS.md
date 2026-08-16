# Email invitations — invite a friend to a match

A player invites an opponent by email from the lobby; the recipient lands
on a branded challenge page, signs in however they like (email code,
wallet, even minting a squad on the way), and the invitation resolves into
a game-native challenge. Real transactional email, not a mailto link.

## Provider: the abstraction and the choice

`apps/lobby-server/src/email.ts` defines `EmailProvider` — two methods
(`sendLoginCode`, `sendMatchInvitation`), zero vendor types in game logic.
Two implementations ship:

- **SES (default)** — the established provider: already deployed on both
  environments, task-role IAM (no key material anywhere), `lobby@fobal.ai`
  sender on the verified `fobal.ai` identity. Constraint: the account is
  still **sandboxed** (production-access case pending with AWS), so
  arbitrary recipients only receive mail once that clears.
- **Resend** — one API key, arbitrary recipients immediately, signed
  delivery webhooks. The escape hatch if the SES case drags. Selected with
  `FOBAL_EMAIL_BACKEND=resend`.

The directive's "prefer Resend unless an established provider exists"
resolves to: SES is established and stays default; Resend is one env var
away behind the same interface.

## Environment

| Var | Meaning |
|---|---|
| `FOBAL_EMAIL_BACKEND` | `ses` \| `resend` (unset → invitations answer 501) |
| `FOBAL_EMAIL_FROM` | verified sender (`lobby@fobal.ai` today; `matches@fobal.ai` works the moment it exists on the verified domain) |
| `FOBAL_RESEND_API_KEY` | **SECRET**, resend backend only — Secrets Manager in deploys |
| `FOBAL_EMAIL_WEBHOOK_SECRET` | **SECRET** — Resend webhook signing secret (`whsec_…`); unset → `/webhooks/email` answers 501 |
| `FOBAL_INVITE_BASE_URL` | public client base for links (CDK sets `https://<playHostname>` per env) |

Development: copy `.env.example`; an unverified Resend dev account can only
send to its own address — inherently spam-safe. Automated tests NEVER send
real mail (the provider is faked).

## Domain / DNS still required

- **SES path**: nothing new — `fobal.ai` DKIM records are already in DNS;
  the blocker is the AWS production-access case, not configuration.
- **Resend path**: add `fobal.ai` in the Resend dashboard and create the
  records it lists at iwantmyname (DKIM + SPF include, and DMARC if not
  present). Sender becomes `matches@fobal.ai` (or any mailbox on the
  domain — Resend verifies domains, not mailboxes).
- **Webhook**: in the Resend dashboard point a webhook at
  `https://<lobby-host>/webhooks/email` (events: delivered, bounced,
  complained, opened, clicked) and put its signing secret in
  `FOBAL_EMAIL_WEBHOOK_SECRET`.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /invites` `{email, message?}` | session | create + send; returns the invitation and the shareable link |
| `GET /invites` | session | my sent invitations (status ladder for the UI) |
| `GET /invites/:token` | public | landing-page context: inviter identity/club, message, expiry — nothing else |
| `POST /invites/:token/accept` | session (the recipient) | claim: marks accepted, creates a challenge **from the accepter to the inviter** |
| `POST /webhooks/email` | svix signature | delivery events → status ladder |

## Persistence

`LobbyStore` gains `invites.json` (file + S3 write-through mirror +
hydrate, same as accounts/matches; capped at 500). The stored record keeps
the **sha-256 of the link token, never the token** — a leaked store leaks
no live links. Non-sequential 24-byte random tokens; the link is
`<base>/invite.html?t=<token>`.

## Lifecycle

`created → sent → delivered → opened → accepted`, with `failed` (send
error or bounce) and `expired` (7 days default) as terminal states. The
ladder only climbs — webhook replays and out-of-order events are no-ops,
a late bounce never regresses an accepted invite, and **game correctness
never depends on tracking**: delivered/opened exist purely for the
inviter's status chips.

## Abuse prevention

Server-side validation (email shape, 200-char sanitized message, no
self-invites), per-account rolling rate limit (5 attempts/hour default —
attempts, not successes), duplicate suppression (one live invite per
inviter+address; failed sends are retryable), 7-day expiry. No CAPTCHA at
this stage by design.

## The no-lost-invitation rule

`invite.html` carries the token to `lobby.html?invite=…`, which stashes it
in sessionStorage BEFORE any sign-in and claims it on the first successful
lobby entry — whether the recipient used an email code, connected a
wallet, or went off to mint a squad first. A used/expired token is
consumed (never retried forever); a network blip leaves it for the next
entry.

## Manual test procedure (dev)

1. `npm run lobby` with `FOBAL_EMAIL_BACKEND=resend`, your dev key, and
   `FOBAL_INVITE_BASE_URL=http://localhost:8492`; serve the client on 8492.
2. Sign in, send an invite to your own address (dev Resend accounts can
   only reach it anyway), watch the SENT chip appear.
3. Open the email → JOIN THE MATCH → invite.html shows the challenge →
   lobby sign-in as a different account → "Challenge sent to …" and the
   inviter sees an incoming challenge.
4. Re-open the link → "already used". Wait out a short-TTL invite (set
   `inviteTtlMs` in a scratch boot) → "expired".

## Automated coverage

`apps/lobby-server/test/invites.test.ts` — send happy path (provider
payload asserted), invalid recipient, self-invite, unconfigured 501,
provider error → 502 + failed + retryable, rate limit 429, duplicate 409,
expired 410, used 409, invalid token 404, accept-from-fresh-account →
challenge created, webhook signature verify (bad sig 401, stale timestamp
401), ladder idempotency, accepted-never-regresses, unknown-message 204,
and the template test (football language; provably no crypto jargon).
