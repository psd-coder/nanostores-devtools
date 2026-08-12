import { atom } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GLOBAL_KEY, resetDevtoolsGlobal } from "./global.ts";
import {
  getEntry,
  getEntryByLabel,
  listEntries,
  makeLabel,
  onRegistryChange,
  type Registration,
  registerStore,
  renameEntry,
  trackStores,
  untrack,
} from "./registry.ts";

function plugin(
  overrides: Partial<Registration> & Pick<Registration, "store" | "name">,
): Registration {
  return {
    home: "src/stores/cart.ts",
    type: "atom",
    origin: "plugin",
    external: false,
    fn: null,
    ...overrides,
  };
}

function labels(): string[] {
  return listEntries()
    .map((entry) => entry.label)
    .sort();
}

describe("registry", () => {
  beforeEach(() => {
    resetDevtoolsGlobal();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDevtoolsGlobal();
  });

  describe("trackStores", () => {
    it("registers every value under its object key with $ kept as written", () => {
      const $items = atom<string[]>([]);
      const $count = atom(0);

      trackStores("cart", { $items, $count });

      expect(labels()).toEqual(["cart/$count", "cart/$items"]);
      expect(getEntry($items)).toMatchObject({
        name: "$items",
        home: "cart",
        label: "cart/$items",
        type: "unknown",
        origin: "explicit",
        everMounted: false,
      });
    });

    it("attaches no hooks", () => {
      const $count = atom(0);

      trackStores("cart", { $count });

      expect($count.lc).toBe(0);
      expect(getEntry($count)?.unhook).toEqual([]);
    });

    it("keeps the first name when one store arrives under two names in one call", () => {
      const $count = atom(0);

      trackStores("cart", { $count, $total: $count });

      expect(labels()).toEqual(["cart/$count"]);
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('"$total" and "$count"');
    });

    it("moves a store to its second group and warns", () => {
      const $count = atom(0);

      trackStores("cart", { $count });
      trackStores("checkout", { $count });

      expect(labels()).toEqual(["checkout/$count"]);
      expect(listEntries()).toHaveLength(1);
      expect(getEntryByLabel("cart/$count")).toBeUndefined();
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain(
        'moved from group "cart" to "checkout"',
      );
    });

    it("replaces the store behind a taken label quietly, because that is a hot reload", () => {
      const $first = atom(0);
      const $second = atom(0);
      const unhook = vi.fn();

      trackStores("cart", { $count: $first });
      getEntry($first)?.unhook.push(unhook);
      trackStores("cart", { $count: $second });

      expect(listEntries()).toHaveLength(1);
      expect(getEntryByLabel("cart/$count")?.store).toBe($second);
      expect(getEntry($first)).toBeUndefined();
      expect(unhook).toHaveBeenCalledTimes(1);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it("re-registering the same store under the same label changes nothing", () => {
      const $count = atom(0);

      trackStores("cart", { $count });
      trackStores("cart", { $count });

      expect(listEntries()).toHaveLength(1);
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe("untrack", () => {
    it("removes every entry whose home is that group and runs each unhook", () => {
      const $items = atom<string[]>([]);
      const $count = atom(0);
      const $other = atom(0);
      const unhookItems = vi.fn();
      const unhookCount = vi.fn();

      trackStores("cart", { $items, $count });
      trackStores("checkout", { $other });
      getEntry($items)?.unhook.push(unhookItems);
      getEntry($count)?.unhook.push(unhookCount);

      untrack("cart");

      expect(labels()).toEqual(["checkout/$other"]);
      expect(getEntryByLabel("cart/$items")).toBeUndefined();
      expect(unhookItems).toHaveBeenCalledTimes(1);
      expect(unhookCount).toHaveBeenCalledTimes(1);
    });

    it("does nothing for an unknown group", () => {
      const $count = atom(0);

      trackStores("cart", { $count });
      untrack("nothing");

      expect(listEntries()).toHaveLength(1);
    });
  });

  describe("registerStore", () => {
    it("keeps one entry per store object", () => {
      const $count = atom(0);

      registerStore(plugin({ store: $count, name: "$count" }));
      registerStore(plugin({ store: $count, name: "$count" }));

      expect(listEntries()).toHaveLength(1);
    });

    it("takes the type it is given", () => {
      const $cart = atom({});

      registerStore(plugin({ store: $cart, name: "$cart", type: "deepMap" }));

      expect(getEntry($cart)?.type).toBe("deepMap");
    });

    it("holds where the file sits, and lets a group that takes the store move it home", () => {
      const $count = atom(0);
      const $hand = atom(0);

      registerStore(plugin({ store: $count, name: "$count", home: "vendor/x.ts", external: true }));

      expect(getEntry($count)?.external).toBe(true);

      trackStores("cart", { $count, $hand });

      expect(getEntry($count)).toMatchObject({ home: "cart", external: false });
      expect(getEntry($hand)?.external).toBe(false);
    });

    it("lets an explicit registration take the name and home while the plugin keeps the type", () => {
      const $count = atom(0);

      registerStore(plugin({ store: $count, name: "$counter", type: "computed" }));
      trackStores("cart", { $count });

      expect(getEntry($count)).toMatchObject({
        name: "$count",
        home: "cart",
        label: "cart/$count",
        type: "computed",
        origin: "explicit",
      });
      expect(getEntryByLabel("src/stores/cart.ts/$counter")).toBeUndefined();
    });

    it("lets a later plugin registration set the type without moving an explicit entry", () => {
      const $count = atom(0);

      trackStores("cart", { $count });
      registerStore(plugin({ store: $count, name: "$counter", type: "batched" }));

      expect(getEntry($count)).toMatchObject({
        name: "$count",
        home: "cart",
        label: "cart/$count",
        type: "batched",
        origin: "explicit",
      });
    });

    it("keeps the enclosing function of the site that registered the store last", () => {
      const $draft = atom("");

      registerStore(plugin({ store: $draft, name: "$draft", fn: "makeDraft" }));

      expect(getEntry($draft)?.fn).toBe("makeDraft");

      registerStore(plugin({ store: $draft, name: "$draft (line 4)", fn: null }));

      expect(getEntry($draft)?.fn).toBeNull();
    });

    it("leaves the enclosing function of an explicit entry alone", () => {
      const $count = atom(0);

      trackStores("cart", { $count });
      registerStore(plugin({ store: $count, name: "$counter", fn: "makeCounter" }));

      expect(getEntry($count)?.fn).toBeNull();
    });

    it("carries the name the site gave, without the number the registry added", () => {
      const $canUndo = atom(false);
      const $other = atom(false);

      registerStore(plugin({ store: $canUndo, name: "$canUndo #2", ownerName: "$canUndo" }));
      registerStore(plugin({ store: $other, name: "$typed" }));

      expect(getEntry($canUndo)?.ownerName).toBe("$canUndo");
      expect(getEntry($other)?.ownerName).toBe("$typed");
    });

    it("answers who holds a label without scanning", () => {
      const $count = atom(0);

      registerStore(plugin({ store: $count, name: "$count" }));

      expect(getEntryByLabel(makeLabel("src/stores/cart.ts", "$count"))?.store).toBe($count);
      expect(getEntryByLabel("cart/$count")).toBeUndefined();
    });

    it("warns once when 2000 stores are registered and evicts nothing", () => {
      const stores = Object.fromEntries(
        Array.from({ length: 2001 }, (_, index) => [`$store${index}`, atom(index)]),
      );

      trackStores("many", stores);

      expect(listEntries()).toHaveLength(2001);
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain("2000 stores are registered");
    });
  });

  describe("renameEntry", () => {
    it("moves the name, the home and the label of the entry the store already has", () => {
      const $canUndo = atom(false);

      registerStore(
        plugin({
          store: $canUndo,
          name: "$canUndo #2",
          ownerName: "$canUndo",
          home: "vendor/withUndo.ts",
          external: true,
        }),
      );
      renameEntry($canUndo, "$undoable", "src/model.ts");

      expect(listEntries()).toHaveLength(1);
      expect(getEntry($canUndo)).toMatchObject({
        name: "$undoable",
        ownerName: "$canUndo",
        home: "src/model.ts",
        label: "src/model.ts/$undoable",
        external: false,
      });
      expect(getEntryByLabel("vendor/withUndo.ts/$canUndo #2")).toBeUndefined();
    });

    it("leaves a name a group was given by hand alone", () => {
      const $count = atom(0);

      trackStores("cart", { $count });
      renameEntry($count, "$counter", "src/model.ts");

      expect(getEntry($count)).toMatchObject({ name: "$count", home: "cart" });
    });

    it("says the registry moved, so a listener redraws", () => {
      const $count = atom(0);
      const changed = vi.fn();

      registerStore(plugin({ store: $count, name: "$count" }));
      onRegistryChange(changed);
      renameEntry($count, "$counter", "src/model.ts");
      renameEntry($count, "$counter", "src/model.ts");

      expect(changed.mock.calls).toEqual([[{ kind: "update" }]]);
    });

    it("drops whatever else held the label it takes, as a registration does", () => {
      const $held = atom(1);
      const $taking = atom(2);

      registerStore(plugin({ store: $held, name: "$counter", home: "src/model.ts" }));
      registerStore(plugin({ store: $taking, name: "$inner", home: "src/model.ts" }));
      renameEntry($taking, "$counter", "src/model.ts");

      expect(labels()).toEqual(["src/model.ts/$counter"]);
      expect(getEntryByLabel("src/model.ts/$counter")?.store).toBe($taking);
    });

    it("does nothing for a store the registry never took", () => {
      expect(() => {
        renameEntry(atom(0), "$counter", "src/model.ts");
      }).not.toThrow();
      expect(listEntries()).toHaveLength(0);
    });
  });

  describe("the change callback", () => {
    it("fires when a store joins and when it leaves", () => {
      const changed = vi.fn();
      const $count = atom(0);

      onRegistryChange(changed);
      trackStores("cart", { $count });

      expect(changed).toHaveBeenCalledTimes(1);

      untrack("cart");

      expect(changed).toHaveBeenCalledTimes(2);
    });

    it("stays silent when nothing changed", () => {
      const changed = vi.fn();
      const $count = atom(0);

      trackStores("cart", { $count });
      onRegistryChange(changed);
      trackStores("cart", { $count });
      untrack("nothing");

      expect(changed).not.toHaveBeenCalled();
    });

    it("stops firing once removed", () => {
      const changed = vi.fn();

      onRegistryChange(changed)();
      trackStores("cart", { $count: atom(0) });

      expect(changed).not.toHaveBeenCalled();
    });
  });

  describe("the globalThis home", () => {
    it("creates nothing until the first registration", async () => {
      vi.resetModules();

      const fresh = await import("./index.ts");

      expect(Object.getOwnPropertySymbols(globalThis)).not.toContain(GLOBAL_KEY);

      fresh.trackStores("cart", { $count: atom(0) });

      expect(Object.getOwnPropertySymbols(globalThis)).toContain(GLOBAL_KEY);
    });

    it("is shared by two copies of the package", async () => {
      vi.resetModules();

      const copy = await import("./registry.ts");
      const $count = atom(0);

      copy.trackStores("cart", { $count });

      expect(getEntry($count)?.label).toBe("cart/$count");
    });
  });
});
