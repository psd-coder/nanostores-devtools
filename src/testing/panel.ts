import { parse } from "jsan";

/**
 * What `options: true` means to the extension. Its own bundle holds this object and hands it to
 * jsan, so `refs: false` is what a repeated value meets. jsan's own boolean expansion leaves
 * `refs` unset, which turns every repeat into a pointer, and that is not what runs in the panel.
 */
export const EXTENSION_OPTIONS: Record<string, boolean> = {
  refs: false,
  date: true,
  function: true,
  regex: true,
  undefined: true,
  error: true,
  symbol: true,
  map: true,
  set: true,
  nan: true,
  infinity: true,
};

/** The key the panel hangs a type on, and the one its monitor reads to draw the label. */
const TYPE_KEY = Symbol.for("__serializedType__");

type Wrapper = { data: unknown; __serializedType__: unknown };

/**
 * The panel's own reviver, copied from `redux-devtools-app-core/src/utils/parseJSON.ts`, so a test
 * can read what a developer ends up seeing rather than the string jsan writes. Reading the string
 * alone hides every label the round trip loses.
 */
export function parsePanel(written: string): unknown {
  return parse(written, (_key, value) => {
    if (!isWrapper(value) || typeof value.data !== "object") {
      return value;
    }

    /**
     * `typeof null` is `"object"`, so the test above lets it through and the panel's own write to
     * it throws. Spelled out here because the throw is what boxing a `null` buys.
     */
    if (value.data === null) {
      throw new TypeError("cannot write the type onto a null data");
    }

    return typed(value.data, value.__serializedType__);
  });
}

/** The label the monitor prints in front of a value, or nothing where the value carries none. */
export function labelOf(value: unknown): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, TYPE_KEY) : undefined;
}

function isWrapper(value: unknown): value is Wrapper {
  return typeof value === "object" && value !== null && "__serializedType__" in value;
}

/**
 * The type is written onto `data` itself, which is why a value the wire turns into another object
 * arrives with no type at all.
 */
function typed(data: object, type: unknown): object {
  Reflect.set(data, TYPE_KEY, type);

  return data;
}
