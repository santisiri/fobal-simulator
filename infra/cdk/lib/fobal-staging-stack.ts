import * as cdk from 'aws-cdk-lib';
import { Duration, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
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
import { Construct } from 'constructs';

const ACCOUNT = '368426158592';
const REGION = 'sa-east-1';
const PREFIX = 'fobal-staging';
const HOSTNAME = 'matches-staging.fobal.ai';
const CONTAINER_PORT = 8473;

export class FobalStagingStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    Tags.of(this).add('Project', 'Fobal');
    Tags.of(this).add('Environment', 'staging');
    Tags.of(this).add('Scope', PREFIX);

    const imageTag = this.node.tryGetContext('imageTag')?.toString() ?? 'staging';
    const certificateArn = this.node.tryGetContext('certificateArn')?.toString()
      ?? `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/REPLACE_WITH_VALIDATED_CERTIFICATE_ID`;

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
      secretName: 'fobal/staging/match-server/token-secret',
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
      },
    });

    const createKey = new secretsmanager.Secret(this, 'CreateKey', {
      secretName: 'fobal/staging/match-server/create-key',
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
      '/fobal/staging/match-server',
    );

    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'Fobal-staging-match-server-task-role',
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
                `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:fobal/staging/match-server/*`,
              ],
            }),
            new iam.PolicyStatement({
              actions: ['cloudwatch:PutMetricData'],
              resources: ['*'],
              conditions: {
                StringEquals: { 'cloudwatch:namespace': '/fobal/staging/match-server' },
              },
            }),
          ],
        }),
      },
    });

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: 'Fobal-staging-match-server-execution-role',
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
              resources: [tokenSecret.secretArn, createKey.secretArn],
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
      cpu: 256,
      memoryLimitMiB: 512,
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
        FOBAL_CLOUDWATCH_NAMESPACE: '/fobal/staging/match-server',
        // per-IP caps must see the CLIENT ip, not the ALB's — the server
        // only honors x-forwarded-for when this is set
        FOBAL_TRUST_PROXY: '1',
        // FOBAL_WS_ORIGINS stays unset until the client is hosted (B3):
        // localhost dev pages still connect to staging today, and tools
        // (no Origin header) always pass regardless
      },
      secrets: {
        FOBAL_SECRET: ecs.Secret.fromSecretsManager(tokenSecret),
        FOBAL_CREATE_KEY: ecs.Secret.fromSecretsManager(createKey),
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

    loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromArn(certificateArn)],
      defaultTargetGroups: [targetGroup],
    });

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

    new cloudwatch.Alarm(this, 'UnhealthyHostsAlarm', {
      alarmName: `${PREFIX}-match-server-unhealthy-hosts`,
      metric: targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      alarmName: `${PREFIX}-match-server-5xx`,
      metric: loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: Duration.minutes(1) }),
      threshold: 5,
      evaluationPeriods: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    new cloudwatch.Alarm(this, 'HighCpuAlarm', {
      alarmName: `${PREFIX}-match-server-high-cpu`,
      metric: service.metricCpuUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    new cloudwatch.Alarm(this, 'HighMemoryAlarm', {
      alarmName: `${PREFIX}-match-server-high-memory`,
      metric: service.metricMemoryUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    new cloudwatch.Alarm(this, 'StoppedTaskAlarm', {
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
    });

    new cdk.CfnOutput(this, 'RepositoryUri', { value: repository.repositoryUri });
    new cdk.CfnOutput(this, 'ReplayBucketName', { value: replayBucket.bucketName });
    new cdk.CfnOutput(this, 'LoadBalancerDnsName', { value: loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'StagingHostname', { value: HOSTNAME });
  }
}
