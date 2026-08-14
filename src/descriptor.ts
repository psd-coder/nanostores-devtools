export type Fields = Record<string, unknown>;

/**
 * Own enumerable string keys that hold data. A getter can run app code, so it is skipped rather
 * than called, and a symbol key is skipped rather than walked.
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

/** An accessor is passed over rather than called, so its key never appears. */
export function copyData(
  fields: Fields,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor && "value" in descriptor) {
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
