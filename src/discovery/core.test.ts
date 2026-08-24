import { describe, expect, it } from "vitest";

import {
  createDiscovery,
  type DiscoveryOptions,
  resolveAdoption,
  resolveMaxDepth,
  resolveStoreCap,
} from "./core.ts";
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

describe("resolveMaxDepth", () => {
  it("keeps a whole number of one or more, and Infinity, which walks a binding to the end", () => {
    expect(resolveMaxDepth(1)).toEqual({ depth: 1, warning: undefined });
    expect(resolveMaxDepth(Number.POSITIVE_INFINITY)).toEqual({
      depth: Number.POSITIVE_INFINITY,
      warning: undefined,
    });
  });

  /** Nothing is the answer, so the number lives in the walk alone and nothing here repeats it. */
  it("names no depth without a warning when the option is unset", () => {
    expect(resolveMaxDepth(undefined)).toEqual({ depth: undefined, warning: undefined });
  });

  it("refuses every number no count of steps can be made of, and names option and value", () => {
    for (const value of [-1, 0, 2.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const { depth, warning } = resolveMaxDepth(value);

      expect(depth).toBeUndefined();
      expect(warning).toContain("maxDepth");
      expect(warning).toContain(String(value));
    }
  });
});

describe("resolveAdoption", () => {
  it("keeps both settings", () => {
    expect(resolveAdoption(true)).toEqual({ adopt: true, warning: undefined });
    expect(resolveAdoption(false)).toEqual({ adopt: false, warning: undefined });
  });

  it("takes the wide rule without a warning when the option is unset", () => {
    expect(resolveAdoption(undefined)).toEqual({ adopt: true, warning: undefined });
  });

  it("refuses a value it cannot read, and names the option, the value and both settings", () => {
    for (const value of ["dollar-only", "$", 1, null]) {
      const { adopt, warning } = resolveAdoption(value);

      expect(adopt).toBe(true);
      expect(warning).toContain("adoptFactories");
      expect(warning).toContain(JSON.stringify(value));
      expect(warning).toContain("true");
      expect(warning).toContain("false");
    }
  });

  it("does not name dollar-only among the settings to pass", () => {
    expect(resolveAdoption(1).warning).not.toContain("dollar-only");
  });
});

describe("createDiscovery", () => {
  const KEYS: ModuleKeys = { moduleKey: "src/stores/cart.ts", home: "stores", external: false };

  function discovery(options: DiscoveryOptions = {}) {
    return createDiscovery({
      ...options,
      roots: { root: "/app", projectRoot: "/app" },
      loadParser,
      runtimeModule: "nanostores-devtools/runtime",
      hotReload: (clear) => `if (import.meta.hot) import.meta.hot.prune(() => { ${clear} });`,
    });
  }

  /** Every save re-transforms the file, and the typo is still there until the developer fixes it. */
  it("tells the developer about an unknown devtools comment once, not on every save", async () => {
    const code = `import { atom } from "nanostores";\n// @nanostores-devtools:ignored\nconst $a = atom(0);\n`;
    const plugin = discovery();
    const first = await plugin.run(code, KEYS);
    const second = await plugin.run(code, KEYS);

    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toContain(`"@nanostores-devtools:ignored"`);
    expect(second.warnings).toEqual([]);
  });

  it("writes the walk depth into the injected line only where the option named one", async () => {
    const code = `import { atom } from "nanostores";\nconst $a = atom(0);\n`;
    const plain = await discovery().run(code, KEYS);
    const deep = await discovery({ maxDepth: 4 }).run(code, KEYS);

    expect(plain.result.changed && plain.result.code).toContain(`"stores", 50, false)`);
    expect(deep.result.changed && deep.result.code).toContain(`"stores", 50, false, 4)`);
  });

  it("raises a refused storeTypes entry on the first file only", async () => {
    const code = `import { atom } from "nanostores";\nconst $a = atom(0);\n`;
    const plugin = discovery({
      // @ts-expect-error the option reaches a JavaScript config with no type to stop this value
      storeTypes: { "@acme/state": { make: "Atom" } },
    });
    const first = await plugin.run(code, KEYS);
    const second = await plugin.run(code, KEYS);

    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toContain("@acme/state");
    expect(second.warnings).toEqual([]);
  });
});
