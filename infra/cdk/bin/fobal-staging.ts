#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FobalStack } from '../lib/fobal-staging-stack.js';
import { ENVS } from '../lib/envs.js';

const app = new cdk.App();
const synth = () => new cdk.DefaultStackSynthesizer({ qualifier: 'fobalstag' });
const env = { account: '368426158592', region: 'sa-east-1' };

// staging — the stack name and logical tree predate the multi-env refactor
// and MUST stay stable (the deployed stack is updated in place)
new FobalStack(app, 'fobal-staging-match-server', ENVS.staging, { env, synthesizer: synth() });

// production (M3): same shape, prod values, stable signing key, pinned
// origins. Deploy with -c prodCertificateArn / -c prodWildcardCertificateArn
// (both are the existing *.fobal.ai sa-east-1 wildcard).
new FobalStack(app, 'fobal-prod-match-server', ENVS.production, { env, synthesizer: synth() });
