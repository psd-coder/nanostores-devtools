import { isStore } from "./registry.ts";

/**
 * The extension's own wrapper. Its reviver drops the wrapper, keeps `data` and prints the type
 * as a label in front of it, so we add no nesting level. What `data` may hold and what has to be
 * boxed first is `boxUnlessPlain` below.
 */
export type Marked = {
  data: object;
  __serializedType__: string;
};

export function mark(type: string, data: object): Marked {
  return { data, __serializedType__: type };
}

/**
 * The one key name invented in this design, and the tree spells a store's own value the same way,
 * so a developer reads one idea in one spelling. Parentheses cannot spell a JS name, so the key
 * never reads as one a binding could take, and jsan escapes only its own `$jsan`, so the parens
 * survive both ways.
 */
export const VALUE_KEY = "(value)";

export function box(value: unknown): { [VALUE_KEY]: unknown } {
  return { [VALUE_KEY]: value };
}

/**
 * What a mark carries for a value. The panel's reviver hangs the type on `data` under a symbol key,
 * so `data` has to be the very object the panel draws, and three kinds of value lose the label
 * unless they are boxed first:
 *
 * - a primitive, which never unwraps at all, and `null`, which breaks the write the reviver makes;
 * - a `Date`, a `Map`, a `Set` and a `RegExp`, which travel as a `{ $jsan: … }` object, so decoding
 *   replaces the object the type was written onto and the type goes with it;
 * - anything we mark ourselves, which would carry two types on one object, and the outer one wins.
 *
 * A plain object and an array are what is left, and both go in bare.
 */
export function boxUnlessPlain(value: unknown): object {
  return isPlain(value) ? value : box(value);
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
