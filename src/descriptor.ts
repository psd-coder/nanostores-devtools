export type Fields = Record<string, unknown>;

/**
 * Own enumerable string keys that hold data. A getter can run app code, so it is skipped rather
 * than called, and a symbol key is skipped rather than walked.
 */
export function ownFields(value: object): Fields {
  const fields: Fields = {};

  for (const key of Object.keys(value)) {
    copyData(fields, key, Object.getOwnPropertyDescriptor(value, key));
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

/** The first descriptor for `key` on the value itself or anywhere up its prototype chain. */
export function chainDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  let holder: object | null = value;

  while (holder !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);

    if (descriptor) {
      return descriptor;
    }

    holder = Object.getPrototypeOf(holder);
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
