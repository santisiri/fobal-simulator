import * as cdk from 'aws-cdk-lib';
import { Duration, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { FobalEnvConfig } from './envs.js';

const ACCOUNT = '368426158592';
const REGION = 'sa-east-1';
const CONTAINER_PORT = 8473;
const LOBBY_PORT = 8475;

export class FobalStack extends Stack {
  constructor(scope: Construct, id: string, envCfg: FobalEnvConfig, props: StackProps = {}) {
    super(scope, id, props);
    const PREFIX = envCfg.prefix;
    const HOSTNAME = envCfg.matchesHostname;
    const LOBBY_HOSTNAME = envCfg.lobbyHostname;
    const ROLE = envCfg.roleInfix;

    Tags.of(this).add('Project', 'Fobal');
    Tags.of(this).add('Environment', envCfg.environmentTag);
    Tags.of(this).add('Scope', PREFIX);

    const imageTag = this.node.tryGetContext('imageTag')?.toString() ?? 'staging';
    const certificateArn = this.node.tryGetContext(envCfg.certContextKey)?.toString()
      ?? `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/REPLACE_WITH_VALIDATED_CERTIFICATE_ID`;
    // *.fobal.ai in sa-east-1 — added to the HTTPS listener for the lobby
    // hostname. The ENTIRE lobby service is gated on this context so the
    // stack keeps synthesizing exactly as before until the cert exists:
    //   -c wildcardCertificateArn=arn:aws:acm:sa-east-1:…
    const wildcardCertificateArn = this.node.tryGetContext(envCfg.wildcardCertContextKey)?.toString();

    const boundary = iam.ManagedPolicy.fromManagedPolicyArn(
      this,
      'FobalAgentBoundary',
      `arn:aws:iam::${ACCOUNT}:policy/FobalAgentBoundary`,
    );

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'DefaultVpc', {
      vpcId: 'vpc-013e7864',
      availabilityZones: ['sa-east-1a', 'sa-east-1b', 'sa-east-1c'],
      publicSubnetIds: ['subnet-1f123f7a', 'subnet-101a8d67', 'subnet-6446903d'],
      publicSubnetRouteTableIds: ['rtb-29f3744c', 'rtb-29f3744c', 'rtb-29f3744c'],
    });

    const publicSubnets = [
      ec2.Subnet.fromSubnetAttributes(this, 'PublicSubnetA', {
        subnetId: 'subnet-1f123f7a',
        availabilityZone: 'sa-east-1a',
        routeTableId: 'rtb-29f3744c',
      }),
      ec2.Subnet.fromSubnetAttributes(this, 'PublicSubnetB', {
        subnetId: 'subnet-101a8d67',
        availabilityZone: 'sa-east-1b',
        routeTableId: 'rtb-29f3744c',
      }),
      ec2.Subnet.fromSubnetAttributes(this, 'PublicSubnetC', {
        subnetId: 'subnet-6446903d',
        availabilityZone: 'sa-east-1c',
        routeTableId: 'rtb-29f3744c',
      }),
    ];

    // The repository is created imperatively BEFORE the first deploy and
    // imported here: the Fargate service cannot stabilize without an image,
    // so the image must be pushable before this stack ever runs. Create it
    // once (scan-on-push + keep-last-20 lifecycle applied via CLI):
    //   aws ecr create-repository --repository-name fobal-staging-match-server \
    //     --image-scanning-configuration scanOnPush=true --region sa-east-1
    const repository = ecr.Repository.fromRepositoryName(
      this,
      'MatchServerRepository',
      `${PREFIX}-match-server`,
    );

    // Like the ECR repository, the replay bucket is created imperatively and
    // IMPORTED: a RETAIN-policy bucket with a fixed name orphans itself on
    // every failed stack create (rollback skips it, the next create
    // collides), and the boundary deliberately forbids the agent from
    // deleting fobal-staging-* buckets. Create once per environment:
    //   aws s3api create-bucket --bucket fobal-staging-replays-368426158592 \
    //     --region sa-east-1 --create-bucket-configuration LocationConstraint=sa-east-1
    //   aws s3api put-bucket-versioning --bucket ... --versioning-configuration Status=Enabled
    //   aws s3api put-public-access-block --bucket ... --public-access-block-configuration \
    //     BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    //   aws s3api put-bucket-lifecycle-configuration --bucket ... (30d noncurrent expiry)
    // (SSE-S3 encryption is the S3 default.) The SSL-only bucket policy stays
    // stack-managed below so redeploys always restore it.
    const replayBucket = s3.Bucket.fromBucketName(
      this,
      'ReplayBucket',
      `${PREFIX}-replays-${ACCOUNT}`,
    );

    new s3.CfnBucketPolicy(this, 'ReplayBucketPolicy', {
      bucket: replayBucket.bucketName,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'DenyInsecureTransport',
            Effect: 'Deny',
            Principal: '*',
            Action: 's3:*',
            Resource: [replayBucket.bucketArn, replayBucket.arnForObjects('*')],
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          },
        ],
      },
    });

    const tokenSecret = new secretsmanager.Secret(this, 'TokenSecret', {
      secretName: `${envCfg.secretsPrefix}/match-server/token-secret`,
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
      },
    });

    const createKey = new secretsmanager.Secret(this, 'CreateKey', {
      secretName: `${envCfg.secretsPrefix}/match-server/create-key`,
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
      },
    });

    // Imported, like the ECR repo and replay bucket: the stack owns only
    // disposable compute/networking; every long-lived fixed-name resource is
    // created imperatively once and imported (RETAIN + fixed name orphans
    // itself on failed creates and collides on the retry). Fresh environments:
    //   aws logs create-log-group --log-group-name /fobal/staging/match-server --region sa-east-1
    //   aws logs put-retention-policy --log-group-name /fobal/staging/match-server --retention-in-days 30
    const logGroup = logs.LogGroup.fromLogGroupName(
      this,
      'MatchServerLogGroup',
      envCfg.namespace,
    );

    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `Fobal-${ROLE}-match-server-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      permissionsBoundary: boundary,
      inlinePolicies: {
        FobalEcsTaskRole: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                's3:AbortMultipartUpload',
                's3:DeleteObject',
                's3:GetObject',
                's3:ListBucket',
                's3:PutObject',
              ],
              resources: [replayBucket.bucketArn, replayBucket.arnForObjects('*')],
            }),
            new iam.PolicyStatement({
              actions: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'],
              resources: [
                `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${envCfg.secretsPrefix}/match-server/*`,
              ],
            }),
            new iam.PolicyStatement({
              actions: ['cloudwatch:PutMetricData'],
              resources: ['*'],
              conditions: {
                StringEquals: { 'cloudwatch:namespace': envCfg.namespace },
              },
            }),
          ],
        }),
      },
    });

    // prod only: results must verify across task restarts — a long-lived
    // Ed25519 key created imperatively ONCE and imported (standing rule):
    //   npx tsx tools/generate-signing-key.mjs | aws secretsmanager create-secret \
    //     --name fobal/prod/match-server/signing-key --secret-string file:///dev/stdin
    const signingSecret = envCfg.stableSigningKey
      ? secretsmanager.Secret.fromSecretNameV2(
          this, 'SigningKeySecret', `${envCfg.secretsPrefix}/match-server/signing-key`)
      : null;

    // M4 voice: the Claude interpreter + hosted STT keys. Gated on
    // -c aiSecrets=1 so deploys stay valid until the secrets exist
    // (created imperatively; a missing referenced secret crash-loops the
    // task at launch):
    //   aws secretsmanager create-secret --name <prefix>/match-server/anthropic-key --secret-string <key>
    //   aws secretsmanager create-secret --name <prefix>/match-server/stt-key --secret-string <key>
    const aiSecrets = this.node.tryGetContext('aiSecrets')
      ? {
          anthropic: secretsmanager.Secret.fromSecretNameV2(
            this, 'AnthropicKeySecret', `${envCfg.secretsPrefix}/match-server/anthropic-key`),
          stt: secretsmanager.Secret.fromSecretNameV2(
            this, 'SttKeySecret', `${envCfg.secretsPrefix}/match-server/stt-key`),
        }
      : null;

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: `Fobal-${ROLE}-match-server-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      permissionsBoundary: boundary,
      inlinePolicies: {
        FobalEcsExecutionRole: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'ecr:BatchCheckLayerAvailability',
                'ecr:BatchGetImage',
                'ecr:GetDownloadUrlForLayer',
              ],
              resources: [repository.repositoryArn],
            }),
            new iam.PolicyStatement({
              actions: ['ecr:GetAuthorizationToken'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [`${logGroup.logGroupArn}:*`],
            }),
            new iam.PolicyStatement({
              actions: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'],
              resources: [
                tokenSecret.secretArn,
                createKey.secretArn,
                // fromSecretNameV2 arns lack the random suffix — wildcard it
                ...(signingSecret ? [`${signingSecret.secretArn}-??????`] : []),
                ...(aiSecrets ? [`${aiSecrets.anthropic.secretArn}-??????`, `${aiSecrets.stt.secretArn}-??????`] : []),
              ],
            }),
          ],
        }),
      },
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${PREFIX}-cluster`,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${PREFIX}-match-server`,
      cpu: envCfg.taskCpu,
      memoryLimitMiB: envCfg.taskMemoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole,
      executionRole,
    });

    const container = taskDefinition.addContainer('match-server', {
      containerName: 'match-server',
      image: ecs.ContainerImage.fromEcrRepository(repository, imageTag),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'match-server',
        logGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        PORT: String(CONTAINER_PORT),
        FOBAL_STORE: '/data/matches',
        FOBAL_STORE_BACKEND: 's3',
        FOBAL_REPLAY_BUCKET: replayBucket.bucketName,
        FOBAL_CLOUDWATCH_NAMESPACE: envCfg.namespace,
        // per-IP caps must see the CLIENT ip, not the ALB's — the server
        // only honors x-forwarded-for when this is set
        FOBAL_TRUST_PROXY: '1',
        // B3: the hosted client plus local dev pages; tools (no Origin
        // header) always pass regardless
        FOBAL_WS_ORIGINS: envCfg.wsOrigins,
        ...(envCfg.maxRooms ? { FOBAL_MAX_ROOMS: envCfg.maxRooms } : {}),
      },
      secrets: {
        FOBAL_SECRET: ecs.Secret.fromSecretsManager(tokenSecret),
        FOBAL_CREATE_KEY: ecs.Secret.fromSecretsManager(createKey),
        ...(signingSecret ? { FOBAL_SIGNING_KEY: ecs.Secret.fromSecretsManager(signingSecret) } : {}),
        ...(aiSecrets ? {
          ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(aiSecrets.anthropic),
          FOBAL_STT_API_KEY: ecs.Secret.fromSecretsManager(aiSecrets.stt),
        } : {}),
      },
      portMappings: [
        {
          containerPort: CONTAINER_PORT,
          protocol: ecs.Protocol.TCP,
        },
      ],
      healthCheck: {
        command: ['CMD-SHELL', `node -e "fetch('http://127.0.0.1:${CONTAINER_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      securityGroupName: `${PREFIX}-alb-sg`,
      description: 'FOBAL staging public ALB security group',
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP redirect');
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS and WSS');

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      securityGroupName: `${PREFIX}-match-server-sg`,
      description: 'FOBAL staging match server task security group',
      allowAllOutbound: false,
    });
    serviceSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(CONTAINER_PORT),
      'Only the public ALB can reach the match server',
    );
    serviceSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to AWS APIs and registries');

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      loadBalancerName: `${PREFIX}-alb`,
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnets: publicSubnets },
    });

    const service = new ecs.FargateService(this, 'Service', {
      serviceName: `${PREFIX}-match-server`,
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: { subnets: publicSubnets },
      enableExecuteCommand: false,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      targetGroupName: `${PREFIX}-match-server-tg`,
      vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: CONTAINER_PORT,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        enabled: true,
        path: '/health',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
      },
      deregistrationDelay: Duration.seconds(30),
    });
    service.attachToApplicationTargetGroup(targetGroup);

    loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    const httpsListener = loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromArn(certificateArn)],
      defaultTargetGroups: [targetGroup],
    });

    // ---- lobby service (B4) — same image, second entrypoint, same ALB ----
    // Everything below only exists once the *.fobal.ai sa-east-1 cert is
    // passed via -c wildcardCertificateArn=…; without it the stack is
    // byte-for-byte what it was before this block landed.
    if (wildcardCertificateArn) {
      httpsListener.addCertificates('WildcardCertificate', [
        elbv2.ListenerCertificate.fromArn(wildcardCertificateArn),
      ]);

      // fresh environments (imperative, imported — standing rule):
      //   aws logs create-log-group --log-group-name /fobal/staging/lobby-server --region sa-east-1
      //   aws logs put-retention-policy --log-group-name /fobal/staging/lobby-server --retention-in-days 30
      const lobbyLogGroup = logs.LogGroup.fromLogGroupName(
        this,
        'LobbyLogGroup',
        envCfg.lobbyLogGroup,
      );

      const lobbySessionSecret = new secretsmanager.Secret(this, 'LobbySessionSecret', {
        secretName: `${envCfg.secretsPrefix}/lobby-server/session-secret`,
        generateSecretString: {
          passwordLength: 48,
          excludePunctuation: true,
        },
      });

      // acceptance scripts present this via x-fobal-test-key to receive login
      // codes in the response; real users only ever get codes by email
      const lobbyTestLoginKey = new secretsmanager.Secret(this, 'LobbyTestLoginKey', {
        secretName: `${envCfg.secretsPrefix}/lobby-server/test-login-key`,
        generateSecretString: {
          passwordLength: 48,
          excludePunctuation: true,
        },
      });

      // M5 mint: the generator-signer key authorizes SquadMint permits and
      // NOTHING else (it holds zero on-chain roles — the generator contract
      // enforces the power budget regardless). Created imperatively, gated
      // on -c mintSigner=1 so deploys stay valid until the secret exists
      // (a missing referenced secret crash-loops the task at launch):
      //   aws secretsmanager create-secret \
      //     --name <prefix>/lobby-server/generator-signer-pk --secret-string <0x…>
      const mintSignerSecret = envCfg.chain?.generatorAddress && this.node.tryGetContext('mintSigner')
        ? secretsmanager.Secret.fromSecretNameV2(
            this, 'MintSignerSecret', `${envCfg.secretsPrefix}/lobby-server/generator-signer-pk`)
        : null;

      const lobbyTaskRole = new iam.Role(this, 'LobbyTaskRole', {
        roleName: `Fobal-${ROLE}-lobby-server-task-role`,
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        permissionsBoundary: boundary,
        inlinePolicies: {
          FobalLobbyTaskRole: new iam.PolicyDocument({
            statements: [
              // durable lobby state lives in the replay bucket under lobby/
              new iam.PolicyStatement({
                actions: ['s3:GetObject', 's3:PutObject'],
                resources: [replayBucket.arnForObjects('lobby/*')],
              }),
              new iam.PolicyStatement({
                actions: ['s3:ListBucket'],
                resources: [replayBucket.bucketArn],
              }),
              // login codes go out via SES as the verified fobal.ai identity
              new iam.PolicyStatement({
                actions: ['ses:SendEmail'],
                resources: [`arn:aws:ses:${REGION}:${ACCOUNT}:identity/fobal.ai`],
              }),
            ],
          }),
        },
      });

      const lobbyExecutionRole = new iam.Role(this, 'LobbyExecutionRole', {
        roleName: `Fobal-${ROLE}-lobby-server-execution-role`,
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        permissionsBoundary: boundary,
        inlinePolicies: {
          FobalLobbyExecutionRole: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: [
                  'ecr:BatchCheckLayerAvailability',
                  'ecr:BatchGetImage',
                  'ecr:GetDownloadUrlForLayer',
                ],
                resources: [repository.repositoryArn],
              }),
              new iam.PolicyStatement({
                actions: ['ecr:GetAuthorizationToken'],
                resources: ['*'],
              }),
              new iam.PolicyStatement({
                actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [`${lobbyLogGroup.logGroupArn}:*`],
              }),
              new iam.PolicyStatement({
                actions: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'],
                // the lobby shares the CREATE KEY with the match server — it
                // is the only holder of it besides the match server itself
                resources: [
                  lobbySessionSecret.secretArn,
                  lobbyTestLoginKey.secretArn,
                  createKey.secretArn,
                  // fromSecretNameV2 arns lack the random suffix — wildcard it
                  ...(mintSignerSecret ? [`${mintSignerSecret.secretArn}-??????`] : []),
                ],
              }),
            ],
          }),
        },
      });

      const lobbyTaskDefinition = new ecs.FargateTaskDefinition(this, 'LobbyTaskDefinition', {
        family: `${PREFIX}-lobby-server`,
        cpu: 256,
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: lobbyTaskRole,
        executionRole: lobbyExecutionRole,
      });

      lobbyTaskDefinition.addContainer('lobby-server', {
        containerName: 'lobby-server',
        image: ecs.ContainerImage.fromEcrRepository(repository, imageTag),
        command: ['node_modules/.bin/tsx', 'apps/lobby-server/src/index.ts'],
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: 'lobby-server',
          logGroup: lobbyLogGroup,
        }),
        environment: {
          NODE_ENV: 'production',
          PORT: String(LOBBY_PORT),
          FOBAL_MATCH_URL: `https://${HOSTNAME}`,
          FOBAL_PUBLIC_MATCH_URL: `https://${HOSTNAME}`,
          FOBAL_LOBBY_STORE: '/data/lobby',
          FOBAL_LOBBY_BACKEND: 's3',
          FOBAL_LOBBY_BUCKET: replayBucket.bucketName,
          FOBAL_LOBBY_S3_PREFIX: 'lobby/',
          // login codes are DELIVERED (never returned): SES as fobal.ai.
          // Acceptance scripts read codes via the test-login-key secret.
          FOBAL_EMAIL_BACKEND: 'ses',
          FOBAL_EMAIL_FROM: 'lobby@fobal.ai',
          // email invitations link back to the public client
          FOBAL_INVITE_BASE_URL: `https://${envCfg.playHostname}`,
          // M5: chain reads (D1). Addresses are public, not secrets; in
          // envs.ts so no deploy can silently drop them (alarmEmail rule)
          ...(envCfg.chain ? {
            FOBAL_RPC_URL: envCfg.chain.rpcUrl,
            FOBAL_CHAIN_ID: String(envCfg.chain.chainId),
            FOBAL_CHAIN_PLAYER: envCfg.chain.playerAddress,
            FOBAL_CHAIN_REGISTRY: envCfg.chain.registryAddress,
          } : {}),
          // harmless without the signer secret: the mint service only boots
          // when the FULL set (generator + chainId + key) is present
          ...(envCfg.chain?.generatorAddress ? {
            FOBAL_CHAIN_GENERATOR: envCfg.chain.generatorAddress,
          } : {}),
        },
        secrets: {
          FOBAL_LOBBY_SECRET: ecs.Secret.fromSecretsManager(lobbySessionSecret),
          FOBAL_TEST_LOGIN_KEY: ecs.Secret.fromSecretsManager(lobbyTestLoginKey),
          FOBAL_CREATE_KEY: ecs.Secret.fromSecretsManager(createKey),
          ...(mintSignerSecret ? { FOBAL_GENERATOR_SIGNER_PK: ecs.Secret.fromSecretsManager(mintSignerSecret) } : {}),
        },
        portMappings: [{ containerPort: LOBBY_PORT, protocol: ecs.Protocol.TCP }],
        healthCheck: {
          command: ['CMD-SHELL', `node -e "fetch('http://127.0.0.1:${LOBBY_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`],
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
          retries: 3,
          startPeriod: Duration.seconds(30),
        },
      });

      const lobbySecurityGroup = new ec2.SecurityGroup(this, 'LobbySecurityGroup', {
        vpc,
        securityGroupName: `${PREFIX}-lobby-server-sg`,
        description: 'FOBAL staging lobby server task security group',
        allowAllOutbound: false,
      });
      lobbySecurityGroup.addIngressRule(
        albSecurityGroup,
        ec2.Port.tcp(LOBBY_PORT),
        'Only the public ALB can reach the lobby',
      );
      lobbySecurityGroup.addEgressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(443),
        'HTTPS to AWS APIs and the match server via its public hostname',
      );

      const lobbyService = new ecs.FargateService(this, 'LobbyService', {
        serviceName: `${PREFIX}-lobby-server`,
        cluster,
        taskDefinition: lobbyTaskDefinition,
        desiredCount: 1,
        assignPublicIp: true,
        securityGroups: [lobbySecurityGroup],
        vpcSubnets: { subnets: publicSubnets },
        enableExecuteCommand: false,
        circuitBreaker: { rollback: true },
        minHealthyPercent: 0,
        maxHealthyPercent: 200,
      });

      const lobbyTargetGroup = new elbv2.ApplicationTargetGroup(this, 'LobbyTargetGroup', {
        targetGroupName: `${PREFIX}-lobby-tg`,
        vpc,
        protocol: elbv2.ApplicationProtocol.HTTP,
        port: LOBBY_PORT,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          enabled: true,
          path: '/health',
          healthyHttpCodes: '200',
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
        },
        deregistrationDelay: Duration.seconds(30),
      });
      lobbyService.attachToApplicationTargetGroup(lobbyTargetGroup);

      httpsListener.addAction('LobbyHostRule', {
        priority: 10,
        conditions: [elbv2.ListenerCondition.hostHeaders([LOBBY_HOSTNAME])],
        action: elbv2.ListenerAction.forward([lobbyTargetGroup]),
      });

      new cdk.CfnOutput(this, 'LobbyHostname', { value: LOBBY_HOSTNAME });
    }

    const hostedZoneId = this.node.tryGetContext('hostedZoneId')?.toString();
    const hostedZoneName = this.node.tryGetContext('hostedZoneName')?.toString();
    if (hostedZoneId && hostedZoneName) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId,
        zoneName: hostedZoneName,
      });
      new route53.ARecord(this, 'MatchesStagingAlias', {
        zone,
        recordName: HOSTNAME,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(loadBalancer)),
        ttl: Duration.minutes(5),
      });
    }

    // ── Observability (M3): every alarm notifies the ops topic, and the
    // dashboard is built from the EMF metrics the server already emits
    // (telemetry.ts — metric lines riding the awslogs pipe, no SDK).
    // EMF metrics are dimensionless by design, so widgets and alarms
    // reference them by bare name in the env namespace.
    const emf = (metricName: string, statistic: string, period = Duration.minutes(1)) =>
      new cloudwatch.Metric({ namespace: envCfg.namespace, metricName, statistic, period });
    // FOBAL_MAX_ROOMS unset → the server's own default cap (SCALE.md)
    const maxRooms = Number(envCfg.maxRooms ?? '25');

    const alarms: cloudwatch.Alarm[] = [];

    alarms.push(new cloudwatch.Alarm(this, 'UnhealthyHostsAlarm', {
      alarmName: `${PREFIX}-match-server-unhealthy-hosts`,
      metric: targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    }));

    alarms.push(new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      alarmName: `${PREFIX}-match-server-5xx`,
      metric: loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: Duration.minutes(1) }),
      threshold: 5,
      evaluationPeriods: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    }));

    alarms.push(new cloudwatch.Alarm(this, 'HighCpuAlarm', {
      alarmName: `${PREFIX}-match-server-high-cpu`,
      metric: service.metricCpuUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    }));

    alarms.push(new cloudwatch.Alarm(this, 'HighMemoryAlarm', {
      alarmName: `${PREFIX}-match-server-high-memory`,
      metric: service.metricMemoryUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    }));

    alarms.push(new cloudwatch.Alarm(this, 'StoppedTaskAlarm', {
      alarmName: `${PREFIX}-match-server-task-stopped`,
      metric: new cloudwatch.Metric({
        namespace: 'ECS/ContainerInsights',
        metricName: 'RunningTaskCount',
        dimensionsMap: {
          ClusterName: cluster.clusterName,
          ServiceName: service.serviceName,
        },
        statistic: 'Minimum',
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    }));

    // EMF alarms — treatMissingData NOT_BREACHING throughout: an idle
    // server emits nothing, and silence must never page anyone.
    alarms.push(new cloudwatch.Alarm(this, 'RoomsNearCapacityAlarm', {
      alarmName: `${PREFIX}-match-server-rooms-near-capacity`,
      metric: emf('RoomsActive', 'Maximum', Duration.minutes(5)),
      threshold: Math.ceil(maxRooms * 0.8),
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    alarms.push(new cloudwatch.Alarm(this, 'SttFailuresAlarm', {
      alarmName: `${PREFIX}-match-server-stt-failures`,
      metric: emf('SttFailed', 'Sum', Duration.minutes(5)),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // the brief's voice budget: order spoken → team heard you in ≤3s
    alarms.push(new cloudwatch.Alarm(this, 'CoachSlowAlarm', {
      alarmName: `${PREFIX}-match-server-coach-slow`,
      metric: emf('CoachInterpretMs', 'p95', Duration.minutes(5)),
      threshold: 3000,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${PREFIX}-alarms`,
    });
    if (envCfg.alarmEmail) {
      alarmTopic.addSubscription(new snsSubs.EmailSubscription(envCfg.alarmEmail));
    }
    for (const alarm of alarms) {
      alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
      alarm.addOkAction(new cwActions.SnsAction(alarmTopic));
    }

    // The ops dashboard. Lobby-specific widgets are deliberately absent:
    // the lobby rides the same ALB and image, so its failures surface in
    // the ALB rows — and the lobby service only exists behind the
    // wildcard-cert gate.
    const graph = (title: string, left: cloudwatch.IMetric[], opts: Partial<cloudwatch.GraphWidgetProps> = {}) =>
      new cloudwatch.GraphWidget({ title, left, width: 8, height: 6, ...opts });
    const dashboard = new cloudwatch.Dashboard(this, 'OpsDashboard', {
      dashboardName: `${PREFIX}-match-server`,
    });
    dashboard.addWidgets(
      graph('Rooms active', [emf('RoomsActive', 'Maximum')], {
        leftAnnotations: [{ value: maxRooms, label: `cap ${maxRooms}` }],
      }),
      graph('Connections open', [emf('ConnectionsOpen', 'Maximum')]),
      graph('Server RSS (MB)', [emf('MemoryRssMb', 'Maximum')], {
        leftAnnotations: [{ value: envCfg.taskMemoryMiB, label: 'task memory' }],
      }),
    );
    dashboard.addWidgets(
      graph('Commands', [emf('CommandAccepted', 'Sum'), emf('CommandRejected', 'Sum')]),
      graph('Sheds & rejects', [
        emf('HelloRejected', 'Sum'),
        emf('OriginRejected', 'Sum'),
        emf('ConnectionCapped', 'Sum'),
        emf('RoomCapacityRejected', 'Sum'),
      ]),
      graph('Room lifecycle', [emf('RoomCreated', 'Sum'), emf('ResultWritten', 'Sum')]),
    );
    dashboard.addWidgets(
      graph('Voice & coach latency (ms)', [
        emf('SttMs', 'p50'),
        emf('SttMs', 'p95'),
        emf('CoachInterpretMs', 'p50'),
        emf('CoachInterpretMs', 'p95'),
      ], { leftAnnotations: [{ value: 3000, label: 'voice budget 3s' }] }),
      graph('STT failures', [emf('SttFailed', 'Sum')]),
      graph('Persistence', [emf('SnapshotPersisted', 'Sum'), emf('InternalStatePersisted', 'Sum')]),
    );
    dashboard.addWidgets(
      graph('ALB 5xx', [
        loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: Duration.minutes(1) }),
        loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: Duration.minutes(1) }),
      ]),
      graph('ALB requests', [loadBalancer.metrics.requestCount({ period: Duration.minutes(1) })]),
      graph('ECS utilization (%)', [service.metricCpuUtilization(), service.metricMemoryUtilization()]),
    );

    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
    new cdk.CfnOutput(this, 'DashboardName', { value: `${PREFIX}-match-server` });

    new cdk.CfnOutput(this, 'RepositoryUri', { value: repository.repositoryUri });
    new cdk.CfnOutput(this, 'ReplayBucketName', { value: replayBucket.bucketName });
    new cdk.CfnOutput(this, 'LoadBalancerDnsName', { value: loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'StagingHostname', { value: HOSTNAME });
  }
}
