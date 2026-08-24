import { fileURLToPath } from "node:url";

import { build, createLogger, createServer, type Plugin, type ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDevtoolsGlobal } from "../global.ts";
import { listEntries, type StoreEntry } from "../stores/registry.ts";
import { buildSnapshot } from "../redux/render.ts";
import { labelled, panelNode } from "../testing/shapes.ts";
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
      resolve: { alias: { "nanostores-devtools/runtime": `${PROJECT_ROOT}/src/runtime.ts` } },
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
      resolve: { alias: { "nanostores-devtools/runtime": `${PROJECT_ROOT}/src/runtime.ts` } },
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
      resolve: { alias: { "nanostores-devtools/runtime": `${PROJECT_ROOT}/src/runtime.ts` } },
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

describe("a maxStoresPerSite the developer typed wrong", () => {
  let server: ViteDevServer;
  const warnings: string[] = [];

  beforeEach(async () => {
    resetDevtoolsGlobal();
    warnings.length = 0;
    server = await createServer({
      configFile: false,
      logLevel: "silent",
      customLogger: {
        ...createLogger("silent"),
        warn: (message) => {
          warnings.push(message);
        },
      },
      root: PROJECT_ROOT,
      plugins: [nanostoresDevtools({ maxStoresPerSite: -1 }), memoryFixture(FILES)],
      resolve: { alias: { "nanostores-devtools/runtime": `${PROJECT_ROOT}/src/runtime.ts` } },
    });

    await server.ssrLoadModule(APP);
  });

  afterEach(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /** The fixture is two files, so a warning per transform would land here twice. */
  it("warns once, naming the option and the number", () => {
    const named = warnings.filter((line) => line.includes("maxStoresPerSite"));

    expect(named).toHaveLength(1);
    expect(named[0]).toContain("-1");
  });

  it("registers the stores under the default cap instead of hanging on the first one", () => {
    expect(entryNamed("$theme")).toMatchObject({ home: APP_HOME });
    expect(entryNamed("$router")).toMatchObject({ home: APP_HOME });
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
      resolve: { alias: { "nanostores-devtools/runtime": `${PROJECT_ROOT}/src/runtime.ts` } },
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
    `export class Thing {\n  constructor(value) {\n    Object.assign(this, atom(value));\n  }\n}\n`,
  [HELD]:
    `import { $ready, $a, $b, $s, createClient, makeThings, Thing } from "${PKG}";\n` +
    `export const $d = $ready;\n` +
    `export const client = createClient();\n` +
    `export const group = { $a, $b };\n` +
    `const { $user, $cart } = makeThings();\n` +
    `export { $user, $cart };\n` +
    `export const $x = new Thing("t");\n` +
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
    resolve: {
      alias: {
        "nanostores-devtools/runtime": `${PROJECT_ROOT}/src/runtime.ts`,
        "nanostores-devtools": `${PROJECT_ROOT}/src/index.ts`,
      },
    },
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

  it("draws a store nested deeper than the three levels the walk used to stop at", () => {
    expect(held()["app"]).toEqual({ a: { b: { "c [store]": unknownStore("deep") } } });
  });

  it("gives every store it found one entry, at the file that holds it", () => {
    expect(listEntries().map((entry) => entry.home)).toEqual(Array(8).fill(HELD_HOME));
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
          `export const box = new Box();\n`,
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
    });
  });
});
