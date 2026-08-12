import { atom, computed, deepMap, map, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDevtoolsGlobal } from "./global.ts";
import { registerStore, trackStores } from "./registry.ts";
import { buildSnapshot, type Snapshot } from "./snapshot.ts";

/** A real store keeping its own `value` and `lc` fields, over a prototype that throws. */
function hostileStore(value: unknown): Store {
  const store = atom<unknown>(value);

  store.get = () => {
    throw new Error("get() was called");
  };

  Object.setPrototypeOf(store, {
    get value() {
      throw new Error("a prototype getter was read");
    },
    get lc() {
      throw new Error("a prototype getter was read");
    },
  });

  return store;
}

/** The marked shape spelled out, so these tests pin the shape the panel receives. */
function stale(value: unknown): unknown {
  return { data: { $$value: value }, __serializedType__: "not mounted, may be stale" };
}

function slot(snapshot: Snapshot, home: string, name: string): unknown {
  return snapshot[home]?.[name];
}

/**
 * The two markers differ by one key holding `undefined`, which `toEqual` ignores, so the box is
 * also read key by key and the check does not depend on the matcher.
 */
function boxedKeys(value: unknown): string[] {
  if (!isMarked(value)) {
    throw new Error("the slot carries no marker");
  }

  return Object.keys(value.data);
}

function isMarked(value: unknown): value is { data: object } {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof value.data === "object" &&
    value.data !== null
  );
}

describe("buildSnapshot", () => {
  beforeEach(() => {
    resetDevtoolsGlobal();
  });

  afterEach(() => {
    resetDevtoolsGlobal();
  });

  it("is empty while nothing is registered", () => {
    expect(buildSnapshot()).toEqual({});
  });

  it("is two levels deep, home then store name, with $ kept in the name", () => {
    trackStores("cart", { $items: atom(["milk"]), $count: atom(1) });

    expect(buildSnapshot()).toEqual({
      cart: { $items: stale(["milk"]), $count: stale(1) },
    });
  });

  it("sorts groups before files, alphabetically inside each level", () => {
    registerStore({
      store: atom(1),
      name: "$b",
      home: "src/stores/zebra.ts",
      type: "atom",
      origin: "plugin",
      external: false,
    });
    registerStore({
      store: atom(2),
      name: "$a",
      home: "src/stores/apple.ts",
      type: "atom",
      origin: "plugin",
      external: false,
    });
    trackStores("shop", { $total: atom(3) });
    trackStores("auth", { $user: atom("me"), $session: atom("id") });

    const snapshot = buildSnapshot();

    expect(Object.keys(snapshot)).toEqual([
      "auth",
      "shop",
      "src/stores/apple.ts",
      "src/stores/zebra.ts",
    ]);
    expect(Object.keys(snapshot["auth"] ?? {})).toEqual(["$session", "$user"]);
  });

  it("sorts every external file after the developer's own, groups still first", () => {
    registerStore({
      store: atom(1),
      name: "$undo",
      home: "packages/nanobots/src/withUndo.ts",
      type: "atom",
      origin: "plugin",
      external: true,
    });
    registerStore({
      store: atom(2),
      name: "$route",
      home: "node_modules/@nanostores/router/index.js",
      type: "atom",
      origin: "plugin",
      external: true,
    });
    registerStore({
      store: atom(3),
      name: "$own",
      home: "src/vendor/thing.ts",
      type: "atom",
      origin: "plugin",
      external: false,
    });
    trackStores("shop", { $total: atom(4) });

    expect(Object.keys(buildSnapshot())).toEqual([
      "shop",
      "src/vendor/thing.ts",
      "node_modules/@nanostores/router/index.js",
      "packages/nanobots/src/withUndo.ts",
    ]);
  });

  it("gives each external file its own top-level node, with no wrapper around them", () => {
    registerStore({
      store: atom(1),
      name: "$undo",
      home: "packages/nanobots/src/withUndo.ts",
      type: "atom",
      origin: "plugin",
      external: true,
    });
    registerStore({
      store: atom(2),
      name: "$route",
      home: "node_modules/@nanostores/router/index.js",
      type: "atom",
      origin: "plugin",
      external: true,
    });

    expect(buildSnapshot()).toEqual({
      "node_modules/@nanostores/router/index.js": { $route: 2 },
      "packages/nanobots/src/withUndo.ts": { $undo: 1 },
    });
  });

  it("sorts a home holding at least one explicit store as a group", () => {
    const $plugin = atom(1);

    registerStore({
      store: $plugin,
      name: "$plugin",
      home: "src/stores/cart.ts",
      type: "atom",
      origin: "plugin",
      external: false,
    });
    registerStore({
      store: atom(2),
      name: "$other",
      home: "src/stores/apple.ts",
      type: "atom",
      origin: "plugin",
      external: false,
    });
    trackStores("src/stores/cart.ts", { $hand: atom(3) });

    expect(Object.keys(buildSnapshot())).toEqual(["src/stores/cart.ts", "src/stores/apple.ts"]);
  });

  it("puts a group named after a file on the same node the plugin uses", () => {
    const $plugin = atom(1);
    const $hand = atom(2);

    registerStore({
      store: $plugin,
      name: "$plugin",
      home: "src/stores/cart.ts",
      type: "atom",
      origin: "plugin",
      external: false,
    });
    trackStores("src/stores/cart.ts", { $hand });

    expect(buildSnapshot()).toEqual({
      "src/stores/cart.ts": { $plugin: 1, $hand: stale(2) },
    });
  });

  it("reads own fields only, so a throwing get() and throwing getters cost nothing", () => {
    const $safe = atom(1);

    trackStores("cart", { $safe, $hostile: hostileStore(7) });

    expect(buildSnapshot()).toEqual({
      cart: { $safe: stale(1), $hostile: stale(7) },
    });
    expect($safe.lc).toBe(0);
  });

  it("keeps every registered store as a key, mounted or not", () => {
    const $mounted = atom(1);
    const unbind = $mounted.listen(() => {});

    registerStore({
      store: $mounted,
      name: "$mounted",
      home: "cart",
      type: "atom",
      origin: "plugin",
      external: false,
    });
    registerStore({
      store: computed(atom(1), (count) => count + 1),
      name: "$never",
      home: "cart",
      type: "computed",
      origin: "plugin",
      external: false,
    });
    trackStores("cart", { $unknown: atom(2) });

    expect(Object.keys(buildSnapshot()["cart"] ?? {})).toEqual([
      "$mounted",
      "$never [computed]",
      "$unknown",
    ]);

    unbind();
  });

  describe("the type note", () => {
    it("leaves an atom and an unknown type bare", () => {
      registerStore({
        store: atom(1),
        name: "$atom",
        home: "cart",
        type: "atom",
        origin: "plugin",
        external: false,
      });
      trackStores("cart", { $adopted: atom(2) });

      expect(Object.keys(buildSnapshot()["cart"] ?? {})).toEqual(["$adopted", "$atom"]);
    });

    it("names every other type after the store", () => {
      registerStore({
        store: map({}),
        name: "$map",
        home: "cart",
        type: "map",
        origin: "plugin",
        external: false,
      });
      registerStore({
        store: deepMap({}),
        name: "$deep",
        home: "cart",
        type: "deepMap",
        origin: "plugin",
        external: false,
      });
      registerStore({
        store: computed(atom(1), (count) => count + 1),
        name: "$total",
        home: "cart",
        type: "computed",
        origin: "plugin",
        external: false,
      });
      registerStore({
        store: computed(atom(1), (count) => count + 1),
        name: "$slow",
        home: "cart",
        type: "batched",
        origin: "plugin",
        external: false,
      });

      expect(Object.keys(buildSnapshot()["cart"] ?? {})).toEqual([
        "$deep [deepMap]",
        "$map [map]",
        "$slow [batched]",
        "$total [computed]",
      ]);
    });

    it("sorts on the name alone, so the note never moves a store", () => {
      registerStore({
        store: atom(1),
        name: "$b",
        home: "cart",
        type: "atom",
        origin: "plugin",
        external: false,
      });
      registerStore({
        store: map({}),
        name: "$a",
        home: "cart",
        type: "map",
        origin: "plugin",
        external: false,
      });

      expect(Object.keys(buildSnapshot()["cart"] ?? {})).toEqual(["$a [map]", "$b"]);
    });

    it("sits behind the place suffix a name clash adds", () => {
      registerStore({
        store: computed(atom(1), (count) => count + 1),
        name: "$total (line 20)",
        home: "cart",
        type: "computed",
        origin: "plugin",
        external: false,
      });

      expect(Object.keys(buildSnapshot()["cart"] ?? {})).toEqual(["$total (line 20) [computed]"]);
    });
  });

  describe("the marker table", () => {
    it("leaves a mounted store bare, whatever its type", () => {
      const $source = atom(1);
      const $computed = computed($source, (count) => count + 1);
      const $unknown = atom("hi");
      const unbindComputed = $computed.listen(() => {});
      const unbindUnknown = $unknown.listen(() => {});

      registerStore({
        store: $computed,
        name: "$computed",
        home: "cart",
        type: "computed",
        origin: "plugin",
        external: false,
      });
      trackStores("cart", { $unknown });

      expect(buildSnapshot()).toEqual({ cart: { "$computed [computed]": 2, $unknown: "hi" } });

      unbindComputed();
      unbindUnknown();
    });

    it("leaves an unmounted atom, map and deepMap bare", () => {
      registerStore({
        store: atom(1),
        name: "$atom",
        home: "cart",
        type: "atom",
        origin: "plugin",
        external: false,
      });
      registerStore({
        store: map({ total: 2 }),
        name: "$map",
        home: "cart",
        type: "map",
        origin: "plugin",
        external: false,
      });
      registerStore({
        store: deepMap({ deep: { total: 3 } }),
        name: "$deepMap",
        home: "cart",
        type: "deepMap",
        origin: "plugin",
        external: false,
      });

      expect(buildSnapshot()).toEqual({
        cart: {
          $atom: 1,
          "$map [map]": { total: 2 },
          "$deepMap [deepMap]": { deep: { total: 3 } },
        },
      });
    });

    it("keeps an atom's slot the same shape after it mounts and unmounts", () => {
      const $atom = atom(1);

      registerStore({
        store: $atom,
        name: "$atom",
        home: "cart",
        type: "atom",
        origin: "plugin",
        external: false,
      });

      const before = buildSnapshot();
      const unbind = $atom.listen(() => {});

      unbind();

      expect(buildSnapshot()).toEqual(before);
      expect($atom.lc).toBe(0);
    });

    it("marks a computed that never mounted and holds no value as never computed", () => {
      registerStore({
        store: computed(atom(1), (count) => count + 1),
        name: "$total",
        home: "cart",
        type: "computed",
        origin: "plugin",
        external: false,
      });

      const total = slot(buildSnapshot(), "cart", "$total [computed]");

      expect(total).toStrictEqual({ data: {}, __serializedType__: "not mounted, never computed" });
      expect(boxedKeys(total)).toEqual([]);
    });

    it("marks a batched store that never mounted and holds no value as never computed", () => {
      registerStore({
        store: computed(atom(1), (count) => count + 1),
        name: "$batched",
        home: "cart",
        type: "batched",
        origin: "plugin",
        external: false,
      });

      expect(slot(buildSnapshot(), "cart", "$batched [batched]")).toStrictEqual({
        data: {},
        __serializedType__: "not mounted, never computed",
      });
    });

    it("marks a computed that mounted before and is unmounted now as may be stale", () => {
      const $source = atom(1);
      const $total = computed($source, (count) => count + 1);
      const entry = registerStore({
        store: $total,
        name: "$total",
        home: "cart",
        type: "computed",
        origin: "plugin",
        external: false,
      });
      const unbind = $total.listen(() => {});

      unbind();
      entry.everMounted = true;

      expect(buildSnapshot()).toEqual({ cart: { "$total [computed]": stale(2) } });
    });

    it("marks a batched store that mounted before and is unmounted now as may be stale", () => {
      const $source = atom(1);
      const $total = computed($source, (count) => count + 1);
      const entry = registerStore({
        store: $total,
        name: "$batched",
        home: "cart",
        type: "batched",
        origin: "plugin",
        external: false,
      });
      const unbind = $total.listen(() => {});

      unbind();
      entry.everMounted = true;

      expect(buildSnapshot()).toEqual({ cart: { "$batched [batched]": stale(2) } });
    });

    it("marks a computed known to have mounted but holding no value as may be stale", () => {
      const entry = registerStore({
        store: computed(atom(1), (count) => count + 1),
        name: "$total",
        home: "cart",
        type: "computed",
        origin: "plugin",
        external: false,
      });

      entry.everMounted = true;

      expect(slot(buildSnapshot(), "cart", "$total [computed]")).toStrictEqual(stale(undefined));
    });

    it("marks an unmounted store of unknown type as may be stale", () => {
      trackStores("cart", { $adopted: atom(5) });

      expect(buildSnapshot()).toEqual({ cart: { $adopted: stale(5) } });
    });

    it("marks an unknown store holding no value as may be stale, with the value boxed", () => {
      trackStores("cart", { $empty: atom(undefined) });

      const empty = slot(buildSnapshot(), "cart", "$empty");

      expect(empty).toStrictEqual(stale(undefined));
      expect(boxedKeys(empty)).toEqual(["$$value"]);
    });
  });

  describe("the marked shape", () => {
    it("boxes a primitive and an object the same way", () => {
      trackStores("cart", { $count: atom(12), $cart: atom({ total: 12 }) });

      expect(buildSnapshot()).toEqual({
        cart: {
          $count: { data: { $$value: 12 }, __serializedType__: "not mounted, may be stale" },
          $cart: {
            data: { $$value: { total: 12 } },
            __serializedType__: "not mounted, may be stale",
          },
        },
      });
    });

    it("marks a store that mounted and unmounted before connect as may be stale", () => {
      const $source = atom(1);
      const $total = computed($source, (count) => count + 1);
      const unbind = $total.listen(() => {});

      unbind();
      registerStore({
        store: $total,
        name: "$total",
        home: "cart",
        type: "computed",
        origin: "plugin",
        external: false,
      });

      expect(buildSnapshot()).toEqual({ cart: { "$total [computed]": stale(2) } });
    });
  });

  it("never mounts a store while building", () => {
    const $atom = atom(1);
    const $total = computed($atom, (count) => count + 1);

    registerStore({
      store: $atom,
      name: "$atom",
      home: "cart",
      type: "atom",
      origin: "plugin",
      external: false,
    });
    registerStore({
      store: $total,
      name: "$total",
      home: "cart",
      type: "computed",
      origin: "plugin",
      external: false,
    });
    buildSnapshot();

    expect($atom.lc).toBe(0);
    expect($total.lc).toBe(0);
  });
});
