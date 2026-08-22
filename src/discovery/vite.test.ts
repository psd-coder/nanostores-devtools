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
 * The two cases parsing every file is there for: `workspace.ts` imports no nanostores and binds no
 * `$` name, so nothing in the text of it says it holds stores at all. Only the scan appended to its
 * body puts the factory results under `panel` and reaches the instance it hides in a `WeakMap`.
 * Unparsed, none of these five stores would be drawn anywhere.
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

  it("attributes what it binds, and draws every registry entry exactly once", async () => {
    await load();

    expect(buildSnapshot()).toEqual({
      [WORKSPACE_HOME]: {
        panel: panelNode(320),
        sidebar: panelNode(240),
        hidden: labelled("WeakMap", { "ref#1": labelled("Editor", { "$value [store]": "draft" }) }),
      },
    });
    expect(listEntries()).toHaveLength(5);
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
