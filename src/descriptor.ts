export type Fields = Record<string, unknown>;

/**
 * Own enumerable string keys that hold state. A getter can run app code, so it is skipped rather
 * than called, a symbol key is skipped rather than walked, and a method is left out.
 *
 * Listing the keys and reading each descriptor are both trapped on a `Proxy`, and a trap of the
 * app's may throw instead of answering. A value that refuses gives up nothing at all, half an
 * object being worse to read than none, and the caller keeps running.
 */
export function ownFields(value: object): Fields {
  const fields: Fields = {};

  try {
    for (const key of Object.keys(value)) {
      copyData(fields, key, Object.getOwnPropertyDescriptor(value, key));
    }
  } catch {
    return {};
  }

  return fields;
}

/**
 * A copy holding what the array's own index descriptors hold, so an accessor of the app's is passed
 * over rather than called and an index the array only inherits is left out. A refused index stays a
 * hole where it sits, so every other member keeps the position it really has. `length` is read
 * through its descriptor too: an array is the one shape a `Proxy` can sit in front of while
 * `Array.isArray` still says yes, and a `get` trap is the app's code like any other.
 *
 * Every read here is trapped on a `Proxy`, and a trap of the app's may throw instead of answering.
 * A value that refuses gives up nothing at all, the same answer `ownFields` gives, and the caller
 * keeps running.
 *
 * `upTo` is how many indices to look at, for a caller that caps its own walk: without it a
 * ten-million-slot array costs a full pass before the caller ever gets to stop. A caller that sends
 * the array on leaves it out, because every index it holds is one the panel draws.
 */
export function ownIndexes(value: readonly unknown[], upTo?: number): unknown[] {
  const size: unknown = chainValue(value, "length");

  if (typeof size !== "number") {
    return [];
  }

  const read = upTo === undefined ? size : Math.min(size, upTo);
  const copy: unknown[] = [];

  try {
    /** Inside the `try` like every other read: a `Proxy` may answer a length no array can have. */
    copy.length = read;

    for (let index = 0; index < read; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);

      if (descriptor && "value" in descriptor) {
        copy[index] = descriptor.value;
      }
    }
  } catch {
    return [];
  }

  return copy;
}

/**
 * An accessor is passed over rather than called, so its key never appears. A method is passed over
 * too: the panel draws state, and `toggle`, `add` and `remove` beside the stores they write say
 * nothing a reader of the source does not already know. A value that is itself a function is
 * untouched, because then the function is the state.
 */
export function copyData(
  fields: Fields,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor && "value" in descriptor && typeof descriptor.value !== "function") {
    fields[key] = descriptor.value;
  }
}

/**
 * The first descriptor for `key` on the value itself or anywhere up its prototype chain. Reading a
 * descriptor and stepping up the chain are both trapped on a `Proxy`, so a trap that throws leaves
 * the key answered with nothing rather than throwing into whoever asked.
 */
export function chainDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  let holder: object | null = value;

  try {
    while (holder !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(holder, key);

      if (descriptor) {
        return descriptor;
      }

      holder = Object.getPrototypeOf(holder);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * What the first descriptor for `key` holds, or nothing when it is an accessor. The nearest holder
 * wins even when it refuses, because a getter the app put on an instance is what a read would run,
 * whatever a prototype further up still has under the same name.
 */
export function chainValue(value: object, key: string): unknown {
  const descriptor = chainDescriptor(value, key);

  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}
