import type { Fields } from "./descriptor.ts";
import { box, keepBuilt, mark, type Marked } from "./redux/marker.ts";
import type { Serializer } from "./redux/replacer.ts";

/** A primitive inside an object wrapper, which keeps it behind the `valueOf` of its prototype. */
type Boxed = { valueOf: () => unknown };

/** One entry of a collection keyed by name, in the order that collection hands its entries out. */
type Visit = (held: unknown, name: string) => void;

/**
 * The rules the bridge ships, checked after the developer's own and ahead of every rule of ours.
 * Each one covers a platform class with one obvious reading and no field to choose: the entries of
 * a `Headers`, a `FormData` and a `URLSearchParams`, the size of a buffer or a view, and the
 * primitive a boxed one holds, which the class-instance rule would otherwise draw as one own key
 * per character.
 *
 * Where a rule and a published reading both fit, the rule wins because it runs first. A
 * `URLSearchParams` would read as its whole query string under `(toString)` without one, and its
 * entries say more.
 *
 * Every result is flat and small, which is what makes that order safe: it holds strings and
 * numbers, and the one object among them, a file inside a `FormData`, is bounded on its own.
 */
export const shippedSerializers: Serializer[] = [
  ruleFor(isHeaders, (value) => mark("Headers", headerFields(value))),
  ruleFor(isFormData, (value) =>
    mark(
      "FormData",
      entryFields((visit) => FormData.prototype.forEach.call(value, visit)),
    ),
  ),
  ruleFor(isSearchParams, (value) =>
    mark(
      "URLSearchParams",
      entryFields((visit) => URLSearchParams.prototype.forEach.call(value, visit)),
    ),
  ),
  ruleFor(isArrayBuffer, (value) => mark("ArrayBuffer", bufferSize(ArrayBuffer.prototype, value))),
  ruleFor(isSharedBuffer, (value) =>
    mark("SharedArrayBuffer", bufferSize(SharedArrayBuffer.prototype, value)),
  ),
  ruleFor(isDataView, (value) => mark("DataView", viewBounds(value))),
  ruleFor(isBoxedString, (value) => mark("String", box(unboxed(String.prototype, value)))),
  ruleFor(isBoxedNumber, (value) => mark("Number", box(unboxed(Number.prototype, value)))),
  ruleFor(isBoxedBoolean, (value) => mark("Boolean", box(unboxed(Boolean.prototype, value)))),
];

/**
 * One rule, written as a guard and a drawing over the type that guard names, so no cast stands
 * between the two halves of a `Serializer`. `convert` runs only once `match` has said yes, and
 * asking a second time is what carries that answer into the type.
 */
function ruleFor<TValue>(
  guard: (value: unknown) => value is TValue,
  draw: (value: TValue) => Marked,
): Serializer {
  return {
    match: guard,
    convert: (value) => (guard(value) ? draw(value) : value),
  };
}

/**
 * Every guard reads its global inside the function, so importing this file runs nothing and a page
 * without the class declines instead of throwing.
 *
 * `instanceof` is realm-bound, so a value built inside an iframe takes the class-instance rule
 * instead. Each class here is one an app holds directly, which is the case this list is for.
 */
function isHeaders(value: unknown): value is Headers {
  return typeof Headers !== "undefined" && value instanceof Headers;
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

function isSearchParams(value: unknown): value is URLSearchParams {
  return typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer;
}

function isSharedBuffer(value: unknown): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
}

function isDataView(value: unknown): value is DataView {
  return typeof DataView !== "undefined" && value instanceof DataView;
}

function isBoxedString(value: unknown): value is Boxed {
  return value instanceof String;
}

function isBoxedNumber(value: unknown): value is Boxed {
  return value instanceof Number;
}

function isBoxedBoolean(value: unknown): value is Boxed {
  return value instanceof Boolean;
}

/**
 * A header name is unique here: `forEach` hands back one line per name, with the values of a name
 * that was set twice already joined, so no entry can be lost to another under the same key.
 */
function headerFields(value: Headers): Fields {
  const fields: Fields = {};

  Headers.prototype.forEach.call(value, (held, name) => {
    fields[name] = held;
  });

  return keepBuilt(fields);
}

/**
 * One key per entry, in the source's own insertion order. A name that repeats takes the ` #2`
 * spelling the tree already uses for a name two children want, because one key holds one entry and
 * a lost entry is worse than a name a field really called `tag #2` could also spell.
 *
 * `read` hands the visit to the built-in `forEach` called against the value, the way `setMembers`
 * reads a `Set`, so a method the app overrode never runs while a tree is written.
 */
function entryFields(read: (visit: Visit) => void): Fields {
  const fields: Fields = {};
  const given: Map<string, number> = new Map();

  read((held, name) => {
    const before = given.get(name) ?? 0;

    given.set(name, before + 1);
    fields[before === 0 ? name : `${name} #${before + 1}`] = held;
  });

  return keepBuilt(fields);
}

function bufferSize(prototype: object, value: object): Fields {
  return keepBuilt({ byteLength: builtinValue(prototype, "byteLength", value) });
}

function viewBounds(value: DataView): Fields {
  return keepBuilt({
    byteLength: builtinValue(DataView.prototype, "byteLength", value),
    byteOffset: builtinValue(DataView.prototype, "byteOffset", value),
  });
}

/**
 * What a built-in getter holds for this value, read off the prototype rather than off the value, so
 * a subclass that shadowed the name cannot run its own code while a tree is written. Each buffer
 * class hands in its own prototype: these getters check the internal slot and throw outright on a
 * value of the other class.
 */
function builtinValue(prototype: object, key: string, value: object): unknown {
  return Object.getOwnPropertyDescriptor(prototype, key)?.get?.call(value);
}

/** The primitive a wrapper holds, read through `valueOf` off the prototype for the same reason. */
function unboxed(prototype: object, value: Boxed): unknown {
  const read: unknown = Object.getOwnPropertyDescriptor(prototype, "valueOf")?.value;

  return typeof read === "function" ? read.call(value) : undefined;
}
