import { describe, expect, it } from "vitest";

import { createDiscovery, resolveStoreCap } from "./core.ts";
import type { ModuleKeys } from "./module-keys.ts";
import { loadParser } from "./parser.ts";

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

describe("createDiscovery", () => {
  const KEYS: ModuleKeys = { moduleKey: "src/stores/cart.ts", home: "stores", external: false };

  function discovery() {
    return createDiscovery({
      roots: { root: "/app", projectRoot: "/app" },
      loadParser,
      runtimeModule: "nanostores-devtools/runtime",
      hotReload: (clear) => `if (import.meta.hot) import.meta.hot.prune(() => { ${clear} });`,
    });
  }

  /** Every save re-transforms the file, and the typo is still there until the developer fixes it. */
  it("tells the developer about an unknown marker once, not on every save", async () => {
    const code = `import { atom } from "nanostores";\n// @devtools-ignored\nconst $a = atom(0);\n`;
    const plugin = discovery();
    const first = await plugin.run(code, KEYS);
    const second = await plugin.run(code, KEYS);

    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toContain(`"@devtools-ignored"`);
    expect(second.warnings).toEqual([]);
  });
});
