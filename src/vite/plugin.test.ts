import { fileURLToPath } from "node:url";

import { build, createLogger, createServer, type Plugin, type ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDevtoolsGlobal } from "../global.ts";
import { listEntries, type StoreEntry } from "../registry.ts";
import { buildSnapshot } from "../redux/render.ts";
import { labelled, panelNode } from "../testing/shapes.ts";
import {
  fileHome,
  type ModuleRoots,
  moduleKeys,
  nanostoresDevtools,
  resolveStoreCap,
  type VitePluginOptions,
} from "./plugin.ts";

const ROOT = "/repo";
const ROOTS: ModuleRoots = { root: ROOT, projectRoot: ROOT };

/** This file's own directory, which is where the package's absolute paths are read from. */
const HERE = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");
const PROJECT_ROOT = HERE.slice(0, -"/src/vite".length);

function idOf(...segments: string[]): string {
  return [ROOT, ...segments].join("/");
}

describe("nanostoresDevtools", () => {
  it("runs on the dev server only, and before every other plugin", () => {
    const plugin = nanostoresDevtools();

    expect(plugin.name).toBe("nanostores-devtools");
    expect(plugin.apply).toBe("serve");
    expect(plugin.enforce).toBe("pre");
  });
});

describe("resolveStoreCap", () => {
  it("keeps a whole number of one or more, and Infinity, which is no cap at all", () => {
    expect(resolveStoreCap(1)).toEqual({ cap: 1, warning: undefined });
    expect(resolveStoreCap(50)).toEqual({ cap: 50, warning: undefined });
    expect(resolveStoreCap(Number.POSITIVE_INFINITY)).toEqual({
      cap: Number.POSITIVE_INFINITY,
      warning: undefined,
    });
  });

  it("takes the default without a warning when the option is unset", () => {
    expect(resolveStoreCap(undefined)).toEqual({ cap: 50, warning: undefined });
  });

  it("refuses every number no store count can be made of, and names option and value", () => {
    for (const value of [-1, 0, 2.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const { cap, warning } = resolveStoreCap(value);

      expect(cap).toBe(50);
      expect(warning).toContain("maxStoresPerSite");
      expect(warning).toContain(String(value));
    }
  });
});

describe("fileHome", () => {
  const roots: ModuleRoots = { root: "/repo/apps/web", projectRoot: "/repo" };

  it("keeps the short path for a file inside the Vite root", () => {
    expect(fileHome(roots, "/repo/apps/web/src/model.ts")).toEqual({
      home: "src/model.ts",
      external: false,
    });
  });

  it("measures a linked package from the project root instead of climbing out", () => {
    expect(fileHome(roots, "/repo/packages/nanobots/src/withUndo.ts")).toEqual({
      home: "packages/nanobots/src/withUndo.ts",
      external: true,
    });
  });

  it("draws a dependency under node_modules", () => {
    expect(fileHome(roots, "/repo/node_modules/@nanostores/router/index.js")).toEqual({
      home: "node_modules/@nanostores/router/index.js",
      external: true,
    });
  });

  it("calls a file inside the root the developer's own, whatever it is named", () => {
    expect(fileHome(roots, "/repo/apps/web/src/vendor/thing.ts")).toEqual({
      home: "src/vendor/thing.ts",
      external: false,
    });
  });

  it("keeps the full path of a file the project root cannot reach either", () => {
    expect(fileHome(roots, "/elsewhere/api-client/src/session.ts")).toEqual({
      home: "/elsewhere/api-client/src/session.ts",
      external: true,
    });
  });

  it("compares whole segments, so a sibling directory sharing a prefix stays outside", () => {
    expect(fileHome(roots, "/repo/apps/website/src/model.ts")).toEqual({
      home: "apps/website/src/model.ts",
      external: true,
    });
  });
});

describe("moduleKeys", () => {
  it("makes the path relative to the Vite root with / separators", () => {
    expect(moduleKeys(idOf("src", "stores", "cart.ts"), ROOTS)).toEqual({
      moduleKey: "src/stores/cart.ts",
      home: "src/stores/cart.ts",
      external: false,
    });
  });

  it("keeps the module key climbing out for a file the home measures from elsewhere", () => {
    expect(
      moduleKeys("/packages/ui/store.ts", { root: "/packages/app", projectRoot: "/" }),
    ).toEqual({ moduleKey: "../ui/store.ts", home: "packages/ui/store.ts", external: true });
  });

  it("lets fileKey change the home and leaves the module key alone", () => {
    const keys = moduleKeys(idOf("src", "stores", "cart.ts"), ROOTS, (file) =>
      file.replace(/^src\/stores\//, ""),
    );

    expect(keys).toEqual({ moduleKey: "src/stores/cart.ts", home: "cart.ts", external: false });
  });

  it("takes the file part of an id that carries a query", () => {
    expect(moduleKeys(`${idOf("src", "app.ts")}?v=1`, ROOTS)?.moduleKey).toBe("src/app.ts");
  });

  it("leaves a dependency, a virtual module and a non-script file alone", () => {
    expect(moduleKeys(idOf("node_modules", "nanostores", "index.js"), ROOTS)).toBeUndefined();
    expect(moduleKeys(`\0${idOf("src", "virtual.ts")}`, ROOTS)).toBeUndefined();
    expect(moduleKeys(idOf("src", "App.vue"), ROOTS)).toBeUndefined();
    expect(moduleKeys(idOf("src", "style.css"), ROOTS)).toBeUndefined();
  });

  it("leaves this package's own files alone, so a linked checkout stays untouched", () => {
    const own = { root: PROJECT_ROOT, projectRoot: PROJECT_ROOT };

    expect(moduleKeys(`${HERE}/runtime.ts`, own)).toBeUndefined();
    expect(moduleKeys(`${PROJECT_ROOT}/src/registry.ts`, own)).toBeUndefined();
    expect(moduleKeys(`${PROJECT_ROOT}/app/src/app.ts`, own)?.moduleKey).toBe("app/src/app.ts");
  });

  it("takes every script extension", () => {
    for (const file of ["a.js", "a.mjs", "a.cjs", "a.jsx", "a.ts", "a.mts", "a.tsx"]) {
      expect(moduleKeys(idOf("src", file), ROOTS)?.moduleKey).toBe(`src/${file}`);
    }
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
    expect(code).not.toContain("vite/runtime");
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

describe("a file that imports no nanostores creator", () => {
  let server: ViteDevServer;

  beforeEach(async () => {
    resetDevtoolsGlobal();
    server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: PROJECT_ROOT,
      plugins: [nanostoresDevtools(), memoryFixture(FILES)],
      resolve: { alias: { "nanostores-devtools/vite/runtime": `${HERE}/runtime.ts` } },
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

  it("puts a dependency's store in the tree with its type lost", () => {
    expect(entryNamed("$router")).toMatchObject({ home: APP_HOME, type: "unknown" });
  });

  it("marks the dependency's store, because an unknown type is not trusted unmounted", () => {
    expect(buildSnapshot()[APP_HOME]?.["$router [store]"]).toMatchObject({
      __serializedType__: "not mounted, may be stale",
    });
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
      resolve: { alias: { "nanostores-devtools/vite/runtime": `${HERE}/runtime.ts` } },
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
      resolve: { alias: { "nanostores-devtools/vite/runtime": `${HERE}/runtime.ts` } },
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
      resolve: { alias: { "nanostores-devtools/vite/runtime": `${HERE}/runtime.ts` } },
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
