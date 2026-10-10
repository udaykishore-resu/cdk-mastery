/**
 * Inspect what `cdktf synth` actually produces, without the CLI.
 *
 *   npx ts-node --prefer-ts-exts src/modules/00-introduction/inspect.ts
 *
 * The CLI does nothing magical: `cdktf synth` runs the `app` command from
 * cdktf.json (here `npx ts-node src/main.ts`), which constructs an `App`, adds
 * stacks and calls `app.synth()`. That call walks the construct tree, resolves
 * tokens, and writes one `cdk.tf.json` per stack plus a `manifest.json`. This
 * script does the same thing into a throwaway directory and prints the result.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App } from 'cdktf';
import { HelloStack } from './hello-stack';

const ANNOTATIONS: Record<string, string> = {
  '//': 'CDKTF metadata: stack name, cdktf version, backend kind and a construct-path index. Terraform ignores "//" keys.',
  provider: 'One entry per provider *instance* (a list, because aliases are allowed). Maps to `provider "google" {}` blocks.',
  resource: 'resource[<type>][<logical id>] = attributes. The logical id comes from the construct path (module 01).',
  data: 'Data sources, same layout as resource. None in HelloStack; module 01 adds some.',
  output: 'Root-module outputs. `terraform output` reads these from state after apply.',
  variable: 'Root-module input variables (`TerraformVariable`). Set with -var/-var-file/TF_VAR_*.',
  locals: 'Named expressions (`TerraformLocal`). Evaluated by Terraform, not by CDKTF.',
  terraform: 'terraform.required_providers pins the provider (from the prebuilt package); terraform.backend is where state lives.',
};

function main(): void {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdktf-inspect-'));
  const app = new App({ outdir });
  const stack = new HelloStack(app, 'm00-hello', { tier: 'dev' });
  app.synth();

  console.log('== Construct tree (node.path)');
  for (const node of app.node.findAll()) {
    const kind = node.constructor.name;
    console.log(`  ${node.node.path || '<App>'}  (${kind})`);
  }

  console.log('\n== Output directory');
  walk(outdir, outdir);

  const stackDir = path.join(outdir, 'stacks', stack.node.id);
  const config = JSON.parse(fs.readFileSync(path.join(stackDir, 'cdk.tf.json'), 'utf8')) as Record<string, unknown>;

  console.log('\n== cdk.tf.json top-level keys');
  for (const key of Object.keys(config)) {
    console.log(`  ${key.padEnd(10)} ${ANNOTATIONS[key] ?? '(no annotation)'}`);
  }
  const terraform = config.terraform as Record<string, unknown>;
  console.log('\n  terraform.required_providers =', JSON.stringify(terraform.required_providers));
  console.log('  terraform.backend            =', JSON.stringify(terraform.backend));

  console.log('\n== cdk.tf.json');
  console.log(JSON.stringify(config, null, 2));

  console.log('\n== manifest.json');
  console.log(fs.readFileSync(path.join(outdir, 'manifest.json'), 'utf8'));
  console.log(`\n(written to ${outdir}; safe to delete)`);
}

function walk(dir: string, root: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    console.log(`  ${path.relative(root, full)}${entry.isDirectory() ? '/' : ''}`);
    if (entry.isDirectory()) walk(full, root);
  }
}

main();
