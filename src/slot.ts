import type { Store } from "nanostores";

import { chainValue } from "./descriptor.ts";
import { DERIVED, type StoreEntry, type StoreType } from "./registry.ts";

/** `set` writes `value` with no check on `lc`, so an unmounted one still holds the true value. */
const TRUSTED_UNMOUNTED: ReadonlySet<StoreType> = new Set<StoreType>(["atom", "map", "deepMap"]);

/** What a store holds, and whether it can be trusted. */
export type Slot =
  | { state: "live"; value: unknown }
  | { state: "stale"; value: unknown }
  | { state: "never-computed" };

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
 * What an unmounted store's value has to say about itself, and `live` where the value can be
 * trusted. The state is the whole answer: what a reader is told about each one is the view's to
 * word.
 *
 * An unknown type never reads as `never-computed`: it may be somebody's computed store, and we
 * cannot prove it never ran.
 */
export function staleNote(store: Store, entry: StoreEntry | undefined): Slot {
  const type = entry?.type ?? "unknown";
  const value = storeValue(store);

  if (store.lc > 0 || TRUSTED_UNMOUNTED.has(type)) {
    return { state: "live", value };
  }

  if (DERIVED.has(type) && !entry?.everMounted && value === undefined) {
    return { state: "never-computed" };
  }

  return { state: "stale", value };
}
