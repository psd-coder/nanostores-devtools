import { box, mark } from "./marker.ts";
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

/**
 * jsan calls this for every key of the tree and then walks whatever we hand back, so returning a
 * value untouched leaves it to jsan and returning a wrapper preempts jsan's own type handling.
 */
export function createReplacer(
  serializers: Serializer[],
): (key: string, value: unknown) => unknown {
  return (key, value) => {
    try {
      for (const serializer of serializers) {
        if (serializer.match(value)) {
          /** Straight out, never back through the serializers, so an endless loop cannot start. */
          return serializer.convert(value);
        }
      }

      return convertValue(value);
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

      return mark("ConversionError", box(message));
    }
  };
}

/** Named apart from a `Serializer.convert`, which is the user's rule and runs before this. */
function convertValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    /** jsan throws outright on a BigInt, so it has to be taken before jsan sees it. */
    return mark("BigInt", box(String(value)));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Error) {
    return mark(constructorName(value, "Error"), errorFields(value));
  }

  if (isTypedArray(value)) {
    return mark(constructorName(value, "Object"), Array.from(value));
  }

  if (isDomNode(value)) {
    return mark(constructorName(value, "Object"), box(openingTag(value)));
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

  return Object.keys(fields).length > 0 ? mark(name, fields) : mark(name, box(String(value)));
}

/**
 * Own enumerable string keys that hold data. A getter can run app code, so it is skipped rather
 * than called, and a symbol key is skipped rather than walked.
 */
function ownFields(value: object): Fields {
  const fields: Fields = {};

  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor && "value" in descriptor) {
      fields[key] = descriptor.value;
    }
  }

  return fields;
}

/** `message`, `stack` and `cause` are own but not enumerable, so each one is read by name. */
function errorFields(error: Error): Fields {
  const fields: Fields = { name: error.name, message: error.message, stack: error.stack };

  if ("cause" in error) {
    fields["cause"] = error.cause;
  }

  return Object.assign(fields, ownFields(error));
}

function constructorName(value: object, fallback: string): string {
  const name = value.constructor?.name;

  return typeof name === "string" && name.length > 0 ? name : fallback;
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
