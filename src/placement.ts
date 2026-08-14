import type { Store } from "nanostores";

import { type NodeInfo, peekDevtoolsGlobal } from "./global.ts";

/** Whether a top-level binding of the developer's own names the store, which draws it flat. */
export function namedByBinding(store: Store): boolean {
  return peekDevtoolsGlobal()?.bound.has(store) ?? false;
}

/**
 * A live owner and the key it knows the store by. The key belongs to the owner and not to the
 * store, so the two are one record: a key with no owner behind it names nothing.
 */
export type LiveOwnerLink = { owner: object; key: string | undefined };

/** An owner the app has let go reads as none, and the store it held is drawn flat again. */
export function ownerLinkOf(store: Store): LiveOwnerLink | undefined {
  const link = peekDevtoolsGlobal()?.owners.get(store);

  if (link === undefined) {
    return undefined;
  }

  const owner = link.owner.deref();

  return owner === undefined ? undefined : { owner, key: link.key };
}

/** What the tree knows about a value it drew as a node, or nothing for a value it never walked. */
export function nodeInfoOf(value: object): NodeInfo | undefined {
  return peekDevtoolsGlobal()?.nodes.get(value);
}
