import { build, type Plugin } from "vite";
import { describe, expect, it } from "vitest";

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
