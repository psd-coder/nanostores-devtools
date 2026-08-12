import type { Store } from "nanostores";

import { getDevtoolsGlobal, type Owners, peekDevtoolsGlobal } from "./global.ts";
import { getEntry, isStore } from "./registry.ts";

/**
 * What nanostores itself puts on a store. Skipped while walking, or an atom holding a store would
 * nest that store under the atom instead of leaving it where the developer put it.
 */
const STORE_KEYS: ReadonlySet<string> = new Set([
  "value",
  "init",
  "lc",
  "events",
  "listen",
  "get",
  "set",
  "setKey",
  "subscribe",
  "notify",
  "off",
]);

/** How many property steps the scan takes from the binding before it gives up. */
const MAX_DEPTH = 3;

/** One top-level binding: the name as the developer wrote it, and the value it holds. */
export type Binding = readonly [string, unknown];

/**
 * The module's own top-level bindings, at the end of its body. Only a store is placed here: a
 * binding holding a plain object or a class instance keeps every store it carries where it is.
 *
 * Nothing is registered. A store is born once and has one entry, which is what makes two names
 * for one store resolve to one store, so this decides where the tree draws it and nothing else.
 */
export function ownBindings(bindings: readonly Binding[]): void {
  for (const [, value] of bindings) {
    if (isStore(value)) {
      walk(value, 0, new Set());
    }
  }
}

/** An owner the app has let go reads as none, and the store it held is drawn flat again. */
export function ownerOf(store: Store): Store | undefined {
  return peekDevtoolsGlobal()?.owners.get(store)?.deref();
}

/**
 * Own enumerable data properties only, read through the descriptor, so a getter never runs: it is
 * the developer's own code and running it would change how the app behaves.
 */
function walk(owner: Store, depth: number, seen: Set<Store>): void {
  if (depth >= MAX_DEPTH || seen.has(owner)) {
    return;
  }

  seen.add(owner);

  for (const key of Object.keys(owner)) {
    if (STORE_KEYS.has(key)) {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    const held: unknown =
      descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;

    if (isStore(held)) {
      recordOwner(held, owner);
      walk(held, depth + 1, seen);
    }
  }
}

/**
 * The first owner the registry still knows keeps the store. An owner it lost is replaced: a hot
 * reload builds a module's stores again, and a store imported from another file would otherwise
 * keep pointing at the owner the run before it made.
 *
 * A new owner the store already holds above it is refused, itself included, because an owner chain
 * that loops would make the tree infinite. Every loop being refused is also why the chain below
 * can be walked without a bound: no chain recorded here can hold one.
 */
function recordOwner(store: Store, owner: Store): void {
  const { owners } = getDevtoolsGlobal();
  const known = owners.get(store)?.deref();

  if ((known !== undefined && getEntry(known) !== undefined) || chainHolds(owners, owner, store)) {
    return;
  }

  owners.set(store, new WeakRef(owner));
}

function chainHolds(owners: Owners, from: Store, wanted: Store): boolean {
  let current: Store | undefined = from;

  while (current !== undefined) {
    if (current === wanted) {
      return true;
    }

    current = owners.get(current)?.deref();
  }

  return false;
}
