import type { Fields } from "./descriptor.ts";

/** What a width cap let through, and how many members it left behind. */
export type Shortened<TDrawn> = { drawn: TDrawn; skipped: number };

/**
 * How the caller keeps an entry whose key has no name in the source to spell. The key is as much
 * state as the value is and a view may not lose it, so the pair goes back whole to whoever knows
 * the shape it leaves in.
 */
export type Pairing = (key: unknown, member: unknown) => unknown;

/**
 * Both collections are read through the built-in `forEach` called against the value rather than
 * through a method of the value's own, so a subclass that overrode iteration cannot run its code
 * while a tree is written.
 */
export function setMembers(value: Set<unknown>, upTo: number): Shortened<unknown[]> {
  const drawn: unknown[] = [];
  let skipped = 0;

  Set.prototype.forEach.call(value, (member: unknown) => {
    if (drawn.length < upTo) {
      drawn.push(member);
    } else {
      skipped += 1;
    }
  });

  return { drawn, skipped };
}

/**
 * One key per entry, spelled the way the tree spells a `Map` key, `["scratch"]`. A key that is
 * neither a string nor a number has no name in the source to spell, so its entry goes to `pair`,
 * which is where the view keeps jsan's own shape, `[entry 0]: { "[key]": …, "[value]": … }`: the
 * tree may leave such a member out of a placement but a value may not.
 */
export function mapEntries(
  value: Map<unknown, unknown>,
  upTo: number,
  pair: Pairing,
): Shortened<Fields> {
  const drawn: Fields = {};
  let index = 0;
  let skipped = 0;

  Map.prototype.forEach.call(value, (member: unknown, key: unknown) => {
    if (index >= upTo) {
      skipped += 1;
      index += 1;

      return;
    }

    if (typeof key === "string" || typeof key === "number") {
      drawn[`[${JSON.stringify(key)}]`] = member;
    } else {
      drawn[`[entry ${index}]`] = pair(key, member);
    }

    index += 1;
  });

  return { drawn, skipped };
}
