#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FobalStagingStack } from '../lib/fobal-staging-stack.js';

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
