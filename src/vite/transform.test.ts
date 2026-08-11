import { decode } from "@jridgewell/sourcemap-codec";
import { describe, expect, it, vi } from "vitest";

import { loadParser } from "./parser.ts";
import type { CreationSite } from "./runtime.ts";
import { type StoreTransform, transformStores } from "./transform.ts";

const MODULE_KEY = "src/stores/cart.ts";
const parser = await loadParser();

type Overrides = { home?: string; maxStoresPerSite?: number; moduleKey?: string };

function transform(code: string, overrides: Overrides = {}): StoreTransform {
  return transformStores({
    code,
    moduleKey: MODULE_KEY,
    home: MODULE_KEY,
    maxStoresPerSite: 50,
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

describe("the pre-parse test", () => {
  it("never parses a file that imports no store creator", () => {
    const parseSync = vi.fn();
    const result = transformStores({
      code: `import { useStore } from "@nanostores/react";\nuseStore($cart);\n`,
      moduleKey: MODULE_KEY,
      home: MODULE_KEY,
      maxStoresPerSite: 50,
      parser: { ...parser, parseSync },
    });

    expect(parseSync).not.toHaveBeenCalled();
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
    const result = transform(`import type { atom } from "nanostores";\nconst $c = atom(0);\n`);

    expect(result.changed).toBe(false);
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
    const result = transform(`import * as ns from "nanostores";\nconst $c = ns.atom(0);\n`);

    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(MODULE_KEY);
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

  it("carries the module key, the home and the per-site cap", () => {
    const result = transform(source, { home: "stores", maxStoresPerSite: 25 });

    expect(output(result)).toContain(`__nsdtFileScope("src/stores/cart.ts", "stores", 25)`);
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
