import { TerraformConstructor } from 'cdktf/lib/testing/matchers';

/**
 * Exercise 2 (medium): custom jest matchers for the things cdktf's adapter does
 * not cover: outputs, variables, backends, and "no resource of type X".
 *
 * Register with `expect.extend(cdkmMatchers)` in a test file (or setup file).
 * The declaration-merging block below gives them types.
 */
type MatcherResult = { pass: boolean; message: () => string };

function parse(received: string): Record<string, any> {
  try {
    return JSON.parse(received);
  } catch {
    throw new Error('expected the JSON string returned by Testing.synth()');
  }
}

export const cdkmMatchers = {
  toHaveOutput(received: string, name: string, props: { sensitive?: boolean } = {}): MatcherResult {
    const output = parse(received).output?.[name];
    const pass = !!output && (props.sensitive === undefined || Boolean(output.sensitive) === props.sensitive);
    return {
      pass,
      message: () => (pass ? `expected no output "${name}"` : `expected output "${name}"${props.sensitive === undefined ? '' : ` with sensitive=${props.sensitive}`}; outputs: ${Object.keys(parse(received).output ?? {}).join(', ') || 'none'}`),
    };
  },

  toHaveVariableWithDefault(received: string, name: string, expected: unknown): MatcherResult {
    const variable = parse(received).variable?.[name];
    const pass = !!variable && JSON.stringify(variable.default) === JSON.stringify(expected);
    return {
      pass,
      message: () => (pass ? `expected variable "${name}" not to default to ${JSON.stringify(expected)}` : `expected variable "${name}" to default to ${JSON.stringify(expected)}, got ${JSON.stringify(variable?.default)}`),
    };
  },

  toHaveBackend(received: string, kind: string, props: Record<string, unknown> = {}): MatcherResult {
    const backend = parse(received).terraform?.backend?.[kind];
    const pass = !!backend && Object.entries(props).every(([k, v]) => JSON.stringify(backend[k]) === JSON.stringify(v));
    return {
      pass,
      message: () => (pass ? `expected no ${kind} backend` : `expected a ${kind} backend matching ${JSON.stringify(props)}; got ${JSON.stringify(parse(received).terraform?.backend)}`),
    };
  },

  toHaveNoResource(received: string, ctor: TerraformConstructor): MatcherResult {
    const instances = parse(received).resource?.[ctor.tfResourceType] ?? {};
    const pass = Object.keys(instances).length === 0;
    return {
      pass,
      message: () => (pass ? `expected some ${ctor.tfResourceType}` : `expected no ${ctor.tfResourceType}; found ${Object.keys(instances).join(', ')}`),
    };
  },
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toHaveOutput(name: string, props?: { sensitive?: boolean }): R;
      toHaveVariableWithDefault(name: string, expected: unknown): R;
      toHaveBackend(kind: string, props?: Record<string, unknown>): R;
      toHaveNoResource(ctor: TerraformConstructor): R;
    }
  }
}
