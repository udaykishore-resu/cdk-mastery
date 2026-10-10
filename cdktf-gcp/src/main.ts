/**
 * The curriculum app: every module registers its stacks under an `m<NN>-` prefix,
 * so `cdktf list` reads as a table of contents and `cdktf synth` builds them all.
 * Nothing here needs credentials or a Terraform binary to synthesize (one stack,
 * m10-refactor, registers `moved`/`import` blocks whose version validation shells
 * out to `terraform version`; it is skipped unless CDKM_ENABLE_REFACTOR_STACK is set).
 *
 * Select a subset with `CDKM_MODULES=00,01,11 cdktf synth` to keep synth fast.
 */
import { App } from 'cdktf';
import * as m00 from './modules/00-introduction';
import * as m01 from './modules/01-providers-resources-and-tokens';
import * as m02 from './modules/02-state-backends-and-environments';
import * as m03 from './modules/03-networking-and-compute';
import * as m04 from './modules/04-serverless-and-events';
import * as m05 from './modules/05-constructs-and-modules';
import * as m06 from './modules/06-aspects-labels-and-governance';
import * as m07 from './modules/07-testing';
import * as m08 from './modules/08-cicd-and-workload-identity';
import * as m09 from './modules/09-multi-project-and-org-scale';
import * as m10 from './modules/10-escape-hatches-hcl-migration-and-interop';
import * as m11 from './modules/11-capstone-platform';

const MODULES: Record<string, { addToApp(app: App): void }> = {
  '00': m00, '01': m01, '02': m02, '03': m03, '04': m04, '05': m05,
  '06': m06, '07': m07, '08': m08, '09': m09, '10': m10, '11': m11,
};

const app = new App();
const selected = (process.env.CDKM_MODULES ?? Object.keys(MODULES).join(','))
  .split(',')
  .map((s) => s.trim().padStart(2, '0'))
  .filter((s) => s in MODULES);

for (const key of selected) MODULES[key].addToApp(app);
app.synth();
