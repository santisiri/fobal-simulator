// fobal-staging-web — the hosted client (B3): CloudFront in front of a
// private S3 bucket at https://play-staging.fobal.ai.
//
// Stack ownership follows the standing rule: the stack owns only disposable
// resources (the distribution, the bucket POLICY); the bucket itself is a
// long-lived fixed-name resource created imperatively once and imported:
//   aws s3api create-bucket --bucket fobal-staging-client-368426158592 \
//     --region sa-east-1 --create-bucket-configuration LocationConstraint=sa-east-1
//   aws s3api put-public-access-block --bucket fobal-staging-client-368426158592 \
//     --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
//   (BlockPublicPolicy stays false so this stack can attach the CloudFront
//   service-principal policy — the policy itself grants only CloudFront.)
//
// The viewer certificate MUST live in us-east-1 (a CloudFront rule — note
// the region difference from the ALB cert): request *.fobal.ai there, pass
// the ARN as -c webCertificateArn=arn:aws:acm:us-east-1:…
//
// The CFN stack itself deploys in sa-east-1 (the agent boundary region-locks
// cloudformation); CloudFront and S3 are global APIs and are exempt.
import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

const ACCOUNT = '368426158592';
const PREFIX = 'fobal-staging';
const HOSTNAME = 'play-staging.fobal.ai';

export class FobalStagingWebStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    Tags.of(this).add('Project', 'Fobal');
    Tags.of(this).add('Environment', 'staging');
    Tags.of(this).add('Scope', PREFIX);

    const webCertificateArn = this.node.tryGetContext('webCertificateArn')?.toString()
      ?? `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/REPLACE_WITH_US_EAST_1_CERTIFICATE_ID`;

    const clientBucket = s3.Bucket.fromBucketName(
      this,
      'ClientBucket',
      `${PREFIX}-client-${ACCOUNT}`,
    );

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'FOBAL staging hosted client (play-staging.fobal.ai)',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(clientBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      defaultRootObject: 'index.html',
      domainNames: [HOSTNAME],
      certificate: acm.Certificate.fromCertificateArn(this, 'WebCertificate', webCertificateArn),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // includes South America edges — the audience staging serves
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    // the bucket is imported, so the OAC grant cannot be auto-attached by the
    // L2 — the policy is stack-managed here (and restored on every deploy)
    new s3.CfnBucketPolicy(this, 'ClientBucketPolicy', {
      bucket: clientBucket.bucketName,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowCloudFrontOac',
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
            Resource: clientBucket.arnForObjects('*'),
            Condition: {
              StringEquals: {
                'AWS:SourceArn': `arn:aws:cloudfront::${ACCOUNT}:distribution/${distribution.distributionId}`,
              },
            },
          },
          {
            Sid: 'DenyInsecureTransport',
            Effect: 'Deny',
            Principal: '*',
            Action: 's3:*',
            Resource: [clientBucket.bucketArn, clientBucket.arnForObjects('*')],
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          },
        ],
      },
    });

    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'ClientBucketName', { value: clientBucket.bucketName });
    new cdk.CfnOutput(this, 'PlayHostname', { value: HOSTNAME });
  }
}
