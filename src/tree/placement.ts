import type { Store } from "nanostores";

import { type BoundName, type MemberCount, type NodeInfo, peekDevtoolsGlobal } from "../global.ts";
import { getEntry, isStore, type StoreEntry } from "../stores/registry.ts";
import { primaryName } from "../stores/ownership.ts";

/**
 * What a row calls the store: the whole chain from the top-level binding down, `config.theme.$x`,
 * or the one name a binding or a group gave it. A row names something the developer goes and looks
 * up, and a path is something they could paste back into their own source, while the last key alone
 * says nothing about which of two objects holding an `$open` moved.
 *
 * The row and the tree are built from the same links rather than from the same string: the entry's
 * name is the chain the scan walked, and the tree draws one key of that chain per level. Both come
 * out of the walk, so neither can drift from the other.
 */
export function rowName(entry: StoreEntry): string {
  return entry.name;
}

/**
 * Every other chain that reaches the store, which a change lists beside the one the entry took. A
 * store two objects hold moves in both of them, and the row can head with only one name.
 */
export function otherPaths(entry: StoreEntry): string[] {
  const paths = ownerLinksOf(entry.store).flatMap((link) =>
    link.path === undefined || link.path === entry.name ? [] : [link.path],
  );

  return [...new Set(paths)];
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
  return boundNames(store) !== undefined;
}

/** The bindings that hold one store: the one the entry took, and every other one the tree draws. */
export type BoundPlacements = { primary: BoundName; repeats: BoundName[] };

/**
 * Every top-level binding of the developer's own that holds the store, told apart rather than
 * ordered, so nothing downstream has to know which end of a list the primary sits at.
 */
export function boundNames(store: Store): BoundPlacements | undefined {
  const names = peekDevtoolsGlobal()?.bound.get(store) ?? [];
  const primary = primaryName(names);

  return primary === undefined
    ? undefined
    : { primary, repeats: names.filter((one) => one !== primary) };
}

/**
 * Every owner the tree can draw the store under, in the order the links were recorded. A store
 * owner the registry lost holds no place in the tree, so a store under it would be drawn nowhere at
 * all and is drawn at its own home instead.
 */
export function drawnOwners(store: Store): LiveOwnerLink[] {
  return ownerLinksOf(store).filter((link) => drawable(link.owner));
}

/** Whether the tree has a place for the owner itself, which is what a store under it hangs from. */
export function drawable(owner: object): boolean {
  return isStore(owner) ? getEntry(owner) !== undefined : nodeInfoOf(owner) !== undefined;
}

/**
 * A live owner, the key it knows the store by, and the chain the walk took to reach it there. All
 * three belong to the owner and not to the store, so they are one record: a key with no owner
 * behind it names nothing.
 */
export type LiveOwnerLink = { owner: object; key: string | undefined; path: string | undefined };

/**
 * Every live owner of a store, and the key each one knows it by. An owner the app has let go reads
 * as none, and a store nothing else holds is drawn flat again.
 */
export function ownerLinksOf(store: Store): LiveOwnerLink[] {
  return (peekDevtoolsGlobal()?.owners.get(store) ?? []).flatMap((link) => {
    const owner = link.owner.deref();

    return owner === undefined ? [] : [{ owner, key: link.key, path: link.path }];
  });
}

/** Every parent the tree can draw a node under, in the order the links were recorded. */
export function drawnParents(info: NodeInfo): object[] {
  return info.parents.flatMap((link) => {
    const parent = link.parent.deref();

    return parent === undefined || !drawable(parent) ? [] : [parent];
  });
}

/** What the tree knows about a value it drew as a node, or nothing for a value it never walked. */
export function nodeInfoOf(value: object): NodeInfo | undefined {
  return peekDevtoolsGlobal()?.nodes.get(value);
}

/**
 * How many of a store's own members the walk drew and left out. A store the walk never looked
 * inside had nothing cut, so it reads as none rather than as missing.
 */
export function memberCountOf(store: Store): MemberCount {
  return peekDevtoolsGlobal()?.members.get(store) ?? { walked: 0, skipped: 0 };
}
