import { describe, expect, it } from "vitest";

import { KNOWN_STORE_TYPES, resolveStoreTypes } from "./store-types.ts";

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
    const { types: merged } = resolveStoreTypes(undefined);

    expect(merged.get("@nanostores/persistent")?.get("persistentMap")).toBe("map");
    expect(merged.size).toBe(Object.keys(KNOWN_STORE_TYPES).length);
  });

  it("adds a package nobody shipped", () => {
    const { types: merged } = resolveStoreTypes({ "@acme/state": { deep: "deepMap" } });

    expect(merged.get("@acme/state")?.get("deep")).toBe("deepMap");
    expect(merged.get("@nanostores/persistent")?.get("persistentAtom")).toBe("atom");
  });

  it("corrects one export of a shipped package and restates none of the rest", () => {
    const { types: merged } = resolveStoreTypes({
      "@nanostores/persistent": { persistentAtom: "map" },
    });

    expect(merged.get("@nanostores/persistent")?.get("persistentAtom")).toBe("map");
    expect(merged.get("@nanostores/persistent")?.get("persistentMap")).toBe("map");
    expect(merged.get("@nanostores/persistent")?.get("persistentJSON")).toBe("atom");
  });

  /** A plain object hands `constructor` and `toString` back as functions, which are no kinds. */
  it("knows no package and no export it was never given", () => {
    const { types: merged } = resolveStoreTypes({ "@acme/state": { make: "atom" } });

    expect(merged.get("constructor")).toBeUndefined();
    expect(merged.get("@acme/state")?.get("toString")).toBeUndefined();
  });
});

describe("refusing an entry the plugin cannot read", () => {
  it("says nothing about the map it ships, and nothing when the option is unset", () => {
    expect(resolveStoreTypes(undefined).warnings).toEqual([]);
    expect(resolveStoreTypes({ "@acme/state": { make: "atom" } }).warnings).toEqual([]);
  });

  it("refuses a kind it does not know, and names the package, the export and the value", () => {
    const { types, warnings } = resolveStoreTypes({ "@acme/state": { make: "Atom" } });

    expect(types.get("@acme/state")?.get("make")).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@acme/state");
    expect(warnings[0]).toContain("make");
    expect(warnings[0]).toContain(`"Atom"`);
    expect(warnings[0]).toContain("deepMap");
  });

  it("keeps every kind a store may carry, `unknown` among them", () => {
    for (const kind of ["atom", "map", "deepMap", "computed", "batched", "unknown"]) {
      const { types, warnings } = resolveStoreTypes({ "@acme/state": { make: kind } });

      expect(types.get("@acme/state")?.get("make")).toBe(kind);
      expect(warnings).toEqual([]);
    }
  });

  it("refuses a kind that is no string at all, and says so without throwing", () => {
    for (const kind of [1, null, {}, ["atom"], 1n, Symbol("atom"), () => "atom"]) {
      const { types, warnings } = resolveStoreTypes({ "@acme/state": { make: kind } });

      expect(types.get("@acme/state")?.get("make")).toBeUndefined();
      expect(warnings).toHaveLength(1);
    }
  });

  it("refuses a package value that is no object, and names the package and what it got", () => {
    const { types, warnings } = resolveStoreTypes({ "@acme/state": null });

    expect(types.get("@acme/state")).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@acme/state");
    expect(warnings[0]).toContain("null");
  });

  it("reads no export off a string and no export off an array", () => {
    for (const exports of ["ab", ["atom", "map"]]) {
      const { types, warnings } = resolveStoreTypes({ "@acme/state": exports });

      expect(types.get("@acme/state")).toBeUndefined();
      expect(warnings).toHaveLength(1);
    }
  });

  it("keeps the exports of a package one of whose entries was refused", () => {
    const { types, warnings } = resolveStoreTypes({
      "@acme/state": { deep: "deepMap", make: "Atom" },
    });

    expect(types.get("@acme/state")?.get("deep")).toBe("deepMap");
    expect(warnings).toHaveLength(1);
  });

  it("keeps every other package when one of them is refused whole", () => {
    const { types, warnings } = resolveStoreTypes({
      "@acme/broken": null,
      "@acme/state": { deep: "deepMap" },
    });

    expect(types.get("@acme/state")?.get("deep")).toBe("deepMap");
    expect(types.get("@nanostores/persistent")?.get("persistentMap")).toBe("map");
    expect(warnings).toHaveLength(1);
  });

  it("leaves a shipped export alone when the entry correcting it is refused", () => {
    const { types, warnings } = resolveStoreTypes({
      "@nanostores/persistent": { persistentAtom: "Atom" },
    });

    expect(types.get("@nanostores/persistent")?.get("persistentAtom")).toBe("atom");
    expect(warnings).toHaveLength(1);
  });

  it("refuses an option that is no map of packages, and keeps the map it ships", () => {
    for (const value of ["@acme/state", 1, null, [{ "@acme/state": { make: "atom" } }]]) {
      const { types, warnings } = resolveStoreTypes(value);

      expect(types.get("@nanostores/persistent")?.get("persistentMap")).toBe("map");
      expect(types.size).toBe(Object.keys(KNOWN_STORE_TYPES).length);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("storeTypes");
    }
  });
});
