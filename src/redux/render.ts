import { DRAWN_UNDER_KEY, MORE_KEY, noted, VALUE_KEY } from "./keys.ts";
import { noteFor } from "./boxing.ts";
import { keepBuilt, mark } from "./marker.ts";
import { qualify } from "../stores/labels.ts";
import { isThrottled } from "../timeline/throttle.ts";
import {
  buildTree,
  type HolderNode,
  type RepeatNode,
  type StoreNode,
  type TreeModel,
  type TreeNode,
} from "../tree/tree.ts";

export type Snapshot = Record<string, Record<string, unknown>>;

/**
 * The tree as the panel reads it: every fact the model holds in a field spelled into the key or
 * into the extension's own wrapper.
 *
 * Every object here is built fresh and noted as ours. A model object handed to jsan would be noted
 * as already spelled the way the panel reads it, and it would sit in jsan's maps for the whole
 * connection, which is a lifetime the model never agreed to.
 */
export function renderSnapshot(tree: TreeModel): Snapshot {
  const snapshot: Snapshot = keepBuilt({});

  for (const group of tree.homes) {
    snapshot[group.home] = renderNodes(group.children);
  }

  return snapshot;
}

export function buildSnapshot(): Snapshot {
  return renderSnapshot(buildTree());
}

function renderNodes(nodes: readonly TreeNode[]): Record<string, unknown> {
  const drawn: Record<string, unknown> = keepBuilt({});

  for (const node of nodes) {
    drawn[keyOf(node)] = renderNode(node);
  }

  return drawn;
}

/**
 * A store that owns nothing is drawn as v1 draws it: its name, its value. One that owns others
 * becomes a node holding its own value under `(value)`.
 *
 * Only a store that owns something is wrapped. A value with nothing under it would gain a nesting
 * level for nothing.
 */
function renderNode(node: TreeNode): unknown {
  if (node.kind === "repeat") {
    return renderSlot(node);
  }

  if (node.kind === "store") {
    return node.children.length === 0
      ? renderSlot(node)
      : keepBuilt({ [VALUE_KEY]: renderSlot(node), ...renderNodes(node.children) });
  }

  return renderHolder(node);
}

function renderHolder(node: HolderNode): unknown {
  const drawn = renderHeld(node);

  /**
   * The extension's own wrapper, which the panel's reviver drops before printing the type in front
   * of the value, so what built a node costs no key and no nesting level of its own.
   */
  return node.type === undefined ? drawn : mark(node.type, drawn);
}

/**
 * What the node holds: its children, or the one line a repeat draws instead of them. The developer
 * wrote both references, so both are here, and this line is what keeps the second one from reading
 * as a container the app left empty.
 */
function renderHeld(node: HolderNode): Record<string, unknown> {
  if (node.expandedAt !== null) {
    return keepBuilt({ [DRAWN_UNDER_KEY]: node.expandedAt });
  }

  const drawn = renderNodes(node.children);

  if (node.skipped > 0) {
    drawn[MORE_KEY] = mark(`${node.skipped} more members past the ${node.walked} walked`, {});
  }

  return drawn;
}

function renderSlot(node: StoreNode | RepeatNode): unknown {
  const { slot } = node;

  if (slot.state === "live") {
    return slot.value;
  }

  const note = noteFor(node.entry.store, slot);

  return mark(note.label, note.data);
}

function keyOf(node: TreeNode): string {
  return node.kind === "holder" ? holderKey(node) : storeKey(node);
}

/**
 * The tree key, in the one order every key reads in: the name, its type in square brackets, then
 * the group saying where it was made, then the number saying which store of that place this is.
 * `name` and `label` stay as they are, because they name timeline rows and decide which two stores
 * are one, and a key that changes when adoption learns a type costs one row redrawn.
 */
function storeKey(node: StoreNode | RepeatNode): string {
  const { entry, ordinal, qualifier } = node;
  const head = noted(node.name, entry.type, isThrottled(entry));
  const named = qualifier === null ? head : qualify(head, qualifier);

  return ordinal === null ? named : `${named} #${ordinal}`;
}

/**
 * A node's number sits tight against the name, `ref#1`, where the name itself is ours, so it never
 * reads as the spaced one a store's key carries. A node the developer named takes the spaced one
 * like every other clash.
 */
function holderKey(node: HolderNode): string {
  if (node.ordinal === null) {
    return node.name;
  }

  return node.ours ? `${node.name}#${node.ordinal}` : `${node.name} #${node.ordinal}`;
}
