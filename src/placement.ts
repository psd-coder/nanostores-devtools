import type { Store } from "nanostores";

import { type NodeInfo, peekDevtoolsGlobal } from "./global.ts";

/** Whether a top-level binding of the developer's own names the store, which draws it flat. */
export function namedByBinding(store: Store): boolean {
  return peekDevtoolsGlobal()?.bound.has(store) ?? false;
}

/** An owner the app has let go reads as none, and the store it held is drawn flat again. */
export function ownerOf(store: Store): object | undefined {
  return peekDevtoolsGlobal()?.owners.get(store)?.owner.deref();
}

/**
 * The key the owner knows the store by, for a collection that reached it by a position or a map key.
 * Nothing for every other owner, where the store's own name is already the key.
 */
export function ownerKeyOf(store: Store): string | undefined {
  return peekDevtoolsGlobal()?.owners.get(store)?.key;
}

/** What the tree knows about a value it drew as a node, or nothing for a value it never walked. */
export function nodeInfoOf(value: object): NodeInfo | undefined {
  return peekDevtoolsGlobal()?.nodes.get(value);
}
