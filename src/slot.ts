import type { Store } from "nanostores";

import { chainValue } from "./descriptor.ts";
import { box } from "./marker.ts";
import { DERIVED, type StoreEntry, type StoreType } from "./registry.ts";

/** `set` writes `value` with no check on `lc`, so an unmounted one still holds the true value. */
const TRUSTED_UNMOUNTED: ReadonlySet<StoreType> = new Set<StoreType>(["atom", "map", "deepMap"]);

/** The label a marked slot carries, and what sits under it. */
export type Note = { label: string; data: object };

/**
 * What a store holds, read through the descriptor so a getter behind `value` never runs. The tree
 * reads a store the registry knows, while a value holds anything that looks like one, and one rule
 * covers both rather than splitting by who vetted the object. Every store nanostores builds keeps
 * `value` as its own data property, so refusing an accessor turns nothing real away, and one that
 * puts its value behind a getter reads as holding `undefined`.
 */
export function storeValue(store: Store): unknown {
  return chainValue(store, "value");
}

/**
 * What an unmounted store's value has to say about itself, or nothing when the value can be
 * trusted. A store is drawn in two places, its own slot in the tree and inside another store's
 * value, and two marks cannot nest, so the rule lives here and each caller wraps what it returns.
 *
 * Only a value that cannot be trusted is marked, so the marker states the consequence and not the
 * mount state. An unknown type never gets `never computed`: it may be somebody's computed store,
 * and we cannot prove it never ran.
 */
export function staleNote(store: Store, entry: StoreEntry | undefined): Note | undefined {
  const type = entry?.type ?? "unknown";

  if (store.lc > 0 || TRUSTED_UNMOUNTED.has(type)) {
    return undefined;
  }

  const value = storeValue(store);

  if (DERIVED.has(type) && !entry?.everMounted && value === undefined) {
    return { label: "not mounted, never computed", data: {} };
  }

  return { label: "not mounted, may be stale", data: box(value) };
}
