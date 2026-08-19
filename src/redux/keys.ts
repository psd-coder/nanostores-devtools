import { storeWord, type StoreType } from "../registry.ts";

/**
 * What a capped shape says it left out, so silence never reads as "this is all of it". Beside
 * `VALUE_KEY` because both are invented keys, and both writers, the tree and the converter, spell
 * the idea this one way.
 */
export const MORE_KEY = "…";

/**
 * The one key name invented in this design, and the tree spells a store's own value the same way,
 * so a developer reads one idea in one spelling. Parentheses cannot spell a JS name, so the key
 * never reads as one a binding could take, and jsan escapes only its own `$jsan`, so the parens
 * survive both ways.
 */
export const VALUE_KEY = "(value)";

/**
 * Which method answered, on an instance that published a reading of itself. Beside `VALUE_KEY`
 * because all three are invented keys, and apart from it because they name a different fact: a
 * number and a string can say different things about one object.
 */
export const VALUE_OF_KEY = "(valueOf)";

export const TO_STRING_KEY = "(toString)";

/**
 * A name with the store's type behind it, `$total [computed]`. Every key pointing at a store carries
 * one, in the tree and inside a value alike, so a store reads the same wherever it is drawn.
 *
 * A throttled store says so in the same brackets, `$frame [store, throttled]`, because a developer
 * counting fewer rows than writes has to be able to see why from the tree. The word comes and goes
 * with the throttling itself, so a key changes shape around a burst.
 */
export function noted(name: string, type: StoreType, throttled = false): string {
  return `${name} [${storeWord(type)}${throttled ? ", throttled" : ""}]`;
}
