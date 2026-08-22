import { describe, expect, it } from "vitest";

import { KNOWN_STORE_TYPES, mergeStoreTypes } from "./store-types.ts";

describe("the map the plugin ships", () => {
  it("names the packages it was built from", () => {
    expect(Object.keys(KNOWN_STORE_TYPES).toSorted()).toEqual([
      "@alexcarpenter/form",
      "@alexcarpenter/machine",
      "@illuxiza/nanostores-immer",
      "@logux/client",
      "@nanostores/async",
      "@nanostores/deepmap",
      "@nanostores/i18n",
      "@nanostores/media-query",
      "@nanostores/persistent",
      "@nanostores/router",
      "@nanostores/sql",
    ]);
  });

  it("names at least one export for every package", () => {
    const empty = Object.entries(KNOWN_STORE_TYPES).filter(
      ([, exports]) => Object.keys(exports).length === 0,
    );

    expect(empty).toEqual([]);
  });
});

describe("merging a developer's own entries", () => {
  it("keeps the built-in map when nothing is added", () => {
    const merged = mergeStoreTypes(undefined);

    expect(merged.get("@nanostores/persistent")?.get("persistentMap")).toBe("map");
    expect(merged.size).toBe(Object.keys(KNOWN_STORE_TYPES).length);
  });

  it("adds a package nobody shipped", () => {
    const merged = mergeStoreTypes({ "@acme/state": { deep: "deepMap" } });

    expect(merged.get("@acme/state")?.get("deep")).toBe("deepMap");
    expect(merged.get("@nanostores/persistent")?.get("persistentAtom")).toBe("atom");
  });

  it("corrects one export of a shipped package and restates none of the rest", () => {
    const merged = mergeStoreTypes({ "@nanostores/persistent": { persistentAtom: "map" } });

    expect(merged.get("@nanostores/persistent")?.get("persistentAtom")).toBe("map");
    expect(merged.get("@nanostores/persistent")?.get("persistentMap")).toBe("map");
    expect(merged.get("@nanostores/persistent")?.get("persistentJSON")).toBe("atom");
  });

  /** A plain object hands `constructor` and `toString` back as functions, which are no kinds. */
  it("knows no package and no export it was never given", () => {
    const merged = mergeStoreTypes({ "@acme/state": { make: "atom" } });

    expect(merged.get("constructor")).toBeUndefined();
    expect(merged.get("@acme/state")?.get("toString")).toBeUndefined();
  });
});
