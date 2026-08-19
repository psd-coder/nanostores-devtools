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
