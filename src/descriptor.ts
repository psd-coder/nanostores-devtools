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
