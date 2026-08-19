import { VALUE_KEY } from "./keys.ts";

/**
 * The extension's own wrapper. Its reviver drops the wrapper, keeps `data` and prints the type
 * as a label in front of it, so we add no nesting level.
 */
export type Marked = {
  data: object;
  __serializedType__: string;
};

/**
 * Objects the bridge built rather than the app: every wrapper and box here, and every node of the
 * tree. Their keys are already spelled the way the panel should read them, so no rule of ours
 * spells them a second time. Held weakly, because a tree is rebuilt for every row.
 */
const BUILT = new WeakSet<object>();

/** The value back, noted as ours. Every object we hand the panel goes through this or through it. */
export function keepBuilt<TValue extends object>(value: TValue): TValue {
  BUILT.add(value);

  return value;
}

export function isBuilt(value: object): boolean {
  return BUILT.has(value);
}

export function mark(type: string, data: object): Marked {
  return keepBuilt({ data, __serializedType__: type });
}

/** A wrapper of ours, told apart from an app object that happens to carry the same key. */
export function isMarked(value: unknown): value is Marked {
  return (
    typeof value === "object" &&
    value !== null &&
    isBuilt(value) &&
    "__serializedType__" in value &&
    "data" in value
  );
}

export function box(value: unknown): { [VALUE_KEY]: unknown } {
  return keepBuilt({ [VALUE_KEY]: value });
}
