#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NlbPrivateLinkStack } from '../lib/nlb_private_link-stack';

const app = new cdk.App();
new NlbPrivateLinkStack(app, 'NlbPrivateLinkStack', {});