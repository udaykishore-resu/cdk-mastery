import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { EnvironmentTier, regionShortCode, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { ORG, SERVICE } from '../config';
import { OrdersPlatformStage } from '../orders-platform-stage';

export interface MultiRegionOrdersPlatformProps extends cdk.StageProps {
  readonly tier: EnvironmentTier;
  readonly account: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
  /** Public zone the failover record lives in. Defaults to a placeholder so the exercise synthesizes offline. */
  readonly hostedZone?: { zoneName: string; hostedZoneId: string };
  /** Where the (global) Route 53 resources are deployed. Health checks are global; the stack is not. */
  readonly dnsRegion?: string;
}

/**
 * Exercise 3 — active/passive across two regions with no change to the
 * platform stacks.
 *
 * The whole capstone is parameterised by `{ tier, env }`, so a second region is
 * a second `OrdersPlatformStage` with a different `env.region`. Nothing inside
 * the stacks knows it is a replica: names carry the region short-code
 * (`…-data-usw2` vs `…-data-use2`), so nothing collides.
 *
 * What this solution adds is the *routing* layer: two Route 53 health checks
 * against each region's `/health` route and a failover record pair. What it
 * deliberately does NOT do:
 *
 *   - Replicate data. Each region has its own table. Turning `TableV2` into a
 *     global table (`replicas: [{ region }]`) is one line in DataStack, but it
 *     changes the consistency model of the Orders API (last-writer-wins across
 *     regions) and that is a product decision, not an infrastructure one.
 *   - Fail over automatically for writes. The passive region receives traffic
 *     only when the primary's health check fails; if you also replicate the
 *     table you must decide what happens to orders written in the secondary
 *     while the primary was down. See "what I'd change at 10× scale" in the README.
 *   - Provision certificates / custom domains for the HTTP APIs. The health
 *     checks target `api-<region>.<zone>`, which in a real deployment is an
 *     `apigwv2.DomainName` + `ApiMapping` per region with an ACM cert in that
 *     region. That is the module 09 GlobalStack pattern; it is left out here so
 *     the exercise stays offline-synthesizable.
 */
export class MultiRegionOrdersPlatform extends cdk.Stage {
  readonly primary: OrdersPlatformStage;
  readonly secondary: OrdersPlatformStage;
  readonly healthCheckStack: cdk.Stack;

  constructor(scope: Construct, id: string, props: MultiRegionOrdersPlatformProps) {
    super(scope, id, props);
    const { tier, account } = props;
    const zone = props.hostedZone ?? { zoneName: 'orders.example.com', hostedZoneId: 'Z0000000000000000000' };

    this.primary = new OrdersPlatformStage(this, 'Primary', { tier, env: { account, region: props.primaryRegion } });
    this.secondary = new OrdersPlatformStage(this, 'Secondary', { tier, env: { account, region: props.secondaryRegion } });

    this.healthCheckStack = new cdk.Stack(this, 'Dns', {
      env: { account, region: props.dnsRegion ?? 'us-east-1' },
      stackName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'dns' }),
      description: 'Route 53 health checks and failover records for the Orders API',
    });

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this.healthCheckStack, 'Zone', zone);
    const apiName = `api.${zone.zoneName}`;

    for (const [role, stage, failover] of [
      ['Primary', this.primary, route53.Failover.PRIMARY],
      ['Secondary', this.secondary, route53.Failover.SECONDARY],
    ] as const) {
      const regional = `api-${regionShortCode(stage.region!)}.${zone.zoneName}`;
      const healthCheck = new route53.HealthCheck(this.healthCheckStack, `${role}HealthCheck`, {
        type: route53.HealthCheckType.HTTPS,
        fqdn: regional,
        resourcePath: '/health',
        port: 443,
        enableSNI: true,
        requestInterval: cdk.Duration.seconds(10), // "fast" interval: failover in ~30 s instead of ~90 s, for ~2× the price
        failureThreshold: 3,
        measureLatency: true,
      });
      new route53.CnameRecord(this.healthCheckStack, `${role}Record`, {
        zone: hostedZone,
        recordName: apiName,
        domainName: regional,
        ttl: cdk.Duration.seconds(30), // low TTL so clients follow the failover; the cost is more DNS queries
        setIdentifier: `${role.toLowerCase()}-${stage.region}`,
        failover,
        healthCheck,
      });
    }
  }
}
