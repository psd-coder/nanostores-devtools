import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fileHome, type ModuleRoots, moduleKeys } from "./module-keys.ts";

const ROOT = "/repo";
const ROOTS: ModuleRoots = { root: ROOT, projectRoot: ROOT };

/** This file's own directory, which is where the package's absolute paths are read from. */
const HERE = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");
const PROJECT_ROOT = HERE.slice(0, -"/src/discovery".length);

function idOf(...segments: string[]): string {
  return [ROOT, ...segments].join("/");
}

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

    expect(moduleKeys(`${PROJECT_ROOT}/src/runtime.ts`, own)).toBeUndefined();
    expect(moduleKeys(`${HERE}/transform.ts`, own)).toBeUndefined();
    expect(moduleKeys(`${PROJECT_ROOT}/app/src/app.ts`, own)?.moduleKey).toBe("app/src/app.ts");
  });

  it("takes every script extension", () => {
    for (const file of ["a.js", "a.mjs", "a.cjs", "a.jsx", "a.ts", "a.mts", "a.tsx"]) {
      expect(moduleKeys(idOf("src", file), ROOTS)?.moduleKey).toBe(`src/${file}`);
    }
  });
});
