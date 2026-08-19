import type { Store } from "nanostores";

import { drawnLately } from "./drawn.ts";
import { type NodeInfo, peekDevtoolsGlobal } from "./global.ts";
import { getEntry, isStore, type StoreEntry } from "./registry.ts";

/**
 * Whether a developer can see this store at all: at a key of its own, or inside the value of a
 * store that has one. A store neither of those reaches is one no row can point at, so a row about
 * it names something nobody can look up and its diff shows nothing.
 */
export function isDrawn(entry: StoreEntry): boolean {
  return isPlaced(entry) || drawnLately(entry.store);
}

/**
 * What a row calls the store, which is the key the tree draws it under. A row names something the
 * developer goes and looks up, so a name no key in the tree carries points at nothing: three lenses
 * writing `$lens/set` say which store changed only to whoever wrote the util.
 *
 * A home of their own wins, as it does everywhere: a top-level binding or a group they registered by
 * hand is drawn flat under that name, and the row says the same. Where nothing does, the store is
 * drawn under its owner alone, and the owner's own key is the only name it has.
 *
 * This reads the placement rather than the entry, so the row and the tree cannot drift: the same
 * link decides both. The entry's `label` is untouched: a change prints it beside the row, and it
 * still says which file the store really came from.
 */
export function rowName(entry: StoreEntry): string {
  if (placedByDeveloper(entry)) {
    return entry.name;
  }

  return drawnOwner(entry.store)?.key ?? entry.name;
}

/**
 * Whether the tree draws the store anywhere at all.
 *
 * A store made inside a function and placed by nothing is that function's own working state: what
 * the function returned is what the app holds, and the tree draws that already. One made at module
 * level has no function it could belong to, and the file it was written in is already its only
 * holding, so it stays flat there.
 *
 * One test for the tree and for the timeline both, or the two would disagree about which stores
 * exist and a row would announce a store the developer cannot find.
 */
export function isPlaced(entry: StoreEntry): boolean {
  return entry.fn === null || placedByDeveloper(entry) || drawnOwner(entry.store) !== undefined;
}

/**
 * A home the developer chose: a group they registered the store into, or a top-level name they
 * bound it to. Either one beats the owner the ownership walk recorded.
 */
export function placedByDeveloper(entry: StoreEntry): boolean {
  return entry.origin === "explicit" || namedByBinding(entry.store);
}

/** Whether a top-level binding of the developer's own names the store, which draws it flat. */
export function namedByBinding(store: Store): boolean {
  return peekDevtoolsGlobal()?.bound.has(store) ?? false;
}

/**
 * The owner a store is drawn under, with the key that owner knows it by. A store owner the registry
 * lost holds no place in the tree, so a store under it would be drawn nowhere at all and is drawn at
 * its own home instead.
 */
export function drawnOwner(store: Store): LiveOwnerLink | undefined {
  const link = ownerLinkOf(store);

  return link !== undefined && drawable(link.owner) ? link : undefined;
}

/** Whether the tree has a place for the owner itself, which is what a store under it hangs from. */
export function drawable(owner: object): boolean {
  return isStore(owner) ? getEntry(owner) !== undefined : nodeInfoOf(owner) !== undefined;
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
