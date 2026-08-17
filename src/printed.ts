import { chainDescriptor, type Fields } from "./descriptor.ts";
import { TO_STRING_KEY, VALUE_OF_KEY } from "./marker.ts";

/**
 * What a class wrote down about how its instances read: a `valueOf` and a `toString` of its own,
 * each answer under a key naming the method that gave it. A `URL` and a `Location` answer with
 * their address this way, and an event, a `Blob` and an `AbortSignal` fall to `Object.prototype`
 * and answer nothing, so the class decides for itself.
 *
 * Calling a method here runs the app's own code, which is why every step of it is a bound. The
 * method is found through a descriptor, so an accessor is refused the way every other read refuses
 * one. `Object.prototype.valueOf` hands the object straight back and `Object.prototype.toString`
 * gives `[object X]`, so both are refused by identity. Each call sits in its own `try`, and only a
 * primitive answer is kept.
 *
 * `(valueOf)` is written first, because the panel never sorts keys and written order is read order.
 */
export function printedFields(value: object): Fields {
  const fields: Fields = {};

  keepReading(fields, value, "valueOf", VALUE_OF_KEY, Object.prototype.valueOf);
  keepReading(fields, value, "toString", TO_STRING_KEY, Object.prototype.toString);

  return fields;
}

function keepReading(
  fields: Fields,
  value: object,
  name: string,
  key: string,
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
      fields[key] = read;
    }
  } catch {
    /** One key gives up, and the other one and the class name still reach the panel. */
  }
}

/** A `valueOf` may hand back anything, and only a primitive is a reading. `null` says nothing. */
function isReading(read: unknown): boolean {
  return (
    read !== null && read !== undefined && typeof read !== "object" && typeof read !== "function"
  );
}
