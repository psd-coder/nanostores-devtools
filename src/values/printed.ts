import { chainDescriptor } from "./descriptor.ts";

/**
 * What a class published about itself, one answer per method. A key is present only where that
 * method answered with a primitive, so an absent key and a key holding `undefined` never mean two
 * different things.
 */
export type PublishedReading = { valueOf?: unknown; toString?: unknown };

/**
 * What a class wrote down about how its instances read: a `valueOf` and a `toString` of its own.
 * A `URL` and a `Location` answer with their address this way, and an event, a `Blob` and an
 * `AbortSignal` fall to `Object.prototype` and answer nothing, so the class decides for itself.
 *
 * Calling a method here runs the app's own code, which is why every step of it is a bound. The
 * method is found through a descriptor, so an accessor is refused the way every other read refuses
 * one. `Object.prototype.valueOf` hands the object straight back and `Object.prototype.toString`
 * gives `[object X]`, so both are refused by identity. Each call sits in its own `try`, and only a
 * primitive answer is kept.
 */
export function printedFields(value: object): PublishedReading {
  const reading: PublishedReading = {};

  keepReading(reading, value, "valueOf", Object.prototype.valueOf);
  keepReading(reading, value, "toString", Object.prototype.toString);

  return reading;
}

function keepReading(
  reading: PublishedReading,
  value: object,
  name: "valueOf" | "toString",
  inherited: unknown,
): void {
  const descriptor = chainDescriptor(value, name);

  if (descriptor === undefined || !("value" in descriptor)) {
    return;
  }

  const method: unknown = descriptor.value;

  if (typeof method !== "function" || method === inherited) {
    return;
  }

  try {
    const read: unknown = method.call(value);

    if (isReading(read)) {
      reading[name] = read;
    }
  } catch {
    /** One answer gives up, and the other one and the class name still reach the panel. */
  }
}

/** A `valueOf` may hand back anything, and only a primitive is a reading. `null` says nothing. */
function isReading(read: unknown): boolean {
  return (
    read !== null && read !== undefined && typeof read !== "object" && typeof read !== "function"
  );
}
