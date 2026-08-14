import type { Store } from "nanostores";

import { chainValue, ownFields, ownIndexes } from "./descriptor.ts";
import { box } from "./marker.ts";
import { DERIVED, isStore, type StoreEntry, type StoreType } from "./registry.ts";

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

  return { label: "not mounted, may be stale", data: dataForMark(store, value) };
}

/**
 * What a mark carries for a store's value. The panel's reviver hangs the type on `data` under a
 * symbol key, so `data` has to be the very object the panel draws, and these values lose the label
 * unless they are boxed first:
 *
 * - a primitive, which never unwraps at all, and `null`, which breaks the write the reviver makes;
 * - a `Date`, a `Map`, a `Set` and a `RegExp`, which travel as a `{ $jsan: … }` object, so decoding
 *   replaces the object the type was written onto and the type goes with it;
 * - anything we mark ourselves, which would carry two types on one object, and the outer one wins;
 * - a value that holds the store back, because then the mark sits inside the object it carries,
 *   jsan writes an object it is already inside as a pointer to that ancestor, and the type was
 *   written onto the object the pointer replaces.
 *
 * A plain object and an array with no way back to the store are what is left, and both go in bare.
 *
 * The loop is a fact about the store rather than about one sighting, so such a store is boxed
 * everywhere it is drawn, including where it sits outside its own value and would not have looped.
 * Two placements of one store then never disagree about their shape.
 */
export function dataForMark(store: Store, value: unknown): object {
  return isPlain(value) && !reachesStore(value, store) ? value : box(value);
}

function isPlain(value: unknown): value is object {
  /** A store is a plain object literal, and we mark it, so it takes the box like every other mark. */
  if (typeof value !== "object" || value === null || isStore(value)) {
    return false;
  }

  if (Array.isArray(value)) {
    return true;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * How many values the walk may line up before it answers yes without looking further. Boxing costs
 * one level and never loses a label, so a value this large is cheaper to box than to walk, and no
 * state object a panel can be read at is anywhere near this wide. Counted where a value is lined
 * up rather than where it is looked at, so a single wide array cannot outrun the count either.
 */
export const MAX_WALKED_NODES = 10_000;

/**
 * Whether the store sits anywhere inside its own value, following what the panel is sent: a getter
 * of the app's is passed over rather than called, and a store contributes its value alone. The
 * visited set is what a value that merely repeats needs, and the stack is what a deep one needs,
 * because a call per level would end the stack first.
 */
function reachesStore(value: object, store: Store): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let budget = MAX_WALKED_NODES;

  while (pending.length > 0) {
    const held: unknown = pending.pop();

    if (held === store) {
      return true;
    }

    if (typeof held !== "object" || held === null || seen.has(held)) {
      continue;
    }

    seen.add(held);

    for (const child of heldValues(held, budget)) {
      if (budget === 0) {
        return true;
      }

      budget -= 1;
      pending.push(child);
    }
  }

  return false;
}

/**
 * What jsan walks into, one level down, once every rule of ours has had the value. An array is read
 * one index past what `budget` still allows, which is enough to line up everything the walk may
 * look at and one more to say it did not reach the end.
 */
function heldValues(value: object, budget: number): unknown[] {
  if (Array.isArray(value)) {
    return ownIndexes(value, budget + 1);
  }

  if (value instanceof Map) {
    return [...value.keys(), ...value.values()];
  }

  if (value instanceof Set) {
    return [...value];
  }

  /** A store goes out as its value alone, so its own fields lead nowhere the panel draws. */
  if (isStore(value)) {
    return [storeValue(value)];
  }

  /** `cause` is own but not enumerable, and the replacer sends it, so the walk follows it too. */
  if (value instanceof Error) {
    return [chainValue(value, "cause"), ...Object.values(ownFields(value))];
  }

  return Object.values(ownFields(value));
}
