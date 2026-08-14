import { stringify } from "jsan";
import { atom, computed, deepMap, map, type Store, type WritableAtom } from "nanostores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
      cart: { $items: staleBare(["milk"]), $count: stale(1) },
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

  it("refuses an own value getter rather than run it, and draws the slot empty", () => {
    const $trapped = atom(1);
    const get = () => {
      throw new Error("app code ran");
    };

    Object.defineProperty($trapped, "value", { get, configurable: true });
    trackStores("cart", { $trapped });

    expect(buildSnapshot()).toEqual({ cart: { $trapped: stale(undefined) } });
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
        fn: null,
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
        fn: null,
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
        fn: null,
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

      expect(buildSnapshot()).toEqual({ cart: { $adopted: stale(5) } });
    });

    it("marks an unknown store holding no value as may be stale, with the value boxed", () => {
      trackStores("cart", { $empty: atom(undefined) });

      const empty = slot(buildSnapshot(), "cart", "$empty");

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
          $count: stale(12),
          $cart: staleBare({ total: 12 }),
          $items: staleBare(["milk"]),
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

      const written = stringify(buildSnapshot(), createReplacer([]), null, EXTENSION_OPTIONS);
      const drawn = parsePanel(written);
      const cart = readNode(drawn, "cart");

      for (const name of ["$count", "$cart", "$when", "$point", "$nothing"]) {
        expect(labelOf(cart[name]), name).toBe("not mounted, may be stale");
      }
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

    function track(store: Store, name: string, home = HOME, type: StoreType = "atom"): StoreEntry {
      return registerStore({
        store,
        name,
        home,
        type,
        origin: "plugin",
        external: false,
        fn: null,
      });
    }

    /**
     * One of several stores from a single creation site, which the registry numbers from two on.
     * Its owner knows it by the name without the number, as the runtime records it.
     */
    function trackNumbered(
      store: Store,
      name: string,
      made: number,
      type: StoreType = "atom",
    ): StoreEntry {
      return registerStore({
        store,
        name: made === 1 ? name : `${name} #${made}`,
        ownerName: name,
        home: HOME,
        type,
        origin: "plugin",
        external: false,
        fn: null,
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
          $draft: { "(value)": "the quick brown fox ", $canUndo: false },
          $typed: "",
        },
      });
      expect(keysOf(HOME, "$draft")).toEqual(["(value)", "$canUndo"]);
    });

    it("draws a store that owns nothing exactly as v1 draws it, with no wrapper", () => {
      track(atom("x"), "$typed");

      expect(buildSnapshot()).toEqual({ [HOME]: { $typed: "x" } });
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
          $draft: { "(value)": "", $history: { "(value)": ["a"], $position: 3 } },
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
        [HOME]: { "$total [computed]": { "(value)": stale(2), $child: 1 } },
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
        [HOME]: { "$total [computed]": { "(value)": staleBare({ total: 12 }), $child: 1 } },
      });
    });

    it("drops a nested store's ordinal, because the parent already says which one it is", () => {
      const $canUndo = atom(false);
      const $draft2 = holder("", { $canUndo });

      track($draft2, "$draft2");
      trackNumbered($canUndo, "$canUndo", 2);
      ownBindings(FROM, [["$draft2", $draft2]]);

      expect(keysOf(HOME, "$draft2")).toEqual(["(value)", "$canUndo"]);
    });

    it("keeps the ordinal where one creation site put two stores on one parent", () => {
      const $first = atom(1);
      const $second = atom(2);
      const $draft = holder("", { $first, $second });

      track($draft, "$draft");
      trackNumbered($first, "$row", 1);
      trackNumbered($second, "$row", 2);
      ownBindings(FROM, [["$draft", $draft]]);

      expect(keysOf(HOME, "$draft")).toEqual(["(value)", "$row", "$row #2"]);
    });

    it("keeps two children of one name apart by the file each came from", () => {
      const $mine = atom(1);
      const $theirs = atom(2);
      const $draft = holder("", { $mine, $theirs });

      track($draft, "$draft");
      track($mine, "$history");
      track($theirs, "$history", "vendor/withUndo.ts");
      ownBindings(FROM, [["$draft", $draft]]);

      expect(keysOf(HOME, "$draft")).toEqual([
        "(value)",
        `$history (${HOME})`,
        "$history (vendor/withUndo.ts)",
      ]);
    });

    it("keeps the type note on a nested store's key", () => {
      const $total = computed(atom(1), (count) => count + 1);
      const $draft = holder("", { $total });

      track($draft, "$draft");
      trackNumbered($total, "$total", 2, "computed");
      ownBindings(FROM, [["$draft", $draft]]);

      expect(keysOf(HOME, "$draft")).toEqual(["(value)", "$total [computed]"]);
    });

    it("draws a child in its owner's node, whatever home registered it", () => {
      const $canUndo = atom(false);
      const $draft = holder("", { $canUndo });

      track($draft, "$draft");
      track($canUndo, "$canUndo", "vendor/withUndo.ts");
      ownBindings(FROM, [["$draft", $draft]]);

      expect(buildSnapshot()).toEqual({ [HOME]: { $draft: { "(value)": "", $canUndo: false } } });
    });

    it("leaves a store flat when nothing registered its owner", () => {
      const $canUndo = atom(false);

      ownBindings(FROM, [["$draft", holder("", { $canUndo })]]);
      track($canUndo, "$canUndo");

      expect(buildSnapshot()).toEqual({ [HOME]: { $canUndo: false } });
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
        [HOME]: { $draft: { "(value)": 7, $canUndo: false } },
      });
      expect($draft.lc).toBe(0);
      expect($canUndo.lc).toBe(0);
    });

    describe("a node", () => {
      class Editor {
        $value = atom("draft");
      }

      /** The type label as the extension carries it: a wrapper its reviver drops before drawing. */
      function labelled(type: string, children: Record<string, unknown>): unknown {
        return { data: children, __serializedType__: type };
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
          [HOME]: { editorOne: labelled("Editor", { $value: "draft" }) },
        });
      });

      it("keys a plain object a factory returned by its binding, and labels it with nothing", () => {
        const panel = { $open: atom(false) };

        track(panel.$open, "$open");
        ownBindings(FROM, [["panel", panel]]);

        expect(buildSnapshot()).toEqual({ [HOME]: { panel: { $open: false } } });
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
              "[0]": labelled("Editor", { $value: "draft" }),
              "[1]": labelled("Editor", { $value: "draft" }),
            }),
          },
        });
      });

      it("walks a Map by key", () => {
        const scratch = new Editor();

        track(scratch.$value, "$value");
        ownBindings(FROM, [["byId", new Map([["scratch", scratch]])]]);

        expect(heldBy("byId")).toEqual({
          '["scratch"]': labelled("Editor", { $value: "draft" }),
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

        expect(Object.keys(heldBy("bounds"))).toEqual(["[0]", "[1] [computed]"]);
        expect(heldBy("bounds")["[0]"]).toBe(320);
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
            $draft: {
              "(value)": "",
              drafts: labelled("Array", { "[0]": labelled("Editor", { $value: "draft" }) }),
            },
          },
        });
      });

      it("draws nothing for a node holding no store at all", () => {
        track(atom("x"), "$typed");
        ownBindings(FROM, [["panel", { title: "Files", size: [1, 2] }]]);

        expect(buildSnapshot()).toEqual({ [HOME]: { $typed: "x" } });
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
          [HOME]: { $draft: { "(value)": "", $canUndo: false } },
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
        expect(held["[0]"]).toEqual({ $open: false });
        expect(held["$open #26"]).toBe(false);
        expect(held["$open #27"]).toBe(false);
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

        expect(held["$open #26"]).toBe(false);
        expect(held["$open"]).toBeUndefined();
      });

      it("numbers a name two children of one home both want", () => {
        const panel = { $open: atom(false) };

        track(atom("bare"), "panel");
        track(panel.$open, "$open");
        ownBindings(FROM, [["panel", panel]]);

        expect(buildSnapshot()).toEqual({
          [HOME]: { "panel #1": "bare", "panel #2": { $open: false } },
        });
      });

      it("sorts a home holding only a node of somebody else's after the developer's own", () => {
        const panel = { $open: atom(false) };

        track(atom("x"), "$typed");
        track(panel.$open, "$open");
        ownBindings(
          {
            home: "node_modules/panel/index.ts",
            external: true,
            moduleKey: "node_modules/panel/index.ts",
          },
          [["panel", panel]],
        );

        expect(Object.keys(buildSnapshot())).toEqual([HOME, "node_modules/panel/index.ts"]);
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
              Editor: { $opened: 3 },
              editorOne: labelled("Editor", { "#hidden": 2, $value: 1 }),
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
              editorOne: labelled("Editor", { "#hidden": 2, $value: 1 }),
              editorTwo: labelled("Editor", { "#hidden": 2, $value: 1 }),
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
              hidden: labelled("WeakMap", { "ref#1": labelled("Editor", { $value: "draft" }) }),
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
            [HOME]: { $draft: { "(value)": "", $timeline: ["a"] } },
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

    describe("the enclosing function", () => {
      /** A store the plugin registered from a creation site inside a function of the app's own. */
      function madeIn(fn: string, store: Store, name: string, home = HOME): void {
        registerStore({ store, name, home, type: "atom", origin: "plugin", external: false, fn });
      }

      it("draws a store nothing else placed under the function that built it", () => {
        const $hits = atom(0);

        madeIn("track", $hits, "$hits");

        expect(buildSnapshot()).toEqual({ [HOME]: { "track()": { $hits: 0 } } });
      });

      it("keeps a store made at module level flat at the file level", () => {
        const $hits = atom(0);

        track($hits, "$hits");

        expect(buildSnapshot()).toEqual({ [HOME]: { $hits: 0 } });
      });

      it("holds everything one function made in one node", () => {
        madeIn("track", atom(0), "$hits");
        madeIn("track", atom(1), "$misses");

        expect(buildSnapshot()).toEqual({ [HOME]: { "track()": { $hits: 0, $misses: 1 } } });
      });

      it("gives each file its own node for a function of the same name", () => {
        madeIn("track", atom(0), "$hits");
        madeIn("track", atom(1), "$rate", "src/other.ts");

        expect(buildSnapshot()).toEqual({
          [HOME]: { "track()": { $hits: 0 } },
          "src/other.ts": { "track()": { $rate: 1 } },
        });
      });

      it("numbers a function node only where the name repeats", () => {
        madeIn("track", atom(0), "$hits");
        madeIn("sample", atom(1), "$rate");

        expect(Object.keys(buildSnapshot()[HOME] ?? {})).toEqual(["sample()", "track()"]);
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
          [HOME]: { $draft: { "(value)": "", $canUndo: false } },
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
          [HOME]: { editorOne: { __serializedType__: "Editor", data: { $value: "draft" } } },
        });
      });

      it("leaves a store the binding scan placed where the scan put it", () => {
        const $canUndo = atom(false);
        const $draft = holder("", { $canUndo });

        madeIn("withUndo", $canUndo, "$canUndo");
        track($draft, "$draft");
        ownBindings(FROM, [["$draft", $draft]]);

        expect(buildSnapshot()).toEqual({
          [HOME]: { $draft: { "(value)": "", $canUndo: false } },
        });
      });

      it("draws every registry entry exactly once, a function's own included", () => {
        madeIn("track", atom(0), "$hits");
        madeIn("track", atom(1), "$hits #2");
        track(atom(2), "$typed");

        expect(numbersIn(buildSnapshot()).sort((left, right) => left - right)).toEqual([0, 1, 2]);
      });

      it("keeps a store the developer bound at the top level out of the function's node", () => {
        const $hits = atom(0);

        madeIn("makeHits", $hits, "$hits");
        ownBindings(FROM, [["$hits", $hits, true]]);

        expect(buildSnapshot()).toEqual({ [HOME]: { $hits: 0 } });
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
          [HOME]: { $canUndo: false, $draft: { "(value)": "", $canUndo: false } },
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
            $draft2: { "(value)": "", "$canUndo [computed]": true },
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
          [HOME]: { $canUndo: true, $draft: { "(value)": "", $canUndo: true } },
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

        expect(buildSnapshot()).toEqual({ [HOME]: { $value: "" } });
      });

      it("keeps an exported binding's name against a plain one scanned after it", () => {
        const $typed = atom("");

        track($typed, "$typed");
        ownBindings(FROM, [
          ["$value", $typed, true],
          ["$alias", $typed, false],
        ]);

        expect(buildSnapshot()).toEqual({ [HOME]: { $value: "" } });
      });

      it("lets no binding in somebody else's file name the store it holds", () => {
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

        expect(buildSnapshot()).toEqual({ [HOME]: { $draft: { "(value)": "", $canUndo: false } } });
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
          cart: { $canUndo: stale(false) },
          [HOME]: { $draft: { "(value)": "", $canUndo: stale(false) } },
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

        expect(buildSnapshot()).toEqual({ [HOME]: { $draft: "" } });
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
          debug: { $route: "/" },
          [HOME]: { router: { "(value)": "", $route: "/" } },
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
          debug: { $route: { "(value)": "/", $params: { id: "1" } } },
          [HOME]: { router: { "(value)": "", $route: "/" } },
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
