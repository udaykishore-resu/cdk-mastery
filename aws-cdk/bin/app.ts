#!/usr/bin/env node
/**
 * The curriculum app: every module registers its stacks under an `M<NN>-` prefix,
 * so `cdk ls` reads as a table of contents and `cdk synth 'M04-*'` builds one
 * module. Nothing here needs credentials — every stack synthesizes offline.
 *
 * Select a subset with `-c cdk-mastery:modules=00,01,11` to keep synth fast.
 */
import * as cdk from 'aws-cdk-lib';
import * as m00 from '../src/modules/00-introduction';
import * as m01 from '../src/modules/01-constructs-and-tokens';
import * as m02 from '../src/modules/02-stacks-environments-and-references';
import * as m03 from '../src/modules/03-networking-and-containers';
import * as m04 from '../src/modules/04-serverless-and-events';
import * as m05 from '../src/modules/05-custom-constructs';
import * as m06 from '../src/modules/06-aspects-tags-and-governance';
import * as m07 from '../src/modules/07-testing';
import * as m08 from '../src/modules/08-pipelines-and-cicd';
import * as m09 from '../src/modules/09-multi-account-and-multi-region';
import * as m10 from '../src/modules/10-escape-hatches-custom-resources-and-migration';
import * as m11 from '../src/modules/11-capstone-platform';

const MODULES: Record<string, { addToApp(app: cdk.App): void }> = {
  '00': m00, '01': m01, '02': m02, '03': m03, '04': m04, '05': m05,
  '06': m06, '07': m07, '08': m08, '09': m09, '10': m10, '11': m11,
};

const app = new cdk.App();
const selected = String(app.node.tryGetContext('cdk-mastery:modules') ?? Object.keys(MODULES).join(','))
  .split(',')
  .map((s) => s.trim().padStart(2, '0'))
  .filter((s) => s in MODULES);

for (const key of selected) MODULES[key].addToApp(app);
