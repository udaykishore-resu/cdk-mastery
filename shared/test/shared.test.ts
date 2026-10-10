import { Construct } from 'constructs';
import {
  ConstructPolicy,
  ENVIRONMENTS,
  PascalCaseIds,
  environmentFor,
  mandatoryTags,
  maxDepthRule,
  normaliseLabelKey,
  regionShortCode,
  resourceName,
  shortHash,
} from '../src';

class Root extends Construct {
  constructor() {
    super(undefined as unknown as Construct, '');
  }
}

describe('naming', () => {
  it('builds lowercase hyphenated names', () => {
    expect(resourceName({ org: 'Revan', service: 'Orders', env: 'prod', component: 'API', region: 'use1' })).toBe(
      'revan-orders-prod-api-use1',
    );
  });
  it('truncates deterministically past 63 chars', () => {
    const long = resourceName({ org: 'a'.repeat(30), service: 'b'.repeat(30), env: 'prod', component: 'c'.repeat(20) });
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/-[0-9a-f]{8}$/);
  });
  it('derives region short codes for both clouds', () => {
    expect(regionShortCode('us-east-1')).toBe('use1');
    expect(regionShortCode('us-central1')).toBe('usc1');
    expect(regionShortCode('europe-west4')).toBe('euw4');
  });
  it('normalises GCP label keys', () => {
    expect(normaliseLabelKey('Cost Center')).toBe('cost_center');
    expect(normaliseLabelKey('1abc')).toBe('k_1abc');
  });
  it('hash is stable', () => {
    expect(shortHash('hello')).toBe(shortHash('hello'));
    expect(shortHash('hello')).not.toBe(shortHash('hellp'));
  });
});

describe('environments', () => {
  it('prod retains stateful resources and requires approval', () => {
    expect(ENVIRONMENTS.prod.retainStatefulResources).toBe(true);
    expect(ENVIRONMENTS.prod.requiresApproval).toBe(true);
    expect(ENVIRONMENTS.dev.retainStatefulResources).toBe(false);
  });
  it('rejects unknown environments', () => {
    expect(() => environmentFor('qa')).toThrow(/Unknown environment/);
  });
  it('mandatory tags include cost centre', () => {
    expect(mandatoryTags(ENVIRONMENTS.prod, 'orders')).toMatchObject({ 'cost-center': 'cc-platform-prod', service: 'orders' });
  });
});

describe('policy walker', () => {
  it('flags non-PascalCase ids and deep trees', () => {
    const root = new Root();
    const good = new Construct(root, 'Good');
    new Construct(good, 'bad_id');
    let deep: Construct = good;
    for (let i = 0; i < 6; i++) deep = new Construct(deep, `L${i}`);

    const policy = new ConstructPolicy([PascalCaseIds, maxDepthRule(5)]);
    const violations = policy.walk(root);
    expect(violations.some((v) => v.rule === 'naming/pascal-case-ids' && v.path.endsWith('bad_id'))).toBe(true);
    expect(violations.some((v) => v.rule === 'structure/max-depth')).toBe(true);
    expect(() => policy.throwIfViolated()).toThrow(/Policy violations/);
  });
});
