import { stringify } from "jsan";
import { atom, computed, deepMap, map, type Store, type WritableAtom } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDevtoolsGlobal } from "./global.ts";
import {
  beginFrame,
  endFrame,
  MAX_MEMBERS,
  noteBirth,
  ownBindings,
  ownField,
} from "./ownership.ts";
import {
  listEntries,
  registerStore,
  type StoreEntry,
  type StoreType,
  trackStores,
  untrack,
} from "./registry.ts";
import { createReplacer } from "./replacer.ts";
import { buildSnapshot, type Snapshot } from "./snapshot.ts";
import { EXTENSION_OPTIONS, labelOf, parsePanel } from "./testing/panel.ts";
import { labelled } from "./testing/shapes.ts";

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
      fn: null,
    });
    registerStore({
      store: atom(2),
      name: "$a",
      home: "src/stores/apple.ts",
      type: "atom",
      origin: "plugin",
      external: false,
      fn: null,
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
      fn: null,
    });
    registerStore({
      store: atom(2),
      name: "$route",
      home: "node_modules/@nanostores/router/index.js",
      type: "atom",
      origin: "plugin",
      external: true,
      fn: null,
    });
    registerStore({
      store: atom(3),
      name: "$own",
      home: "src/vendor/thing.ts",
      type: "atom",
      origin: "plugin",
      external: false,
      fn: null,
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
      fn: null,
    });
    registerStore({
      store: atom(2),
      name: "$route",
      home: "node_modules/@nanostores/router/index.js",
      type: "atom",
      origin: "plugin",
      external: true,
      fn: null,
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
      fn: null,
    });
    registerStore({
      store: atom(2),
      name: "$other",
      home: "src/stores/apple.ts",
      type: "atom",
      origin: "plugin",
      external: false,
      fn: null,
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
      fn: null,
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
      fn: null,
    });
    registerStore({
      store: computed(atom(1), (count) => count + 1),
      name: "$never",
      home: "cart",
      type: "computed",
      origin: "plugin",
      external: false,
      fn: null,
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
        fn: null,
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
        fn: null,
      });
      registerStore({
        store: deepMap({}),
        name: "$deep",
        home: "cart",
        type: "deepMap",
        origin: "plugin",
        external: false,
        fn: null,
      });
      registerStore({
        store: computed(atom(1), (count) => count + 1),
        name: "$total",
        home: "cart",
        type: "computed",
        origin: "plugin",
        external: false,
        fn: null,
      });
      registerStore({
        store: computed(atom(1), (count) => count + 1),
        name: "$slow",
        home: "cart",
        type: "batched",
        origin: "plugin",
        external: false,
        fn: null,
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
        fn: null,
      });
      registerStore({
        store: map({}),
        name: "$a",
        home: "cart",
        type: "map",
        origin: "plugin",
        external: false,
        fn: null,
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
        fn: null,
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
        fn: null,
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
        fn: null,
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
        fn: null,
      });
      registerStore({
        store: map({ total: 2 }),
        name: "$map",
        home: "cart",
        type: "map",
        origin: "plugin",
        external: false,
        fn: null,
      });
      registerStore({
        store: deepMap({ deep: { total: 3 } }),
        name: "$deepMap",
        home: "cart",
        type: "deepMap",
        origin: "plugin",
        external: false,
        fn: null,
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
        fn: null,
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
        fn: null,
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
        fn: null,
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
        fn: null,
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
        fn: null,
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
        fn: null,
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
        fn: null,
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
        fn: null,
      });

      expect(buildSnapshot()).toEqual({ cart: { "$total [computed]": stale(2) } });
    });
  });

  describe("the ownership tree", () => {
    const HOME = "src/model.ts";
    const FROM = { home: HOME, external: false, moduleKey: HOME };

    /**
     * `fn` is the function the store was made inside, `null` at module level. A store made at module
     * level stands at a site of its own, so only one made inside a function needs a frame to place
     * it, and a test about the frame has to say which it is.
     */
    function track(
      store: Store,
      name: string,
      home = HOME,
      type: StoreType = "atom",
      place: string | null = null,
      fn: string | null = null,
    ): StoreEntry {
      return registerStore({
        store,
        name,
        home,
        type,
        place,
        origin: "plugin",
        external: false,
        fn,
      });
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
      fn: string | null = null,
    ): StoreEntry {
      return registerStore({
        store,
        name,
        number: made,
        home: HOME,
        type,
        origin: "plugin",
        external: false,
        fn,
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
      ownBindings(FROM, [["$draft", $draft]]);

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
      ownBindings(FROM, [["$draft", $draft]]);

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
      ownBindings(FROM, [["$total", $total]]);

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
      ownBindings(FROM, [["$total", $total]]);

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
      ownBindings(FROM, [["$draft", $draft]]);

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
      ownBindings(FROM, [["$draft2", $draft2]]);

      expect(keysOf(HOME, "$draft2 [store]")).toEqual(["(value)", "$canUndo [store]"]);
    });

    /**
     * A frame is what still puts two children of one name on one parent. It holds them under no key
     * of its own, so each falls back to the name its creation site gave, and two sites may agree.
     * Every store it places was made inside a function, or the frame would leave it where it stands.
     */
    function underFrame($parent: Store, ...born: Store[]): void {
      beginFrame();

      for (const store of born) {
        noteBirth(store);
      }

      endFrame(FROM, $parent, "$draft");
    }

    it("keeps the ordinal where one creation site put two stores on one parent", () => {
      const $first = atom(1);
      const $second = atom(2);
      const $draft = atom("");

      track($draft, "$draft");
      trackNumbered($first, "$row", 1, "atom", "makeRows");
      trackNumbered($second, "$row", 2, "atom", "makeRows");
      underFrame($draft, $first, $second);

      expect(keysOf(HOME, "$draft [store]")).toEqual([
        "(value)",
        "$row [store]",
        "$row [store] #2",
      ]);
    });

    it("keeps two children of one name apart by the file each came from", () => {
      const $mine = atom(1);
      const $theirs = atom(2);
      const $draft = atom("");

      track($draft, "$draft");
      track($mine, "$history", HOME, "atom", null, "withUndo");
      track($theirs, "$history", "vendor/withUndo.ts", "atom", null, "withUndo");
      underFrame($draft, $mine, $theirs);

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
      track($mine, "$history", HOME, "atom", "line 20", "withUndo");
      track($theirs, "$history", "vendor/withUndo.ts", "atom", "line 20", "withUndo");
      underFrame($draft, $mine, $theirs);

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
      ownBindings(FROM, [["$form", $form]]);

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
      ownBindings(FROM, [["$draft", $draft]]);

      expect(keysOf(HOME, "$draft [store]")).toEqual(["(value)", "$total [computed]"]);
    });

    it("draws a child in its owner's node, whatever home registered it", () => {
      const $canUndo = atom(false);
      const $draft = holder("", { $canUndo });

      track($draft, "$draft");
      track($canUndo, "$canUndo", "vendor/withUndo.ts");
      ownBindings(FROM, [["$draft", $draft]]);

      expect(buildSnapshot()).toEqual({
        [HOME]: { "$draft [store]": { "(value)": "", "$canUndo [store]": false } },
      });
    });

    it("leaves a store flat when nothing registered its owner", () => {
      const $canUndo = atom(false);

      ownBindings(FROM, [["$draft", holder("", { $canUndo })]]);
      track($canUndo, "$canUndo");

      expect(buildSnapshot()).toEqual({ [HOME]: { "$canUndo [store]": false } });
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
      ownBindings(FROM, [["$draft", $draft]]);

      expect(drawnSlots()).toBe(listEntries().length);
    });

    it("runs no getter and mounts nothing while drawing a node", () => {
      const $canUndo = atom(false);
      const $draft = Object.assign(hostileStore(7), { $canUndo });

      track($draft, "$draft");
      track($canUndo, "$canUndo");
      ownBindings(FROM, [["$draft", $draft]]);

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
        ownBindings(FROM, [["editorOne", editorOne]]);

        expect(buildSnapshot()).toEqual({
          [HOME]: { editorOne: labelled("Editor", { "$value [store]": "draft" }) },
        });
      });

      it("keys a plain object a factory returned by its binding, and labels it with nothing", () => {
        const panel = { $open: atom(false) };

        track(panel.$open, "$open");
        ownBindings(FROM, [["panel", panel]]);

        expect(buildSnapshot()).toEqual({ [HOME]: { panel: { "$open [store]": false } } });
      });

      it("walks an array by index, so an array of instances draws two levels", () => {
        const first = new Editor();
        const second = new Editor();

        trackNumbered(first.$value, "$value", 1);
        trackNumbered(second.$value, "$value", 2);
        ownBindings(FROM, [["drafts", [first, second]]]);

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
        ownBindings(FROM, [["byId", new Map([["scratch", scratch]])]]);

        expect(heldBy("byId")).toEqual({
          '["scratch"]': labelled("Editor", { "$value [store]": "draft" }),
        });
      });

      it("walks a Set in insertion order", () => {
        const first = new Editor();
        const second = new Editor();

        track(second.$value, "$second");
        track(first.$value, "$first");
        ownBindings(FROM, [["pool", new Set([first, second])]]);

        expect(Object.keys(heldBy("pool"))).toEqual(["[0]", "[1]"]);
      });

      it("keys a bare store in a collection by its position, and keeps the type note", () => {
        const $width = atom(320);
        const $ratio = computed($width, (width) => width / 2);

        track($width, "$width");
        track($ratio, "$ratio", HOME, "computed");
        ownBindings(FROM, [["bounds", [$width, $ratio]]]);

        expect(Object.keys(heldBy("bounds"))).toEqual(["[0] [store]", "[1] [computed]"]);
        expect(heldBy("bounds")["[0] [store]"]).toBe(320);
      });

      it("draws a node the store that holds it keeps beside its own value", () => {
        const first = new Editor();
        const $draft = holder("", {});

        Object.assign($draft, { drafts: [first] });
        track($draft, "$draft");
        track(first.$value, "$value");
        ownBindings(FROM, [["$draft", $draft]]);

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
        ownBindings(FROM, [["panel", { title: "Files", size: [1, 2] }]]);

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
        ownBindings(FROM, [["$draft", $draft]]);

        expect(buildSnapshot()).toEqual({
          [HOME]: { "$draft [store]": { "(value)": "", "$canUndo [store]": false } },
        });
      });

      it("says what a capped collection left out, and loses none of its stores", () => {
        const members = Array.from({ length: MAX_MEMBERS + 2 }, () => ({ $open: atom(false) }));

        members.forEach((member, index) => {
          track(member.$open, index === 0 ? "$open" : `$open #${index + 1}`);
        });
        ownBindings(FROM, [["many", members]]);

        const held = heldBy("many");

        expect(Object.keys(held)).toHaveLength(MAX_MEMBERS + 3);
        expect(held["[0]"]).toEqual({ "$open [store]": false });
        expect(held["$open #26 [store]"]).toBe(false);
        expect(held["$open #27 [store]"]).toBe(false);
        expect(held["…"]).toEqual({
          data: {},
          __serializedType__:
            "2 more members past the 25 walked; their stores are listed here without a node of " +
            "their own",
        });
      });

      it("keeps the registry ordinal of the one store a single skipped member hung there", () => {
        const members = Array.from({ length: MAX_MEMBERS + 1 }, () => ({ $open: atom(false) }));

        members.forEach((member, index) => {
          track(member.$open, index === 0 ? "$open" : `$open #${index + 1}`);
        });
        ownBindings(FROM, [["many", members]]);

        const held = heldBy("many");

        expect(held["$open #26 [store]"]).toBe(false);
        expect(held["$open [store]"]).toBeUndefined();
      });

      it("numbers a name two nodes of one home both want", () => {
        const panel = { $open: atom(false) };
        const sidebar = { $width: atom(320) };

        track(panel.$open, "$open");
        track(sidebar.$width, "$width");
        ownBindings(FROM, [
          ["panel", panel],
          ["panel", sidebar],
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
        ownBindings(FROM, [["panel", panel]]);

        expect(buildSnapshot()).toEqual({
          [HOME]: { panel: { "$open [store]": false }, "panel [store]": "bare" },
        });
      });

      it("draws no node for a binding in somebody else's file, so its working state is gone", () => {
        const panel = { $open: atom(false) };

        track(atom("x"), "$typed");
        registerStore({
          store: panel.$open,
          name: "$open",
          home: "node_modules/panel/index.ts",
          type: "atom",
          origin: "plugin",
          external: true,
          fn: "panel",
        });
        ownBindings(
          {
            home: "node_modules/panel/index.ts",
            external: true,
            moduleKey: "node_modules/panel/index.ts",
          },
          [["panel", panel]],
        );

        expect(buildSnapshot()).toEqual({ [HOME]: { "$typed [store]": "x" } });
      });

      describe("a class field", () => {
        /** A class that places its own fields, `this` being what each initializer holds. */
        class Editor {
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
        function trackFields(editor: Editor, made: number): void {
          trackNumbered(editor.$value, "$value", made);
          trackNumbered(editor.hidden, "#hidden", made);
        }

        it("draws an instance field, a private field and the class's statics", () => {
          const editorOne = new Editor();

          ownField(FROM, Editor.$opened, Editor);
          track(Editor.$opened, "$opened");
          trackFields(editorOne, 1);
          ownBindings(FROM, [["editorOne", editorOne]]);

          expect(buildSnapshot()).toEqual({
            [HOME]: {
              Editor: { "$opened [store]": 3 },
              editorOne: labelled("Editor", { "#hidden [store]": 2, "$value [store]": 1 }),
            },
          });
        });

        it("keeps two instances apart, and neither steals the other's fields", () => {
          const editorOne = new Editor();
          const editorTwo = new Editor();

          trackFields(editorOne, 1);
          trackFields(editorTwo, 2);
          ownBindings(FROM, [
            ["editorOne", editorOne],
            ["editorTwo", editorTwo],
          ]);

          expect(buildSnapshot()).toEqual({
            [HOME]: {
              editorOne: labelled("Editor", { "#hidden [store]": 2, "$value [store]": 1 }),
              editorTwo: labelled("Editor", { "#hidden [store]": 2, "$value [store]": 1 }),
            },
          });
        });

        it("draws every store a class field placed exactly once", () => {
          const editorOne = new Editor();
          const editorTwo = new Editor();

          editorTwo.$value.set(4);
          editorTwo.hidden.set(5);
          ownField(FROM, Editor.$opened, Editor);
          track(Editor.$opened, "$opened");
          trackFields(editorOne, 1);
          trackFields(editorTwo, 2);
          ownBindings(FROM, [["editorOne", editorOne]]);

          expect(numbersIn(buildSnapshot()).sort((left, right) => left - right)).toEqual([
            1, 2, 3, 4, 5,
          ]);
        });
      });

      describe("the creation frame", () => {
        class Viewer {
          $shown = atom(true);
        }

        it("keeps an instance in an unenumerable holder under its binding, keyed ref#1", () => {
          beginFrame();

          const editor = new Editor();

          noteBirth(editor.$value);
          ownField(FROM, editor.$value, editor);

          const hidden = new WeakMap([[{}, editor]]);

          endFrame(FROM, hidden, "hidden");
          track(editor.$value, "$value");
          ownBindings(FROM, [["hidden", hidden]]);

          expect(buildSnapshot()).toEqual({
            [HOME]: {
              hidden: labelled("WeakMap", {
                "ref#1": labelled("Editor", { "$value [store]": "draft" }),
              }),
            },
          });
        });

        it("numbers a name of ours across the file, so two classes never share ref#1", () => {
          const editorOne = new Editor();

          ownField(FROM, editorOne.$value, editorOne);
          track(editorOne.$value, "$value");
          beginFrame();

          const viewer = new Viewer();

          noteBirth(viewer.$shown);
          ownField(FROM, viewer.$shown, viewer);
          track(viewer.$shown, "$shown");
          endFrame(FROM, new WeakMap([[{}, viewer]]), "hidden");

          const keys = Object.keys(buildSnapshot()[HOME] ?? {});

          expect(keys).toContain("ref#1");
          expect(Object.keys(heldBy("hidden"))).toEqual(["ref#2"]);
        });

        it("draws a store held in a closure under the binding the call fed", () => {
          const $timeline = atom(["a"]);
          const $draft = atom("");

          beginFrame();
          noteBirth($draft);
          noteBirth($timeline);
          endFrame(FROM, $draft, "$draft");
          track($draft, "$draft");
          track($timeline, "$timeline");
          ownBindings(FROM, [["$draft", $draft]]);

          expect(buildSnapshot()).toEqual({
            [HOME]: { "$draft [store]": { "(value)": "", "$timeline [store]": ["a"] } },
          });
        });

        it("draws every registry entry exactly once, what a frame placed included", () => {
          const $timeline = atom(0);
          const $draft = atom(1);
          const scratch = { $open: atom(2) };
          const byId = new Map([["scratch", scratch]]);

          beginFrame();
          noteBirth($draft);
          noteBirth($timeline);
          endFrame(FROM, $draft, "$draft");
          beginFrame();
          noteBirth(scratch.$open);
          endFrame(FROM, byId, "byId");
          track($draft, "$draft");
          track($timeline, "$timeline");
          track(scratch.$open, "$open");
          ownBindings(FROM, [
            ["$draft", $draft],
            ["byId", byId],
          ]);

          expect(numbersIn(buildSnapshot()).sort((left, right) => left - right)).toEqual([0, 1, 2]);
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
          ["drafts", [first, second]],
          ["byId", new Map([["scratch", panel]])],
          ["$typed", $typed],
        ]);

        expect(numbersIn(buildSnapshot()).sort((left, right) => left - right)).toEqual([
          0, 1, 2, 3,
        ]);
      });
    });

    describe("a store made inside a function", () => {
      /** A store the plugin registered from a creation site inside a function of the app's own. */
      function madeIn(fn: string, store: Store, name: string, home = HOME): void {
        registerStore({ store, name, home, type: "atom", origin: "plugin", external: false, fn });
      }

      it("draws nothing at all for one nothing else placed", () => {
        const $hits = atom(0);

        madeIn("track", $hits, "$hits");

        expect(buildSnapshot()).toEqual({});
      });

      it("keeps a store made at module level flat at the file level", () => {
        const $hits = atom(0);

        track($hits, "$hits");

        expect(buildSnapshot()).toEqual({ [HOME]: { "$hits [store]": 0 } });
      });

      it("leaves a home out entirely when every store in it was made inside a function", () => {
        madeIn("track", atom(0), "$hits");
        madeIn("track", atom(1), "$misses");
        madeIn("sample", atom(2), "$rate", "src/other.ts");

        expect(buildSnapshot()).toEqual({});
      });

      it("still draws the rest of a home the function's own stores left", () => {
        madeIn("track", atom(0), "$hits");
        track(atom(1), "$typed");

        expect(buildSnapshot()).toEqual({ [HOME]: { "$typed [store]": 1 } });
      });

      it("leaves a store the frame placed where the frame put it", () => {
        const $canUndo = atom(false);
        const $draft = atom("");

        beginFrame();
        noteBirth($canUndo);
        madeIn("withUndo", $canUndo, "$canUndo");
        endFrame(FROM, $draft, "$draft");
        track($draft, "$draft");

        expect(buildSnapshot()).toEqual({
          [HOME]: { "$draft [store]": { "(value)": "", "$canUndo [store]": false } },
        });
      });

      it("leaves a store a class field placed where the field put it", () => {
        class Editor {
          $value = atom("draft");
        }

        const editorOne = new Editor();

        madeIn("makeEditor", editorOne.$value, "$value");
        ownField(FROM, editorOne.$value, editorOne);
        ownBindings(FROM, [["editorOne", editorOne]]);

        expect(buildSnapshot()).toEqual({
          [HOME]: {
            editorOne: { __serializedType__: "Editor", data: { "$value [store]": "draft" } },
          },
        });
      });

      it("leaves a store the binding scan placed where the scan put it", () => {
        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        madeIn("withUndo", $canUndo, "$canUndo");
        track($draft, "$draft");
        ownBindings(FROM, [["$draft", $draft]]);

        expect(buildSnapshot()).toEqual({
          [HOME]: { "$draft [store]": { "(value)": "", "$canUndo [store]": false } },
        });
      });

      it("draws every registry entry at most once, and a function's own not at all", () => {
        madeIn("track", atom(0), "$hits");
        madeIn("track", atom(1), "$hits #2");
        track(atom(2), "$typed");

        expect(numbersIn(buildSnapshot())).toEqual([2]);
      });

      it("draws one the developer bound at the top level, however it was made", () => {
        const $hits = atom(0);

        madeIn("makeHits", $hits, "$hits");
        ownBindings(FROM, [["$hits", $hits, true]]);

        expect(buildSnapshot()).toEqual({ [HOME]: { "$hits [store]": 0 } });
      });
    });

    describe("the developer's own binding", () => {
      it("names the store, drawn flat, and its owner keeps a second placement of it", () => {
        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        track($draft, "$draft");
        track($canUndo, "$canUndo", "vendor/withUndo.ts");
        ownBindings(FROM, [
          ["$draft", $draft, true],
          ["$canUndo", $canUndo, true],
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
          ["$draft2", $draft2, true],
          ["$undoable", $canUndo, true],
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
          ["$draft", $draft, true],
          ["$canUndo", $canUndo, true],
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

      it("lets an exported binding name the store over a plain one scanned before it", () => {
        const $typed = atom("");

        track($typed, "$typed");
        ownBindings(FROM, [
          ["$typed", $typed, false],
          ["$value", $typed, true],
          ["$alias", $typed, false],
        ]);

        expect(buildSnapshot()).toEqual({ [HOME]: { "$value [store]": "" } });
      });

      it("keeps an exported binding's name against a plain one scanned after it", () => {
        const $typed = atom("");

        track($typed, "$typed");
        ownBindings(FROM, [
          ["$value", $typed, true],
          ["$alias", $typed, false],
        ]);

        expect(buildSnapshot()).toEqual({ [HOME]: { "$value [store]": "" } });
      });

      it("lets a binding in somebody else's file neither name nor nest the store it holds", () => {
        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        track($draft, "$draft");
        track($canUndo, "$canUndo");
        ownBindings(
          { home: "vendor/withUndo.ts", external: true, moduleKey: "vendor/withUndo.ts" },
          [
            ["$draft", $draft, true],
            ["$canUndo", $canUndo, true],
          ],
        );

        expect(buildSnapshot()).toEqual({
          [HOME]: { "$canUndo [store]": false, "$draft [store]": "" },
        });
      });

      it("leaves the name a group was given by hand alone, and still draws it twice", () => {
        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        track($draft, "$draft");
        trackStores("cart", { $canUndo });
        ownBindings(FROM, [
          ["$draft", $draft, true],
          ["$undoable", $canUndo, true],
        ]);

        expect(buildSnapshot()).toEqual({
          cart: { "$canUndo [store]": stale(false) },
          [HOME]: { "$draft [store]": { "(value)": "", "$canUndo [store]": stale(false) } },
        });
      });

      it("drops both placements with the entry when untrack removes its group", () => {
        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        track($draft, "$draft");
        trackStores("cart", { $canUndo });
        ownBindings(FROM, [
          ["$draft", $draft, true],
          ["$canUndo", $canUndo, true],
        ]);
        untrack("cart");

        expect(buildSnapshot()).toEqual({ [HOME]: { "$draft [store]": "" } });
      });

      it("draws one slot per entry, plus one for every second placement", () => {
        const $canUndo = atom(1);
        const $history = atom(2);
        const $draft = holder(3, { $canUndo, $history });

        track($draft, "$draft");
        track($canUndo, "$canUndo", "vendor/withUndo.ts");
        track($history, "$history", "vendor/withUndo.ts");
        track(atom(4), "$typed");
        ownBindings(FROM, [
          ["$draft", $draft, true],
          ["$canUndo", $canUndo, true],
          ["$entries", $history, true],
        ]);

        expect(drawnSlots()).toBe(listEntries().length + 2);
        expect(numbersIn(buildSnapshot()).sort((left, right) => left - right)).toEqual([
          1, 1, 2, 2, 3, 4,
        ]);
      });
    });

    describe("a group written by hand", () => {
      it("draws the store at its group, whatever owner the walk recorded", () => {
        const $route = atom("/");
        const router = holder("", { $route });

        track(router, "router");
        track($route, "$route", "node_modules/@nanostores/router/index.js");
        trackStores("debug", { $route });
        ownBindings(FROM, [["router", router, true]]);

        expect(buildSnapshot()).toEqual({
          debug: { "$route [store]": "/" },
          [HOME]: { "router [store]": { "(value)": "", "$route [store]": "/" } },
        });
      });

      it("leaves the owner's second placement under the name the owner knows the store by", () => {
        const $route = atom("/");
        const router = holder("", { $route });

        track(router, "router");
        track($route, "$route", "node_modules/@nanostores/router/index.js");
        trackStores("debug", { route: $route });
        ownBindings(FROM, [["router", router, true]]);

        expect(buildSnapshot()).toEqual({
          debug: { "route [store]": "/" },
          [HOME]: { "router [store]": { "(value)": "", "$route [store]": "/" } },
        });
      });

      it("keys the second placement by the property the owner holds it under, not the group", () => {
        const $route = atom("/");
        const router = holder("", { $route });

        track(router, "router");
        trackStores("debug", { route: $route });
        ownBindings(FROM, [["router", router, true]]);

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
        ownBindings(FROM, [["router", router, true]]);

        expect(buildSnapshot()).toEqual({
          debug: { "$route [store]": { "(value)": "/", "$params [store]": { id: "1" } } },
          [HOME]: { "router [store]": { "(value)": "", "$route [store]": "/" } },
        });
      });

      it("draws one slot per entry, plus one for the second placement its owner keeps", () => {
        const $canUndo = atom(1);
        const $draft = holder(2, { $canUndo });

        track($draft, "$draft");
        track($canUndo, "$canUndo", "vendor/withUndo.ts");
        trackStores("debug", { $canUndo });
        ownBindings(FROM, [["$draft", $draft, true]]);

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
      fn: null,
    });
    registerStore({
      store: $total,
      name: "$total",
      home: "cart",
      type: "computed",
      origin: "plugin",
      external: false,
      fn: null,
    });
    buildSnapshot();

    expect($atom.lc).toBe(0);
    expect($total.lc).toBe(0);
  });
});
