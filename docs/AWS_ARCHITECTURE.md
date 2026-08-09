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
