/**
 * The extension's own wrapper. Its reviver drops the wrapper, keeps `data` and prints the type
 * as a label in front of it, so we add no nesting level.
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
