import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

/**
 * Exercise 2 — HTTPS with an HTTP→HTTPS redirect on a hand-built ALB.
 *
 * Use INSTEAD of `alb.addListener('Http', { port: 80 })`: the redirect listener owns port 80.
 * The certificate is imported by ARN (ACM certificates are usually created out-of-band or
 * by a DNS-validated `Certificate` in a stack that owns the hosted zone). TLS policy:
 * `RECOMMENDED_TLS` tracks AWS's recommended policy (TLS 1.2/1.3); with the
 * `usePostQuantumTlsPolicy` flag from cdk.json the default is the post-quantum variant.
 */
export interface HttpsListenerProps {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly certificateArn: string;
}

export interface HttpsListeners {
  readonly https: elbv2.ApplicationListener;
  readonly redirect: elbv2.ApplicationListener;
}

export function addHttpsWithRedirect(scope: Construct, id: string, props: HttpsListenerProps): HttpsListeners {
  const certificate = acm.Certificate.fromCertificateArn(scope, `${id}Certificate`, props.certificateArn);

  const https = props.loadBalancer.addListener(`${id}Https`, {
    port: 443,
    protocol: elbv2.ApplicationProtocol.HTTPS,
    certificates: [certificate],
    sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
    open: true,
  });
  https.addTargetGroups('Default', { targetGroups: [props.targetGroup] });

  // 301 to the same host/path on 443. `open: true` on the ALB SG for port 80 is implied.
  const redirect = props.loadBalancer.addRedirect({
    sourceProtocol: elbv2.ApplicationProtocol.HTTP,
    sourcePort: 80,
    targetProtocol: elbv2.ApplicationProtocol.HTTPS,
    targetPort: 443,
  });

  new cdk.CfnOutput(scope, `${id}Url`, { value: `https://${props.loadBalancer.loadBalancerDnsName}` });
  return { https, redirect };
}
