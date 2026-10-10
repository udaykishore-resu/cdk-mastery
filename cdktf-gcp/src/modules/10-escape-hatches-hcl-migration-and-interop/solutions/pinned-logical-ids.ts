import { App, IAspect, TerraformElement, TerraformStack } from 'cdktf';
import { IConstruct, Node } from 'constructs';

/**
 * Exercise 3 (hard): pin Terraform addresses during a migration, stack-wide.
 *
 * After `cdktf convert`, every refactor that moves a resource into a construct
 * changes its logical id (`assets` -> `Assets_Bucket_1A2B3C4D`) and therefore
 * its Terraform address, which Terraform reads as destroy + create. Calling
 * `overrideLogicalId` by hand on 80 resources is error-prone and the calls get
 * lost in refactors.
 *
 * The obvious design — an aspect that calls `overrideLogicalId` from a path
 * map — DOES NOT WORK for any resource whose attributes are referenced, and the
 * failure is silent. `TerraformElement.friendlyUniqueId` is computed once and
 * cached; every `resource.someAttribute` read (`interpolationForAttribute`)
 * computes it immediately. Aspects run after the tree is built, i.e. after
 * those reads, so the override lands on a cached value and is ignored.
 * `PinnedLogicalIdsAspect` below is kept to demonstrate the trap: it records
 * which pins arrived too late.
 *
 * The design that works: `TerraformStack.allocateLogicalId` is a *protected
 * hook* ("wrap the allocation for future renaming support" in
 * terraform-stack.js) consulted the first time an id is needed, whatever
 * triggers it. A stack subclass that looks up the element's path in a pin map
 * before falling back to `super` pins ids regardless of reference order, with
 * no per-resource code. `unmatched()` reports pins that matched nothing, so a
 * typo in the map is a test failure instead of a destroy+create.
 */
export interface LogicalIdPins {
  /** construct path relative to the stack (`Assets/Bucket`) -> legacy logical id */
  readonly [path: string]: string;
}

export class PinnedIdsStack extends TerraformStack {
  private readonly pins: Map<string, string>;
  readonly applied = new Map<string, string>();

  constructor(scope: App, id: string, pins: LogicalIdPins) {
    super(scope, id);
    this.pins = new Map(Object.entries(pins));
  }

  protected allocateLogicalId(tfElement: TerraformElement | Node): string {
    const node = TerraformElement.isTerraformElement(tfElement) ? tfElement.node : tfElement;
    const relative = relativePath(node, this);
    const pinned = this.pins.get(relative);
    if (pinned !== undefined) {
      this.applied.set(relative, pinned);
      return pinned;
    }
    return super.allocateLogicalId(tfElement);
  }

  /** Pins that no element asked for — typos, or resources that no longer exist. Call after synth. */
  unmatched(): string[] {
    return [...this.pins.keys()].filter((p) => !this.applied.has(p));
  }
}

/**
 * The trap, kept for the test: overrides applied from an aspect are ignored
 * for every element whose id was already computed. `lateForReferenced` lists
 * the pins that arrived after the id was frozen.
 */
export class PinnedLogicalIdsAspect implements IAspect {
  private readonly pins: Map<string, string>;
  readonly applied = new Map<string, string>();
  readonly lateForReferenced: string[] = [];

  constructor(pins: LogicalIdPins) {
    this.pins = new Map(Object.entries(pins));
  }

  visit(node: IConstruct): void {
    if (!(node instanceof TerraformElement)) return;
    const relative = relativePath(node.node, TerraformStack.of(node));
    const pinned = this.pins.get(relative);
    if (pinned === undefined) return;
    // friendlyUniqueId is cached on first read; if it already holds a value
    // other than the pin, the override below will be silently ignored.
    const alreadyComputed = (node as unknown as { _friendlyUniqueId?: string })._friendlyUniqueId;
    if (alreadyComputed !== undefined && alreadyComputed !== pinned) {
      this.lateForReferenced.push(relative);
      return;
    }
    node.overrideLogicalId(pinned);
    this.applied.set(relative, pinned);
  }
}

function relativePath(node: Node, stack: TerraformStack): string {
  const stackIndex = node.scopes.indexOf(stack);
  return node.scopes
    .slice(stackIndex + 1)
    .map((c) => c.node.id)
    .join('/');
}
