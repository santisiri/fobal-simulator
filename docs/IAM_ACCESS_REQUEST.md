# FOBAL staging IAM access request

Account: `368426158592`
Region: `sa-east-1`
Environment: `staging`
Project prefix: `fobal-staging`
IAM role prefix: `Fobal-`
Secret namespace: `fobal/staging/*`
Log namespace: `/fobal/staging/*`
CloudFormation stack prefix: `fobal-staging-`

This request is for staging access only. It does not request AdministratorAccess, IAM user management, organization administration, billing administration, CloudTrail control, production access, or mainnet access.

## Policy files in this PR

- `infra/iam/FobalAgentBoundary.json`: permissions boundary required on all roles created by this project.
- `infra/iam/FobalStagingEngineer.json`: proposed Identity Center permission-set policy for `sairi-fobal`.
- `infra/iam/FobalCloudFormationExecution.json`: proposed CDK/CloudFormation execution role policy.
- `infra/iam/FobalEcsTaskRole.json`: runtime permissions for the match server application.
- `infra/iam/FobalEcsExecutionRole.json`: ECS agent permissions needed to pull images, read secrets, and write logs.

## Admin provisioning steps

IAM managed policies are capped at 6,144 non-whitespace characters.
`FobalAgentBoundary` and `FobalCloudFormationExecution` fit and MUST be
customer-managed policies (the CDK bootstrap references both by name).
`FobalStagingEngineer` does not fit; it is provisioned as the permission
set's INLINE policy (Identity Center inline limit: 10,240 characters).

1. Create the two managed policies (admin credentials, any region):

```sh
aws iam create-policy --policy-name FobalAgentBoundary \
  --policy-document file://infra/iam/FobalAgentBoundary.json
aws iam create-policy --policy-name FobalCloudFormationExecution \
  --policy-document file://infra/iam/FobalCloudFormationExecution.json
```

2. In IAM Identity Center, create a NEW permission set `FobalStaging`
   (keep `FobalDiscovery` read-only as-is):
   - Inline policy: the contents of `infra/iam/FobalStagingEngineer.json`.
   - Permissions boundary: customer-managed policy `FobalAgentBoundary`
     (this makes the boundary bind the agent itself, not just the roles it
     creates).
   - Session duration: 4 hours or more (CDK deploys plus the acceptance run
     exceed the 1 hour default).
3. Assign the `sairi-fobal` user to account `368426158592` with the
   `FobalStaging` permission set and provision it.
4. The operator refreshes SSO (`aws sso login --profile fobal-staging`) and
   verifies with `aws sts get-caller-identity` that the role is
   `AWSReservedSSO_FobalStaging_*`.

## Interactive staging development

Needed by `sairi-fobal` while developing and inspecting staging.

CloudFormation:

- `cloudformation:CreateStack`, `UpdateStack`, `DeleteStack`, `CreateChangeSet`, `ExecuteChangeSet`, `DeleteChangeSet`, `Describe*`, `List*`, `GetTemplate`, `GetTemplateSummary`, `ValidateTemplate`, `DetectStackDrift`
- Resources: `arn:aws:cloudformation:sa-east-1:368426158592:stack/fobal-staging-*/*`
- Why: CDK deploys and updates staging stacks through CloudFormation and needs to inspect changesets.

ECR:

- `ecr:CreateRepository`, `DescribeRepositories`, `PutLifecyclePolicy`, `SetRepositoryPolicy`, `BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage`, `BatchGetImage`, `GetDownloadUrlForLayer`, `ListImages`, `DescribeImages`, `BatchDeleteImage`
- Resources: `arn:aws:ecr:sa-east-1:368426158592:repository/fobal-staging-*`
- `ecr:GetAuthorizationToken` on `*`
- Why: build and push staging match-server images.

ECS:

- `ecs:CreateCluster`, `DeleteCluster`, `DescribeClusters`, `RegisterTaskDefinition`, `DeregisterTaskDefinition`, `DescribeTaskDefinition`, `CreateService`, `UpdateService`, `DeleteService`, `DescribeServices`, `ListServices`, `ListTasks`, `DescribeTasks`, `TagResource`, `UntagResource`
- Resources: Fobal staging clusters, services, task definitions, and tasks.
- Why: deploy and inspect the single staging service.

EC2 networking:

- `ec2:Describe*` on `*`
- Scoped create/update/delete actions for security groups and load-balancer-facing network rules tagged `Project=Fobal`, `Environment=staging`, `Scope=fobal-staging`
- Why: CDK must look up the default VPC/subnets and create staging security groups.

ELBv2:

- `elasticloadbalancing:CreateLoadBalancer`, `DeleteLoadBalancer`, `CreateTargetGroup`, `DeleteTargetGroup`, `CreateListener`, `DeleteListener`, `ModifyListener`, `ModifyLoadBalancerAttributes`, `ModifyTargetGroup`, `ModifyTargetGroupAttributes`, `Describe*`, `AddTags`, `RemoveTags`, `RegisterTargets`, `DeregisterTargets`
- Resources: `fobal-staging-*` ALB, target group, listeners.
- Why: public HTTPS/WSS ingress.

CloudWatch and Logs:

- `logs:CreateLogGroup`, `DeleteLogGroup`, `CreateLogStream`, `PutLogEvents`, `PutRetentionPolicy`, `DescribeLogGroups`, `DescribeLogStreams`, `FilterLogEvents`
- Resources: `/fobal/staging/*`
- `cloudwatch:PutMetricAlarm`, `DeleteAlarms`, `DescribeAlarms`, `GetMetricData`, `ListMetrics`
- Why: runtime logs and staging health alarms.

Secrets Manager:

- `secretsmanager:CreateSecret`, `UpdateSecret`, `PutSecretValue`, `DescribeSecret`, `GetSecretValue`, `TagResource`, `UntagResource`, `DeleteSecret`, `RestoreSecret`
- Resources: `arn:aws:secretsmanager:sa-east-1:368426158592:secret:fobal/staging/*`
- Why: token HMAC secret, match creation key, future result signing key.
- Force-delete is deliberately NOT denied: CloudFormation deletes secrets
  with `ForceDeleteWithoutRecovery=true`, so denying it wedges every stack
  rollback in `ROLLBACK_FAILED`. Staging secrets are generated values with
  nothing durable to protect.

S3:

- `s3:CreateBucket`, `PutBucketTagging`, `PutBucketVersioning`, `PutEncryptionConfiguration`, `PutBucketPublicAccessBlock`, `PutLifecycleConfiguration`, `GetBucket*`, `ListBucket`, `PutObject`, `GetObject`, `DeleteObject`, `AbortMultipartUpload`, `ListMultipartUploadParts`
- Resources: `arn:aws:s3:::fobal-staging-*` and `arn:aws:s3:::fobal-staging-*/*`
- Why: replay and snapshot storage plus CDK bootstrap assets.
- Boundary denies deleting buckets.

IAM:

- `iam:CreateRole`, `DeleteRole`, `GetRole`, `UpdateRole`, `TagRole`, `UntagRole`, `AttachRolePolicy`, `DetachRolePolicy`, `PutRolePolicy`, `DeleteRolePolicy`, `GetRolePolicy`, `ListRolePolicies`, `ListAttachedRolePolicies`
- Resources: `arn:aws:iam::368426158592:role/Fobal-*`
- `iam:PassRole` only to explicitly named Fobal roles.
- Why: CDK creates task roles and passes them to ECS.
- Boundary requires created roles to use `FobalAgentBoundary`.

SSM:

- `ssm:GetParameter`, `ssm:PutParameter`
- Resources: CDK bootstrap parameters under `/cdk-bootstrap/fobalstag/*`
- Why: CDK bootstrap version tracking.

ACM:

- `acm:RequestCertificate`, `acm:AddTagsToCertificate`, `acm:DescribeCertificate`, `acm:GetCertificate`, `acm:ListCertificates`, `acm:ListTagsForCertificate`
- Resources: `*` (ACM does not support resource scoping at request time; the boundary pins mutations to `sa-east-1`)
- Why: request and monitor the DNS-validated certificate for `matches-staging.fobal.ai`.

STS:

- `sts:AssumeRole`
- Resources: `arn:aws:iam::368426158592:role/cdk-fobalstag-*`
- Why: CDK deploys assume the bootstrap deploy/publishing/lookup roles.

## CDK deployment

CDK deployment requires the staging engineer policy plus the bootstrap roles created by:

```sh
npx cdk bootstrap aws://368426158592/sa-east-1 \
  --qualifier fobalstag \
  --toolkit-stack-name CDKToolkit-fobalstag \
  --no-bootstrap-customer-key \
  --cloudformation-execution-policies arn:aws:iam::368426158592:policy/FobalCloudFormationExecution \
  --custom-permissions-boundary FobalAgentBoundary \
  --tags Project=Fobal \
  --tags Environment=staging \
  --tags Scope=fobal-staging
```

`--toolkit-stack-name CDKToolkit-fobalstag` is mandatory: the default
`CDKToolkit` stack name is outside the scope both the boundary and the
engineer policy allow. `--no-bootstrap-customer-key` keeps the asset bucket
on S3-managed encryption — the engineer policy deliberately grants no KMS
administration.

The deployer should assume or use the CDK bootstrap deploy role and CloudFormation should use the execution role with `FobalCloudFormationExecution`.

## CloudFormation execution

The CloudFormation execution role needs create/update/delete permissions for the exact staging resources described in `docs/AWS_ARCHITECTURE.md`. It needs broader `Describe*`/`List*` reads where AWS does not support resource-level scoping.

The execution role must be created with the `FobalAgentBoundary` permissions boundary.

## ECS runtime

Task role:

- Read/write only `fobal-staging-replays-368426158592`.
- Read only `fobal/staging/match-server/*` secrets when the application code reads secrets directly in the future.
- Write custom metrics in namespace `/fobal/staging/match-server`.

Execution role:

- Pull image layers from `fobal-staging-match-server`.
- Read Secrets Manager values injected into container environment.
- Write container logs to `/fobal/staging/match-server`.

## GitHub Actions deployment

Future GitHub Actions should use OIDC, not permanent AWS access keys.

Required actions:

- `sts:AssumeRoleWithWebIdentity` into a Fobal deployment role constrained to `repo:santisiri/fobal-simulator:*`.
- ECR image push to `fobal-staging-match-server`.
- `cloudformation:*` on `fobal-staging-*` stacks through CDK.
- `iam:PassRole` only for `Fobal-staging-match-server-task-role`, `Fobal-staging-match-server-execution-role`, and the Fobal CloudFormation execution role.

No GitHub Action should receive `AdministratorAccess`, IAM user management, or static IAM access keys.

## Remaining broad permissions

The following remain broader than resource-level scope because AWS does not support resource scoping or CDK requires discovery:

- `ec2:Describe*`
- `ecs:List*`
- `ecs:Describe*`
- `elasticloadbalancing:Describe*`
- `cloudwatch:GetMetricData`
- `cloudwatch:ListMetrics`
- `logs:DescribeLogGroups`
- `ecr:GetAuthorizationToken`
- `iam:GetPolicy`, `iam:GetPolicyVersion` for managed policy inspection
- Selected `cloudformation:Describe*` and `cloudformation:List*`

All mutating actions are scoped to Fobal staging names, tags, ARNs, or explicit role names as far as AWS IAM supports.
