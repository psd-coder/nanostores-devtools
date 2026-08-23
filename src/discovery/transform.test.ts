import { decode } from "@jridgewell/sourcemap-codec";
import { describe, expect, it } from "vitest";

import { loadParser } from "./parser.ts";
import { resolveStoreTypes } from "./store-types.ts";
import type { CreationSite, FileScope, StoreType } from "../runtime.ts";
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
    storeTypes: resolveStoreTypes(undefined).types,
    parser,
    runtimeModule: "nanostores-devtools/runtime",
    hotReload: (clear) => `if (import.meta.hot) import.meta.hot.prune(() => { ${clear} });`,
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

/** Enough of the runtime to run a transformed file: every call hands its own value straight back. */
const runtime: FileScope = {
  store: (store) => store,
  adopt: (value) => value,
  own: () => {},
  begin: () => {},
  end: (value) => value,
  clear: () => {},
};

/**
 * What the transformed file evaluates to, so a test reads the developer's own semantics rather
 * than the text they were rewritten to. A module body is no function body, so every import line
 * is dropped, the injected header first among them, and the names the file imported are handed in
 * as arguments instead. So is every free name the source reads, which is otherwise a
 * `ReferenceError` rather than the value under test.
 */
function evaluate(result: StoreTransform, read: string, given: Record<string, unknown>): unknown {
  const body = output(result)
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n");
  const names = Object.keys(given);
  /** `new Function` is the one way to run a module body without a module, and it types nothing. */
  const run = new Function("__nsdt", ...names, `${body}\nreturn ${read};`) as (
    scope: FileScope,
    ...values: unknown[]
  ) => unknown;

  return run(runtime, ...names.map((name) => given[name]));
}

describe("the pre-parse test", () => {
  const FACTORY_CALL =
    `import { createPanel } from "./panel.ts";\n` + `export const panel = createPanel();\n`;

  it("parses a file that imports no nanostores", () => {
    const result = transform(FACTORY_CALL);

    expect(output(result)).toContain(
      `__nsdt.end((__nsdt.begin(), __nsdt.adopt(createPanel(), ` +
        `{"name":"panel","fn":null,"line":2,"type":"unknown"})), ` +
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
    const result = transform(`export function Cart() {\n  return render($cart);\n}\n`);

    expect(result.changed).toBe(false);
  });

  it("leaves a file that imports nanostores and makes no store alone", () => {
    const result = transform(
      `import { onMount } from "nanostores";\n` +
        `export function start() {\n  $cart.listen(() => {});\n}\n`,
    );

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

    /** `onMount` is no creator, so it takes no type here and reaches the file as an adoption. */
    expect(metas(result).map((meta) => meta.type)).toEqual([
      "atom",
      "map",
      "deepMap",
      "computed",
      "batched",
      "unknown",
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
        `{"name":"$theme","fn":null,"line":2,"type":"atom"})`,
    );
  });

  /** The name is the whole gate, so a codebase that never writes the prefix is adopted too. */
  it("wraps a binding without a $", () => {
    const result = transform(`const theme = persistentAtom("theme", "dark");\n`);

    expect(output(result)).toContain(
      `__nsdt.adopt(persistentAtom("theme", "dark"), ` +
        `{"name":"theme","fn":null,"line":1,"type":"unknown"})`,
    );
    expect(ownCall(result)).toBe(`__nsdt.own([["theme", theme, false]]);`);
  });

  it("numbers a call standing in an argument under a plain name", () => {
    const result = transform(`const theme = persistent(fallback("dark"));\n`);

    expect(output(result)).toContain(
      `__nsdt.adopt(persistent(__nsdt.adopt(fallback("dark"), ` +
        `{"name":"theme unassigned 1","fn":null,"line":1,"type":"unknown"})), ` +
        `{"name":"theme","fn":null,"line":1,"type":"unknown"})`,
    );
  });

  it("leaves a plain-named call callee matching already wrapped alone", () => {
    const result = transform(`import { atom } from "nanostores";\nconst count = atom(0);\n`);

    expect(output(result)).not.toContain("__nsdt.adopt(");
    expect(metas(result)).toEqual([{ name: "count", fn: null, line: 2, type: "atom" }]);
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

describe("a call no name reaches", () => {
  const IMPORTED = `import { userStore } from "./stores.ts";\n`;
  const IN_A_COMPONENT = `${IMPORTED}export function Row(id) {\n  return userStore(id);\n}\n`;

  it("adopts it under its callee, where the file imported that callee", () => {
    const result = transform(IN_A_COMPONENT);

    expect(output(result)).toContain(
      `__nsdt.adopt(userStore(id), {"name":"userStore","fn":"Row","line":3,"type":"unknown"})`,
    );
  });

  /** The store is made where it is used, and the call around it is nobody's value either. */
  it("wraps the call around it too, which hands a value that is no store straight back", () => {
    const result = transform(
      `import { useStore } from "@nanostores/react";\n${IMPORTED}` +
        `export function Row(id) {\n  return useStore(userStore(id));\n}\n`,
    );

    expect(metas(result)).toEqual([
      { name: "userStore", fn: "Row", line: 4, type: "unknown" },
      { name: "useStore", fn: "Row", line: 4, type: "unknown" },
    ]);
  });

  /** One site, which is the unit the runtime numbers its stores under and caps. */
  it("gives two calls on one line the same site, so their numbers tell them apart", () => {
    const result = transform(
      `${IMPORTED}export function Row() {\n  return [userStore(1), userStore(2)];\n}\n`,
    );

    expect(metas(result)).toEqual([
      { name: "userStore", fn: "Row", line: 3, type: "unknown" },
      { name: "userStore", fn: "Row", line: 3, type: "unknown" },
    ]);
  });

  it("takes a default import, which is a name the file brought in as much as any other", () => {
    const result = transform(
      `import userStore from "./stores.ts";\nexport function Row(id) {\n  return userStore(id);\n}\n`,
    );

    expect(metas(result)).toEqual([{ name: "userStore", fn: "Row", line: 3, type: "unknown" }]);
  });

  it("writes the name the file wrote, and reads the kind off the export behind it", () => {
    const result = transform(
      `import { persistentAtom as stored } from "@nanostores/persistent";\n` +
        `export function themeFor(key) {\n  return stored(key, "dark");\n}\n`,
    );

    expect(metas(result)).toEqual([{ name: "stored", fn: "themeFor", line: 3, type: "atom" }]);
  });

  it("leaves a callee the file declares itself alone, which is a helper of its own", () => {
    const result = transform(
      `function localStore(id) {\n  return { id };\n}\nexport function Row() {\n` +
        `  return localStore(1);\n}\n`,
    );

    expect(metas(result)).toEqual([]);
  });

  it("leaves a member call alone, though the file imported what it stands on", () => {
    const result = transform(
      `import { api } from "./api.ts";\nexport function Row(id) {\n  return api.userStore(id);\n}\n`,
    );

    expect(metas(result)).toEqual([]);
  });

  /** Every store one factory line makes carries the same name, so it still waits to be adopted. */
  it("leaves a creator call as it was: kind recorded, and no name of its own", () => {
    const result = transform(
      `import { map } from "nanostores";\nexport function userStore(id) {\n  return map({ id });\n}\n`,
    );

    expect(output(result)).toContain(
      `__nsdt.store(map({ id }), {"name":null,"fn":"userStore","line":3,"type":"map"})`,
    );
    expect(output(result)).not.toContain("__nsdt.adopt(");
  });

  it("adopts nothing at all with adoption turned off", () => {
    const result = transform(IN_A_COMPONENT, { adoptFactories: false });

    expect(metas(result)).toEqual([]);
  });

  it("gives a file whose only store is one of these the header, so a reload clears it", () => {
    const result = transform(IN_A_COMPONENT);

    expect(output(result)).toContain("__nsdt.clear();");
    expect(ownCall(result)).toBeUndefined();
  });
});

describe("an optional chain", () => {
  it("leaves a call alone where the chain runs on past it", () => {
    const result = transform(`const x = a?.b().c;\n`);

    expect(output(result)).toContain(`const x = a?.b().c;`);
    expect(metas(result)).toEqual([]);
  });

  it("keeps the short circuit of an adopted call, which gives undefined and throws nothing", () => {
    const result = transform(`const x = a?.b().c;\n`);

    expect(evaluate(result, "x", { a: null })).toBeUndefined();
  });

  it("keeps the short circuit of a creator call the chain can skip", () => {
    const result = transform(`import { atom } from "nanostores";\nconst x = atom?.(0).get();\n`);

    expect(output(result)).not.toContain(`__nsdt.store(atom?.(0)`);
    expect(evaluate(result, "x", { atom: undefined })).toBeUndefined();
  });

  it("wraps the call the chain ends on, where the wrapper stands outside the short circuit", () => {
    const result = transform(`const x = a?.b();\n`);

    expect(output(result)).toContain(
      `__nsdt.adopt(a?.b(), {"name":"x","fn":null,"line":1,"type":"unknown"})`,
    );
    expect(evaluate(result, "x", { a: null })).toBeUndefined();
  });

  it("wraps a call standing under every `?.`, which the chain runs whatever happens", () => {
    const result = transform(`const x = f()?.b().c;\n`);

    expect(output(result)).toContain(
      `__nsdt.adopt(f(), {"name":"x","fn":null,"line":1,"type":"unknown"})?.b().c;`,
    );
  });

  it("wraps a creator call standing in an argument inside a chain", () => {
    const result = transform(`import { atom } from "nanostores";\nconst x = a?.b(atom(0)).c;\n`);

    expect(output(result)).toContain(
      `a?.b(__nsdt.store(atom(0), {"name":"x unassigned 1","fn":null,"line":2,"type":"atom"})).c;`,
    );
    expect(evaluate(result, "x", { atom: () => ({}), a: null })).toBeUndefined();
  });

  it("reads a `!` as a link of the chain, which is all TypeScript leaves of it", () => {
    const result = transform(`const x = a?.b!.c().d;\n`);

    expect(output(result)).toContain(`const x = a?.b!.c().d;`);
  });

  it("wraps a call outside the parentheses that ended the chain", () => {
    const result = transform(`const x = (a?.b)().c;\n`);

    expect(output(result)).toContain(
      `__nsdt.adopt((a?.b)(), {"name":"x","fn":null,"line":1,"type":"unknown"}).c;`,
    );
  });

  it("wraps a chain that is not optional the way it always did", () => {
    const result = transform(`const x = a.b().c;\n`);

    expect(output(result)).toContain(
      `__nsdt.adopt(a.b(), {"name":"x","fn":null,"line":1,"type":"unknown"}).c;`,
    );
  });
});

describe("the package map", () => {
  /** What an adoption site carries, which is the whole of what the map changes. */
  function type(code: string, overrides: Overrides = {}): StoreType | undefined {
    return metas(transform(code, overrides))[0]?.type;
  }

  it("gives an adopted store the kind its package's export makes", () => {
    expect(
      type(
        `import { persistentMap } from "@nanostores/persistent";\n` +
          `export const $settings = persistentMap("settings:", {});\n`,
      ),
    ).toBe("map");
  });

  it("reads the export name rather than the local one, so a renamed import still lands", () => {
    expect(
      type(
        `import { persistentAtom as stored } from "@nanostores/persistent";\n` +
          `export const $theme = stored("theme", "dark");\n`,
      ),
    ).toBe("atom");
  });

  it("leaves a package it has no entry for without a kind", () => {
    expect(
      type(`import { createStore } from "@acme/state";\nexport const $c = createStore(0);\n`),
    ).toBe("unknown");
  });

  it("leaves an export the entry does not name without a kind", () => {
    expect(
      type(
        `import { createStorage } from "@nanostores/persistent";\n` +
          `export const $c = createStorage();\n`,
      ),
    ).toBe("unknown");
  });

  /** An entry may name an export its package dropped, or never had. Nothing here reads it. */
  it("says nothing about an entry naming an export the file never imports", () => {
    const result = transform(
      `import { persistentAtom } from "@nanostores/persistent";\n` +
        `export const $theme = persistentAtom("theme", "dark");\n`,
      { storeTypes: resolveStoreTypes({ "@nanostores/persistent": { gone: "map" } }).types },
    );

    expect(metas(result)[0]).toEqual({ name: "$theme", fn: null, line: 2, type: "atom" });
    expect(result.warnings).toEqual([]);
  });

  it("gives no kind to a namespace import, and says nothing about it", () => {
    const result = transform(
      `import * as persistent from "@nanostores/persistent";\n` +
        `export const $theme = persistent.persistentAtom("theme", "dark");\n`,
    );

    expect(metas(result)[0]?.type).toBe("unknown");
    expect(result.warnings).toEqual([]);
  });

  it("gives no kind to a default import, whatever an entry of that name says", () => {
    expect(
      type(`import stored from "@acme/state";\nexport const $c = stored(0);\n`, {
        storeTypes: resolveStoreTypes({ "@acme/state": { default: "map" } }).types,
      }),
    ).toBe("unknown");
  });

  it("gives no kind to a type-only import", () => {
    expect(
      type(
        `import type { persistentAtom } from "@nanostores/persistent";\n` +
          `export const $theme = persistentAtom("theme", "dark");\n`,
      ),
    ).toBe("unknown");
  });

  it("keeps callee matching's own kind, which the map never reaches", () => {
    const result = transform(
      `import { atom } from "nanostores";\n` +
        `import { persistentAtom } from "@nanostores/persistent";\n` +
        `export const $c = atom(0);\n`,
    );

    expect(metas(result)).toEqual([{ name: "$c", fn: null, line: 3, type: "atom" }]);
  });

  it("carries a package kind wherever adoption reaches, not only a top-level binding", () => {
    const result = transform(
      `import { persistentAtom } from "@nanostores/persistent";\n` +
        `export function make() {\n  return { theme: persistentAtom("theme", "dark") };\n}\n`,
    );

    expect(metas(result)).toEqual([{ name: "theme", fn: "make", line: 3, type: "atom" }]);
  });

  it("takes no kind at all with adoption turned off", () => {
    const result = transform(
      `import { persistentAtom } from "@nanostores/persistent";\n` +
        `export const $theme = persistentAtom("theme", "dark");\n`,
      { adoptFactories: false },
    );

    expect(output(result)).not.toContain("__nsdt.adopt(");
  });

  it("takes an entry a developer added", () => {
    expect(
      type(`import { deep } from "@acme/state";\nexport const $c = deep({});\n`, {
        storeTypes: resolveStoreTypes({ "@acme/state": { deep: "deepMap" } }).types,
      }),
    ).toBe("deepMap");
  });

  it("takes a correction to one export, and keeps the rest of that package", () => {
    const added = { "@nanostores/persistent": { persistentAtom: "deepMap" } } as const;

    expect(
      type(
        `import { persistentAtom } from "@nanostores/persistent";\n` +
          `export const $theme = persistentAtom("theme", "dark");\n`,
        { storeTypes: resolveStoreTypes(added).types },
      ),
    ).toBe("deepMap");
    expect(
      type(
        `import { persistentMap } from "@nanostores/persistent";\n` +
          `export const $settings = persistentMap("settings:", {});\n`,
        { storeTypes: resolveStoreTypes(added).types },
      ),
    ).toBe("map");
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

describe("the throttle comment", () => {
  const IMPORT = `import { atom } from "nanostores";\n`;

  it("marks the store made in the statement below it", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:throttle\nconst $frame = atom(0);\n`,
    );

    expect(metas(result)).toEqual([
      { name: "$frame", fn: null, line: 3, type: "atom", throttle: true },
    ]);
  });

  it("marks a call adoption takes, which is where a store from a dependency arrives", () => {
    const result = transform(`// @nanostores-devtools:throttle\nconst $frame = countdown(60);\n`);

    expect(metas(result)).toContainEqual({
      name: "$frame",
      fn: null,
      line: 2,
      type: "unknown",
      throttle: true,
    });
  });

  it("reads a block comment the same way", () => {
    const result = transform(
      `${IMPORT}/* @nanostores-devtools:throttle */\nconst $frame = atom(0);\n`,
    );

    expect(metas(result)).toEqual([
      { name: "$frame", fn: null, line: 3, type: "atom", throttle: true },
    ]);
  });

  /** The comment marks a statement, and one statement can make more than one store. */
  it("marks every store the statement it stands over makes", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:throttle\nconst $pair = merge([atom(0), atom(1)]);\n`,
    );

    expect(metas(result).map((site) => site.throttle)).toEqual([true, true, true, true]);
  });

  it("reaches no further than that statement", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:throttle\nconst $frame = atom(0);\nconst $other = atom(0);\n`,
    );

    expect(metas(result)).toEqual([
      { name: "$frame", fn: null, line: 3, type: "atom", throttle: true },
      { name: "$other", fn: null, line: 4, type: "atom" },
    ]);
  });

  it("marks nothing when a statement stands between it and the store", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:throttle\nconst $other = 1;\nconst $frame = atom(0);\n`,
    );

    expect(metas(result)).toEqual([{ name: "$frame", fn: null, line: 4, type: "atom" }]);
  });

  it("leaves an ordinary comment alone", () => {
    const result = transform(`${IMPORT}// the frame clock\nconst $frame = atom(0);\n`);

    expect(metas(result)).toEqual([{ name: "$frame", fn: null, line: 3, type: "atom" }]);
  });

  it("reads the rate the comment names, in milliseconds", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:throttle 100\nconst $frame = atom(0);\n`,
    );

    expect(metas(result)).toEqual([
      { name: "$frame", fn: null, line: 3, type: "atom", throttle: 100 },
    ]);
  });

  it("hands the rate to every store of the statement, block comment included", () => {
    const result = transform(
      `${IMPORT}/* @nanostores-devtools:throttle 250 */\nconst $pair = merge([atom(0), atom(1)]);\n`,
    );

    expect(metas(result).map((site) => site.throttle)).toEqual([250, 250, 250, 250]);
  });

  /** The mark is the point of the comment, so nothing readable behind it may cost the store one. */
  it.each(["100ms", "abc", "0", "-100", "Infinity", "100 200"])(
    "marks the store with the default rate when the comment says %s",
    (rate) => {
      const result = transform(
        `${IMPORT}// @nanostores-devtools:throttle ${rate}\nconst $frame = atom(0);\n`,
      );

      expect(metas(result)).toEqual([
        { name: "$frame", fn: null, line: 3, type: "atom", throttle: true },
      ]);
    },
  );

  it("leaves a comment alone that only starts like the name", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:throttled\nconst $frame = atom(0);\n`,
    );

    expect(metas(result)).toEqual([{ name: "$frame", fn: null, line: 3, type: "atom" }]);
  });
});

describe("the no-throttle comment", () => {
  const IMPORT = `import { atom } from "nanostores";\n`;

  it("spares the store made in the statement below it", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:no-throttle\nconst $frame = atom(0);\n`,
    );

    expect(metas(result)).toEqual([
      { name: "$frame", fn: null, line: 3, type: "atom", throttle: false },
    ]);
  });

  it("reads a block comment the same way, and spares every store of the statement", () => {
    const result = transform(
      `${IMPORT}/* @nanostores-devtools:no-throttle */\nconst $pair = merge([atom(0), atom(1)]);\n`,
    );

    expect(metas(result).map((site) => site.throttle)).toEqual([false, false, false, false]);
  });

  it("reaches no further than that statement", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:no-throttle\nconst $frame = atom(0);\nconst $other = atom(0);\n`,
    );

    expect(metas(result)).toEqual([
      { name: "$frame", fn: null, line: 3, type: "atom", throttle: false },
      { name: "$other", fn: null, line: 4, type: "atom" },
    ]);
  });

  it("spares the store whatever a developer wrote behind the name", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:no-throttle it runs at 60fps\nconst $frame = atom(0);\n`,
    );

    expect(metas(result)).toEqual([
      { name: "$frame", fn: null, line: 3, type: "atom", throttle: false },
    ]);
  });

  it("leaves a comment alone that only starts like the name", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:no-throttled\nconst $frame = atom(0);\n`,
    );

    expect(metas(result)).toEqual([{ name: "$frame", fn: null, line: 3, type: "atom" }]);
  });

  /** Two comments say two things, and the rate the mark names is the one nothing else can say. */
  it("loses to a throttle comment over the same statement, whichever stands first", () => {
    const marked = transform(
      `${IMPORT}// @nanostores-devtools:no-throttle\n// @nanostores-devtools:throttle 100\nconst $frame = atom(0);\n`,
    );
    const reversed = transform(
      `${IMPORT}// @nanostores-devtools:throttle 100\n// @nanostores-devtools:no-throttle\nconst $frame = atom(0);\n`,
    );

    expect(metas(marked).map((site) => site.throttle)).toEqual([100]);
    expect(metas(reversed).map((site) => site.throttle)).toEqual([100]);
  });
});

describe("the ignore comment", () => {
  const IMPORT = `import { atom } from "nanostores";\n`;

  /** The module's own body, past the one header line the transform writes above it. */
  function body(result: StoreTransform): string {
    const code = output(result);

    return code.slice(code.indexOf("\n") + 1);
  }

  it("hands the statement below it back exactly as it was written", () => {
    const source = `// @nanostores-devtools:ignore\nconst $secret = atom(0);\n`;

    expect(body(transform(IMPORT + source))).toBe(IMPORT + source);
  });

  it("reads a block comment the same way", () => {
    const source = `/* @nanostores-devtools:ignore */\nconst $secret = atom(0);\n`;

    expect(body(transform(IMPORT + source))).toBe(IMPORT + source);
  });

  it("ignores the store whatever a developer wrote behind the name", () => {
    const source = `// @nanostores-devtools:ignore it holds a token\nconst $secret = atom(0);\n`;

    expect(body(transform(IMPORT + source))).toBe(IMPORT + source);
  });

  /** A class instance, a factory result and an array each hold stores nobody wrapped by name. */
  it("draws none of the stores an ignored statement holds", () => {
    const source =
      `// @nanostores-devtools:ignore\nconst editor = new Editor();\n` +
      `// @nanostores-devtools:ignore\nconst $theme = persistentAtom("theme", "dark");\n` +
      `// @nanostores-devtools:ignore\nconst $pair = merge([atom(0), atom(1)]);\n`;

    expect(body(transform(IMPORT + source))).toBe(IMPORT + source);
  });

  it("wraps no field of an ignored class, which is a store its instances make", () => {
    const source = `// @nanostores-devtools:ignore\nclass Editor {\n  $value = atom("");\n}\n`;

    expect(body(transform(IMPORT + source))).toBe(IMPORT + source);
  });

  /** A frame is the only thing that reaches a store an initializer kept in a closure. */
  it("opens no creation frame around an ignored initializer", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:ignore\nconst editor = new Editor();\n`,
    );

    expect(output(result)).not.toContain("__nsdt.begin(");
  });

  it("leaves an ignored binding out of the own list, so it renames and places nothing", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:ignore\nexport const $secret = atom(0);\n` +
        `export const $shown = atom(1);\n`,
    );

    expect(ownCall(result)).toBe(`__nsdt.own([["$shown", $shown, true]]);`);
  });

  it("reaches no further than that statement", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:ignore\nconst $secret = atom(0);\nconst $shown = atom(1);\n`,
    );

    expect(metas(result)).toEqual([{ name: "$shown", fn: null, line: 4, type: "atom" }]);
  });

  it("marks nothing when a statement stands between it and the store", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:ignore\nconst other = 1;\nconst $shown = atom(0);\n`,
    );

    expect(metas(result)).toEqual([{ name: "$shown", fn: null, line: 4, type: "atom" }]);
  });

  it("leaves a comment alone that only starts like the name", () => {
    const result = transform(`${IMPORT}// @nanostores-devtools:ignored\nconst $frame = atom(0);\n`);

    expect(metas(result)).toEqual([{ name: "$frame", fn: null, line: 3, type: "atom" }]);
  });

  /** A store nobody draws has no rate, so the comment that asks for one has nothing to say. */
  it("wins over both throttle comments over the same statement, whichever stands first", () => {
    const marked = transform(
      `${IMPORT}// @nanostores-devtools:throttle 100\n// @nanostores-devtools:ignore\nconst $frame = atom(0);\n`,
    );
    const spared = transform(
      `${IMPORT}// @nanostores-devtools:ignore\n// @nanostores-devtools:no-throttle\nconst $frame = atom(0);\n`,
    );

    expect(metas(marked)).toEqual([]);
    expect(metas(spared)).toEqual([]);
  });

  it("gives a file back unchanged when it binds a creator for nothing but ignored stores", () => {
    const result = transform(
      `// @nanostores-devtools:ignore\nconst $theme = persistentAtom("theme", "");\n`,
    );

    expect(result.changed).toBe(false);
  });

  /**
   * The header carries the clear a reload runs, so a file that imports a creator keeps it even
   * with every store ignored: adding the comment has to drop the store the panel already drew.
   */
  it("keeps the header on a file that imports a creator and ignores every store", () => {
    const result = transform(`${IMPORT}// @nanostores-devtools:ignore\nconst $secret = atom(0);\n`);

    expect(output(result)).toContain("__nsdt.clear();");
    expect(ownCall(result)).toBeUndefined();
  });
});

describe("a devtools comment the plugin does not know", () => {
  const IMPORT = `import { atom } from "nanostores";\n`;

  it("warns, naming the file, the line, what was written and every comment it reads", () => {
    const result = transform(
      `${IMPORT}\n// @nanostores-devtools:ignored\nconst $frame = atom(0);\n`,
    );
    const [warning] = result.warnings;

    expect(result.warnings).toHaveLength(1);
    expect(warning).toContain(MODULE_KEY);
    expect(warning).toContain("line 3");
    expect(warning).toContain(`"@nanostores-devtools:ignored"`);
    expect(warning).toContain(
      "@nanostores-devtools:ignore, @nanostores-devtools:throttle, @nanostores-devtools:no-throttle",
    );
  });

  it("reads a block comment the same way", () => {
    const result = transform(
      `${IMPORT}/* @nanostores-devtools:throtle */\nconst $frame = atom(0);\n`,
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(`"@nanostores-devtools:throtle"`);
  });

  /** The colon is the one separator, and a hyphen for it is the typo the namespace makes easy. */
  it("warns about the namespace written with a hyphen where the colon belongs", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools-throttle\nconst $frame = atom(0);\n`,
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(`"@nanostores-devtools-throttle"`);
    expect(metas(result)).toEqual([{ name: "$frame", fn: null, line: 3, type: "atom" }]);
  });

  it("warns about a file the transform gives back unchanged", () => {
    const result = transform(`// @nanostores-devtools:ignored\nfetchAll();\n`);

    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(1);
  });

  it("says nothing about the three comments it reads, whatever follows them", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:ignore it holds a token\nconst $secret = atom(0);\n` +
        `// @nanostores-devtools:throttle 100\nconst $frame = atom(1);\n` +
        `// @nanostores-devtools:no-throttle\nconst $fast = atom(2);\n`,
    );

    expect(result.warnings).toEqual([]);
  });

  it("says nothing about an ordinary comment, whatever it says", () => {
    const result = transform(
      `${IMPORT}// devtools: skip this\n// @todo hide @nanostores-devtools:ignore from the panel\n` +
        `const $frame = atom(0);\n`,
    );

    expect(result.warnings).toEqual([]);
  });

  /** Two typos are two mistakes, and the line each one names is the only way to tell them apart. */
  it("warns about every comment it cannot read, one line at a time", () => {
    const result = transform(
      `${IMPORT}// @nanostores-devtools:ignored\nconst $a = atom(0);\n` +
        `// @nanostores-devtools:ignored\nconst $b = atom(1);\n// @nanostores-devtools:throtle\nconst $c = atom(2);\n`,
    );

    expect(result.warnings).toHaveLength(3);
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
    expect(output(result)).toContain(`const model = ${OPENED}__nsdt.adopt(makeModel(), `);
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

    expect(code.split("\n")[0]).toContain(`from "nanostores-devtools/runtime"`);
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

  it("writes the import and the hot-reload line the adapter handed in", () => {
    const result = transform(source, {
      runtimeModule: "@acme/devtools/runtime",
      hotReload: (clear) =>
        `if (import.meta.webpackHot) import.meta.webpackHot.dispose(() => { ${clear} });`,
    });

    expect(output(result).split("\n")[0]).toBe(
      `import { fileScope as __nsdtFileScope } from "@acme/devtools/runtime"; ` +
        `const __nsdt = __nsdtFileScope("src/stores/cart.ts", "src/stores/cart.ts", 50, false); ` +
        `__nsdt.clear(); ` +
        `if (import.meta.webpackHot) import.meta.webpackHot.dispose(() => { __nsdt.clear(); });`,
    );
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
