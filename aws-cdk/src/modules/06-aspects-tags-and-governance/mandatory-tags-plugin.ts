import * as fs from 'node:fs';
import * as cdk from 'aws-cdk-lib';

export interface MandatoryTagsPluginProps {
  readonly requiredKeys: string[];
  /**
   * Resource types to inspect. Templates do not tell you which types are taggable,
   * so a plugin (unlike an aspect, which can ask `TagManager.of(node)`) must carry
   * its own list. That asymmetry is the whole "aspect vs validation" lesson.
   */
  readonly resourceTypes: string[];
}

/**
 * A *policy validation plugin*: the third and last place governance can run
 * inside the CDK process, after aspects and after templates are rendered.
 *
 *   aspect     → sees constructs, may mutate, runs before synthesis
 *   validation → sees CloudFormation JSON on disk, read-only, runs after synthesis
 *
 * Plugins get `context.stackTemplates` (path + account/region per stack) and the
 * root construct as `context.appConstruct`. They return a report; if any report
 * has `success: false`, synthesis fails and the CLI prints one consolidated
 * report (also written to `cdk.out/validation-report.json`). Registration:
 *
 *   Validations.of(app).addPlugins(new MandatoryTagsPlugin({ ... }))
 *
 * `new App({ policyValidationBeta1: [...] })` is the deprecated spelling of the
 * same thing and still works in 2.269.0. cdk-nag 3 packs are plugins of exactly
 * this shape; this file is what one looks like with the rule logic stripped to
 * ~30 lines. Vendor plugins (checkov, cfn-guard, KICS) use the same interface and
 * usually shell out to their binary with `templatePaths`.
 */
export class MandatoryTagsPlugin implements cdk.IPolicyValidationPlugin {
  readonly name = 'MandatoryTags';
  readonly version = '1.0.0';
  readonly ruleIds = ['tags/mandatory-keys'];

  constructor(private readonly props: MandatoryTagsPluginProps) {}

  validate(context: cdk.IPolicyValidationContext): cdk.PolicyValidationPluginReport {
    const violatingResources: cdk.PolicyViolatingResource[] = [];
    const inspect = new Set(this.props.resourceTypes);

    for (const stackTemplate of context.stackTemplates) {
      const template = JSON.parse(fs.readFileSync(stackTemplate.templatePath, 'utf8')) as {
        Resources?: Record<string, { Type: string; Properties?: { Tags?: Array<{ Key: string; Value: string }> } }>;
      };
      for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
        if (!inspect.has(resource.Type)) continue;
        const keys = new Set((resource.Properties?.Tags ?? []).map((t) => t.Key));
        const missing = this.props.requiredKeys.filter((k) => !keys.has(k));
        if (missing.length === 0) continue;
        violatingResources.push({
          resourceLogicalId: logicalId,
          templatePath: stackTemplate.templatePath,
          locations: [`Properties/Tags (missing: ${missing.join(', ')})`],
        });
      }
    }

    return {
      success: violatingResources.length === 0,
      violations:
        violatingResources.length === 0
          ? []
          : [
              {
                ruleName: 'tags/mandatory-keys',
                description: `Every ${this.props.resourceTypes.join('/')} must carry tags: ${this.props.requiredKeys.join(', ')}`,
                severity: 'error',
                fix: 'Call applyGovernance() (or Tags.of(scope).add) at a scope that contains the resource',
                violatingResources,
              },
            ],
    };
  }
}
