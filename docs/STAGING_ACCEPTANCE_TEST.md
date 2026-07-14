# FOBAL staging acceptance test

Staging is operational only after all checks below pass against `https://matches-staging.fobal.ai`.

Do not run this checklist against production or mainnet resources.

## Preflight

- AWS account is `368426158592`.
- Region is `sa-east-1`.
- CloudFormation stacks all start with `fobal-staging-`.
- ECS cluster is `fobal-staging-cluster`.
- ECS service is `fobal-staging-match-server` with desired count `1`.
- ECR repository is `fobal-staging-match-server`.
- S3 replay bucket is `fobal-staging-replays-368426158592`.
- Secrets are under `fobal/staging/match-server/*`.
- Log group is `/fobal/staging/match-server`.
- No NAT Gateway exists for this staging stack.
- No autoscaling target or policy exists for the service.
- No production or mainnet-named resource is created.

## Build and deploy gate

- `npm install` at repo root succeeds.
- `npm test` succeeds.
- `npm run typecheck --workspaces --if-present` succeeds.
- Match-server container builds from the repository.
- Image is pushed to `368426158592.dkr.ecr.sa-east-1.amazonaws.com/fobal-staging-match-server:<tag>`.
- `cdk synth` succeeds from `infra/cdk` with the approved certificate ARN.
- CDK diff contains only Fobal staging resources.

## Runtime health

- ALB HTTPS listener serves a valid certificate for `matches-staging.fobal.ai`.
- HTTP `:80` redirects to HTTPS.
- `GET /health` returns `200`.
- ALB target group reports exactly one healthy target.
- ECS service has one running task and no deployment rollback.
- Container logs appear in `/fobal/staging/match-server`.
- No task accepts direct public ingress except traffic from the ALB security group.

## Match API

- `POST /matches` without bearer create key returns `401`.
- `POST /matches` with invalid JSON returns `400`.
- `POST /matches` with valid create key and valid manifest returns `201` with controller and spectator tokens.
- Duplicate match id returns a deterministic client error and does not create a second room.
- `GET /matches/:id/result` before full time returns `404`.
- WebSocket connection without `hello` is terminated after the configured timeout.
- WebSocket `hello` with invalid token is rejected.
- WebSocket `hello` with valid spectator token receives `welcome` and snapshots.
- Controller command is accepted only with the correct team token.
- Malformed command is rejected and does not crash the room.
- Reconnecting with `resumeFromSeq` converges to the current authoritative stream.

## Determinism and replay

- Same manifest and same accepted command log produce the same final state hash locally and on staging.
- Final result is signed once and repeated reads return the same signed result.
- `GET /matches/:id/replay` after full time returns a `fobal-replay` document.
- `GET /matches/:id/replays/goals` returns deterministic goal clips derived from re-simulation.
- Snapshot recovery after a forced task restart resumes unfinished matches from S3-backed state.

## Storage

- S3 contains the expected match object layout:
  - `manifest.json`
  - `commands.jsonl`
  - `events.jsonl`
  - `snapshots/*.json`
  - `internal-latest.json`
  - `result.json`
  - `clips.json`
- Bucket blocks public access.
- Bucket encryption is enabled.
- Bucket versioning is enabled.
- CloudFormation cannot delete the bucket during stack deletion; it is retained.

## Observability

- CloudWatch alarm `fobal-staging-match-server-unhealthy-hosts` exists.
- CloudWatch alarm `fobal-staging-match-server-5xx` exists.
- CloudWatch alarm `fobal-staging-match-server-high-cpu` exists.
- CloudWatch alarm `fobal-staging-match-server-high-memory` exists.
- CloudWatch alarm `fobal-staging-match-server-task-stopped` exists.
- Structured logs include match id, request id or socket id, event type, and error code where applicable.
- No secret value appears in CloudWatch logs.

## Security

- IAM task role can access only Fobal staging S3, metrics, and runtime secrets.
- ECS execution role can pull only the Fobal staging image, read injected staging secrets, and write staging logs.
- `iam:PassRole` is limited to explicitly named Fobal roles.
- No IAM users or permanent access keys are created.
- Secrets cannot be force-deleted without recovery.
- Existing S3 buckets `democracy.earth`, `democracyearth`, `earth-app`, and `vote-democracy-earth` are untouched.
- CloudTrail is not disabled or modified.

## Cost check

- Confirm there is one ALB.
- Confirm there is one running Fargate task at `0.25 vCPU` and `0.5 GiB`.
- Confirm there is no NAT Gateway.
- Expected monthly cost remains about USD 32-50 at low traffic.
