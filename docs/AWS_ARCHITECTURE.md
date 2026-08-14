# FOBAL staging AWS architecture

Account: `368426158592`
Region: `sa-east-1`
Environment: `staging`
Prefix: `fobal-staging`
Hostname: `matches-staging.fobal.ai`

This is a staging-only design. It must not create production resources, mainnet integrations, autoscaling, or any resource outside the `fobal-staging` / `Fobal-` scope.

## Target resources

Networking:

- Use existing default VPC `vpc-013e7864`.
- Use existing public subnets:
  - `subnet-1f123f7a` in `sa-east-1a`
  - `subnet-101a8d67` in `sa-east-1b`
  - `subnet-6446903d` in `sa-east-1c`
- Use existing main route table `rtb-29f3744c`, which routes internet egress through `igw-f960a39c`.
- No NAT Gateway.
- `fobal-staging-alb-sg`: public ingress `80` and `443`; egress to match-server security group.
- `fobal-staging-match-server-sg`: ingress only from ALB security group to container port `8473`; egress HTTPS `443` to AWS APIs and ECR.

Compute and routing:

- ECS cluster: `fobal-staging-cluster`.
- Fargate task definition family: `fobal-staging-match-server`.
- Container: `match-server`, port `8473`.
- ECS service: `fobal-staging-match-server`, desired count `1`.
- Public ALB: `fobal-staging-alb`.
- Target group: `fobal-staging-match-server-tg`, HTTP health check path `/health`.
- Listener `80`: redirect to HTTPS.
- Listener `443`: HTTPS certificate for `matches-staging.fobal.ai`; forwards HTTP and WSS to the target group.

Images:

- ECR repository: `fobal-staging-match-server`.
- Image URI: `368426158592.dkr.ecr.sa-east-1.amazonaws.com/fobal-staging-match-server:<tag>`.

Logs, metrics, and alarms:

- Log group: `/fobal/staging/match-server`.
- CloudWatch namespace: `/fobal/staging/match-server`.
- Alarms:
  - `fobal-staging-match-server-unhealthy-hosts`
  - `fobal-staging-match-server-5xx`
  - `fobal-staging-match-server-high-cpu`
  - `fobal-staging-match-server-high-memory`
  - `fobal-staging-match-server-task-stopped`

Secrets:

- `fobal/staging/match-server/token-secret`
- `fobal/staging/match-server/create-key`
- Future: `fobal/staging/match-server/result-signing-private-key`

Storage:

- S3 bucket: `fobal-staging-replays-368426158592`.
- Object prefixes:
  - `matches/<matchId>/manifest.json`
  - `matches/<matchId>/commands.jsonl`
  - `matches/<matchId>/events.jsonl`
  - `matches/<matchId>/snapshots/<tick>.json`
  - `matches/<matchId>/internal-latest.json`
  - `matches/<matchId>/result.json`
  - `matches/<matchId>/clips.json`

IAM:

- Permissions boundary: `FobalAgentBoundary`.
- CDK deployer role, created by bootstrap: `cdk-fobalstag-deploy-role-368426158592-sa-east-1`.
- CloudFormation execution role, created by bootstrap: `cdk-fobalstag-cfn-exec-role-368426158592-sa-east-1`.
- ECS task role: `Fobal-staging-match-server-task-role`.
- ECS execution role: `Fobal-staging-match-server-execution-role`.

## Request flow

1. Client resolves `matches-staging.fobal.ai`.
2. DNS points to the public ALB.
3. ALB terminates TLS on `443`.
4. HTTP requests and WebSocket upgrades forward to container port `8473`.
5. The match server validates bearer tokens, owns authoritative match state, emits snapshots/deltas/events, and writes durable replay/snapshot material.
6. CloudWatch receives container logs and service metrics.

## No NAT Gateway

The first staging task runs in public subnets with a public IP and a restrictive security group. This allows outbound HTTPS to ECR, CloudWatch Logs, Secrets Manager, S3, and STS without paying for a NAT Gateway. Inbound access still terminates at the ALB; the task security group does not accept public ingress.

A NAT Gateway should only be added if a later requirement forces private subnets without VPC endpoints. For initial staging, it is mostly expensive ceremony.

## CDK context

The CDK app requires a validated certificate ARN:

```sh
npm run cdk -- -c certificateArn=arn:aws:acm:sa-east-1:368426158592:certificate/REPLACE_WITH_VALIDATED_CERTIFICATE_ID synth
```

Optional context:

- `imageTag`: image tag to deploy, default `staging`.
- `hostedZoneId` and `hostedZoneName`: when Route 53 should create the alias record.

## Exact CDK bootstrap command

The proposed bootstrap qualifier is `fobalstag` so the staging bootstrap resources are visually distinct from any existing/default CDK bootstrap.

```sh
npx cdk bootstrap aws://368426158592/sa-east-1 \
  --qualifier fobalstag \
  --cloudformation-execution-policies arn:aws:iam::368426158592:policy/FobalCloudFormationExecution \
  --custom-permissions-boundary FobalAgentBoundary \
  --tags Project=Fobal \
  --tags Environment=staging \
  --tags Scope=fobal-staging
```

Do not run this until the access package is approved.

## Expected created resources

- `AWS::ECR::Repository` `fobal-staging-match-server`
- `AWS::S3::Bucket` `fobal-staging-replays-368426158592`
- `AWS::SecretsManager::Secret` `fobal/staging/match-server/token-secret`
- `AWS::SecretsManager::Secret` `fobal/staging/match-server/create-key`
- `AWS::Logs::LogGroup` `/fobal/staging/match-server`
- `AWS::ECS::Cluster` `fobal-staging-cluster`
- `AWS::IAM::Role` `Fobal-staging-match-server-task-role`
- `AWS::IAM::Role` `Fobal-staging-match-server-execution-role`
- `AWS::EC2::SecurityGroup` `fobal-staging-alb-sg`
- `AWS::EC2::SecurityGroup` `fobal-staging-match-server-sg`
- `AWS::ElasticLoadBalancingV2::LoadBalancer` `fobal-staging-alb`
- `AWS::ElasticLoadBalancingV2::TargetGroup` `fobal-staging-match-server-tg`
- `AWS::ElasticLoadBalancingV2::Listener` ports `80` and `443`
- `AWS::ElasticLoadBalancingV2::ListenerRule` default forward behavior
- `AWS::ECS::TaskDefinition` family `fobal-staging-match-server`
- `AWS::ECS::Service` `fobal-staging-match-server`
- `AWS::CloudWatch::Alarm` resources listed above
- Optional `AWS::Route53::RecordSet` for `matches-staging.fobal.ai`

## Permission scope that remains broader than resource-level

AWS requires broad `Resource: "*"` for several read/list APIs:

- `ec2:Describe*`
- `ecs:List*`
- `ecs:Describe*`
- `cloudwatch:GetMetricData`
- `cloudwatch:ListMetrics`
- `logs:DescribeLogGroups`
- `ecr:GetAuthorizationToken`
- `cloudformation:DescribeStacks` and related stack discovery in some CDK flows

Those actions are read-only except `ecr:GetAuthorizationToken`, which returns a registry login token and cannot be repository-scoped.

## Hosted client (play-staging.fobal.ai) — imperative, NOT stack-managed

The CloudFront distribution serving the built client is created and managed
IMPERATIVELY under the engineer role, not by CloudFormation. This is a
deliberate exception, forced by a reproducible AWS quirk, and it also fits
the standing rule that long-lived resources are created imperatively.

**The quirk (isolated 2026-08-08, kept for the record):** creating an
ENABLED `AWS::CloudFront::Distribution` with an ACM certificate through
CloudFormation using the boundary-carrying exec role
(`cdk-fobalstag-cfn-exec-role-*`) deterministically fails with
`InvalidViewerCertificate` ("The specified SSL certificate doesn't
exist…"), even though: the cert is ISSUED in us-east-1 with a full chain;
the synthesized template carries the correct ARN; the boundary's default
version exempts `acm:*` from the region lock; the exec role's identity
policy grants `acm:Describe*/Get*/List*`; and the IDENTICAL config succeeds
via `aws cloudfront create-distribution` under the engineer SSO role — and
via CloudFormation for DISABLED distributions. Discriminator matrix:
engineer+CLI+enabled ✓, root+CLI+disabled ✓, CFN+exec-role+disabled ✓ (not
retested post-fix but earlier evidence), CFN+exec-role+enabled ✗ (5×,
request ids in PR #32/#33 thread). Conclusion: CloudFront's on-behalf-of
certificate visibility check fails closed for this principal via CFN;
the written policies do not explain it.

**Deployed resources (created under the engineer role):**

- Distribution: `E35URO4KFESJYU`, domain `dozmg6c3es7yz.cloudfront.net`,
  alias `play-staging.fobal.ai`, cert `*.fobal.ai`
  (`arn:aws:acm:us-east-1:368426158592:certificate/eb808baf-f8c4-4a3a-8af9-4d1e57410c40`
  — us-east-1 on purpose: CloudFront viewer certs must live there),
  default root object `index.html`, redirect-to-https, compress,
  CachingOptimized managed policy, http2and3, PriceClass_All.
- Origin Access Control: `E24QXXYXV4R7X4` (s3, sigv4, always-sign) over
  `fobal-staging-client-368426158592.s3.sa-east-1.amazonaws.com`.
- Client bucket policy: CloudFront service principal `s3:GetObject` scoped
  by `AWS:SourceArn` to the distribution, plus a deny-insecure-transport
  statement. Applied imperatively (`aws s3api put-bucket-policy`).

**Client redeploy runbook** (engineer role; no CDK involved):

    node tools/build-client.mjs \
      --lobby-url https://lobby-staging.fobal.ai \
      --match-ws  wss://matches-staging.fobal.ai
    aws s3 sync dist/client s3://fobal-staging-client-368426158592/ --delete
    aws cloudfront create-invalidation --distribution-id E35URO4KFESJYU --paths '/*'

DNS at iwantmyname: `play-staging.fobal.ai` CNAME →
`dozmg6c3es7yz.cloudfront.net`; `lobby-staging.fobal.ai` CNAME → the ALB
DNS name. The `fobal-staging-web` CDK stack that originally owned the
distribution was retired in favor of this runbook.

## Production environment (M3)

Same account, same VPC, fully parallel `fobal-prod-*` world defined by
`infra/cdk/lib/envs.ts` (one parameterized stack, per-env values; the
staging template was verified BYTE-IDENTICAL across the refactor):

- Stack `fobal-prod-match-server`: matches.fobal.ai + lobby.fobal.ai on its
  own ALB; match task 0.5 vCPU / 1 GB with `FOBAL_MAX_ROOMS=90` (the
  SCALE.md capacity rung); `FOBAL_WS_ORIGINS=https://play.fobal.ai` ONLY —
  no localhost escape hatches in prod.
- **Stable Ed25519 signing key** (prod results verify forever):
  `fobal/prod/match-server/signing-key`, created imperatively ONCE via
  `npx tsx tools/generate-signing-key.mjs | aws secretsmanager create-secret
  --name fobal/prod/match-server/signing-key --secret-string file:///dev/stdin
  --region sa-east-1` (the tool refuses to print to a TTY), imported by the
  stack and injected as FOBAL_SIGNING_KEY. Rotation invalidates verification
  of previously signed results — treat as long-lived identity.
- Certificates: the existing `*.fobal.ai` wildcards (sa-east-1 for the ALB,
  us-east-1 for CloudFront) already cover matches/lobby/play.fobal.ai — no
  new certs.
- Imperative one-time resources (standing rule): `fobal-prod-match-server`
  ECR repo (or reuse the staging repo's images — they are env-agnostic; we
  create a prod repo for lifecycle isolation), `fobal-prod-replays-<acct>`
  bucket, `fobal-prod-client-<acct>` bucket, `/fobal/prod/match-server` +
  `/fobal/prod/lobby-server` log groups, the signing-key secret, and the
  prod CloudFront distribution per the imperative runbook above (same
  CFN+exec-role quirk applies — do NOT attempt the distribution via CFN).
- Lobby: SES from lobby@fobal.ai (same verified identity), test-login-key
  secret for acceptance, NO dev auth. SES production access must be
  APPROVED for strangers to receive codes.
- Deploy contexts: `-c imageTag=… -c prodCertificateArn=<sa-east-1
  wildcard> -c prodWildcardCertificateArn=<same>`.
- IAM: engineer/boundary/cfn-exec were widened to fobal-prod-* scopes and
  Environment/Scope tag values ['staging','production']/['fobal-staging',
  'fobal-prod']. The boundary sits at ~6,001 of 6,144 non-ws chars — the
  NEXT boundary change must slim something first.

## CI/CD (M3): GitHub Actions with OIDC — no static keys

Two workflows, one principle: **no long-lived AWS credentials exist
anywhere in GitHub.** Every AWS call authenticates through GitHub's OIDC
provider assuming `Fobal-GitHubDeploy`, and the role can do exactly four
things: push match-server images, assume the `cdk-fobalstag-*` bootstrap
roles, sync the two client buckets, and invalidate the two distributions.

- `.github/workflows/ci.yml` — the merge gate, credential-less:
  typecheck + full test suite (characterization first), the client build's
  rewrite assertions, CDK typecheck, and BOTH synth paths (no contexts =
  the deploy-neutral rule stays enforced; all context gates open with
  placeholder ARNs = the gated resources still synthesize).
- `.github/workflows/deploy.yml` —
  - on **merge to main**: build the image once, push the same digest to
    both ECR repos tagged `<short-sha>`, `cdk diff` both stacks
    (informational; nothing mutates).
  - on **manual dispatch** (the deploy gate): choose staging or
    production; the job binds to the GitHub *environment* of that name —
    add required reviewers under repo Settings → Environments to make the
    gate two-person. Steps: ensure the image tag exists (build from the
    dispatched checkout if not) → `cdk deploy` → client build + `s3 sync`
    + CloudFront invalidation → health smoke on matches/lobby/play.

**Role setup (one-time, human console — IAM provider/role creation is
deliberately NOT in the agent's or the pipeline's permissions):**

1. IAM → Identity providers → Add provider → OpenID Connect →
   URL `https://token.actions.githubusercontent.com`, audience
   `sts.amazonaws.com`. (Skip if the provider already exists — one per
   account.)
2. IAM → Roles → Create role → Web identity → that provider, audience
   `sts.amazonaws.com` → name it `Fobal-GitHubDeploy`, set permissions
   boundary `FobalAgentBoundary` (Fobal-* principals carry the boundary,
   standing rule).
3. Open the role → Trust relationships → Edit → paste
   `infra/iam/FobalGitHubDeployTrust.json` (locks the role to
   `santisiri/fobal-simulator`: the `main` branch for publish, the
   `staging`/`production` environments for deploys).
4. Add permissions → Create inline policy → JSON → paste
   `infra/iam/FobalGitHubDeploy.json`, name it `FobalGitHubDeployCurrent`.

**Repo variables (one-time, `gh variable set` or repo Settings):**
`FOBAL_STAGING_CERT_ARN` (the matches-staging.fobal.ai listener cert,
sa-east-1) and `FOBAL_WILDCARD_CERT_ARN` (the `*.fobal.ai` sa-east-1
wildcard — also serves as both prod cert contexts). ARNs are not secret;
they live in variables, not secrets, so diffs can print them.

Notes:
- The CDK bootstrap roles trust the account root principal, so granting
  the deploy role `sts:AssumeRole` on `cdk-fobalstag-*` is sufficient —
  no bootstrap re-run needed.
- Image tags are the 7-char short SHA (same convention the agent used by
  hand). The deploy job accepts an explicit `image-tag` input to roll back
  to any previously published image.
- Acceptance suites (`staging-acceptance.mjs`, `lobby-acceptance.mjs
  --full`) are NOT in the pipeline: they need the create-key/test-login-key
  secrets, which stay out of GitHub by design. Run them via the agent
  after a deploy, as always.
- The imperative one-time resources (ECR repos, buckets, distributions,
  log groups, secrets) remain outside the pipeline per the standing rule
  above — the pipeline only updates compute and content.

## Observability (M3): dashboard + alarms from the EMF metrics

The B2 telemetry design pays off here: the server's metrics are EMF log
lines, so the dashboard and alarms are pure CDK — no agents, no sidecars,
no new task permissions. Everything is per-env (`fobal-<env>-…`).

- **Dashboard** `fobal-<env>-match-server` (CloudWatch → Dashboards):
  capacity row (RoomsActive vs the cap, ConnectionsOpen, RSS vs task
  memory), command row (accepted/rejected, shed/reject breakdown, room
  lifecycle), voice row (SttMs + CoachInterpretMs p50/p95 against the 3s
  budget line, SttFailed), infra row (ALB 5xx/requests, ECS utilization).
- **Alarms** (8): the five infra alarms that shipped with the stacks
  (unhealthy hosts, ALB 5xx, high CPU/memory, task stopped) now NOTIFY,
  plus three EMF alarms — rooms ≥80% of cap, ≥5 STT failures/5min, coach
  interpret p95 >3s. EMF alarms treat missing data as NOT_BREACHING: an
  idle server emits nothing, and silence must never page.
- **Notifications**: SNS topic `fobal-<env>-alarms`; every alarm sends
  both ALARM and OK. The email endpoint lives IN `envs.ts`
  (`alarmEmail`) rather than a deploy context on purpose — a context
  forgotten on one deploy would silently delete the subscription. After
  the first deploy, AWS emails a **Confirm subscription** link to that
  address — until it is clicked, alarms fire into the void. One
  confirmation per topic (so one per environment).
- IAM: `FobalCloudFormationExecution.json` gained dashboard
  (`arn:aws:cloudwatch::<acct>:dashboard/fobal-*`) and SNS
  (`arn:aws:sns:sa-east-1:<acct>:fobal-*`) statements — re-apply the
  cfn-exec inline policy before deploying (standing rule after every
  pull).
