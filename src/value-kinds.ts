import { chainDescriptor, ownFields } from "./descriptor.ts";

/** What a value walk goes into: an object or an array. A function is not one, whatever it holds. */
export function isWalkable(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * The values held one level down. A `Map` and a `Set` hand back their keys, their values and their
 * members, which are the app's; every other shape is read through its own fields, so no getter of
 * the app's runs while a walk chooses where to go next.
 */
export function childValues(value: unknown): unknown[] {
  if (!isWalkable(value)) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (value instanceof Map) {
    return [...value.keys(), ...value.values()];
  }

  if (value instanceof Set) {
    return [...value];
  }

  return Object.values(ownFields(value));
}

/**
 * Throws on a value that will not let its keys be listed, before anything hands it on. Two reads
 * sit behind it. Whoever walks the value lists its keys, and a `Proxy` trap that throws there is
 * outside the guard around one value, so it would take the whole write down. And the copy a plain
 * object and an array go out as answers a refusal with nothing at all, so without this call a value
 * that refused would draw as one that held nothing. Asking here costs one listing and leaves the
 * refusal where every other bad value lands: one slot.
 */
export function refuseUnlistable(value: object): void {
  Object.keys(value);
}

/**
 * What built the value, read through the descriptor so a getter the app put on `constructor` or on
 * the function's own `name` never runs. The value's own `constructor` comes first, which keeps
 * `this.constructor = Foo` written by hand working, and the prototype's is where a class puts it, so
 * reading own properties alone would lose every label.
 */
export function constructorName(value: object, fallback: string): string {
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
export function isTypedArray(value: object): value is ArrayLike<number | bigint> {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/**
 * `instanceof` reads no property off the value, so no getter of the app's can run here.
 *
 * A node is drawn by what its class published rather than by what it holds, and telling it apart is
 * what skips the own-data reading. A framework parks its own state on a node as an own enumerable
 * property, React's fiber above all, so without this test the class-instance rule would walk a
 * whole render tree out of one element.
 */
export function isDomNode(value: object): boolean {
  return typeof Node !== "undefined" && value instanceof Node;
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
export function stackDescriptor(
  error: Error,
  headerIsSafe: boolean,
): PropertyDescriptor | undefined {
  const own = Object.getOwnPropertyDescriptor(error, "stack");

  if (!own) {
    return chainDescriptor(error, "stack");
  }

  if ("value" in own) {
    return own;
  }

  return own.get && headerIsSafe ? { value: own.get.call(error) } : undefined;
}
