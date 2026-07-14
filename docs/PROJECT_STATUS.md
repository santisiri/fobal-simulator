# FOBAL project status - staging readiness

Status date: 2026-07-14

This document captures the state found during Phase 0 discovery and the access package needed before any AWS staging deployment.

## Current simulator architecture

`index.html` remains the golden reference: a single-file browser demo with vanilla JavaScript and Canvas. It contains the complete live renderer, match simulation, replay controller, script import/export, procedural avatars, tactical controls, and console QA API.

The platform code now wraps that reference in a monorepo:

- `tests/characterization/`: dependency-free golden behavior tests driven by the browser QA seams.
- `packages/protocol`: Zod schemas for manifests, commands, events, snapshots, deltas, replay files, signed results, and WebSocket messages.
- `packages/engine`: authoritative `MatchEngine` around the golden simulation source in a hermetic `node:vm` runtime.
- `apps/match-server`: Node HTTP/WebSocket service with token auth, one authoritative room per match, append-only file persistence, crash recovery, goal replay extraction, and Ed25519-signed final results.
- `apps/match-client`: local mode plus online mode using an interpolation buffer and spectator renderer.

The current invariant is intentional: the platform proves parity against the golden demo before extracting subsystems into server-native modules.

## Browser dependencies blocking a headless server

The match server can run under Node today, but the system still depends on browser-era architecture in important places:

- The engine still extracts and executes the golden script rather than importing fully server-native modules.
- The golden script owns both simulation and rendering concepts, so extraction must preserve the wall between deterministic sim state and render-only state.
- The current file-backed `MatchStore` writes to local disk. It is suitable for tests and a single process, but not sufficient for durable ECS replacement or task restart without shared storage.
- The LLM coach UI stores provider credentials in browser `localStorage`; server deployment must keep secrets in AWS Secrets Manager and keep any model provider integration outside deterministic sim execution.
- The browser QA API (`__reset`, `__simulate`, `__exportScript`, `__loadScript`) is still the characterization seam and should remain available until equivalent package-level harnesses cover the same behavior.

## Existing deterministic systems

Already proven by tests and docs:

- Fixed 1/60s simulation tick.
- Seeded RNG with snapshot capture/restore; `Math.random` is cosmetic only.
- `manifest + ordered command log` reproduces a match.
- Snapshot recovery continues identically to uninterrupted play.
- Server run, local run, and replay file converge on the same truth.
- Commands are validated, sequenced, rate limited, and applied at effective ticks.
- Result signing is idempotent and first-write-wins.
- Goal clips are re-simulated from recorded match data, not approximated.

## Proposed extraction sequence

1. Add an S3-backed `MatchStore` implementation behind the existing store API. Keep local file store as test/default.
2. Add structured JSON logs and CloudWatch metrics around match creation, active rooms, WebSocket connections, rejected commands, replay extraction, snapshot writes, and final result writes.
3. Extract runtime configuration into environment variables and Secrets Manager references:
   - `FOBAL_SECRET`
   - `FOBAL_CREATE_KEY`
   - result signing private key
   - `FOBAL_STORE_BACKEND=s3`
   - `FOBAL_REPLAY_BUCKET=fobal-staging-replays-368426158592`
4. Package `apps/match-server` into a container image published to `368426158592.dkr.ecr.sa-east-1.amazonaws.com/fobal-staging-match-server`.
5. Deploy one ECS Fargate task behind a public ALB for `matches-staging.fobal.ai`.
6. Run staging acceptance tests against HTTPS and WSS.
7. Only after staging is proven, consider multi-task/shared-room routing, autoscaling, private subnets, NAT, or production resources.

## Current AWS inventory

Account: `368426158592`
Region: `sa-east-1`
Current role: `AWSReservedSSO_FobalDiscovery_33b12e69705c510a/sairi-fobal`

Read-only Phase 0 inventory found:

- ECS clusters: none.
- ECR repositories: none.
- Application/Network Load Balancers: none.
- CloudFormation stacks: none.
- `/fobal/staging` CloudWatch log groups: none.
- Default VPC exists: `vpc-013e7864`, CIDR `172.31.0.0/16`.
- Public default subnets:
  - `subnet-1f123f7a`, `sa-east-1a`, `172.31.32.0/20`
  - `subnet-101a8d67`, `sa-east-1b`, `172.31.0.0/20`
  - `subnet-6446903d`, `sa-east-1c`, `172.31.16.0/20`
- Internet Gateway: `igw-f960a39c`.
- Main route table: `rtb-29f3744c`, with default route to `igw-f960a39c`.
- Default security group: `sg-0d315d68`.
- Existing unrelated S3 buckets:
  - `democracy.earth`
  - `democracyearth`
  - `earth-app`
  - `vote-democracy-earth`
- Secrets Manager list access is currently denied to `sairi-fobal`.

No AWS resources were created or modified during Phase 0.

## Risks and blockers

- Current `sairi-fobal` access is read-only discovery-grade. CDK deployment requires a new permission set and a CloudFormation execution role.
- Durable portal access for `sairi-fobal` still needs admin-side password/MFA reset or human-assisted AWS access portal recovery.
- The match server currently persists to local disk. Staging acceptance should require S3-backed replay/snapshot persistence before treating ECS restarts as operationally durable.
- HTTPS requires an ACM certificate for `matches-staging.fobal.ai` in `sa-east-1` and DNS control for `fobal.ai` or a delegated validation flow.
- The first container tag must exist in ECR before the ECS service can stabilize.
- WebSocket behavior behind ALB must be tested under reconnect and idle timeout conditions.
- IAM policies below deliberately keep some list/describe actions broader than resource-level scope because AWS does not support resource scoping for those APIs.

## Estimated staging cost

Assumptions: one Fargate task, `0.25 vCPU`, `0.5 GiB`, always on; one public ALB; low traffic; no NAT Gateway; modest CloudWatch logs and S3 storage.

- ECS Fargate: about USD 9-12/month.
- Public ALB: about USD 18-25/month depending on LCUs.
- ECR storage: less than USD 1/month for a small image history.
- CloudWatch logs/metrics/alarms: about USD 2-8/month at low volume.
- S3 replay/snapshot bucket: less than USD 1/month at low volume.
- Secrets Manager: about USD 1-3/month for two to five secrets.
- ACM public certificate: USD 0.
- Route 53 hosted zone, if hosted in this account: about USD 0.50/month plus tiny query cost.

Expected total: about USD 32-50/month. NAT Gateway is intentionally excluded; adding one would add roughly USD 45+/month before data processing and is not justified for initial staging.
