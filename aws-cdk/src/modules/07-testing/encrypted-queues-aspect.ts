import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { IConstruct } from 'constructs';

/**
 * A small read-only aspect that exists so this module can show how to test
 * *aspect output* (`Annotations.fromStack`) rather than template output.
 *
 * SQS applies SSE-SQS server-side by default for new queues, but the template
 * does not say so unless `SqsManagedSseEnabled: true` (or a KMS key) is present.
 * Auditors read templates, not service defaults — hence the rule.
 */
export class EncryptedQueuesAspect implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof sqs.CfnQueue)) return;
    const managed = cdk.Stack.of(node).resolve(node.sqsManagedSseEnabled);
    const kms = cdk.Stack.of(node).resolve(node.kmsMasterKeyId);
    if (managed === true || (typeof kms === 'string' && kms.length > 0) || (kms && typeof kms === 'object')) return;
    cdk.Annotations.of(node).addError('EncryptedQueuesAspect: queue must declare SqsManagedSseEnabled or KmsMasterKeyId explicitly');
  }
}
