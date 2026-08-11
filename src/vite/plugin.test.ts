import { build, createServer, type Plugin, type ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDevtoolsGlobal } from "../global.ts";
import { listEntries, type StoreEntry } from "../registry.ts";
import { buildSnapshot } from "../snapshot.ts";
import { moduleKeys, nanostoresDevtools } from "./plugin.ts";

const ROOT = "/repo";

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

describe("moduleKeys", () => {
  it("makes the path relative to the project root with / separators", () => {
    expect(moduleKeys(idOf("src", "stores", "cart.ts"), ROOT)).toEqual({
      moduleKey: "src/stores/cart.ts",
      home: "src/stores/cart.ts",
    });
  });

  it("climbs out of the root for a file beside it", () => {
    expect(moduleKeys("/packages/ui/store.ts", "/packages/app")?.moduleKey).toBe("../ui/store.ts");
  });

  it("lets fileKey change the home and leaves the module key alone", () => {
    const keys = moduleKeys(idOf("src", "stores", "cart.ts"), ROOT, (file) =>
      file.replace(/^src\/stores\//, ""),
    );

    expect(keys).toEqual({ moduleKey: "src/stores/cart.ts", home: "cart.ts" });
  });

  it("takes the file part of an id that carries a query", () => {
    expect(moduleKeys(`${idOf("src", "app.ts")}?v=1`, ROOT)?.moduleKey).toBe("src/app.ts");
  });

  it("leaves a dependency, a virtual module and a non-script file alone", () => {
    expect(moduleKeys(idOf("node_modules", "nanostores", "index.js"), ROOT)).toBeUndefined();
    expect(moduleKeys(`\0${idOf("src", "virtual.ts")}`, ROOT)).toBeUndefined();
    expect(moduleKeys(idOf("src", "App.vue"), ROOT)).toBeUndefined();
    expect(moduleKeys(idOf("src", "style.css"), ROOT)).toBeUndefined();
  });

  it("takes every script extension", () => {
    for (const file of ["a.js", "a.mjs", "a.cjs", "a.jsx", "a.ts", "a.mts", "a.tsx"]) {
      expect(moduleKeys(idOf("src", file), ROOT)?.moduleKey).toBe(`src/${file}`);
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

/** This file's own directory, which is where the package's absolute paths are read from. */
const HERE = import.meta.url.slice("file://".length, import.meta.url.lastIndexOf("/"));
const PROJECT_ROOT = HERE.slice(0, -"/src/vite".length);

/**
 * The fixture is served from memory under the project root, so the module keys read like a real
 * app's and nothing is written to disk.
 */
const APP_HOME = "src/vite/fixture/app.ts";
const FIXTURE_DIR = `${HERE}/fixture`;
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

const fixture: Plugin = {
  name: "fixture",
  enforce: "pre",
  resolveId(id, importer) {
    if (id in FILES) {
      return id;
    }

    if (importer === undefined || !id.startsWith("./")) {
      return null;
    }

    const sibling = `${importer.slice(0, importer.lastIndexOf("/"))}/${id.slice(2)}`;

    return sibling in FILES ? sibling : null;
  },
  load: (id) => FILES[id] ?? null,
};

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
      plugins: [nanostoresDevtools(), fixture],
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
    expect(buildSnapshot()[APP_HOME]?.["$theme"]).toBe("dark");
  });

  it("puts a dependency's store in the tree with its type lost", () => {
    expect(entryNamed("$router")).toMatchObject({ home: APP_HOME, type: "unknown" });
  });

  it("marks the dependency's store, because an unknown type is not trusted unmounted", () => {
    expect(buildSnapshot()[APP_HOME]?.["$router"]).toMatchObject({
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
