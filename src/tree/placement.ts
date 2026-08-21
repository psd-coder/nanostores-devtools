import type { Store } from "nanostores";

import { type BoundName, type NodeInfo, type OwnerSource, peekDevtoolsGlobal } from "../global.ts";
import { drawnLately } from "./drawn.ts";
import { getEntry, isStore, type StoreEntry } from "../stores/registry.ts";
import { primaryName } from "../stores/ownership.ts";

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

  return drawnOwners(entry.store)[0]?.key ?? entry.name;
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
  return entry.fn === null || placedByDeveloper(entry) || drawnOwners(entry.store).length > 0;
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
 *
 * **A frame link draws only where nothing else does.** A scan and a field both know a property
 * name, so each is a reference the developer wrote; a frame knows only that the store was born
 * while an expression ran, and letting that stand beside a real reference draws the store twice.
 */
export function ownerLinksOf(store: Store): LiveOwnerLink[] {
  return drawnLinks(peekDevtoolsGlobal()?.owners.get(store) ?? []).flatMap((link) => {
    const owner = link.owner.deref();

    return owner === undefined ? [] : [{ owner, key: link.key }];
  });
}

/**
 * The links the tree draws: every one the developer wrote, or the one frame link where they wrote
 * none. Shared by a store's owners and a node's parents, because the rule is about what a link
 * knows and not about what it holds.
 */
function drawnLinks<TLink extends { source: OwnerSource }>(links: readonly TLink[]): TLink[] {
  const written = links.filter((link) => link.source !== "frame");

  return written.length > 0 ? written : [...links];
}

/**
 * Every parent the tree can draw a node under, in the order the links were recorded, on the same
 * terms an owner link is read: a frame parent stands only where no written reference does.
 */
export function drawnParents(info: NodeInfo): object[] {
  return drawnLinks(info.parents).flatMap((link) => {
    const parent = link.parent.deref();

    return parent === undefined || !drawable(parent) ? [] : [parent];
  });
}

/** What the tree knows about a value it drew as a node, or nothing for a value it never walked. */
export function nodeInfoOf(value: object): NodeInfo | undefined {
  return peekDevtoolsGlobal()?.nodes.get(value);
}
