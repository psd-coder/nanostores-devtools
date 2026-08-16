import { decode } from "@jridgewell/sourcemap-codec";
import { describe, expect, it } from "vitest";

import { loadParser } from "./parser.ts";
import type { CreationSite } from "./runtime.ts";
import { type StoreTransform, type TransformInput, transformStores } from "./transform.ts";

const MODULE_KEY = "src/stores/cart.ts";
const parser = await loadParser();

/** Everything the transform takes but the source itself, which every test writes for itself. */
type Overrides = Partial<Omit<TransformInput, "code">>;

function transform(code: string, overrides: Overrides = {}): StoreTransform {
  return transformStores({
    code,
    moduleKey: MODULE_KEY,
    home: MODULE_KEY,
    external: false,
    maxStoresPerSite: 50,
    adoptFactories: true,
    parser,
    ...overrides,
  });
}

/** The emitted meta is flat JSON, so the sites the walk found read back out of the output. */
function sites(code: string): string[] {
  return [...code.matchAll(/\{"name":[^}]*\}/g)].map(([json]) => json);
}

function metas(result: StoreTransform): CreationSite[] {
  return result.changed ? sites(result.code).map((json) => JSON.parse(json) as CreationSite) : [];
}

function changed(result: StoreTransform): Extract<StoreTransform, { changed: true }> {
  if (!result.changed) {
    throw new Error("the transform changed nothing");
  }

  return result;
}

function output(result: StoreTransform): string {
  return changed(result).code;
}

/** The one line the binding scan adds, which the transform appends after the module's own body. */
function ownCall(result: StoreTransform): string | undefined {
  return output(result)
    .split("\n")
    .find((line) => line.startsWith("__nsdt.own("));
}

describe("the pre-parse test", () => {
  const FACTORY_CALL =
    `import { createPanel } from "./panel.ts";\n` + `export const panel = createPanel();\n`;

  it("parses a file that imports no nanostores and binds no $ name", () => {
    const result = transform(FACTORY_CALL);

    expect(output(result)).toContain(
      `__nsdt.end((__nsdt.begin(), createPanel()), ` +
        `{"name":"panel","fn":null,"line":2,"type":"unknown"})`,
    );
    expect(ownCall(result)).toBe(`__nsdt.own([["panel", panel, true]]);`);
  });

  it("reaches a file whose only store sits in an unenumerable holder", () => {
    const result = transform(
      `import { Editor } from "./editor.ts";\nconst hidden = new WeakMap([[{}, new Editor()]]);\n`,
    );

    expect(output(result)).toContain(
      `__nsdt.end((__nsdt.begin(), new WeakMap([[{}, new Editor()]])), {"name":"hidden"`,
    );
    expect(ownCall(result)).toBe(`__nsdt.own([["hidden", hidden, false]]);`);
  });

  it("leaves a file that binds nothing at the top level alone, though it parses it", () => {
    const result = transform(
      `import { useStore } from "@nanostores/react";\n` +
        `export function Cart() {\n  return useStore($cart);\n}\n`,
    );

    expect(result.changed).toBe(false);
  });

  it("leaves a file that imports nanostores and makes no store alone", () => {
    const result = transform(`import { onMount } from "nanostores";\nonMount($cart, () => {});\n`);

    expect(result.changed).toBe(false);
  });

  it("still clears for a file whose last store an edit took away", () => {
    const result = transform(`import { atom } from "nanostores";\nexport const cart = {};\n`);

    expect(output(result)).toContain("__nsdt.clear();");
    expect(metas(result)).toEqual([]);
  });

  it("leaves a file it cannot parse alone", () => {
    const result = transform(`import { atom } from "nanostores";\nconst $c = atom(;\n`);

    expect(result.changed).toBe(false);
  });
});

describe("callee matching", () => {
  it("wraps a store declared at module top level, in place", () => {
    const result = transform(`import { atom } from "nanostores";\nexport const $c = atom(0);\n`);

    expect(output(result)).toContain(
      `export const $c = __nsdt.store(atom(0), {"name":"$c","fn":null,"line":2,"type":"atom"});`,
    );
  });

  it("matches a renamed import", () => {
    const result = transform(
      `import { atom as a, computed as c } from "nanostores";\n` +
        `const $one = a(0);\n` +
        `const $two = c($one, (value) => value);\n`,
    );

    expect(metas(result)).toEqual([
      { name: "$one", fn: null, line: 2, type: "atom" },
      { name: "$two", fn: null, line: 3, type: "computed" },
    ]);
  });

  it("gives every creator its own type and leaves the rest of the import alone", () => {
    const result = transform(
      `import { atom, map, deepMap, computed, batched, onMount } from "nanostores";\n` +
        `const $a = atom(0);\n` +
        `const $m = map({});\n` +
        `const $d = deepMap({});\n` +
        `const $c = computed($a, (value) => value);\n` +
        `const $b = batched($a, (value) => value);\n` +
        `onMount($a, () => {});\n`,
    );

    expect(metas(result).map((meta) => meta.type)).toEqual([
      "atom",
      "map",
      "deepMap",
      "computed",
      "batched",
    ]);
  });

  it("takes no name from a type-only import", () => {
    const source = `import type { atom } from "nanostores";\nconst $c = atom(0);\n`;

    expect(output(transform(source, { adoptFactories: false }))).not.toContain("__nsdt.adopt(");
    expect(output(transform(source))).toContain(
      `__nsdt.adopt(atom(0), {"name":"$c","fn":null,"line":2,"type":"unknown"})`,
    );
  });

  it("names an object property, a class field and an array element", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `export const stores = { $count: atom(0) };\n` +
        `export class Cart {\n` +
        `  $items = atom([]);\n` +
        `}\n` +
        `export const list = [atom(1), atom(2)];\n`,
    );

    expect(metas(result).map((meta) => meta.name)).toEqual([
      "$count",
      "$items",
      "list[0]",
      "list[1]",
    ]);
  });

  it("instruments a store inside a factory, a loop, a block and a method", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `export function makeCart() {\n` +
        `  const $items = atom([]);\n` +
        `  return $items;\n` +
        `}\n` +
        `for (const key of keys) {\n` +
        `  const $each = atom(key);\n` +
        `}\n` +
        `{\n` +
        `  const $blocked = atom(0);\n` +
        `}\n` +
        `class Cart {\n` +
        `  load() {\n` +
        `    const $inside = atom(0);\n` +
        `  }\n` +
        `}\n`,
    );

    expect(metas(result)).toEqual([
      { name: "$items", fn: "makeCart", line: 3, type: "atom" },
      { name: "$each", fn: null, line: 7, type: "atom" },
      { name: "$blocked", fn: null, line: 10, type: "atom" },
      { name: "$inside", fn: "load", line: 14, type: "atom" },
    ]);
  });

  it("names an anonymous function after the declarator, property or method around it", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `const makeCart = () => {\n` +
        `  const $items = atom([]);\n` +
        `  return $items;\n` +
        `};\n` +
        `const factories = {\n` +
        `  cart: function () {\n` +
        `    const $cart = atom(0);\n` +
        `    return $cart;\n` +
        `  },\n` +
        `};\n`,
    );

    expect(metas(result).map((meta) => meta.fn)).toEqual(["makeCart", "cart"]);
  });

  it("leaves a store a function returns unnamed, because one line makes them all", () => {
    const result = transform(
      `import { map } from "nanostores";\n` +
        `export function makeUser(name) {\n` +
        `  return map({ name });\n` +
        `}\n`,
    );

    expect(metas(result)).toEqual([{ name: null, fn: "makeUser", line: 3, type: "map" }]);
  });

  it("skips a creation site nested inside an already instrumented one", () => {
    const result = transform(
      `import { atom, computed } from "nanostores";\n` +
        `const $total = computed($items, () => atom(0));\n`,
    );

    expect(metas(result)).toEqual([{ name: "$total", fn: null, line: 2, type: "computed" }]);
  });

  it("instruments nothing for a namespace import and warns once for the file", () => {
    const source = `import * as ns from "nanostores";\nconst $c = ns.atom(0);\n`;
    const result = transform(source);

    expect(output(transform(source, { adoptFactories: false }))).not.toContain("__nsdt.adopt(");
    expect(output(result)).toContain(
      `__nsdt.adopt(ns.atom(0), {"name":"$c","fn":null,"line":2,"type":"unknown"})`,
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(MODULE_KEY);
  });
});

describe("`this` in a class field", () => {
  it("hands a store made in an instance field the instance that holds it", () => {
    const result = transform(
      `import { atom } from "nanostores";\nclass Editor {\n  $value = atom("");\n}\n`,
    );

    expect(output(result)).toContain(
      `$value = __nsdt.store(atom(""), {"name":"$value","fn":null,"line":3,"type":"atom"}, this);`,
    );
  });

  it("hands a static field the very same `this`, which is the class itself", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `class Editor {\n` +
        `  static $opened = atom(false);\n` +
        `  $value = atom("");\n` +
        `}\n`,
    );

    expect(output(result)).toContain(
      `static $opened = __nsdt.store(atom(false), ` +
        `{"name":"$opened","fn":null,"line":3,"type":"atom"}, this);`,
    );
    expect(output(result)).toContain(
      `$value = __nsdt.store(atom(""), {"name":"$value","fn":null,"line":4,"type":"atom"}, this);`,
    );
  });

  it("reaches a private field, which no property walk can see", () => {
    const result = transform(
      `import { atom } from "nanostores";\nclass Editor {\n  #hidden = atom(0);\n}\n`,
    );

    expect(output(result)).toContain(
      `#hidden = __nsdt.store(atom(0), {"name":"#hidden","fn":null,"line":3,"type":"atom"}, this);`,
    );
  });

  it("keeps `this` through an arrow inside a field, which shares the instance's own", () => {
    const result = transform(
      `import { atom } from "nanostores";\nclass Editor {\n  make = () => atom(0);\n}\n`,
    );

    expect(output(result)).toContain(
      `__nsdt.store(atom(0), {"name":null,"fn":"make","line":3,"type":"atom"}, this)`,
    );
  });

  it("stops at a function inside a field, which has a `this` of its own", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `class Editor {\n  make = function () {\n    return atom(0);\n  };\n}\n`,
    );

    expect(output(result)).not.toContain(", this)");
  });

  it("leaves a store made in a method body alone, which is one per call, not per field", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `class Editor {\n  load() {\n    const $each = atom(0);\n  }\n}\n`,
    );

    expect(output(result)).not.toContain(", this)");
  });

  it("leaves a field with a computed key alone, whose key runs outside the class", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `class Editor {\n  [key(atom(0))] = 1;\n  [name] = atom("");\n}\n`,
    );

    expect(output(result)).not.toContain(", this)");
  });

  it("leaves an object property alone, whose `this` is nothing of the sort", () => {
    const result = transform(
      `import { atom } from "nanostores";\nconst stores = { $count: atom(0) };\n`,
    );

    expect(output(result)).not.toContain(", this)");
  });

  it("leaves a store at module level alone, where there is no `this` to hand over", () => {
    const result = transform(`import { atom } from "nanostores";\nconst $c = atom(0);\n`);

    expect(output(result)).not.toContain(", this)");
  });
});

describe("adoption", () => {
  it("wraps a $-named binding assigned from a call it did not instrument", () => {
    const result = transform(
      `import { persistentAtom } from "@nanostores/persistent";\n` +
        `export const $theme = persistentAtom("theme", "dark");\n`,
    );

    expect(output(result)).toContain(
      `__nsdt.adopt(persistentAtom("theme", "dark"), ` +
        `{"name":"$theme","fn":null,"line":2,"type":"unknown"})`,
    );
  });

  /** The wide gate still frames the call and lists the binding: only adoption stays out of it. */
  it("adopts no binding without a $", () => {
    const result = transform(`const theme = persistentAtom("theme", "dark");\n`);

    expect(output(result)).not.toContain("__nsdt.adopt(");
    expect(ownCall(result)).toBe(`__nsdt.own([["theme", theme, false]]);`);
  });

  it("leaves a call callee matching already wrapped alone", () => {
    const result = transform(`import { atom } from "nanostores";\nconst $c = atom(0);\n`);

    expect(output(result)).not.toContain("__nsdt.adopt(");
    expect(metas(result)).toEqual([{ name: "$c", fn: null, line: 2, type: "atom" }]);
  });

  /**
   * The store the call hands back takes the binding, and the one written inside it is numbered.
   * A wrapper that hands its own argument back meets both, and the second renames the first, which
   * is what keeps the type the creator knew.
   */
  it("numbers the creator inside a call and keeps the binding for what the call returns", () => {
    const result = transform(
      `import { atom } from "nanostores";\nconst $c = withLogging(atom(0));\n`,
    );

    expect(output(result)).toContain(
      `__nsdt.store(atom(0), {"name":"$c unassigned 1","fn":null,"line":2,"type":"atom"})`,
    );
    expect(output(result)).toContain(
      `__nsdt.adopt(withLogging(__nsdt.store(atom(0), ` +
        `{"name":"$c unassigned 1","fn":null,"line":2,"type":"atom"})), ` +
        `{"name":"$c","fn":null,"line":2,"type":"unknown"})`,
    );
  });

  it("still takes the binding when the call is handed a store under another name", () => {
    const result = transform(
      `import { atom } from "nanostores";\nconst $store = createStore({ initial: atom(0) });\n`,
    );

    expect(output(result)).toContain(
      `{"name":"initial","fn":null,"line":2,"type":"atom"}) }), ` +
        `{"name":"$store","fn":null,"line":2,"type":"unknown"})`,
    );
  });

  /**
   * A call standing in an argument is adopted too. What it hands back is the developer's, and on a
   * util that builds a store of its own it is the only thing that ever reaches it: `filtered(...)`
   * and `latched(...)` in the examples each hold a `computed` written right there.
   */
  it("adopts a call standing in an argument, numbered after the binding", () => {
    const result = transform(`const $theme = persistent(fallback("dark"));\n`);

    expect(output(result)).toContain(
      `__nsdt.adopt(persistent(__nsdt.adopt(fallback("dark"), ` +
        `{"name":"$theme unassigned 1","fn":null,"line":1,"type":"unknown"})), ` +
        `{"name":"$theme","fn":null,"line":1,"type":"unknown"})`,
    );
  });

  it("numbers two calls in one initializer in source order, so neither takes the other's label", () => {
    const result = transform(`const $pair = combine(fallback("a"), fallback("b"));\n`);

    expect(output(result)).toContain(
      `{"name":"$pair unassigned 1","fn":null,"line":1,"type":"unknown"}`,
    );
    expect(output(result)).toContain(
      `{"name":"$pair unassigned 2","fn":null,"line":1,"type":"unknown"}`,
    );
  });

  it("keeps the index where the array is the value the binding holds", () => {
    const result = transform(
      `import { atom } from "nanostores";\nconst $totals = [atom(0), atom(1)];\n`,
    );

    expect(metas(result)).toEqual([
      { name: "$totals[0]", fn: null, line: 2, type: "atom" },
      { name: "$totals[1]", fn: null, line: 2, type: "atom" },
    ]);
  });

  /** `$pointerEnd` is the atom `merged` built, and it holds no member at `[0]` to point at. */
  it("numbers an array's members where the array only stands in an argument", () => {
    const result = transform(
      `import { atom } from "nanostores";\nconst $pointerEnd = merged([atom(0), atom(1)]);\n`,
    );

    expect(metas(result)).toEqual([
      { name: "$pointerEnd unassigned 1", fn: null, line: 2, type: "atom" },
      { name: "$pointerEnd unassigned 2", fn: null, line: 2, type: "atom" },
      { name: "$pointerEnd", fn: null, line: 2, type: "unknown" },
      { name: "$pointerEnd", fn: null, line: 2, type: "unknown" },
    ]);
  });

  it("names an object property, a class field and an array element", () => {
    const result = transform(
      `export const stores = { $count: persistentAtom("count") };\n` +
        `export class Cart {\n` +
        `  $items = persistentAtom("items");\n` +
        `}\n` +
        `export const $list = [persistentAtom("a"), persistentAtom("b")];\n`,
    );

    expect(metas(result).map((meta) => meta.name)).toEqual([
      "$count",
      "$items",
      "$list[0]",
      "$list[1]",
    ]);
  });

  it("takes the enclosing function, so two lines making one name stay apart", () => {
    const result = transform(
      `export function makeCart() {\n  const $items = persistentAtom("items");\n}\n`,
    );

    expect(metas(result)).toEqual([{ name: "$items", fn: "makeCart", line: 2, type: "unknown" }]);
  });

  it("skips a $ binding nested inside an instrumented creation site", () => {
    const result = transform(
      `import { computed } from "nanostores";\n` +
        `const $total = computed($items, () => {\n` +
        `  const $tmp = persistentAtom("tmp");\n` +
        `  return 1;\n` +
        `});\n`,
    );

    expect(metas(result)).toEqual([{ name: "$total", fn: null, line: 2, type: "computed" }]);
  });

  it("is turned off by adoptFactories, and callee matching keeps working", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `const $a = atom(0);\n` +
        `const $b = persistentAtom("b");\n`,
      { adoptFactories: false },
    );

    expect(output(result)).not.toContain("__nsdt.adopt(");
    expect(output(result)).toContain(
      `__nsdt.store(atom(0), {"name":"$a","fn":null,"line":2,"type":"atom"})`,
    );
  });

  it("reads through a type annotation between the name and the call", () => {
    const result = transform(`export const $router: Router = createRouter({ home: "/" });\n`);

    expect(output(result)).toContain(
      `__nsdt.adopt(createRouter({ home: "/" }), ` +
        `{"name":"$router","fn":null,"line":1,"type":"unknown"})`,
    );
  });

  it("reads through parentheses around the call, and through a cast over them", () => {
    const result = transform(
      `export const $theme = (persistentAtom("theme", "dark"));\n` +
        `export const $router = (createRouter({ home: "/" })) as Router;\n`,
    );

    expect(output(result)).toContain(
      `__nsdt.adopt(persistentAtom("theme", "dark"), ` +
        `{"name":"$theme","fn":null,"line":1,"type":"unknown"})`,
    );
    expect(output(result)).toContain(
      `__nsdt.adopt(createRouter({ home: "/" }), ` +
        `{"name":"$router","fn":null,"line":2,"type":"unknown"})`,
    );
  });

  it("keeps the name of a parenthesized object property and array element", () => {
    const result = transform(
      `export const stores = { $count: (persistentAtom("count")) };\n` +
        `export const $list = [(persistentAtom("a"))];\n`,
    );

    expect(metas(result).map((meta) => meta.name)).toEqual(["$count", "$list[0]"]);
  });

  it("adopts no parenthesized call callee matching already named", () => {
    const result = transform(`import { atom } from "nanostores";\nconst $c = (atom(0));\n`);

    expect(output(result)).not.toContain("__nsdt.adopt(");
    expect(metas(result)).toEqual([{ name: "$c", fn: null, line: 2, type: "atom" }]);
  });

  it("gives a file that only adopts the same header, so a reload clears it", () => {
    const result = transform(`const $theme = persistentAtom("theme", "dark");\n`);

    expect(output(result)).toContain("__nsdt.clear();");
  });
});

describe("the binding scan", () => {
  it("lists the module's top-level bindings at the end of its body", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `export const $draft = atom("");\n` +
        `const model = makeModel();\n` +
        `let pending;\n`,
    );

    expect(
      output(result)
        .trimEnd()
        .endsWith(
          `__nsdt.own([["$draft", $draft, true], ["model", model, false], ` +
            `["pending", pending, false]]);`,
        ),
    ).toBe(true);
  });

  it("marks which bindings the developer exported, so the exported one can name a store", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `const $typed = atom("");\n` +
        `export const $value = $typed;\n` +
        `const $alias = $typed;\n`,
    );

    expect(ownCall(result)).toBe(
      `__nsdt.own([["$typed", $typed, false], ["$value", $value, true], ` +
        `["$alias", $alias, false]]);`,
    );
  });

  it("marks a binding an export list names, and not one a type or a re-export names", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `const $typed = atom("");\n` +
        `const $only = atom(0);\n` +
        `const $shared = atom(1);\n` +
        `export { $typed };\n` +
        `export type { $only };\n` +
        `export { $shared } from "./other.ts";\n`,
    );

    expect(ownCall(result)).toBe(
      `__nsdt.own([["$typed", $typed, true], ["$only", $only, false], ` +
        `["$shared", $shared, false]]);`,
    );
  });

  it("leaves the module's own last line where it was", () => {
    const code = output(transform(`import { atom } from "nanostores";\nconst $c = atom(0);\n`));

    expect(code.indexOf("__nsdt.own(")).toBeGreaterThan(code.indexOf("__nsdt.store("));
    expect(code.split("\n")[1]).toContain(`import { atom } from "nanostores"`);
  });

  it("skips an ambient declaration, which binds nothing once the types are stripped", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `declare const $ambientOnly: Store<number>;\n` +
        `export declare const $alsoAmbient: Store<number>;\n` +
        `const $real = atom(0);\n`,
    );

    expect(ownCall(result)).toBe(`__nsdt.own([["$real", $real, false]]);`);
  });

  it("leaves a destructured binding out", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `const { $one, $two } = makePair();\n` +
        `const [$first] = makeList();\n` +
        `const $plain = atom(0);\n`,
    );

    expect(ownCall(result)).toBe(`__nsdt.own([["$plain", $plain, false]]);`);
  });

  it("leaves out an import, a class, a function and a binding inside a block", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `import { $shared } from "./other.ts";\n` +
        `export class Editor {}\n` +
        `export function makeEditor() {\n  const $inner = atom(0);\n  return $inner;\n}\n` +
        `for (const key of keys) {\n  const $each = atom(key);\n}\n` +
        `const $own = atom(0);\n`,
    );

    expect(ownCall(result)).toBe(`__nsdt.own([["$own", $own, false]]);`);
  });

  it("still parses when the module's last line is a comment that ends the file", () => {
    const result = transform(
      `import { atom } from "nanostores";\nconst $c = atom(0);\n// no newline after this`,
    );

    expect(parser.parseSync(MODULE_KEY, output(result)).errors).toEqual([]);
  });

  it("says nothing for a file with no top-level binding", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` + `export class Editor {\n  $value = atom("");\n}\n`,
    );

    expect(output(result)).not.toContain("__nsdt.own(");
  });
});

describe("the creation frame", () => {
  const IMPORT = `import { atom } from "nanostores";\n`;

  /** What one frame opens with, which is the same text for every initializer it wraps. */
  const OPENED = "__nsdt.end((__nsdt.begin(), ";

  function frames(result: StoreTransform): number {
    return output(result).split(OPENED).length - 1;
  }

  it("wraps a top-level initializer that calls something we did not instrument", () => {
    const result = transform(`${IMPORT}const $draft = pipe(atom(""), withUndo());\n`);

    expect(output(result)).toContain(
      `const $draft = ${OPENED}__nsdt.adopt(pipe(__nsdt.store(atom(""), ` +
        `{"name":"$draft unassigned 1","fn":null,"line":2,"type":"atom"}), ` +
        `__nsdt.adopt(withUndo(), ` +
        `{"name":"$draft unassigned 2","fn":null,"line":2,"type":"unknown"})), ` +
        `{"name":"$draft","fn":null,"line":2,"type":"unknown"})), ` +
        `{"name":"$draft","fn":null,"line":2,"type":"unknown"});`,
    );
  });

  it("wraps a `new`, whose fields and closures are made while it runs", () => {
    const result = transform(`${IMPORT}const $c = atom(0);\nconst editorOne = new Editor();\n`);

    expect(output(result)).toContain(
      `const editorOne = ${OPENED}new Editor()), ` +
        `{"name":"editorOne","fn":null,"line":3,"type":"unknown"});`,
    );
  });

  it("stands outside the adopt call around the same initializer", () => {
    const result = transform(`const $theme = persistentAtom("theme", "dark");\n`);
    const site = `{"name":"$theme","fn":null,"line":1,"type":"unknown"}`;

    expect(output(result)).toContain(
      `const $theme = ${OPENED}__nsdt.adopt(persistentAtom("theme", "dark"), ${site})), ${site});`,
    );
  });

  it("opens none around a plain creator, which makes the one store the wrap names", () => {
    const result = transform(
      `import { atom, computed } from "nanostores";\n` +
        `const $c = atom(0);\n` +
        `const $t = computed($c, (value) => value);\n`,
    );

    expect(frames(result)).toBe(0);
  });

  it("looks through a cast, which a test on the node type alone sees no call behind", () => {
    const result = transform(
      `${IMPORT}const $c = atom(0);\n` +
        `const $one = pipe($c) as Draft;\n` +
        `const $two = pipe($c) satisfies Draft;\n` +
        `const $three = pipe($c)!;\n` +
        `const four = (pipe($c));\n`,
    );

    expect(frames(result)).toBe(4);
  });

  it("opens no frame around an await, and still lists the module's bindings", () => {
    const result = transform(
      `${IMPORT}const $c = atom(0);\nconst $remote = withUndo(await load());\n`,
    );

    expect(frames(result)).toBe(0);
    expect(ownCall(result)).toBe(`__nsdt.own([["$c", $c, false], ["$remote", $remote, false]]);`);
  });

  it("keeps the frame around a sibling initializer the await never reached", () => {
    const result = transform(
      `${IMPORT}const $c = atom(0);\n` +
        `const remote = load(await ready());\n` +
        `const model = makeModel();\n`,
    );

    expect(frames(result)).toBe(1);
    expect(output(result)).toContain(`const model = ${OPENED}makeModel()`);
  });

  it("opens none for a destructured binding, which no one name holds", () => {
    const result = transform(`${IMPORT}const $c = atom(0);\nconst { $one } = makePair();\n`);

    expect(frames(result)).toBe(0);
  });

  it("opens none for a binding that stands inside a function", () => {
    const result = transform(
      `${IMPORT}const $c = atom(0);\nfunction make() {\n  const held = makeModel();\n}\n`,
    );

    expect(frames(result)).toBe(0);
  });

  it("opens none for an ambient declaration, which binds nothing at all", () => {
    const result = transform(`${IMPORT}const $c = atom(0);\ndeclare const model: Model;\n`);

    expect(frames(result)).toBe(0);
  });

  it("leaves the file it emits parsable", () => {
    const result = transform(`${IMPORT}const $draft = pipe(atom(""), withUndo()) as Draft;\n`);

    expect(parser.parseSync(MODULE_KEY, output(result)).errors).toEqual([]);
  });
});

describe("the injected header", () => {
  const source = `import { atom } from "nanostores";\nexport const $c = atom(0);\n`;

  it("is the first thing in the module body and clears the module's own stores", () => {
    const code = output(transform(source));

    expect(code.split("\n")[0]).toContain(`from "nanostores-devtools/vite/runtime"`);
    expect(code.indexOf("__nsdt.clear()")).toBeLessThan(code.indexOf("__nsdt.store("));
  });

  it("clears the module's stores again when the file is deleted", () => {
    expect(output(transform(source)).split("\n")[0]).toContain(
      "import.meta.hot.prune(() => { __nsdt.clear(); })",
    );
  });

  it("carries the module key, the home, the per-site cap and where the file sits", () => {
    const result = transform(source, { home: "stores", maxStoresPerSite: 25 });

    expect(output(result)).toContain(`__nsdtFileScope("src/stores/cart.ts", "stores", 25, false)`);
  });

  it("carries the external flag the plugin passed, because no path spelling says it", () => {
    const result = transform(source, {
      home: "node_modules/nanobots/dist/index.js",
      external: true,
    });

    expect(output(result)).toContain(`"node_modules/nanobots/dist/index.js", 50, true)`);
  });

  it("writes Infinity as a number the runtime reads back as no cap", () => {
    const result = transform(source, { maxStoresPerSite: Number.POSITIVE_INFINITY });

    expect(output(result)).toContain(`"src/stores/cart.ts", Infinity, false)`);
  });

  it("leaves the module body on the next line, so nothing before it moves", () => {
    expect(output(transform(source)).split("\n")[1]).toContain(`import { atom } from "nanostores"`);
  });
});

describe("the source map", () => {
  const source = `import { atom } from "nanostores";\nexport const $c: Store<number> = atom(0);\n`;

  it("holds the clean file name and the original source", () => {
    const { map } = changed(transform(source));

    expect(map.sources).toEqual([MODULE_KEY]);
    expect(map.sourcesContent).toEqual([source]);
  });

  it("maps a generated line back to the original line it came from", () => {
    const mappings = decode(changed(transform(source)).map.mappings);

    /** The header is one line, so the module's own first line is generated line 2. */
    expect(mappings[1]?.[0]?.[2]).toBe(0);
    expect(mappings[2]?.[0]?.[2]).toBe(1);
  });
});
