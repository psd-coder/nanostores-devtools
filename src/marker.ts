/**
 * The extension's own wrapper. Its reviver drops the wrapper, keeps `data` and prints the type
 * as a label in front of it, so we add no nesting level. It only unwraps while
 * `typeof data === "object"`, which is why a primitive is boxed first.
 */
export type Marked = {
  data: object;
  __serializedType__: string;
};

export function mark(type: string, data: object): Marked {
  return { data, __serializedType__: type };
}

/**
 * The one key name invented in this design. jsan escapes only its own `$jsan`, so a `$$` key
 * survives both ways, and the prefix says the key is ours and not the developer's.
 */
export function box(value: unknown): { $$value: unknown } {
  return { $$value: value };
}
