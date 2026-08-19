import type { NameParts } from "./registry.ts";

/**
 * How a store's name is spelled out for a reader. The model calls these for `entry.label`, which is
 * the name the bridge's own console warnings print: a warning is the bridge speaking to a
 * developer, not the panel drawing, so the spelling belongs on this side.
 *
 * A view is welcome to call them, so that a tree key and a warning read the same parts in the same
 * order.
 */
export function makeLabel(home: string, name: string): string {
  return `${home}/${name}`;
}

/**
 * `$counter (a.ts, makeCart, line 12) #2`: a head, then everything that tells this store from
 * another one the same name was given. The file first, because it says where to look before the
 * line says where in the file, and the number last, spaced, so it never reads as part of the place.
 *
 * The head is a parameter so that one function spells the parts for every caller: whatever sits in
 * front of them, they arrive in one order.
 */
export function qualify(head: string, parts: NameParts): string {
  const group = groupOf(parts);
  const placed = group === null ? head : `${head} (${group})`;

  return parts.number > 1 ? `${placed} #${parts.number}` : placed;
}

function groupOf(parts: NameParts): string | null {
  if (parts.file === null) {
    return parts.place;
  }

  return parts.place === null ? parts.file : `${parts.file}, ${parts.place}`;
}
