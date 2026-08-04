#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FobalStagingStack } from '../lib/fobal-staging-stack.js';
import { FobalStagingWebStack } from '../lib/fobal-staging-web-stack.js';

const app = new cdk.App();

new FobalStagingStack(app, 'fobal-staging-match-server', {
  env: {
    account: '368426158592',
    region: 'sa-east-1',
  },
  synthesizer: new cdk.DefaultStackSynthesizer({
    qualifier: 'fobalstag',
  }),
});

// B3 — the hosted client (CloudFront + imported client bucket). The stack
// deploys in sa-east-1 (the boundary region-locks CloudFormation); its
// viewer certificate is the us-east-1 wildcard passed via context.
new FobalStagingWebStack(app, 'fobal-staging-web', {
  env: {
    account: '368426158592',
    region: 'sa-east-1',
  },
  synthesizer: new cdk.DefaultStackSynthesizer({
    qualifier: 'fobalstag',
  }),
});
