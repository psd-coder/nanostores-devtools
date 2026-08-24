import type { Store } from "nanostores";

import { type BoundName, type NodeInfo, peekDevtoolsGlobal } from "../global.ts";
import { getEntry, isStore, type StoreEntry } from "../stores/registry.ts";
import { primaryName } from "../stores/ownership.ts";

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

  return drawnOwners(entry.store)[0]?.key ?? entry.name;
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
 * A live owner and the key it knows the store by. The key belongs to the owner and not to the
 * store, so the two are one record: a key with no owner behind it names nothing.
 */
export type LiveOwnerLink = { owner: object; key: string | undefined };

/**
 * Every live owner of a store, and the key each one knows it by. An owner the app has let go reads
 * as none, and a store nothing else holds is drawn flat again.
 */
export function ownerLinksOf(store: Store): LiveOwnerLink[] {
  return (peekDevtoolsGlobal()?.owners.get(store) ?? []).flatMap((link) => {
    const owner = link.owner.deref();

    return owner === undefined ? [] : [{ owner, key: link.key }];
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
