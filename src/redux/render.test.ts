import { stringify } from "jsan";
import { atom, computed, deepMap, map, type Store, type WritableAtom } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDevtoolsGlobal } from "../global.ts";
import { ownBindings, ownField } from "../stores/ownership.ts";
import {
  listEntries,
  registerStore,
  type StoreEntry,
  type StoreType,
  trackStores,
  untrack,
} from "../stores/registry.ts";
import { buildSnapshot, type Snapshot } from "./render.ts";
import { createReplacer } from "./replacer.ts";
import { EXTENSION_OPTIONS, labelOf, parsePanel } from "../testing/panel.ts";
import { labelled } from "../testing/shapes.ts";

/** A class instance, which the replacer marks, so a store holding one carries two labels. */
class Point {
  x = 1;
}

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
  return { data: { "(value)": value }, __serializedType__: "not mounted, may be stale" };
}

/** The same marker over a value that goes in with no box at all: a plain object or an array. */
function staleBare(value: object): unknown {
  return { data: value, __serializedType__: "not mounted, may be stale" };
}

function slot(snapshot: Snapshot, home: string, name: string): unknown {
  return snapshot[home]?.[name];
}

/** The whole trip: written the way the extension writes it, read the way the panel reads it. */
function drawnTree(): unknown {
  return parsePanel(stringify(buildSnapshot(), createReplacer([]), null, EXTENSION_OPTIONS));
}

/** One level of a tree the panel's reviver has already been over, so its labels sit on symbols. */
function readNode(value: unknown, key: string): Record<string, unknown> {
  const node = isRecord(value) ? value[key] : undefined;

  if (!isRecord(node)) {
    throw new Error(`"${key}" holds no node`);
  }

  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

/**
 * Every number the tree draws. One store holding one number makes the count invariant a list: a
 * key that overwrote another loses its number, and a store drawn twice repeats one.
 */
function numbersIn(value: unknown): number[] {
  if (typeof value === "number") {
    return [value];
  }

  if (value === null || typeof value !== "object") {
    return [];
  }

  return Object.values(value).flatMap(numbersIn);
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
      cart: { "$items [store]": staleBare(["milk"]), "$count [store]": stale(1) },
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
    expect(Object.keys(snapshot["auth"] ?? {})).toEqual(["$session [store]", "$user [store]"]);
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
      "node_modules/@nanostores/router/index.js": { "$route [store]": 2 },
      "packages/nanobots/src/withUndo.ts": { "$undo [store]": 1 },
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
      "src/stores/cart.ts": { "$plugin [store]": 1, "$hand [store]": stale(2) },
    });
  });

  it("reads own fields only, so a throwing get() and throwing getters cost nothing", () => {
    const $safe = atom(1);

    trackStores("cart", { $safe, $hostile: hostileStore(7) });

    expect(buildSnapshot()).toEqual({
      cart: { "$safe [store]": stale(1), "$hostile [store]": stale(7) },
    });
    expect($safe.lc).toBe(0);
  });

  it("refuses an own value getter rather than run it, and draws the slot empty", () => {
    const $trapped = atom(1);
    const get = () => {
      throw new Error("app code ran");
    };

    Object.defineProperty($trapped, "value", { get, configurable: true });
    trackStores("cart", { $trapped });

    expect(buildSnapshot()).toEqual({ cart: { "$trapped [store]": stale(undefined) } });
  });

  describe("a value inside a store that refuses to be read", () => {
    /** A `Proxy` whose trap throws rather than answers, which no walk of ours can tell apart. */
    function refusing(): object {
      return new Proxy(
        { open: true },
        {
          ownKeys: (): never => {
            throw new Error("a trap ran");
          },
        },
      );
    }

    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("leaves the tree standing, so every other store keeps its slot", () => {
      const $safe = atom(1);

      trackStores("cart", { $safe, $remote: atom({ remote: refusing() }) });

      const snapshot = buildSnapshot();

      expect(Object.keys(snapshot["cart"] ?? {})).toEqual(["$remote [store]", "$safe [store]"]);
      expect(slot(snapshot, "cart", "$safe [store]")).toEqual(stale(1));
    });

    it("costs its own slot alone once the tree is written the way the panel reads it", () => {
      const $safe = atom(1);

      trackStores("cart", { $safe, $remote: atom({ remote: refusing() }) });

      const cart = readNode(drawnTree(), "cart");
      const held = readNode(cart, "$remote [store]");

      expect(readNode(cart, "$safe [store]")["(value)"]).toBe(1);
      expect(labelOf(held["remote"])).toBe("ConversionError");
      expect(readNode(held, "remote")["(value)"]).toBe("a trap ran");
    });
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
      "$mounted [store]",
      "$never [computed]",
      "$unknown [store]",
    ]);

    unbind();
  });

  describe("the type note", () => {
    it("gives an atom and an unknown type the same plain word", () => {
      registerStore({
        store: atom(1),
        name: "$atom",
        home: "cart",
        type: "atom",
        origin: "plugin",
        external: false,
      });
      trackStores("cart", { $adopted: atom(2) });

      expect(Object.keys(buildSnapshot()["cart"] ?? {})).toEqual([
        "$adopted [store]",
        "$atom [store]",
      ]);
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

      expect(Object.keys(buildSnapshot()["cart"] ?? {})).toEqual(["$a [map]", "$b [store]"]);
    });

    it("sits in front of the group a name clash adds, and of the number behind it", () => {
      registerStore({
        store: computed(atom(1), (count) => count + 1),
        name: "$total",
        place: "line 20",
        home: "cart",
        type: "computed",
        origin: "plugin",
        external: false,
      });

      registerStore({
        store: atom(1),
        name: "$counter",
        file: "app.ts",
        place: "makeCart, line 20",
        number: 2,
        home: "cart",
        type: "atom",
        origin: "plugin",
        external: false,
      });

      expect(Object.keys(buildSnapshot()["cart"] ?? {})).toEqual([
        "$counter [store] (app.ts, makeCart, line 20) #2",
        "$total [computed] (line 20)",
      ]);
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

      expect(buildSnapshot()).toEqual({
        cart: { "$computed [computed]": 2, "$unknown [store]": "hi" },
      });

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
          "$atom [store]": 1,
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

      expect(buildSnapshot()).toEqual({ cart: { "$adopted [store]": stale(5) } });
    });

    it("marks an unknown store holding no value as may be stale, with the value boxed", () => {
      trackStores("cart", { $empty: atom(undefined) });

      const empty = slot(buildSnapshot(), "cart", "$empty [store]");

      expect(empty).toStrictEqual(stale(undefined));
      expect(boxedKeys(empty)).toEqual(["(value)"]);
    });
  });

  describe("the marked shape", () => {
    it("boxes a primitive and lets a plain object and an array in bare", () => {
      trackStores("cart", {
        $count: atom(12),
        $cart: atom({ total: 12 }),
        $items: atom(["milk"]),
      });

      expect(buildSnapshot()).toEqual({
        cart: {
          "$count [store]": stale(12),
          "$cart [store]": staleBare({ total: 12 }),
          "$items [store]": staleBare(["milk"]),
        },
      });
    });

    it("boxes every value that would otherwise reach the panel with no label", () => {
      trackStores("cart", {
        $when: atom(new Date(0)),
        $pairs: atom(new Map([["a", 1]])),
        $members: atom(new Set([1])),
        $pattern: atom(/a/),
        $bytes: atom(new Uint8Array([1])),
        $failed: atom(new Error("boom")),
        $point: atom(new Point()),
        $nothing: atom<unknown>(null),
        $held: atom(atom(1)),
      });

      const tree = buildSnapshot();
      const names = Object.keys(tree["cart"] ?? {});

      expect(names).toHaveLength(9);

      for (const name of names) {
        expect(boxedKeys(slot(tree, "cart", name)), name).toEqual(["(value)"]);
      }
    });

    it("keeps every label through the panel's own reviver, over a whole tree", () => {
      trackStores("cart", {
        $count: atom(12),
        $cart: atom({ total: 12 }),
        $when: atom(new Date(0)),
        $point: atom(new Point()),
        $nothing: atom<unknown>(null),
      });

      const cart = readNode(drawnTree(), "cart");

      for (const name of ["$count", "$cart", "$when", "$point", "$nothing"]) {
        expect(labelOf(cart[`${name} [store]`]), name).toBe("not mounted, may be stale");
      }
    });

    it("keeps the label on a store its own value holds back", () => {
      const shared: Record<string, unknown> = {};
      const $inner = atom<unknown>(shared);

      shared["self"] = $inner;
      registerStore({
        store: $inner,
        name: "$inner",
        home: "cart",
        type: "atom",
        origin: "plugin",
        external: false,
      });

      const value = readNode(readNode(drawnTree(), "cart"), "$inner [store]");

      expect(labelOf(value["self"])).toBe("store");
      expect(Object.keys(Object(value["self"]))).toEqual(["(value)"]);
    });

    it("keeps the marker on a store its own value holds back", () => {
      const shared: Record<string, unknown> = {};
      const $inner = atom<unknown>(shared);

      shared["self"] = $inner;
      trackStores("cart", { $inner });

      const drawn = readNode(drawnTree(), "cart")["$inner [store]"];
      const held = Object(Reflect.get(Object(drawn), "(value)"));

      expect(labelOf(drawn)).toBe("not mounted, may be stale");
      expect(Object.keys(Object(drawn))).toEqual(["(value)"]);
      /** The key says which store, and the wrapper beside it says why the value cannot be read. */
      expect(Object.keys(held)).toEqual(["self [store]"]);
      expect(labelOf(held["self [store]"])).toBe("not mounted, may be stale");
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

  describe("the ownership tree", () => {
    const HOME = "src/model.ts";
    const FROM = { home: HOME, external: false, moduleKey: HOME };

    function track(
      store: Store,
      name: string,
      home = HOME,
      type: StoreType = "atom",
      place: string | null = null,
    ): StoreEntry {
      return registerStore({ store, name, home, type, place, origin: "plugin", external: false });
    }

    /**
     * One of several stores from a single creation site, which the registry numbers from two on.
     * The number sits beside the name, as the runtime records it, so the owner can leave it off.
     */
    function trackNumbered(
      store: Store,
      name: string,
      made: number,
      type: StoreType = "atom",
    ): StoreEntry {
      return registerStore({
        store,
        name,
        number: made,
        home: HOME,
        type,
        origin: "plugin",
        external: false,
      });
    }

    /** A store holding other stores beside its own value, which is what `Object.assign` builds. */
    function holder(value: unknown, held: Record<string, Store>): Store {
      return Object.assign(atom<unknown>(value), held);
    }

    function keysOf(home: string, name: string): string[] {
      const node = slot(buildSnapshot(), home, name);

      return node !== null && typeof node === "object" ? Object.keys(node) : [];
    }

    /** Every key is one store's place, `(value)` apart: it is the owner's own slot, not a store. */
    function countSlots(node: object): number {
      let count = 0;

      for (const [key, value] of Object.entries(node)) {
        if (key === "(value)") {
          continue;
        }

        count += 1;

        if (isNode(value)) {
          count += countSlots(value);
        }
      }

      return count;
    }

    function isNode(value: unknown): value is object {
      return typeof value === "object" && value !== null && "(value)" in value;
    }

    function drawnSlots(): number {
      return Object.values(buildSnapshot()).reduce((total, node) => total + countSlots(node), 0);
    }

    it("draws a store that owns others with its own value under (value)", () => {
      const $canUndo = atom(false);
      const $draft = holder("the quick brown fox ", { $canUndo });

      track($draft, "$draft");
      track($canUndo, "$canUndo");
      track(atom(""), "$typed");
      ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

      expect(buildSnapshot()).toEqual({
        [HOME]: {
          "$draft [store]": { "(value)": "the quick brown fox ", "$canUndo [store]": false },
          "$typed [store]": "",
        },
      });
      expect(keysOf(HOME, "$draft [store]")).toEqual(["(value)", "$canUndo [store]"]);
    });

    it("draws a store that owns nothing exactly as v1 draws it, with no wrapper", () => {
      track(atom("x"), "$typed");

      expect(buildSnapshot()).toEqual({ [HOME]: { "$typed [store]": "x" } });
    });

    it("nests a node inside a node", () => {
      const $position = atom(3);
      const $history = holder(["a"], { $position });
      const $draft = holder("", { $history });

      track($draft, "$draft");
      track($history, "$history");
      track($position, "$position");
      ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

      expect(buildSnapshot()).toEqual({
        [HOME]: {
          "$draft [store]": {
            "(value)": "",
            "$history [store]": { "(value)": ["a"], "$position [store]": 3 },
          },
        },
      });
    });

    it("keeps the marker inside (value), so the node itself carries no label", () => {
      const $child = atom(1);
      const $total = Object.assign(
        computed(atom(1), (count) => count + 1),
        { $child },
      );
      const entry = track($total, "$total", HOME, "computed");
      const unbind = $total.listen(() => {});

      unbind();
      entry.everMounted = true;
      track($child, "$child");
      ownBindings(FROM, [{ name: "$total", value: $total, exported: false }]);

      expect(buildSnapshot()).toEqual({
        [HOME]: { "$total [computed]": { "(value)": stale(2), "$child [store]": 1 } },
      });
    });

    it("costs one level and not two where the marked value is an object", () => {
      const $child = atom(1);
      const $total = Object.assign(
        computed(atom(1), () => ({ total: 12 })),
        { $child },
      );
      const entry = track($total, "$total", HOME, "computed");
      const unbind = $total.listen(() => {});

      unbind();
      entry.everMounted = true;
      track($child, "$child");
      ownBindings(FROM, [{ name: "$total", value: $total, exported: false }]);

      expect(buildSnapshot()).toEqual({
        [HOME]: {
          "$total [computed]": { "(value)": staleBare({ total: 12 }), "$child [store]": 1 },
        },
      });
    });

    it("keeps a store bare in its own slot and inside its owner's value alike", () => {
      const $canUndo = atom({ total: 12 });
      const $draft = holder({ from: $canUndo }, { $canUndo });

      track($draft, "$draft");
      track($canUndo, "$canUndo");
      ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

      const node = readNode(readNode(drawnTree(), HOME), "$draft [store]");
      const held = readNode(node["(value)"], "from [store]");

      expect(labelOf(held)).toBeUndefined();
      expect(Object.keys(held)).toEqual(["total"]);
      expect(node["$canUndo [store]"]).toEqual({ total: 12 });
      expect(labelOf(node["$canUndo [store]"])).toBeUndefined();
    });

    it("drops a nested store's ordinal, because the parent already says which one it is", () => {
      const $canUndo = atom(false);
      const $draft2 = holder("", { $canUndo });

      track($draft2, "$draft2");
      trackNumbered($canUndo, "$canUndo", 2);
      ownBindings(FROM, [{ name: "$draft2", value: $draft2, exported: false }]);

      expect(keysOf(HOME, "$draft2 [store]")).toEqual(["(value)", "$canUndo [store]"]);
    });

    /**
     * A class field is what puts two children of one name on one parent. The link holds no key of
     * its own, so each child falls back to the name its creation site gave, and two sites may agree.
     */
    function underOwner($parent: Store, ...held: Store[]): void {
      for (const store of held) {
        ownField(FROM, store, $parent);
      }
    }

    it("keeps the ordinal where one creation site put two stores on one parent", () => {
      const $first = atom(1);
      const $second = atom(2);
      const $draft = atom("");

      track($draft, "$draft");
      trackNumbered($first, "$row", 1, "atom");
      trackNumbered($second, "$row", 2, "atom");
      underOwner($draft, $first, $second);

      expect(keysOf(HOME, "$draft [store]")).toEqual([
        "(value)",
        "$row [store]",
        "$row [store] #2",
      ]);
    });

    /**
     * The clash rests on the name the tree draws, never on the key the view spells. The type word
     * moves when adoption learns a type, so a clash decided on it would qualify a pair one moment
     * and leave it bare the next.
     */
    it("qualifies two children of one name whose types differ", () => {
      const $count = atom(1);
      const $total = computed(atom(1), (count) => count + 1);
      const $draft = atom("");

      track($draft, "$draft");
      track($count, "$sum", HOME, "atom", "line 20");
      track($total, "$sum", HOME, "computed", "line 30");
      underOwner($draft, $count, $total);

      expect(keysOf(HOME, "$draft [store]")).toEqual([
        "(value)",
        "$sum [store] (line 20)",
        "$sum [computed] (line 30)",
      ]);
    });

    /** The throttle word comes and goes with a burst, so a key resting on it would move with it. */
    it("keeps a key's shape while a store starts and stops being throttled", () => {
      const $first = atom(1);
      const $second = atom(2);
      const $draft = atom("");

      track($draft, "$draft");
      const first = trackNumbered($first, "$row", 1, "atom");

      trackNumbered($second, "$row", 2, "atom");
      underOwner($draft, $first, $second);

      const bare = keysOf(HOME, "$draft [store]");

      first.throttle.marked = true;

      const held = keysOf(HOME, "$draft [store]");

      first.throttle.marked = false;

      expect(bare).toEqual(["(value)", "$row [store]", "$row [store] #2"]);
      expect(held).toEqual(["(value)", "$row [store, throttled]", "$row [store] #2"]);
      expect(keysOf(HOME, "$draft [store]")).toEqual(bare);
    });

    it("keeps two children of one name apart by the file each came from", () => {
      const $mine = atom(1);
      const $theirs = atom(2);
      const $draft = atom("");

      track($draft, "$draft");
      track($mine, "$history", HOME);
      track($theirs, "$history", "vendor/withUndo.ts");
      underOwner($draft, $mine, $theirs);

      expect(keysOf(HOME, "$draft [store]")).toEqual([
        "(value)",
        `$history [store] (${HOME})`,
        "$history [store] (vendor/withUndo.ts)",
      ]);
    });

    it("gives the home the one group, so no key of a home clash carries two", () => {
      const $mine = atom(1);
      const $theirs = atom(2);
      const $draft = atom("");

      track($draft, "$draft");
      track($mine, "$history", HOME, "atom", "line 20");
      track($theirs, "$history", "vendor/withUndo.ts", "atom", "line 20");
      underOwner($draft, $mine, $theirs);

      expect(keysOf(HOME, "$draft [store]")).toEqual([
        "(value)",
        `$history [store] (${HOME})`,
        "$history [store] (vendor/withUndo.ts)",
      ]);
    });

    it("keys a child by the property its owner holds it under, not the name it was born with", () => {
      const $lens = atom("ada");
      const $second = atom("");
      const $form = holder("", { username: $lens, password: $second });

      track($form, "$form");
      trackNumbered($lens, "$lens", 1);
      trackNumbered($second, "$lens", 2);
      ownBindings(FROM, [{ name: "$form", value: $form, exported: false }]);

      expect(keysOf(HOME, "$form [store]")).toEqual([
        "(value)",
        "password [store]",
        "username [store]",
      ]);
    });

    it("keeps the type note on a nested store's key", () => {
      const $total = computed(atom(1), (count) => count + 1);
      const $draft = holder("", { $total });

      track($draft, "$draft");
      trackNumbered($total, "$total", 2, "computed");
      ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

      expect(keysOf(HOME, "$draft [store]")).toEqual(["(value)", "$total [computed]"]);
    });

    it("draws a child in its owner's node, whatever home registered it", () => {
      const $canUndo = atom(false);
      const $draft = holder("", { $canUndo });

      track($draft, "$draft");
      track($canUndo, "$canUndo", "vendor/withUndo.ts");
      ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

      expect(buildSnapshot()).toEqual({
        [HOME]: { "$draft [store]": { "(value)": "", "$canUndo [store]": false } },
      });
    });

    it("registers the owner it walked through, so the store is drawn under it", () => {
      const $canUndo = atom(false);

      ownBindings(FROM, [{ name: "$draft", value: holder("", { $canUndo }), exported: false }]);
      track($canUndo, "$canUndo");

      expect(buildSnapshot()).toEqual({
        [HOME]: {
          "$draft [store]": {
            "(value)": labelled("not mounted, may be stale", { "(value)": "" }),
            "$canUndo [store]": false,
          },
        },
      });
    });

    it("draws every registry entry exactly once", () => {
      const $position = atom(3);
      const $history = holder(["a"], { $position });
      const $canUndo = atom(false);
      const $twin = atom(true);
      const $draft = holder("", { $canUndo, $history, $twin });
      const $orphan = atom(0);

      track($draft, "$draft");
      track($canUndo, "$canUndo");
      track($twin, "$canUndo", "vendor/withUndo.ts");
      track($history, "$history", "vendor/withUndo.ts");
      track($position, "$position", "vendor/withUndo.ts");
      track($orphan, "$orphan", "src/other.ts");
      trackStores("cart", { $items: atom([]) });
      ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

      expect(drawnSlots()).toBe(listEntries().length);
    });

    it("runs no getter and mounts nothing while drawing a node", () => {
      const $canUndo = atom(false);
      const $draft = Object.assign(hostileStore(7), { $canUndo });

      track($draft, "$draft");
      track($canUndo, "$canUndo");
      ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

      expect(buildSnapshot()).toEqual({
        [HOME]: { "$draft [store]": { "(value)": 7, "$canUndo [store]": false } },
      });
      expect($draft.lc).toBe(0);
      expect($canUndo.lc).toBe(0);
    });

    describe("a node", () => {
      class Editor {
        $value = atom("draft");
      }

      /** What one node holds, out from behind the type label, so a key list reads plainly. */
      function heldBy(name: string, home = HOME): Record<string, unknown> {
        const drawn = slot(buildSnapshot(), home, name);

        if (drawn === null || typeof drawn !== "object") {
          throw new Error(`"${name}" is no node`);
        }

        return Object.fromEntries(Object.entries(isMarked(drawn) ? drawn.data : drawn));
      }

      it("keys a class instance by its binding and labels it with its constructor", () => {
        const editorOne = new Editor();

        track(editorOne.$value, "$value");
        ownBindings(FROM, [{ name: "editorOne", value: editorOne, exported: false }]);

        expect(buildSnapshot()).toEqual({
          [HOME]: { editorOne: labelled("Editor", { "$value [store]": "draft" }) },
        });
      });

      it("keys a plain object a factory returned by its binding, and labels it with nothing", () => {
        const panel = { $open: atom(false) };

        track(panel.$open, "$open");
        ownBindings(FROM, [{ name: "panel", value: panel, exported: false }]);

        expect(buildSnapshot()).toEqual({ [HOME]: { panel: { "$open [store]": false } } });
      });

      it("walks an array by index, so an array of instances draws two levels", () => {
        const first = new Editor();
        const second = new Editor();

        trackNumbered(first.$value, "$value", 1);
        trackNumbered(second.$value, "$value", 2);
        ownBindings(FROM, [{ name: "drafts", value: [first, second], exported: false }]);

        expect(buildSnapshot()).toEqual({
          [HOME]: {
            drafts: labelled("Array", {
              "[0]": labelled("Editor", { "$value [store]": "draft" }),
              "[1]": labelled("Editor", { "$value [store]": "draft" }),
            }),
          },
        });
      });

      it("walks a Map by key", () => {
        const scratch = new Editor();

        track(scratch.$value, "$value");
        ownBindings(FROM, [
          { name: "byId", value: new Map([["scratch", scratch]]), exported: false },
        ]);

        expect(heldBy("byId")).toEqual({
          '["scratch"]': labelled("Editor", { "$value [store]": "draft" }),
        });
      });

      it("walks a Set in insertion order", () => {
        const first = new Editor();
        const second = new Editor();

        track(second.$value, "$second");
        track(first.$value, "$first");
        ownBindings(FROM, [{ name: "pool", value: new Set([first, second]), exported: false }]);

        expect(Object.keys(heldBy("pool"))).toEqual(["[0]", "[1]"]);
      });

      it("keys a bare store in a collection by its position, and keeps the type note", () => {
        const $width = atom(320);
        const $ratio = computed($width, (width) => width / 2);

        track($width, "$width");
        track($ratio, "$ratio", HOME, "computed");
        ownBindings(FROM, [{ name: "bounds", value: [$width, $ratio], exported: false }]);

        expect(Object.keys(heldBy("bounds"))).toEqual(["[0] [store]", "[1] [computed]"]);
        expect(heldBy("bounds")["[0] [store]"]).toBe(320);
      });

      it("draws a node the store that holds it keeps beside its own value", () => {
        const first = new Editor();
        const $draft = holder("", {});

        Object.assign($draft, { drafts: [first] });
        track($draft, "$draft");
        track(first.$value, "$value");
        ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

        expect(buildSnapshot()).toEqual({
          [HOME]: {
            "$draft [store]": {
              "(value)": "",
              drafts: labelled("Array", {
                "[0]": labelled("Editor", { "$value [store]": "draft" }),
              }),
            },
          },
        });
      });

      it("draws nothing for a node holding no store at all", () => {
        track(atom("x"), "$typed");
        ownBindings(FROM, [
          { name: "panel", value: { title: "Files", size: [1, 2] }, exported: false },
        ]);

        expect(buildSnapshot()).toEqual({ [HOME]: { "$typed [store]": "x" } });
      });

      it("gives a store's own slot no type label, because it already carries its marker", () => {
        /** A constructor over a store, so the tree has a type name it could wrongly reach for. */
        class Draft {}

        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        Object.setPrototypeOf($draft, Draft.prototype);
        track($draft, "$draft");
        track($canUndo, "$canUndo");
        ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

        expect(buildSnapshot()).toEqual({
          [HOME]: { "$draft [store]": { "(value)": "", "$canUndo [store]": false } },
        });
      });

      it("says what a capped collection left out, naming the number the binding carried", () => {
        const members = Array.from({ length: 4 }, () => ({ $open: atom(false) }));

        members.forEach((member, index) => {
          track(member.$open, index === 0 ? "$open" : `$open #${index + 1}`);
        });
        ownBindings(FROM, [{ name: "many", value: members, exported: false, maxMembers: 2 }]);

        const held = heldBy("many");

        expect(Object.keys(held)).toEqual(["[0]", "[1]", "…"]);
        expect(held["[0]"]).toEqual({ "$open [store]": false });
        expect(held["…"]).toEqual({
          data: {},
          __serializedType__: "2 more members left out by `@nanostores-devtools:max-members 2`",
        });
      });

      /** The scan stops at the number, so a store a wrapper already named keeps its own file row. */
      it("draws a store past the cap at its file, not under the collection", () => {
        const members = Array.from({ length: 3 }, () => ({ $open: atom(false) }));

        members.forEach((member, index) => {
          track(member.$open, index === 0 ? "$open" : `$open #${index + 1}`);
        });
        ownBindings(FROM, [{ name: "many", value: members, exported: false, maxMembers: 2 }]);

        expect(heldBy("many")["$open #3 [store]"]).toBeUndefined();
        expect(slot(buildSnapshot(), HOME, "$open #3 [store]")).toBe(false);
      });

      it("draws every member of a binding that named no number", () => {
        const members = Array.from({ length: 5000 }, () => ({ $open: atom(false) }));

        members.forEach((member, index) => {
          track(member.$open, index === 0 ? "$open" : `$open #${index + 1}`);
        });
        ownBindings(FROM, [{ name: "many", value: members, exported: false }]);

        const held = heldBy("many");

        expect(Object.keys(held)).toHaveLength(5000);
        expect(held["[4999]"]).toEqual({ "$open [store]": false });
      });

      it("draws every key of a plain object built at run time", () => {
        const members = Object.fromEntries(
          Array.from({ length: 5000 }, (_, index) => [`$key${index}`, atom(index)]),
        );

        Object.values(members).forEach((store, index) => {
          track(store, `$made #${index + 1}`);
        });
        ownBindings(FROM, [{ name: "made", value: members, exported: false }]);

        const held = heldBy("made");

        expect(Object.keys(held)).toHaveLength(5000);
        expect(held["$key4999 [store]"]).toBe(4999);
      });

      it("caps a plain object built at run time and names the comment in the note", () => {
        const members = Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [`$key${index}`, atom(index)]),
        );

        Object.values(members).forEach((store, index) => {
          track(store, `$made #${index + 1}`);
        });
        ownBindings(FROM, [{ name: "made", value: members, exported: false, maxMembers: 2 }]);

        const held = heldBy("made");

        expect(Object.keys(held)).toEqual(["$key0 [store]", "$key1 [store]", "…"]);
        expect(held["…"]).toEqual({
          data: {},
          __serializedType__: "3 more members left out by `@nanostores-devtools:max-members 2`",
        });
      });

      it("numbers a name two nodes of one home both want", () => {
        const panel = { $open: atom(false) };
        const sidebar = { $width: atom(320) };

        track(panel.$open, "$open");
        track(sidebar.$width, "$width");
        ownBindings(FROM, [
          { name: "panel", value: panel, exported: false },
          { name: "panel", value: sidebar, exported: false },
        ]);

        expect(buildSnapshot()).toEqual({
          [HOME]: {
            "panel #1": { "$open [store]": false },
            "panel #2": { "$width [store]": 320 },
          },
        });
      });

      it("tells a store from a node of one name, so the word takes the place of a number", () => {
        const panel = { $open: atom(false) };

        track(atom("bare"), "panel");
        track(panel.$open, "$open");
        ownBindings(FROM, [{ name: "panel", value: panel, exported: false }]);

        expect(buildSnapshot()).toEqual({
          [HOME]: { panel: { "$open [store]": false }, "panel [store]": "bare" },
        });
      });

      it("draws a store somebody else's binding holds flat at their file, under no node", () => {
        const panel = { $open: atom(false) };

        track(atom("x"), "$typed");
        registerStore({
          store: panel.$open,
          name: "$open",
          home: "node_modules/panel/index.ts",
          type: "atom",
          origin: "plugin",
          external: true,
        });
        ownBindings(
          {
            home: "node_modules/panel/index.ts",
            external: true,
            moduleKey: "node_modules/panel/index.ts",
          },
          [{ name: "panel", value: panel, exported: false }],
        );

        /** The store draws flat at its own home: the library hands it out, and no node holds it. */
        expect(buildSnapshot()).toEqual({
          [HOME]: { "$typed [store]": "x" },
          "node_modules/panel/index.ts": { "$open [store]": false },
        });
      });

      describe("a class field", () => {
        /** A class that places its own fields, `this` being what each initializer holds. */
        class Workbench {
          static $opened = atom(3);

          $value = atom(1);

          #hidden = atom(2);

          constructor() {
            ownField(FROM, this.$value, this);
            ownField(FROM, this.#hidden, this);
          }

          get hidden(): WritableAtom<number> {
            return this.#hidden;
          }
        }

        /** Two instances mean two stores from one creation site, which the registry numbers. */
        function trackFields(workbench: Workbench, made: number): void {
          trackNumbered(workbench.$value, "$value", made);
          trackNumbered(workbench.hidden, "#hidden", made);
        }

        it("draws an instance field, a private field and the class's statics", () => {
          const workbenchOne = new Workbench();

          ownField(FROM, Workbench.$opened, Workbench);
          track(Workbench.$opened, "$opened");
          trackFields(workbenchOne, 1);
          ownBindings(FROM, [{ name: "workbenchOne", value: workbenchOne, exported: false }]);

          expect(buildSnapshot()).toEqual({
            [HOME]: {
              Workbench: { "$opened [store]": 3 },
              workbenchOne: labelled("Workbench", { "#hidden [store]": 2, "$value [store]": 1 }),
            },
          });
        });

        it("keeps two instances apart, and neither steals the other's fields", () => {
          const workbenchOne = new Workbench();
          const workbenchTwo = new Workbench();

          trackFields(workbenchOne, 1);
          trackFields(workbenchTwo, 2);
          ownBindings(FROM, [
            { name: "workbenchOne", value: workbenchOne, exported: false },
            { name: "workbenchTwo", value: workbenchTwo, exported: false },
          ]);

          expect(buildSnapshot()).toEqual({
            [HOME]: {
              workbenchOne: labelled("Workbench", { "#hidden [store]": 2, "$value [store]": 1 }),
              workbenchTwo: labelled("Workbench", { "#hidden [store]": 2, "$value [store]": 1 }),
            },
          });
        });

        it("draws every store a class field placed exactly once", () => {
          const workbenchOne = new Workbench();
          const workbenchTwo = new Workbench();

          workbenchTwo.$value.set(4);
          workbenchTwo.hidden.set(5);
          ownField(FROM, Workbench.$opened, Workbench);
          track(Workbench.$opened, "$opened");
          trackFields(workbenchOne, 1);
          trackFields(workbenchTwo, 2);
          ownBindings(FROM, [{ name: "workbenchOne", value: workbenchOne, exported: false }]);

          expect(numbersIn(buildSnapshot()).sort((left, right) => left - right)).toEqual([
            1, 2, 3, 4, 5,
          ]);
        });
      });

      it("draws every registry entry exactly once, nodes and collections included", () => {
        /** One number per store, so a key that overwrote another leaves a number missing. */
        class Row {
          $value = atom(0);
        }

        const first = new Row();
        const second = new Row();
        const panel = { $open: atom(2) };
        const $typed = atom(3);

        second.$value.set(1);
        track(first.$value, "$value");
        track(second.$value, "$value #2");
        track(panel.$open, "$open");
        track($typed, "$typed");
        ownBindings(FROM, [
          { name: "drafts", value: [first, second], exported: false },
          { name: "byId", value: new Map([["scratch", panel]]), exported: false },
          { name: "$typed", value: $typed, exported: false },
        ]);

        expect(numbersIn(buildSnapshot()).sort((left, right) => left - right)).toEqual([
          0, 1, 2, 3,
        ]);
      });
    });

    describe("where a store is drawn", () => {
      it("keeps a store made at module level flat at the file level", () => {
        const $hits = atom(0);

        track($hits, "$hits");

        expect(buildSnapshot()).toEqual({ [HOME]: { "$hits [store]": 0 } });
      });

      it("leaves a store a class field placed where the field put it", () => {
        class Editor {
          $value = atom("draft");
        }

        const editorOne = new Editor();

        track(editorOne.$value, "$value");
        ownField(FROM, editorOne.$value, editorOne);
        ownBindings(FROM, [{ name: "editorOne", value: editorOne, exported: false }]);

        expect(buildSnapshot()).toEqual({
          [HOME]: {
            editorOne: { __serializedType__: "Editor", data: { "$value [store]": "draft" } },
          },
        });
      });

      it("leaves a store the binding scan placed where the scan put it", () => {
        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        track($canUndo, "$canUndo");
        track($draft, "$draft");
        ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

        expect(buildSnapshot()).toEqual({
          [HOME]: { "$draft [store]": { "(value)": "", "$canUndo [store]": false } },
        });
      });

      it("draws one the developer bound at the top level, however it was made", () => {
        const $hits = atom(0);

        track($hits, "$hits");
        ownBindings(FROM, [{ name: "$hits", value: $hits, exported: true }]);

        expect(buildSnapshot()).toEqual({ [HOME]: { "$hits [store]": 0 } });
      });
    });

    describe("the developer's own binding", () => {
      it("names the store, drawn flat, and its owner keeps a repeat of it", () => {
        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        track($draft, "$draft");
        track($canUndo, "$canUndo", "vendor/withUndo.ts");
        ownBindings(FROM, [
          { name: "$draft", value: $draft, exported: true },
          { name: "$canUndo", value: $canUndo, exported: true },
        ]);

        expect(buildSnapshot()).toEqual({
          [HOME]: {
            "$canUndo [store]": false,
            "$draft [store]": { "(value)": "", "$canUndo [store]": false },
          },
        });
      });

      it("keeps a renamed alias under the name it was given, and the owner's under its own", () => {
        const $canUndo = computed(atom(1), (count) => count > 0);
        const $draft2 = holder("", { $canUndo });

        /** Mounted, so the slot holds the value itself and the two keys read as one store. */
        $canUndo.listen(() => {});
        track($draft2, "$draft2");
        trackNumbered($canUndo, "$canUndo", 2, "computed");
        ownBindings(FROM, [
          { name: "$draft2", value: $draft2, exported: true },
          { name: "$undoable", value: $canUndo, exported: true },
        ]);

        expect(buildSnapshot()).toEqual({
          [HOME]: {
            "$undoable [computed]": true,
            "$draft2 [store]": { "(value)": "", "$canUndo [computed]": true },
          },
        });
      });

      it("resolves both placements to one entry, so one write moves both", () => {
        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        track($draft, "$draft");
        track($canUndo, "$canUndo");
        ownBindings(FROM, [
          { name: "$draft", value: $draft, exported: true },
          { name: "$canUndo", value: $canUndo, exported: true },
        ]);
        $canUndo.set(true);

        expect(listEntries()).toHaveLength(2);
        expect(buildSnapshot()).toEqual({
          [HOME]: {
            "$canUndo [store]": true,
            "$draft [store]": { "(value)": "", "$canUndo [store]": true },
          },
        });
      });

      it("draws every binding, and lets the exported one name the entry", () => {
        const $typed = atom("");

        track($typed, "$typed");
        ownBindings(FROM, [
          { name: "$typed", value: $typed, exported: false },
          { name: "$value", value: $typed, exported: true },
          { name: "$alias", value: $typed, exported: false },
        ]);

        expect(buildSnapshot()).toEqual({
          [HOME]: { "$alias [store]": "", "$typed [store]": "", "$value [store]": "" },
        });
        expect(listEntries()[0]?.name).toBe("$value");
      });

      it("keeps an exported binding's name against a plain one scanned after it", () => {
        const $typed = atom("");

        track($typed, "$typed");
        ownBindings(FROM, [
          { name: "$value", value: $typed, exported: true },
          { name: "$alias", value: $typed, exported: false },
        ]);

        expect(buildSnapshot()).toEqual({ [HOME]: { "$alias [store]": "", "$value [store]": "" } });
        expect(listEntries()[0]?.name).toBe("$value");
      });

      it("lets a binding in somebody else's file neither name nor nest the store it holds", () => {
        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        track($draft, "$draft");
        track($canUndo, "$canUndo");
        ownBindings(
          { home: "vendor/withUndo.ts", external: true, moduleKey: "vendor/withUndo.ts" },
          [
            { name: "$draft", value: $draft, exported: true },
            { name: "$canUndo", value: $canUndo, exported: true },
          ],
        );

        expect(buildSnapshot()).toEqual({
          [HOME]: { "$canUndo [store]": false, "$draft [store]": "" },
        });
      });

      it("leaves the name a group was given by hand alone, and draws the binding beside it", () => {
        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        track($draft, "$draft");
        trackStores("cart", { $canUndo });
        ownBindings(FROM, [
          { name: "$draft", value: $draft, exported: true },
          { name: "$undoable", value: $canUndo, exported: true },
        ]);

        expect(buildSnapshot()).toEqual({
          cart: { "$canUndo [store]": stale(false) },
          [HOME]: {
            "$draft [store]": { "(value)": "", "$canUndo [store]": stale(false) },
            "$undoable [store]": stale(false),
          },
        });
      });

      it("drops both placements with the entry when untrack removes its group", () => {
        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        track($draft, "$draft");
        trackStores("cart", { $canUndo });
        ownBindings(FROM, [
          { name: "$draft", value: $draft, exported: true },
          { name: "$canUndo", value: $canUndo, exported: true },
        ]);
        untrack("cart");

        expect(buildSnapshot()).toEqual({ [HOME]: { "$draft [store]": "" } });
      });

      it("draws one slot per entry, plus one for every repeat", () => {
        const $canUndo = atom(1);
        const $history = atom(2);
        const $draft = holder(3, { $canUndo, $history });

        track($draft, "$draft");
        track($canUndo, "$canUndo", "vendor/withUndo.ts");
        track($history, "$history", "vendor/withUndo.ts");
        track(atom(4), "$typed");
        ownBindings(FROM, [
          { name: "$draft", value: $draft, exported: true },
          { name: "$canUndo", value: $canUndo, exported: true },
          { name: "$entries", value: $history, exported: true },
        ]);

        expect(drawnSlots()).toBe(listEntries().length + 2);
        expect(numbersIn(buildSnapshot()).sort((left, right) => left - right)).toEqual([
          1, 1, 2, 2, 3, 4,
        ]);
      });
    });

    describe("many references to one value", () => {
      it("draws two bindings for one store as two nodes, and names the entry once", () => {
        const $draft = atom("");

        track($draft, "$draft");
        ownBindings(FROM, [
          { name: "$draft1", value: $draft, exported: true },
          { name: "$draft2", value: $draft, exported: true },
        ]);

        expect(buildSnapshot()).toEqual({
          [HOME]: { "$draft1 [store]": "", "$draft2 [store]": "" },
        });
        /** One store, one entry, one name: what the timeline and the by-name index both read. */
        expect(listEntries()).toHaveLength(1);
        expect(listEntries()[0]?.name).toBe("$draft2");
      });

      it("draws a binding written in another module at that module's own home", () => {
        const $draft = atom("");
        const other = { home: "src/aliases.ts", external: false, moduleKey: "src/aliases.ts" };

        track($draft, "$draft");
        ownBindings(FROM, [{ name: "$draft1", value: $draft, exported: true }]);
        ownBindings(other, [{ name: "$draft2", value: $draft, exported: true }]);

        expect(buildSnapshot()).toEqual({
          "src/aliases.ts": { "$draft2 [store]": "" },
          [HOME]: { "$draft1 [store]": "" },
        });
      });

      it("draws both containers that hold one store, with the store under each", () => {
        const $width = atom(0);
        const bounds = [$width];
        const layout = { width: $width };

        track($width, "$width", HOME);
        ownBindings(FROM, [
          { name: "bounds", value: bounds, exported: true },
          { name: "layout", value: layout, exported: true },
        ]);

        expect(buildSnapshot()).toEqual({
          [HOME]: {
            bounds: labelled("Array", { "[0] [store]": 0 }),
            layout: { "width [store]": 0 },
          },
        });
      });

      it("expands a node under its first container and says where the second one draws it", () => {
        const $w = atom(0);
        const shared = { $w };
        const a = { shared };
        const b = { shared };

        track($w, "$w", HOME);
        ownBindings(FROM, [
          { name: "a", value: a, exported: true },
          { name: "b", value: b, exported: true },
        ]);

        expect(buildSnapshot()).toEqual({
          [HOME]: {
            a: { shared: { "$w [store]": 0 } },
            b: { shared: { "(drawn under)": `${HOME}/a` } },
          },
        });
      });

      it("draws a node two collections hold under both, under the key each one knows it by", () => {
        class Editor {
          $value = atom("");
        }

        const editor = new Editor();
        const pool = new Set([editor]);
        const drafts = [editor];

        track(editor.$value, "$value", HOME);
        ownField(FROM, editor.$value, editor);
        ownBindings(FROM, [
          { name: "drafts", value: drafts, exported: true },
          { name: "pool", value: pool, exported: true },
        ]);

        expect(buildSnapshot()).toEqual({
          [HOME]: {
            drafts: labelled("Array", {
              "[0]": labelled("Editor", { "$value [store]": "" }),
            }),
            pool: labelled("Set", {
              "[0]": labelled("Editor", { "(drawn under)": `${HOME}/drafts` }),
            }),
          },
        });
      });
    });

    describe("a group written by hand", () => {
      it("draws the store at its group, whatever owner the walk recorded", () => {
        const $route = atom("/");
        const router = holder("", { $route });

        track(router, "router");
        track($route, "$route", "node_modules/@nanostores/router/index.js");
        trackStores("debug", { $route });
        ownBindings(FROM, [{ name: "router", value: router, exported: true }]);

        expect(buildSnapshot()).toEqual({
          debug: { "$route [store]": "/" },
          [HOME]: { "router [store]": { "(value)": "", "$route [store]": "/" } },
        });
      });

      it("leaves the owner's repeat under the name the owner knows the store by", () => {
        const $route = atom("/");
        const router = holder("", { $route });

        track(router, "router");
        track($route, "$route", "node_modules/@nanostores/router/index.js");
        trackStores("debug", { route: $route });
        ownBindings(FROM, [{ name: "router", value: router, exported: true }]);

        expect(buildSnapshot()).toEqual({
          debug: { "route [store]": "/" },
          [HOME]: { "router [store]": { "(value)": "", "$route [store]": "/" } },
        });
      });

      it("keys the repeat by the property the owner holds it under, not the group", () => {
        const $route = atom("/");
        const router = holder("", { $route });

        track(router, "router");
        trackStores("debug", { route: $route });
        ownBindings(FROM, [{ name: "router", value: router, exported: true }]);

        expect(buildSnapshot()).toEqual({
          debug: { "route [store]": stale("/") },
          [HOME]: { "router [store]": { "(value)": "", "$route [store]": stale("/") } },
        });
      });

      it("keeps the stores it owns under it, at the group it was given", () => {
        const $params = atom({ id: "1" });
        const $route = holder("/", { $params });
        const router = holder("", { $route });

        track(router, "router");
        track($route, "$route");
        track($params, "$params");
        trackStores("debug", { $route });
        ownBindings(FROM, [{ name: "router", value: router, exported: true }]);

        expect(buildSnapshot()).toEqual({
          debug: { "$route [store]": { "(value)": "/", "$params [store]": { id: "1" } } },
          [HOME]: { "router [store]": { "(value)": "", "$route [store]": "/" } },
        });
      });

      it("draws one slot per entry, plus one for the repeat its owner keeps", () => {
        const $canUndo = atom(1);
        const $draft = holder(2, { $canUndo });

        track($draft, "$draft");
        track($canUndo, "$canUndo", "vendor/withUndo.ts");
        trackStores("debug", { $canUndo });
        ownBindings(FROM, [{ name: "$draft", value: $draft, exported: true }]);

        expect(drawnSlots()).toBe(listEntries().length + 1);
        expect(numbersIn(buildSnapshot()).sort((left, right) => left - right)).toEqual([1, 1, 2]);
      });
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
