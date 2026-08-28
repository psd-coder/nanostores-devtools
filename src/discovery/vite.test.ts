import { fileURLToPath } from "node:url";

import { build, createServer, type Plugin, type ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { peekDevtoolsGlobal, resetDevtoolsGlobal } from "../global.ts";
import { listEntries, type StoreEntry } from "../stores/registry.ts";
import { buildSnapshot } from "../redux/render.ts";
import { labelled, panelNode } from "../testing/shapes.ts";
import { ownRuntimePath, RUNTIME_MODULE } from "./runtime-module.ts";
import { nanostoresDevtools, type VitePluginOptions, viteHotReload } from "./vite.ts";

/** This file's own directory, which is where the package's absolute paths are read from. */
const HERE = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");
const PROJECT_ROOT = HERE.slice(0, -"/src/discovery".length);

describe("nanostoresDevtools", () => {
  it("names itself, and runs on the dev server only", () => {
    const plugin = nanostoresDevtools();

    expect(plugin.name).toBe("nanostores-devtools");
    expect(plugin.apply).toBe("serve");
  });
});

describe("viteHotReload", () => {
  it("spells the hot handle Vite gives a module and the hook that fires for a deleted file", () => {
    expect(viteHotReload("__nsdt.clear();")).toBe(
      "if (import.meta.hot) import.meta.hot.prune(() => { __nsdt.clear(); });",
    );
  });
});

describe("a production build", () => {
  const entry = "/nanostores-fixture/cart.js";
  const fixture: Plugin = {
    name: "fixture",
    resolveId: (id) => (id === entry ? id : null),
    load: (id) =>
      id === entry ? `import { atom } from "nanostores";\nexport const $items = atom([]);\n` : null,
  };

  it("carries nothing the plugin injects", async () => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [nanostoresDevtools(), fixture],
      build: {
        write: false,
        lib: { entry, formats: ["es"], fileName: "cart" },
        rollupOptions: { external: ["nanostores"] },
      },
    });

    const bundles = Array.isArray(result) ? result : [result];
    const code = bundles
      .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
      .map((chunk) => (chunk.type === "chunk" ? chunk.code : ""))
      .join("\n");

    expect(code).toContain(`from "nanostores"`);
    expect(code).not.toContain("__nsdt");
    expect(code).not.toContain("nanostores-devtools/runtime");
  });
});

/**
 * The fixture is served from memory under the project root, so the module keys read like a real
 * app's and nothing is written to disk. It sits beside the package's own source rather than inside
 * it, because the plugin skips every file of its own package.
 */
const APP_HOME = "fixture/app.ts";
const FIXTURE_DIR = `${PROJECT_ROOT}/fixture`;
const APP = `${FIXTURE_DIR}/app.ts`;

const FILES: Record<string, string> = {
  [`${FIXTURE_DIR}/factory.ts`]:
    `import { atom } from "nanostores";\n` +
    `export function persistentAtom(key, initial) {\n` +
    `  return atom(initial);\n` +
    `}\n` +
    `export function readConfig() {\n` +
    `  return { dark: true };\n` +
    `}\n`,
  [APP]:
    `import { createRouter } from "@nanostores/router";\n` +
    `import { persistentAtom, readConfig } from "./factory.ts";\n` +
    `export const $theme = persistentAtom("theme", "dark");\n` +
    `export const $router = createRouter({ home: "/" });\n` +
    `export const $config = readConfig();\n`,
};

function memoryFixture(files: Record<string, string>): Plugin {
  return {
    name: "fixture",
    enforce: "pre",
    resolveId(id, importer) {
      if (id in files) {
        return id;
      }

      if (importer === undefined || !id.startsWith("./")) {
        return null;
      }

      const sibling = `${importer.slice(0, importer.lastIndexOf("/"))}/${id.slice(2)}`;

      return sibling in files ? sibling : null;
    },
    load: (id) => files[id] ?? null,
  };
}

function entryNamed(name: string): StoreEntry | undefined {
  return listEntries().find((entry) => entry.name === name);
}

/**
 * Every line and every column the walk records is read off the string the plugin is handed, so that
 * string has to be the file the developer wrote.
 */
const SOURCE = `${FIXTURE_DIR}/source.ts`;

const SOURCE_FILES: Record<string, string> = {
  [SOURCE]: `import { atom } from "nanostores";\n\nexport const $count = atom<number>(0);\n`,
};

const REWRITTEN =
  "the plugin was handed source somebody else had already rewritten. It has to be handed the " +
  "developer's own file first, before the bundler's own TypeScript transform collapses the blank " +
  "lines and drops the type arguments, or every line it records sends a developer to the wrong " +
  "place in their own file";

/** The plugin as it ships, keeping the code it is handed on the way through. */
function watched(seen: string[]): Plugin {
  const plugin = nanostoresDevtools();
  const { transform } = plugin;

  if (typeof transform !== "function") {
    throw new Error("the plugin no longer carries a plain transform hook");
  }

  return {
    ...plugin,
    transform(code, id, options) {
      if (id === SOURCE) {
        seen.push(code);
      }

      return transform.call(this, code, id, options);
    },
  };
}

describe("the source the plugin is handed", () => {
  const seen: string[] = [];
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    seen.length = 0;
    server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: PROJECT_ROOT,
      plugins: [watched(seen), memoryFixture(SOURCE_FILES)],
    });

    await server.ssrLoadModule(SOURCE);
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("is the file the developer wrote, with its types and its blank lines still in it", () => {
    const [code] = seen;

    if (code === undefined) {
      throw new Error("the plugin's transform never ran on the fixture file");
    }

    expect(code, REWRITTEN).toContain("atom<number>(0)");
    expect(code.split("\n")[1], REWRITTEN).toBe("");
  });
});

describe("a file that imports no nanostores creator", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: PROJECT_ROOT,
      plugins: [nanostoresDevtools(), memoryFixture(FILES)],
    });

    await server.ssrLoadModule(APP);
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("puts a factory's store under the calling file, its own name and the factory's type", () => {
    expect(entryNamed("$theme")).toMatchObject({
      home: APP_HOME,
      label: `${APP_HOME}/$theme`,
      type: "atom",
      origin: "plugin",
    });
    expect(buildSnapshot()[APP_HOME]?.["$theme [store]"]).toBe("dark");
  });

  it("puts a dependency's store in the tree under the kind the package map gives it", () => {
    expect(entryNamed("$router")).toMatchObject({ home: APP_HOME, type: "atom" });
  });

  it("reads the dependency's store, because the map settled what it holds", () => {
    expect(buildSnapshot()[APP_HOME]?.["$router [store]"]).toMatchObject({ params: {} });
  });

  it("changes nothing for a $ name holding a value that is no store", () => {
    expect(
      listEntries()
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["$router", "$theme"]);
  });
});

/**
 * The case parsing every file is there for: `workspace.ts` imports no nanostores and binds no `$`
 * name, so nothing in the text of it says it holds stores at all. Only the scan appended to its
 * body puts the factory results under a binding. Unparsed, none of these stores would be drawn.
 */
const WORKSPACE_HOME = "fixture/workspace.ts";
const WORKSPACE = `${FIXTURE_DIR}/workspace.ts`;

const GATE_FILES: Record<string, string> = {
  [`${FIXTURE_DIR}/panel.ts`]:
    `import { atom } from "nanostores";\n` +
    `export function createPanel(width) {\n` +
    `  return { open: atom(false), width: atom(width) };\n` +
    `}\n`,
  [`${FIXTURE_DIR}/editor.ts`]:
    `import { atom } from "nanostores";\n` +
    `export class Editor {\n` +
    `  $value = atom("draft");\n` +
    `}\n`,
  [WORKSPACE]:
    `import { createPanel } from "./panel.ts";\n` +
    `import { Editor } from "./editor.ts";\n` +
    `export const panel = createPanel(320);\n` +
    `export const sidebar = createPanel(240);\n` +
    `export const hidden = new WeakMap([[{}, new Editor()]]);\n`,
};

describe("a file that says nothing about stores in its own text", () => {
  let server: ViteDevServer;

  async function load(options: VitePluginOptions = {}): Promise<void> {
    resetDevtoolsGlobal();
    server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: PROJECT_ROOT,
      plugins: [nanostoresDevtools(options), memoryFixture(GATE_FILES)],
    });

    await server.ssrLoadModule(WORKSPACE);
  }

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /**
   * Both factory results hold a store keyed `open` and one keyed `width`, and they stay apart
   * because the scan registers each under the whole path that reached it: `panel.open` is not
   * `sidebar.open`.
   *
   * `hidden` draws nothing. A `WeakMap` gives up no members, so no walk reaches the instance inside
   * it, and after the gate no wrapper names a store made in a class field either.
   */
  it("attributes what it binds, and draws every registry entry exactly once", async () => {
    await load();

    expect(buildSnapshot()).toEqual({
      [WORKSPACE_HOME]: {
        panel: panelNode(320),
        sidebar: panelNode(240),
      },
    });
    expect(listEntries()).toHaveLength(4);
  });
});

/**
 * A linked package: it makes its store outside the Vite root, so its home is measured from the
 * pinned project root one level above instead of climbing out of the root.
 */
const ABOVE_ROOT = PROJECT_ROOT.slice(0, PROJECT_ROOT.lastIndexOf("/"));
const LINKED_HOME = "api-client/src/session.ts";
const LINKED = `${ABOVE_ROOT}/${LINKED_HOME}`;

const OUTSIDE_FILES: Record<string, string> = {
  [LINKED]: `import { atom } from "nanostores";\nexport const $session = atom("anon");\n`,
  [APP]:
    `import { atom } from "nanostores";\n` +
    `import { $session } from "${LINKED}";\n` +
    `export const $ready = atom($session.value !== "");\n`,
};

describe("a store made outside the Vite root", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: PROJECT_ROOT,
      plugins: [nanostoresDevtools({ projectRoot: ABOVE_ROOT }), memoryFixture(OUTSIDE_FILES)],
      server: { fs: { allow: [ABOVE_ROOT] } },
    });

    await server.ssrLoadModule(APP);
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("takes its home from the project root the option pinned, with no climbing out", () => {
    expect(entryNamed("$session")).toMatchObject({ home: LINKED_HOME, external: true });
  });

  it("leaves a file inside the root measured from the root and the developer's own", () => {
    expect(entryNamed("$ready")).toMatchObject({ home: APP_HOME, external: false });
  });

  /** The external home sorts first alphabetically, so only the rank can put it last. */
  it("draws every external file after the developer's own", () => {
    expect(Object.keys(buildSnapshot())).toEqual([APP_HOME, LINKED_HOME]);
  });
});

/**
 * Everything the held rule adds. Not one of these stores is named by a wrapper: the package file
 * sits under `node_modules`, which is never transformed, so the only thing that reaches its stores
 * is a top-level binding of the developer's own and the walk down from it.
 */
const PKG = `${FIXTURE_DIR}/node_modules/pkg/index.js`;
const HELD_HOME = "fixture/held.js";
const HELD = `${FIXTURE_DIR}/held.js`;

const HELD_FILES: Record<string, string> = {
  [PKG]:
    `import { atom } from "nanostores";\n` +
    `export const $ready = atom(true);\n` +
    `export const $a = atom("a");\n` +
    `export const $b = atom("b");\n` +
    `export const $s = atom("deep");\n` +
    `export function createClient() {\n  return { $value: atom("v") };\n}\n` +
    `export function makeThings() {\n  return { $user: atom("u"), $cart: atom("c") };\n}\n` +
    `export class Thing {\n  constructor(value) {\n    Object.assign(this, atom(value));\n  }\n}\n` +
    `export class Widget {\n  constructor(value) {\n    this.$value = atom(value);\n  }\n}\n` +
    `export function merged(left, right) {\n` +
    `  const $left = atom(left);\n` +
    `  const $right = atom(right);\n` +
    `  return atom($left.get() + $right.get());\n}\n`,
  [HELD]:
    `import { $ready, $a, $b, $s, createClient, makeThings, Thing, Widget, merged } ` +
    `from "${PKG}";\n` +
    `export const $d = $ready;\n` +
    `export const client = createClient();\n` +
    `export const group = { $a, $b };\n` +
    `const { $user, $cart } = makeThings();\n` +
    `export { $user, $cart };\n` +
    `export const $x = new Thing("t");\n` +
    `export const widget = new Widget("w");\n` +
    `export const $pointer = merged("up", "move");\n` +
    `export const app = { a: { b: { c: $s } } };\n`,
};

/** A store no creator call named, so nothing worked its kind out and the value is not trusted. */
function unknownStore(value: unknown): unknown {
  return labelled("not mounted, may be stale", { "(value)": value });
}

async function devServer(files: Record<string, string>, entry: string): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: false,
    logLevel: "silent",
    root: PROJECT_ROOT,
    plugins: [nanostoresDevtools(), memoryFixture(files)],
    resolve: { alias: { "nanostores-devtools": `${PROJECT_ROOT}/src/index.ts` } },
  });

  await server.ssrLoadModule(entry);

  return server;
}

describe("a store nothing but a binding of the developer's own reaches", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(HELD_FILES, HELD);
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  function held(): Record<string, unknown> {
    return buildSnapshot()[HELD_HOME] ?? {};
  }

  it("draws a package store the file rebound, and the file with it", () => {
    expect(held()["$d [store]"]).toEqual(unknownStore(true));
  });

  it("draws a store sitting on what a call returned, under the binding that took it", () => {
    expect(held()["client"]).toEqual({ "$value [store]": unknownStore("v") });
  });

  it("draws an object gathering imported stores as a node holding both", () => {
    expect(held()["group"]).toEqual({
      "$a [store]": unknownStore("a"),
      "$b [store]": unknownStore("b"),
    });
  });

  it("draws every name a destructured declaration binds, each at the file's own level", () => {
    expect(held()["$user [store]"]).toEqual(unknownStore("u"));
    expect(held()["$cart [store]"]).toEqual(unknownStore("c"));
  });

  it("draws a store a `new` expression built, which no wrapper ever visits", () => {
    expect(held()["$x [store]"]).toEqual(unknownStore("t"));
  });

  it("draws a store a `new` expression put on its instance, under that instance", () => {
    expect(held()["widget"]).toEqual(labelled("Widget", { "$value [store]": unknownStore("w") }));
  });

  it("draws the binding a call handed back, and nothing the call kept in a closure", () => {
    expect(held()["$pointer [store]"]).toEqual(unknownStore("upmove"));
    /** The two atoms `merged` kept are registered by nothing, so ten entries stand here, not twelve. */
    expect(listEntries()).toHaveLength(10);
  });

  it("draws a store nested deeper than the three levels the walk used to stop at", () => {
    expect(held()["app"]).toEqual({ a: { b: { "c [store]": unknownStore("deep") } } });
  });

  it("gives every store it found one entry, at the file that holds it", () => {
    expect(listEntries().map((entry) => entry.home)).toEqual(Array(10).fill(HELD_HOME));
  });
});

/**
 * A store that lands in a binding while the module body is still running is found by the scan at
 * the end of that body. The same three shapes in a callback are not, and never will be.
 */
const LATE_HOME = "fixture/late.js";
const LATE = `${FIXTURE_DIR}/late.js`;
const CALLBACK_HOME = "fixture/callback.js";
const CALLBACK = `${FIXTURE_DIR}/callback.js`;

const LANDING_FILES: Record<string, string> = {
  [LATE]:
    `import { atom } from "nanostores";\n` +
    `export const list = [];\n` +
    `for (const n of [1, 2]) list.push(atom(n));\n` +
    `export let $late;\n` +
    `$late = atom("late");\n` +
    `export const $m = new Map();\n` +
    `$m.set("a", atom("m"));\n`,
  [CALLBACK]:
    `import { atom } from "nanostores";\n` +
    `export const later = [];\n` +
    `export let $never;\n` +
    `export const $map = new Map();\n` +
    `queueMicrotask(() => {\n` +
    `  later.push(atom(1));\n` +
    `  $never = atom(2);\n` +
    `  $map.set("a", atom(3));\n` +
    `});\n`,
};

describe("a store that lands in a binding while the module body still runs", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(LANDING_FILES, LATE);
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  function late(): Record<string, unknown> {
    return buildSnapshot()[LATE_HOME] ?? {};
  }

  it("draws every store pushed into an array at module level", () => {
    expect(late()["list"]).toEqual(labelled("Array", { "[0] [store]": 1, "[1] [store]": 2 }));
  });

  it("draws a store assigned to a binding declared above it", () => {
    expect(late()["$late [store]"]).toBe("late");
  });

  it("draws a store put into a `Map`, under the key it was put in at", () => {
    expect(late()["$m"]).toEqual(labelled("Map", { '["a"] [store]': "m" }));
  });
});

describe("a store that lands in a binding after the module body finished", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(LANDING_FILES, CALLBACK);
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("draws none of the three shapes the same file draws at module level", async () => {
    /** The callback really ran: what follows is a store nobody drew, not a store nobody made. */
    const loaded = await server.ssrLoadModule(CALLBACK);

    expect(loaded["later"]).toHaveLength(1);
    expect(buildSnapshot()[CALLBACK_HOME]).toBeUndefined();
    expect(listEntries()).toEqual([]);
  });
});

const MANY_HOME = "fixture/many.js";
const MANY = `${FIXTURE_DIR}/many.js`;

describe("a binding holding thousands of stores", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(
      {
        [MANY]:
          `import { atom } from "nanostores";\n` +
          `export const all = [];\n` +
          `for (let index = 0; index < 5000; index += 1) all.push(atom(index));\n`,
      },
      MANY,
    );
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("draws all of them, because nothing asked for a number", () => {
    const all = buildSnapshot()[MANY_HOME]?.["all"] as { data: Record<string, unknown> };

    expect(Object.keys(all.data)).toHaveLength(5000);
    expect(all.data["[4999] [store]"]).toBe(4999);
    expect(listEntries()).toHaveLength(5000);
  });
});

const CAPPED_HOME = "fixture/capped.js";
const CAPPED = `${FIXTURE_DIR}/capped.js`;

describe("a binding a max-members comment stands over", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(
      {
        [CAPPED]:
          `import { atom } from "nanostores";\n` +
          `const make = (open) => ({ $open: atom(open) });\n` +
          `const made = atom("past");\n` +
          `// @nanostores-devtools:max-members 2\n` +
          `export const rows = [make(false), [make(true), make(false), make(true)], made];\n`,
      },
      CAPPED,
    );
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("draws the number the comment named and a note that names the comment", () => {
    const rows = buildSnapshot()[CAPPED_HOME]?.["rows"] as { data: Record<string, unknown> };

    expect(Object.keys(rows.data)).toEqual(["[0]", "[1]", "…"]);
    expect(rows.data["…"]).toEqual({
      data: {},
      __serializedType__: "1 more members left out by `@nanostores-devtools:max-members 2`",
    });
  });

  /** The number bounds the whole binding, so the array inside it takes the same two. */
  it("caps a member of a member by the same number", () => {
    const rows = buildSnapshot()[CAPPED_HOME]?.["rows"] as { data: Record<string, unknown> };
    const inner = rows.data["[1]"] as { data: Record<string, unknown> };

    expect(Object.keys(inner.data)).toEqual(["[0]", "[1]", "…"]);
  });

  /** The creator call named it before the scan ran, so the cap leaves it drawn at its own file. */
  it("draws a store a wrapper registered past the number flat at its file", () => {
    expect(buildSnapshot()[CAPPED_HOME]?.["made [store]"]).toBe("past");
  });

  /** Every store the scan reached, and the one the wrapper named where the scan stopped. */
  it("registers no store past the number, at any depth", () => {
    expect(
      listEntries()
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["made", "rows[0].$open", "rows[1][0].$open", "rows[1][1].$open"]);
  });
});

const STORE_CAP_HOME = "fixture/store-capped.js";
const STORE_CAP = `${FIXTURE_DIR}/store-capped.js`;

describe("a store the same comment caps", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(
      {
        [STORE_CAP]:
          `import { atom } from "nanostores";\n` +
          `// @nanostores-devtools:max-members 2\n` +
          `export const $user = Object.assign(atom({ id: 1 }), {\n` +
          `  $name: Object.assign(atom("nan"), {\n` +
          `    $first: atom("na"), $last: atom("no"), $middle: atom("n"),\n` +
          `  }),\n` +
          `  $email: atom("n@n"),\n` +
          `  $phone: atom("0"),\n` +
          `});\n`,
      },
      STORE_CAP,
    );
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("draws its value, the members the comment named and a note that names the comment", () => {
    const user = buildSnapshot()[STORE_CAP_HOME]?.["$user [store]"] as Record<string, unknown>;

    expect(Object.keys(user)).toEqual(["(value)", "$email [store]", "$name [store]", "…"]);
    expect(user["…"]).toEqual({
      data: {},
      __serializedType__: "1 more members left out by `@nanostores-devtools:max-members 2`",
    });
  });

  /** The number bounds the whole binding, so a store held by a store takes the same two. */
  it("caps a store a capped store holds, and words its note the same", () => {
    const user = buildSnapshot()[STORE_CAP_HOME]?.["$user [store]"] as Record<string, unknown>;
    const name = user["$name [store]"] as Record<string, unknown>;

    expect(Object.keys(name)).toEqual(["(value)", "$first [store]", "$last [store]", "…"]);
    expect(name["…"]).toEqual({
      data: {},
      __serializedType__: "1 more members left out by `@nanostores-devtools:max-members 2`",
    });
  });

  it("registers no member past the number, at either depth", () => {
    expect(
      listEntries()
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["$user", "$user.$email", "$user.$name", "$user.$name.$first", "$user.$name.$last"]);
  });
});

const SPREAD_HOME = "fixture/spread.js";
const SPREAD = `${FIXTURE_DIR}/spread.js`;

describe("a spread copy of a store, held by a binding of its own", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(
      {
        [SPREAD]:
          `import { atom } from "nanostores";\n` +
          `export const $live = atom(1);\n` +
          `export const copy = { ...$live };\n`,
      },
      SPREAD,
    );
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /**
   * Nothing in an object's shape tells a copy from the store it came from, so the copy draws a row
   * of its own. That row is frozen at the value the spread took, which is a true picture of code
   * that is already wrong.
   */
  it("draws a row of its own, and keeps its value while the original moves", () => {
    const live = entryNamed("$live")?.store;

    if (live === undefined || !("set" in live)) {
      throw new Error("the fixture no longer holds a store this test can write to");
    }

    live.set(2);

    expect(buildSnapshot()[SPREAD_HOME]).toEqual({
      "$live [store]": 2,
      "copy [store]": unknownStore(1),
    });
  });
});

const EXPLICIT = `${FIXTURE_DIR}/explicit.js`;

describe("a store the developer registered by hand", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(
      {
        [EXPLICIT]:
          `import { atom } from "nanostores";\n` +
          `import { trackStores } from "nanostores-devtools";\n` +
          `export const $counter = atom(0);\n` +
          `export const box = { $counter };\n` +
          `trackStores("cart", { $counter });\n`,
      },
      EXPLICIT,
    );
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /**
   * The developer said where the store belongs, so the scan yields: it keeps the one entry, in the
   * group, under the name the group gave it. What the scan adds is the references it found, which
   * draw as repeats of a store that is still rooted where it was put.
   */
  it("keeps its group, its name and its flat placement, whatever the scan walked to", () => {
    expect(listEntries()).toHaveLength(1);
    expect(listEntries()[0]).toMatchObject({ name: "$counter", home: "cart", origin: "explicit" });
    expect(buildSnapshot()).toEqual({
      cart: { "$counter [store]": 0 },
      "fixture/explicit.js": { "$counter [store]": 0, box: { "$counter [store]": 0 } },
    });
  });
});

const KEPT_HOME = "fixture/kept.js";
const KEPT = `${FIXTURE_DIR}/kept.js`;

describe("the rows that were already right", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(
      {
        [`${FIXTURE_DIR}/makers.js`]:
          `import { atom } from "nanostores";\n` +
          `export function persistentAtom(key, initial) {\n  return atom(initial);\n}\n` +
          `export function userStore(id) {\n  return atom(id);\n}\n`,
        [KEPT]:
          `import { atom } from "nanostores";\n` +
          `import * as ns from "nanostores";\n` +
          `import * as api from "./makers.js";\n` +
          `import { persistentAtom, userStore } from "./makers.js";\n` +
          `export const $one = atom(0);\n` +
          `export const theme = persistentAtom("t", "dark");\n` +
          `export const $u = api.userStore(7);\n` +
          `export const $nsx = ns.atom(0);\n` +
          `export const holder = { $user: userStore(1) };\n` +
          `export const byId = Object.fromEntries([["r1"], ["r2"]].map(([id]) => [id, atom(id)]));\n`,
      },
      KEPT,
    );
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /** Six shapes the panel drew right before the scan registered anything, drawn the same after. */
  it("draws exactly what it drew before the scan started registering", () => {
    expect(buildSnapshot()[KEPT_HOME]).toEqual({
      "$one [store]": 0,
      "theme [store]": "dark",
      "$u [store]": 7,
      "$nsx [store]": unknownStore(0),
      holder: { "$user [store]": 1 },
      byId: { "r1 [store]": "r1", "r2 [store]": "r2" },
    });
  });
});

const GONE_HOME = "fixture/gone.js";
const GONE = `${FIXTURE_DIR}/gone.js`;

/**
 * Every shape the gate takes off the panel, in one file. Each of them runs: the point is not that
 * no store was made, it is that a store nothing in the source holds is drawn nowhere.
 */
const GONE_FILES: Record<string, string> = {
  [`${FIXTURE_DIR}/factories.js`]:
    `import { atom } from "nanostores";\n` +
    `export function userStore(id) {\n  return atom(id);\n}\n` +
    `export function init() {\n  return atom("i");\n}\n` +
    `export function make() {\n  return atom("m");\n}\n`,
  [GONE]:
    `import { atom } from "nanostores";\n` +
    `import { userStore, init, make } from "./factories.js";\n` +
    `export const seen = [];\n` +
    `seen.push(String(userStore(1)));\n` +
    `init();\n` +
    `function inside() {\n  const $x = atom("in");\n  return String($x);\n}\n` +
    `seen.push(inside());\n` +
    `function returned() {\n  return { $x: atom("r") };\n}\n` +
    `seen.push(String(returned().$x));\n` +
    `const reader = {\n  get $x() {\n    return make();\n  },\n};\n` +
    `seen.push(String(reader.$x));\n` +
    `{\n  const $x = atom("block");\n  seen.push(String($x));\n}\n` +
    `class Loose {\n  $x = make();\n}\n` +
    `seen.push(String(new Loose().$x));\n` +
    `export default make();\n`,
};

describe("a store the developer wrote nothing that holds", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(GONE_FILES, GONE);
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("draws none of them, and registers none of them", async () => {
    const loaded = await server.ssrLoadModule(GONE);

    /** Six stores really were made: what follows is a store nobody drew, not a store nobody made. */
    expect(loaded["seen"]).toHaveLength(6);
    expect(buildSnapshot()[GONE_HOME]).toBeUndefined();
    expect(listEntries()).toEqual([]);
  });
});

const LOOP_HOME = "fixture/loop.js";
const LOOP = `${FIXTURE_DIR}/loop.js`;

describe("a `const` in a top-level loop body", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(
      {
        [LOOP]:
          `import { atom } from "nanostores";\n` +
          `export const list = [];\n` +
          `for (const n of [1, 2]) {\n  const $x = atom(n);\n  list.push($x);\n}\n`,
      },
      LOOP,
    );
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /** The binding dies with the turn that made it, so the array it was pushed into is the holder. */
  it("registers nothing of its own, and draws its stores under the array that kept them", () => {
    expect(buildSnapshot()[LOOP_HOME]).toEqual({
      list: labelled("Array", { "[0] [store]": 1, "[1] [store]": 2 }),
    });
    expect(listEntries()).toHaveLength(2);
  });
});

const SAME_HOME = "fixture/same.js";
const SAME = `${FIXTURE_DIR}/same.js`;

describe("the rows the gate reaches by another route", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(
      {
        [SAME]:
          `import { atom } from "nanostores";\n` +
          `const first = true;\n` +
          `export const $ternary = first ? atom(1) : atom(2);\n` +
          `function makeLocal() {\n  return atom("local");\n}\n` +
          `export const $local = makeLocal();\n` +
          `class Box {\n  $v = atom("v");\n}\n` +
          `export const box = new Box();\n` +
          `// @nanostores-devtools:throttle\n` +
          `class Timer {\n  $tick = atom(0);\n}\n` +
          `export const timer = new Timer();\n`,
      },
      SAME,
    );
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /** A ternary, a local factory and a class field on a held instance: all three drew before. */
  it("draws exactly what it drew before the gate", () => {
    expect(buildSnapshot()[SAME_HOME]).toEqual({
      "$ternary [store]": 1,
      "$local [store]": "local",
      box: labelled("Box", { "$v [store]": "v" }),
      timer: labelled("Timer", { "$tick [store]": 0 }),
    });
  });
});

/**
 * One owner and one key name one store. When a second store lands at a key another store already
 * sits at, the first one loses its link to that owner. It keeps its entry, so whether it draws at
 * all comes down to whether it had registered before it lost the key.
 */
const OWNER_HOME = "fixture/owner.js";
const OWNER = `${FIXTURE_DIR}/owner.js`;
const REPLACER = `${FIXTURE_DIR}/replacer.js`;
const REPLACED_APP = `${FIXTURE_DIR}/replaced.js`;

describe("a store another file replaced at the key that held it", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(
      {
        [OWNER]:
          `import { atom } from "nanostores";\n` + `export const holder = { $x: atom(0) };\n`,
        [REPLACER]:
          `import { atom } from "nanostores";\n` +
          `import { holder } from "./owner.js";\n` +
          `holder.$x = atom(1);\n` +
          `export const box = holder;\n`,
        [REPLACED_APP]: `import "./replacer.js";\n`,
      },
      REPLACED_APP,
    );
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /**
   * The replaced store registered under `holder.$x` while the first file's scan ran, so it still
   * draws, flat, under the path it had then. `box` draws nothing: the first path to reach a store
   * is the one that heads it, and import order must not move that row.
   */
  it("draws the store that is there now under the binding, and the old one flat beside it", () => {
    expect(buildSnapshot()).toEqual({
      [OWNER_HOME]: {
        holder: { "$x [store]": 1 },
        "holder.$x [store]": 0,
      },
    });
  });
});

const REPLACED_HOME = "fixture/same-key.js";
const REPLACED = `${FIXTURE_DIR}/same-key.js`;

describe("a store the same file replaced at the key that held it", () => {
  let server: ViteDevServer;

  async function load(body: string): Promise<void> {
    resetDevtoolsGlobal();
    server = await devServer(
      { [REPLACED]: `import { atom } from "nanostores";\n${body}` },
      REPLACED,
    );
  }

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /**
   * A key of an object literal under a held binding is a named creation site, so the first store
   * was registered before the assignment took its key away. It keeps its own name and draws flat.
   */
  it("keeps the old store drawn when an object literal made it", async () => {
    await load(`export const holder = { $x: atom(0) };\nholder.$x = atom(1);\n`);

    expect(buildSnapshot()).toEqual({
      [REPLACED_HOME]: {
        "$x [store]": 0,
        holder: { "$x [store]": 1 },
      },
    });
  });

  /**
   * Both stores land by member assignment, which registers nothing on its own: only the scan at the
   * end of the body registers, and by then the key holds the second store. The first never had an
   * entry to keep.
   */
  it("draws the old store nowhere when a member assignment made it", async () => {
    await load(
      `const holder = {};\nholder.$x = atom(0);\nholder.$x = atom(1);\nexport { holder };\n`,
    );

    expect(buildSnapshot()).toEqual({ [REPLACED_HOME]: { holder: { "$x [store]": 1 } } });
    expect(listEntries()).toHaveLength(1);
  });
});

/**
 * The package is a bare id with no file extension, which the plugin transforms nothing of. So no
 * wrapper inside it files a kind, and the only kind a store from it can carry is the one the
 * package map names for the call that handed it over.
 */
const ASYNC_PKG = "async-pkg";
const AWAITED_HOME = "fixture/awaited.ts";
const AWAITED_APP = `${FIXTURE_DIR}/awaited.ts`;

const AWAITED_FILES: Record<string, string> = {
  [ASYNC_PKG]:
    `import { map } from "nanostores";\n` +
    `export async function loadSession() {\n` +
    `  return map({ user: "ada" });\n` +
    `}\n` +
    `export function readSession() {\n` +
    `  return map({ user: "grace" });\n` +
    `}\n` +
    `export async function loadConfig() {\n` +
    `  return { dark: true };\n` +
    `}\n`,
  [AWAITED_APP]:
    `import { loadSession, readSession, loadConfig } from "${ASYNC_PKG}";\n` +
    `export const $session = await loadSession();\n` +
    `export const $read = readSession();\n` +
    `export const config = await loadConfig();\n`,
};

describe("a store an untransformed package handed back through a promise", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: PROJECT_ROOT,
      plugins: [
        nanostoresDevtools({
          storeTypes: { [ASYNC_PKG]: { loadSession: "map", readSession: "map" } },
        }),
        memoryFixture(AWAITED_FILES),
      ],
    });

    await server.ssrLoadModule(AWAITED_APP);
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /** The wrapper sits outside the await, so it is handed the store and not the promise. */
  it("carries the kind the package map gives the call, rather than `unknown`", () => {
    expect(entryNamed("$session")).toMatchObject({ home: AWAITED_HOME, type: "map" });
  });

  it("draws its value, because the kind settled what it holds", () => {
    expect(buildSnapshot()[AWAITED_HOME]?.["$session [map]"]).toEqual({ user: "ada" });
  });

  it("changes nothing for the same package call written without an await", () => {
    expect(entryNamed("$read")).toMatchObject({ home: AWAITED_HOME, type: "map" });
  });

  it("registers nothing for an awaited call that hands back no store", () => {
    expect(
      listEntries()
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["$read", "$session"]);
  });
});

/**
 * A creation site is keyed by the name a call stands under plus its line, and a property names its
 * call by the bare key rather than by the path. So two creator calls under one key name on one
 * source line are one site holding two stores, and the second one is numbered. The same code over
 * two lines is two sites, each holding one store and each numbered 1.
 */
const SITE_HOME = "fixture/site.ts";
const SITE = `${FIXTURE_DIR}/site.ts`;

const ONE_LINE = `export const panels = { left: { $open: atom(false) }, right: { $open: atom(true) } };\n`;

const TWO_LINES =
  `export const panels = {\n` +
  `  left: { $open: atom(false) },\n` +
  `  right: { $open: atom(true) },\n` +
  `};\n`;

const BOTH_PANELS = {
  panels: {
    left: { "$open [store]": false },
    right: { "$open [store]": true },
  },
};

describe("two creator calls under one key name", () => {
  let server: ViteDevServer;

  async function load(body: string): Promise<void> {
    resetDevtoolsGlobal();
    server = await devServer({ [SITE]: `import { atom } from "nanostores";\n${body}` }, SITE);
  }

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /** One site made both, so the second store is told from the first by its number alone. */
  it("draws both stores from one line, and numbers the second one", async () => {
    await load(ONE_LINE);

    expect(entryNamed("panels.left.$open")).toMatchObject({
      number: 1,
      place: null,
      label: `${SITE_HOME}/panels.left.$open`,
    });
    expect(entryNamed("panels.right.$open")).toMatchObject({
      number: 2,
      place: null,
      label: `${SITE_HOME}/panels.right.$open #2`,
    });
    expect(buildSnapshot()[SITE_HOME]).toEqual(BOTH_PANELS);
  });

  /** The same code over two lines: two sites, so both stores are the first of their own site. */
  it("makes two sites of the same shape written over two lines, each numbered 1", async () => {
    await load(TWO_LINES);

    expect(entryNamed("panels.left.$open")).toMatchObject({
      number: 1,
      place: "line 3",
      label: `${SITE_HOME}/panels.left.$open (line 3)`,
    });
    expect(entryNamed("panels.right.$open")).toMatchObject({
      number: 1,
      place: "line 4",
      label: `${SITE_HOME}/panels.right.$open (line 4)`,
    });
    expect(buildSnapshot()[SITE_HOME]).toEqual(BOTH_PANELS);
  });

  /**
   * A third site takes `$open` on the next line, which makes the name ambiguous. The two-store site
   * is re-qualified by line, and it is `redisplay` walking the site's own list that carries the new
   * part to both stores it had already registered.
   */
  it("re-qualifies both stores of the site once a later site takes the same name", async () => {
    await load(`${ONE_LINE}export const more = { $open: atom(false) };\n`);

    expect(entryNamed("panels.left.$open")).toMatchObject({
      number: 1,
      place: "line 2",
      label: `${SITE_HOME}/panels.left.$open (line 2)`,
    });
    expect(entryNamed("panels.right.$open")).toMatchObject({
      number: 2,
      place: "line 2",
      label: `${SITE_HOME}/panels.right.$open (line 2) #2`,
    });
    expect(entryNamed("more.$open")).toMatchObject({
      number: 1,
      place: "line 3",
      label: `${SITE_HOME}/more.$open (line 3)`,
    });
  });
});

/**
 * A builder hands back a store at every step, and `query("rows")` starts at the same character as
 * `query("rows").limit(10)` that stands over it. Only the last step is the value the key holds, so
 * only that step is named, only that store registers, and the site holds one store rather than
 * two. The steps before it are throwaways the key never reaches, and they draw nowhere.
 */
const BUILDER_HOME = "fixture/builder.ts";
const BUILDER = `${FIXTURE_DIR}/builder.ts`;

describe("a builder whose every step hands back a store", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(
      {
        [`${FIXTURE_DIR}/query.ts`]:
          `import { atom } from "nanostores";\n` +
          `export function query(name) {\n` +
          `  const $step = atom({ name, limit: 0 });\n` +
          `  $step.limit = (limit) => atom({ name, limit });\n` +
          `  return $step;\n` +
          `}\n`,
        [BUILDER]:
          `import { query } from "./query.ts";\n` +
          `export const rows = { $data: query("rows").limit(10) };\n`,
      },
      BUILDER,
    );
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("registers the step the key holds, and nothing under a number", () => {
    expect(listEntries().map((entry) => entry.label)).toEqual([`${BUILDER_HOME}/rows.$data`]);
  });

  it("draws that one store under its key, and the first step nowhere", () => {
    expect(buildSnapshot()[BUILDER_HOME]).toEqual({
      rows: { "$data [store]": { name: "rows", limit: 10 } },
    });
  });
});

const PAIR_HOME = "fixture/pair.ts";
const PAIR = `${FIXTURE_DIR}/pair.ts`;

/** Every site of every module this run made, so a test can read what one site is holding. */
function sitesMade(): { name: string; line: number; made: number; held: number }[] {
  const scopes = peekDevtoolsGlobal()?.scopes.values() ?? [];

  return [...scopes].flatMap((scope) =>
    [...scope.sites.values()].map((state) => ({
      name: state.name,
      line: state.line,
      made: state.made,
      held: state.stores.length,
    })),
  );
}

describe("one store handed to two same-named keys on one line", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await devServer(
      {
        [PAIR]:
          `import { atom, type Atom } from "nanostores";\n` +
          `let cached: Atom<number> | null = null;\n` +
          `function same(): Atom<number> { cached ??= atom(0); return cached; }\n` +
          `export const pair = { a: { $s: same() }, b: { $s: same() } };\n`,
      },
      PAIR,
    );
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /**
   * Both keys reach the one site, and the dedupe guard in `take` catches the second arrival. What
   * the site made and what it holds is where that shows, so the test reads the site state itself.
   */
  it("holds the store once at the site both keys reach", () => {
    expect(sitesMade()).toEqual([{ name: "$s", line: 4, made: 1, held: 1 }]);
  });

  it("draws the one store under both keys, and gives it one entry", () => {
    expect(buildSnapshot()[PAIR_HOME]).toEqual({
      "cached [store]": 0,
      pair: { a: { "$s [store]": 0 }, b: { "$s [store]": 0 } },
    });
    expect(listEntries().map((entry) => entry.name)).toEqual(["cached"]);
  });
});

/** What the hook below is called as, which is less than Vite's own hook type spells out. */
type ResolveHook = (id: string) => string | null;

/**
 * The hook is a plain function on the plugin. The cast sits here rather than at the call site,
 * because Vite's own hook type carries a context and an options bag this hook never reads.
 */
function resolveHook(): ResolveHook {
  const plugin = nanostoresDevtools();

  if (typeof plugin.resolveId !== "function") {
    throw new Error("the plugin no longer resolves anything");
  }

  return plugin.resolveId as unknown as ResolveHook;
}

/**
 * A store file in a package that does not depend on this one cannot find the runtime by name, and
 * an SSR run hands the same name to Node, which searches the same wrong place. So the injected
 * import names a path of the plugin's own, and the plugin answers for it.
 */
describe("the runtime the injected import names", () => {
  it("answers for its own path with the runtime beside the plugin", () => {
    expect(resolveHook()("/@nanostores-devtools/runtime")).toBe(ownRuntimePath());
  });

  it("leaves every other import alone", () => {
    expect(resolveHook()(RUNTIME_MODULE)).toBeNull();
    expect(resolveHook()("nanostores")).toBeNull();
  });
});
