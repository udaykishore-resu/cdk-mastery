import { TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { SecretManagerSecretIamMember } from '@cdktf/provider-google/lib/secret-manager-secret-iam-member';
import { CloudRunV2Service } from '@cdktf/provider-google/lib/cloud-run-v2-service';
import { CloudRunV2ServiceIamMember } from '@cdktf/provider-google/lib/cloud-run-v2-service-iam-member';
import { environmentFor, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { CloudSqlStack } from './cloud-sql-stack';
import { gcpProject } from './gcp-config';
import { NetworkStack } from './network-stack';
import { ProjectServices } from './services';

export interface CloudRunStackProps {
  readonly tier: string;
  readonly network: NetworkStack;
  readonly database: CloudSqlStack;
  readonly project?: string;
  /** Container image; defaults to Google's hello image so the stack applies without a build. */
  readonly image?: string;
  /**
   * Who may invoke the service. `allUsers` makes it public (IAM still gates,
   * but to everyone); a list of principals (`user:`, `group:`, `serviceAccount:`)
   * keeps it private and requires an identity token on every request.
   */
  readonly invokers?: readonly string[];
}

/**
 * Cloud Run v2 with a dedicated identity, direct VPC egress to the private
 * subnet, the database password from Secret Manager, and least-privilege IAM:
 *
 *   ServiceAccount                    the service's own identity (never the default compute SA)
 *   ProjectIamMember                  roles/cloudsql.client (needed for the Cloud SQL connector / IAM auth)
 *   SecretManagerSecretIamMember      roles/secretmanager.secretAccessor on *one* secret
 *   CloudRunV2Service                 template.vpcAccess.networkInterfaces → the subnet; env from secret
 *   CloudRunV2ServiceIamMember        roles/run.invoker for each invoker principal
 *
 * References into NetworkStack and CloudSqlStack make this the last stack in
 * the deploy order (network → sql → run).
 */
export class CloudRunStack extends TerraformStack {
  readonly serviceAccount: ServiceAccount;
  readonly service: CloudRunV2Service;

  constructor(scope: Construct, id: string, props: CloudRunStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const project = props.project ?? gcpProject();
    const region = props.network.region;
    new GoogleProvider(this, 'Google', { project, region });
    const apis = new ProjectServices(this, 'Apis', ['run.googleapis.com', 'iam.googleapis.com']);
    const name = (component: string) => resourceName({ org: 'cdkm', service: 'api', env: tier.name, component });
    const invokers = props.invokers ?? (tier.name === 'dev' ? ['allUsers'] : []);

    this.serviceAccount = new ServiceAccount(this, 'RuntimeIdentity', {
      accountId: name('run'),
      displayName: `Cloud Run runtime identity (${tier.name})`,
      dependsOn: apis.services,
    });

    // Project-level role because the Cloud SQL Admin API has no per-instance IAM.
    // `_iam_member` is additive: it never touches other members of the role.
    new ProjectIamMember(this, 'CloudSqlClient', {
      project,
      role: 'roles/cloudsql.client',
      member: this.serviceAccount.member,
    });
    // Secret-level, not project-level: this identity can read exactly one secret.
    new SecretManagerSecretIamMember(this, 'ReadDbPassword', {
      secretId: props.database.passwordSecret.secretId,
      role: 'roles/secretmanager.secretAccessor',
      member: this.serviceAccount.member,
    });

    this.service = new CloudRunV2Service(this, 'Api', {
      name: name('svc'),
      location: region,
      // INGRESS_TRAFFIC_ALL still requires IAM (roles/run.invoker). Use
      // INTERNAL_LOAD_BALANCER when only an internal LB may reach it.
      ingress: 'INGRESS_TRAFFIC_ALL',
      // Provider 6.x defaults this to true, which blocks `destroy`. Tie it to the tier.
      deletionProtection: tier.retainStatefulResources,
      labels: mandatoryTags(tier, 'api'),
      dependsOn: apis.services,
      template: {
        serviceAccount: this.serviceAccount.email,
        executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
        timeout: '60s',
        maxInstanceRequestConcurrency: 80,
        scaling: {
          // A warm instance in prod removes cold starts and costs ~1 vCPU-hour continuously.
          minInstanceCount: tier.highlyAvailable ? 1 : 0,
          maxInstanceCount: tier.highlyAvailable ? 20 : 3,
        },
        vpcAccess: {
          // Direct VPC egress (no Serverless VPC Access connector): the revision
          // gets an IP in the subnet. `tags` are network tags for firewall rules.
          egress: 'PRIVATE_RANGES_ONLY',
          networkInterfaces: [{ network: props.network.network.id, subnetwork: props.network.subnet.id, tags: ['cloud-run'] }],
        },
        containers: [
          {
            image: props.image ?? 'us-docker.pkg.dev/cloudrun/container/hello',
            ports: { containerPort: 8080 },
            resources: {
              limits: { cpu: '1', memory: '512Mi' },
              cpuIdle: true, // CPU only during requests (the cheap default)
              startupCpuBoost: true,
            },
            env: [
              { name: 'DB_HOST', value: props.database.instance.privateIpAddress },
              { name: 'DB_NAME', value: props.database.database.name },
              { name: 'DB_USER', value: props.database.user.name },
              { name: 'INSTANCE_CONNECTION_NAME', value: props.database.instance.connectionName },
              {
                name: 'DB_PASSWORD',
                valueSource: { secretKeyRef: { secret: props.database.passwordSecret.secretId, version: 'latest' } },
              },
            ],
            startupProbe: {
              httpGet: { path: '/', port: 8080 },
              initialDelaySeconds: 0,
              periodSeconds: 2,
              failureThreshold: 15,
              timeoutSeconds: 2,
            },
          },
        ],
      },
      traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }],
    });

    // Invoker bindings. `allUsers` = unauthenticated internet; anything else
    // must present an OIDC identity token minted for the service URL.
    invokers.forEach((member, i) => {
      new CloudRunV2ServiceIamMember(this, `Invoker${i}`, {
        name: this.service.name,
        location: region,
        role: 'roles/run.invoker',
        member,
      });
    });

    new TerraformOutput(this, 'service_url', { value: this.service.uri });
    new TerraformOutput(this, 'service_account', { value: this.serviceAccount.email });
  }
}
