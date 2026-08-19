import { platformRules } from "../values/platform.ts";
import { box, keepBuilt, mark } from "./marker.ts";
import type { Serializer } from "./replacer.ts";

/**
 * The rules the bridge ships, as the panel reads them. A rule answers with what a platform class
 * holds and nothing about the wire, so the wrapper, the box and the note that this object is ours
 * are all added here: a set of fields goes under the mark bare, and the one value a boxed primitive
 * stands for goes under `(value)`, which is what makes a primitive `data` unwrap in the panel.
 *
 * The note matters as much as the wrapper. jsan walks whatever we hand back and brings every value
 * inside it here again, and without it a rule's own fields would be read as an object of the app's:
 * counted against the width cap and respelled a second time.
 */
export const shippedSerializers: Serializer[] = platformRules.map(({ match, read }) => ({
  match,
  convert: (value) => {
    const reading = read(value);

    return reading.kind === "fields"
      ? mark(reading.type, keepBuilt(reading.fields))
      : mark(reading.type, box(reading.value));
  },
}));
