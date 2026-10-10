/**
 * Builds the module-00 app in memory, synthesizes it into a temp directory and prints
 * what `cdk synth` would have produced — without the CLI, without credentials.
 *
 *   npx ts-node --prefer-ts-exts src/modules/00-introduction/inspect.ts
 *
 * Run it from `aws-cdk/`. It never writes to `aws-cdk/cdk.out`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { addToApp } from './index';

const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-mastery-m00-'));

// `new cdk.App({ outdir })` is exactly what `cdk synth` does behind `bin/app.ts`; the CLI
// simply sets CDK_OUTDIR (and the context from cdk.json) in the environment first.
const app = new cdk.App({ outdir });
addToApp(app);

// --- 1. The construct tree, before synthesis -----------------------------------------
// `findAll()` is a pre-order walk. `node.path` is what logical IDs are derived from.
console.log('== Construct tree (path  [class]) ==');
for (const c of app.node.findAll()) {
  const fqn = c.constructor.name;
  const depth = c.node.path === '' ? 0 : c.node.path.split('/').length;
  console.log(`${'  '.repeat(depth)}${c.node.path || '(App)'}  [${fqn}]`);
}

// --- 2. Synthesize --------------------------------------------------------------------
// This is phase 2+3+4 (prepare, validate, synthesize) in one call. It is idempotent:
// a second call returns the cached assembly.
const assembly = app.synth();

// --- 3. Logical IDs -------------------------------------------------------------------
// Every CfnElement (L1 resource, output, parameter, condition, mapping) gets a logical ID
// from `stack.getLogicalId()`. For a top-level child it is just the id; for nested paths
// it is the concatenated path components plus an 8-hex-char hash of the full path.
console.log('\n== Logical IDs ==');
for (const stack of app.node.children.filter((c): c is cdk.Stack => cdk.Stack.isStack(c))) {
  console.log(`-- ${stack.stackName}`);
  for (const c of stack.node.findAll()) {
    if (cdk.CfnElement.isCfnElement(c)) {
      const type = cdk.CfnResource.isCfnResource(c) ? c.cfnResourceType : c.constructor.name;
      console.log(`  ${stack.getLogicalId(c).padEnd(40)} <- ${c.node.path}  (${type})`);
    }
  }
}

// --- 4. The cloud assembly on disk ----------------------------------------------------
const describe = (file: string): string => {
  if (file === 'manifest.json') return 'index of every artifact (stacks, asset manifests, tree, reports) and their dependencies/env';
  if (file === 'tree.json') return 'the construct tree with fqn/version per node; what the console "Constructs" view reads';
  if (file === 'cdk.out') return 'assembly schema version marker; the CLI refuses assemblies newer than it understands';
  if (file === 'validation-report.json') return 'output of validation plugins (CloudFormation Validate, cdk-nag when wired as a plugin)';
  if (file.endsWith('.template.json')) return 'the CloudFormation template for that stack';
  if (file.endsWith('.assets.json')) return 'asset manifest: files/images to publish, with destinations and publishing roles';
  if (file.endsWith('.metadata.json')) return 'construct-path -> logical-id/annotations metadata for that stack';
  if (file.startsWith('asset.')) return 'a staged asset (Lambda code, Docker context) whose name is its content hash';
  return 'unknown to this script';
};

console.log(`\n== Cloud assembly: ${assembly.directory} (schema ${assembly.version}) ==`);
for (const file of fs.readdirSync(outdir).sort()) {
  console.log(`  ${file.padEnd(32)} ${describe(file)}`);
}

// --- 5. What the stack artifact says about bootstrap ----------------------------------
const stackArtifact = assembly.getStackByName('M00-Hello');
console.log('\n== Stack artifact ==');
console.log(`  environment:                  ${stackArtifact.environment.name}`);
console.log(`  requiresBootstrapStackVersion: ${stackArtifact.requiresBootstrapStackVersion}`);
console.log(`  bootstrapStackVersionSsmParameter: ${stackArtifact.bootstrapStackVersionSsmParameter}`);
console.log(`  assumeRoleArn:                ${stackArtifact.assumeRoleArn}`);
console.log(`  cloudFormationExecutionRoleArn: ${stackArtifact.cloudFormationExecutionRoleArn}`);
console.log(`  template resources:           ${Object.keys(stackArtifact.template.Resources).length}`);
const helloStack = app.node.findChild('M00-Hello') as cdk.Stack;
const phasesL1 = helloStack.node.findChild('Phases').node.defaultChild as cdk.CfnResource;
const phasesLogicalId = helloStack.getLogicalId(phasesL1);
console.log(`  lifecycle order recorded:     ${stackArtifact.template.Resources[phasesLogicalId].Properties.Value}`);
