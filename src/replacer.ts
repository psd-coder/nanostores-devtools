import { chainDescriptor } from "./descriptor.ts";
import { box, mark, type Marked } from "./marker.ts";
import { describeError, warnOnce } from "./warn.ts";

/** Checked in array order, ahead of every rule of ours, and the first match wins. */
export type Serializer = {
  match: (value: unknown) => boolean;
  convert: (value: unknown) => unknown;
};

type Fields = Record<string, unknown>;

type NodeAttribute = { name: string; value: string };

/** What a DOM node gives us for its opening tag. `attributes` is missing on a text node. */
type TaggedNode = { nodeName: string; attributes?: ArrayLike<NodeAttribute> | undefined };

/** The one wrapper each source object gets, for as long as the replacer lives. */
type Wrappers = WeakMap<object, Marked>;

/**
 * jsan calls this for every key of the tree and then walks whatever we hand back, so returning a
 * value untouched leaves it to jsan and returning a wrapper preempts jsan's own type handling.
 */
export function createReplacer(
  serializers: Serializer[],
): (key: string, value: unknown) => unknown {
  /**
   * jsan spots a value it has already walked by holding what the replacer handed back and matching
   * a second sighting by identity, so a fresh wrapper on every call means a value that refers to
   * itself never comes round and the walk runs until the stack ends. One wrapper per source value
   * is what lets jsan see the repeat, and it lives as long as the replacer, which is one
   * connection.
   */
  const wrappers: Wrappers = new WeakMap();

  return (key, value) => {
    try {
      for (const serializer of serializers) {
        if (serializer.match(value)) {
          /** Straight out, never back through the serializers, so an endless loop cannot start. */
          return serializer.convert(value);
        }
      }

      return convertValue(value, wrappers);
    } catch (error) {
      const message = describeError(error);

      /**
       * jsan passes the key and nothing else: no holder object and no path, so the store the
       * value belongs to is not reachable from here and the key is the whole dedup subject.
       */
      warnOnce(
        "conversion-failed",
        key,
        `A value at "${key}" could not be converted for the panel, so that one slot shows ` +
          `ConversionError. ${message}`,
      );

      /** Left out of the cache: whatever threw may be a primitive, and a weak key must not be. */
      return mark("ConversionError", box(message));
    }
  };
}

/**
 * The wrapper this value already has, holding what the value holds now, or a new one. Handing the
 * same object back twice is what tells jsan a value has come round again, and refreshing it is what
 * keeps a second walk from showing the first walk's values.
 */
function markOnce(wrappers: Wrappers, source: object, type: string, data: object): Marked {
  const known = wrappers.get(source);

  if (!known) {
    const fresh = mark(type, data);

    wrappers.set(source, fresh);

    return fresh;
  }

  known.data = data;
  known.__serializedType__ = type;

  return known;
}

/** Named apart from a `Serializer.convert`, which is the user's rule and runs before this. */
function convertValue(value: unknown, wrappers: Wrappers): unknown {
  if (typeof value === "bigint") {
    /**
     * jsan throws outright on a BigInt, so it has to be taken before jsan sees it. Left out of the
     * cache for the same reason as a slot that threw: a weak key must be an object.
     */
    return mark("BigInt", box(String(value)));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Error) {
    return markOnce(wrappers, value, constructorName(value, "Error"), errorFields(value));
  }

  if (isTypedArray(value)) {
    return markOnce(wrappers, value, constructorName(value, "Object"), Array.from(value));
  }

  if (isDomNode(value)) {
    return markOnce(wrappers, value, constructorName(value, "Object"), box(openingTag(value)));
  }

  /** Before the class instance rule, or jsan never gets to render these four natively. */
  if (
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof RegExp ||
    Array.isArray(value)
  ) {
    return value;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  if (prototype === Object.prototype || prototype === null) {
    return value;
  }

  const name = constructorName(value, "Object");
  const fields = ownFields(value);
  const data = Object.keys(fields).length > 0 ? fields : box(String(value));

  return markOnce(wrappers, value, name, data);
}

/**
 * Own enumerable string keys that hold data. A getter can run app code, so it is skipped rather
 * than called, and a symbol key is skipped rather than walked.
 */
function ownFields(value: object): Fields {
  const fields: Fields = {};

  for (const key of Object.keys(value)) {
    copyData(fields, key, Object.getOwnPropertyDescriptor(value, key));
  }

  return fields;
}

/**
 * `message`, `stack` and `cause` are own but not enumerable, so each one is read by name, and each
 * one through a descriptor so a getter the app put on it never runs. `name` sits on the instance
 * only when a constructor assigned it and two prototypes up for a subclass, hence the chain walk;
 * `message` and `cause` are own on every engine we know, and the same walk costs nothing and covers
 * an app that moved them. A field whose descriptor is refused is left out rather than shown empty.
 */
function errorFields(error: Error): Fields {
  const fields: Fields = {};

  copyData(fields, "name", chainDescriptor(error, "name"));
  copyData(fields, "message", chainDescriptor(error, "message"));

  /** Both keys being here means both held data, and that is what makes the stack safe to read. */
  const headerIsSafe = "name" in fields && "message" in fields;

  copyData(fields, "stack", stackDescriptor(error, headerIsSafe));

  /** `in` walks the prototype chain without running a getter, so the presence test is safe. */
  if ("cause" in error) {
    copyData(fields, "cause", chainDescriptor(error, "cause"));
  }

  return Object.assign(fields, ownFields(error));
}

/** An accessor is passed over rather than called, so its key never appears. */
function copyData(fields: Fields, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor && "value" in descriptor) {
    fields[key] = descriptor.value;
  }
}

/**
 * V8 installs `stack` as an own accessor on the instance, so refusing every accessor would drop the
 * stack from every error we draw. The position tells the two apart: an own accessor is the engine's
 * and is read, while a `get stack()` the app wrote lands on a prototype and is refused.
 *
 * That getter builds the first stack line as `name: message` and reads both off the error, so a
 * getter on either one would run through it. `headerIsSafe` says both were read as data, and
 * without it the stack goes out with them. Even then the read can run app code through
 * `Error.prepareStackTrace`, a V8 hook that formats the stack, and that is the one hole we take: it
 * is rare in a browser, and a devtools with no stack traces is worth less than the risk.
 */
function stackDescriptor(error: Error, headerIsSafe: boolean): PropertyDescriptor | undefined {
  const own = Object.getOwnPropertyDescriptor(error, "stack");

  if (!own) {
    return chainDescriptor(error, "stack");
  }

  if ("value" in own) {
    return own;
  }

  return own.get && headerIsSafe ? { value: own.get.call(error) } : undefined;
}

/**
 * What built the value, read through the descriptor so a getter the app put on `constructor` or on
 * the function's own `name` never runs. The value's own `constructor` comes first, which keeps
 * `this.constructor = Foo` written by hand working, and the prototype's is where a class puts it, so
 * reading own properties alone would lose every label.
 */
function constructorName(value: object, fallback: string): string {
  const prototype: object | null = Object.getPrototypeOf(value);
  const built: unknown =
    ownValue(value, "constructor") ??
    (prototype === null ? undefined : ownValue(prototype, "constructor"));
  const name: unknown = typeof built === "function" ? ownValue(built, "name") : undefined;

  return typeof name === "string" && name.length > 0 ? name : fallback;
}

/** What an own data property holds. A getter is passed over rather than called. */
function ownValue(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/** Every view except a `DataView` is a typed array, and every typed array is array-like. */
function isTypedArray(value: object): value is ArrayLike<number | bigint> {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/** `instanceof` reads no property off the value, so no getter of the app's can run here. */
function isDomNode(value: object): value is TaggedNode {
  return typeof Node !== "undefined" && value instanceof Node;
}

/** The opening tag only: children can be a whole page, and `outerHTML` carries all of them. */
function openingTag(node: TaggedNode): string {
  const attributes = node.attributes ? Array.from(node.attributes) : [];
  const rendered = attributes.map((attribute) => ` ${attribute.name}="${attribute.value}"`);

  return `<${node.nodeName.toLowerCase()}${rendered.join("")}>`;
}
