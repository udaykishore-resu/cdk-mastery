import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { IConstruct } from 'constructs';

/**
 * cdk-nag 3.x is a *validation plugin*, not an aspect.
 *
 * In cdk-nag 2.x you wrote `Aspects.of(app).add(new AwsSolutionsChecks())` and
 * suppressed with `NagSuppressions.addResourceSuppressions(...)`. Version 3
 * (pinned here: 3.0.2) plugs into the core validation framework instead:
 *
 *   register : Validations.of(app | stage).addPlugins(new AwsSolutionsChecks(scope, { verbose: true }))
 *   suppress : Validations.of(construct | stack).acknowledge({ id: 'AwsSolutions-S1', reason: '...' })
 *
 * Mapping from the v2 API you will find in most blog posts:
 *   NagSuppressions.addResourceSuppressions(c, [{id, reason}])     → Validations.of(c).acknowledge({id, reason})
 *   NagSuppressions.addStackSuppressions(stack, [{id, reason}])    → Validations.of(stack).acknowledge({id, reason})
 *   NagSuppressions.addResourceSuppressionsByPath(stack, path, …)  → Validations.of(stack.node.findChild(path)).acknowledge(…)
 *   { id: 'AwsSolutions-IAM5', appliesTo: ['Resource::*'] }        → { id: 'AwsSolutions-IAM5[Resource::*]' }
 *
 * The consequence that matters: plugins run *after* templates are written, and
 * when any plugin reports a violation `app.synth()` throws (in tests) or the CLI
 * exits non-zero. Acknowledgements are inherited down the tree, exactly like
 * aspects — acknowledge on a Stack and every resource in it is covered.
 */
export function applyAwsSolutionsChecks(scope: cdk.App | cdk.Stage): AwsSolutionsChecks {
  const pack = new AwsSolutionsChecks(scope, { verbose: true });
  cdk.Validations.of(scope).addPlugins(pack);
  return pack;
}

export interface NagFinding {
  readonly ruleId: string;
  readonly severity: 'error' | 'warning';
  readonly constructPath: string;
  readonly description: string;
}

/**
 * Run the AwsSolutions pack over one construct subtree and return the findings
 * that were *not* acknowledged. This is how tests read the report without
 * registering the plugin on the App (which would make `Template.fromStack` throw
 * before you could look at anything).
 *
 * Call it after aspects have run (`app.synth()` or `Template.fromStack(stack)`),
 * otherwise mutating aspects have not fixed the tree yet and you will see
 * findings that never reach a deployed template.
 */
export function nagFindings(scope: IConstruct): NagFinding[] {
  const report = new AwsSolutionsChecks(undefined, { verbose: true }).validateScope(scope);
  const out: NagFinding[] = [];
  for (const v of report.violations) {
    for (const r of v.violatingResources) {
      out.push({
        ruleId: v.ruleName,
        severity: v.severity === 'error' ? 'error' : 'warning',
        constructPath: r.constructPath ?? '<unknown>',
        description: v.description,
      });
    }
  }
  return out;
}
