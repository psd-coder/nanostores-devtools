import { atom, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectDevtools } from "./redux/connect.ts";
import { resetDevtoolsGlobal } from "./global.ts";
import { qualify } from "./stores/labels.ts";
import { drawnParents, nodeInfoOf, ownerLinksOf } from "./tree/placement.ts";
import { getEntry, listEntries, trackStores, unregisterStore, untrack } from "./stores/registry.ts";
import { type FakeExtension, installFakeExtension } from "./testing/fake-extension.ts";
import { keepHooks } from "./stores/unhook.ts";
import { buildSnapshot } from "./redux/render.ts";
import { type CreationSite, type FileScope, fileScope } from "./runtime.ts";

const MODULE_ID = "/repo/src/stores/cart.ts";
const HOME = "src/stores/cart.ts";
const CAP = 50;

let fake: FakeExtension;

function site(overrides: Partial<CreationSite> = {}): CreationSite {
  return { name: "$items", line: 3, type: "atom", ...overrides };
}

/** The owner the tree expands the store under, which is the first link recorded. */
function ownerOf(store: Store): object | undefined {
  return ownerLinksOf(store)[0]?.owner;
}

/** Everything the tree draws the node under, in the order the walk recorded them. */
function parentsOf(value: object): object[] {
  const info = nodeInfoOf(value);

  return info === undefined ? [] : drawnParents(info);
}

/** The qualified name, which is what the label is built from and what tells two entries apart. */
function names(): string[] {
  return listEntries().map((entry) => qualify(entry.name, entry));
}

/** The name the developer wrote, which the entry carries on its own and the timeline draws. */
function plainNames(): string[] {
  return listEntries().map((entry) => entry.name);
}

/** Every warning printed so far, in order, so a second one about the same name is visible. */
function warnings(): unknown[] {
  return vi.mocked(console.warn).mock.calls.map((call) => call[0]);
}

function endOfTurn(): Promise<void> {
  return Promise.resolve();
}

/** Connect, reach the deferred `init`, then open the panel, which is when rows start flowing. */
async function listen(): Promise<void> {
  connectDevtools();

  await endOfTurn();
  fake.start();
}

function rowNames(): string[] {
  return fake.sends.map((call) => call.action.type);
}

beforeEach(() => {
  resetDevtoolsGlobal();
  fake = installFakeExtension();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  fake.uninstall();
  vi.restoreAllMocks();
  resetDevtoolsGlobal();
});

describe("store", () => {
  it("returns exactly what it was given", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $items = atom<string[]>([]);

    expect(scope.store($items, site())).toBe($items);
  });

  it("registers the store with its name, its type and the module's home", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $items = atom<string[]>([]);

    scope.store($items, site({ type: "deepMap" }));

    expect(getEntry($items)).toMatchObject({
      name: "$items",
      home: HOME,
      label: `${HOME}/$items`,
      type: "deepMap",
      origin: "plugin",
    });
  });

  it("carries the throttle comment the site read, which marks the store on its own", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $frame = atom(0);
    const $other = atom(0);

    scope.store($frame, site({ name: "$frame", throttle: true }));
    scope.store($other, site({ name: "$other", line: 9 }));

    expect(getEntry($frame)?.throttle).toMatchObject({ commented: true, marked: true });
    expect(getEntry($other)?.throttle).toMatchObject({ commented: false, marked: false });
  });

  it("shows the line the store was made at once a name clash forces it", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $hits = atom(0);

    scope.store($hits, site({ name: "$hits", line: 3 }));
    scope.store(atom(0), site({ name: "$hits", line: 9 }));

    expect(getEntry($hits)).toMatchObject({ name: "$hits", place: "line 3" });
  });

  it("carries where the file sits, so a store from somebody else's file says so", () => {
    const vendor = fileScope(
      "/repo/packages/nanobots/src/withUndo.ts",
      "packages/nanobots/src/withUndo.ts",
      CAP,
      true,
    );
    const $undo = atom(false);

    vendor.store($undo, site({ name: "$undo" }));

    expect(getEntry($undo)).toMatchObject({
      home: "packages/nanobots/src/withUndo.ts",
      external: true,
    });
  });

  it("keeps the developer's own file own, whatever the file is named", () => {
    const scope = fileScope(MODULE_ID, "src/vendor/thing.ts", CAP, false);
    const $items = atom<string[]>([]);

    scope.store($items, site());

    expect(getEntry($items)).toMatchObject({ external: false });
  });

  it("numbers repeats of one site and never renames the first", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.store(atom(0), site());
    scope.store(atom(0), site());
    scope.store(atom(0), site());

    expect(names()).toEqual(["$items", "$items #2", "$items #3"]);
  });

  it("keeps a store whose creation site had no name out of the tree", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $theme = atom("dark");

    scope.store($theme, site({ name: null, type: "map" }));

    expect(listEntries()).toEqual([]);
  });

  it("places a store made in an instance field under the instance the field ran for", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    class Editor {
      $value = scope.store(atom(""), site({ name: "$value" }), this);
    }

    const editorOne = new Editor();

    expect(ownerOf(editorOne.$value)).toBe(editorOne);
    expect(nodeInfoOf(editorOne)).toMatchObject({ name: "ref", type: "Editor", home: HOME });
    expect(names()).toEqual(["$value"]);
  });

  it("tells a static field from an instance one by `this` being a function", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    class Editor {
      static $opened = scope.store(atom(false), site({ name: "$opened" }), this);
    }

    expect(ownerOf(Editor.$opened)).toBe(Editor);
    expect(nodeInfoOf(Editor)).toMatchObject({ name: "Editor", home: HOME });
    expect(nodeInfoOf(Editor)?.type).toBeUndefined();
  });

  it("leaves a store made with no owner where its own name puts it", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $items = atom<string[]>([]);

    scope.store($items, site());

    expect(ownerOf($items)).toBeUndefined();
  });

  it("counts each site on its own", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.store(atom(0), site({ line: 3 }));
    scope.store(atom(0), site({ line: 7, name: "$cart" }));
    scope.store(atom(0), site({ line: 7, name: "$cart" }));

    expect(names()).toEqual(["$items", "$cart", "$cart #2"]);
  });
});

describe("a name two source lines claim", () => {
  const TWO_PLACES =
    `[nanostores-devtools] "$counter" is made in 2 places in "src/stores/cart.ts": ` +
    `line 12 and line 20. Each entry shows its place.`;
  const THREE_PLACES =
    `[nanostores-devtools] "$counter" is made in 3 places in "src/stores/cart.ts": ` +
    `line 12, line 20 and line 31. Each entry shows its place.`;

  it("qualifies both entries with the line they were made at", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.store(atom(0), site({ name: "$counter", line: 12 }));
    scope.store(atom(0), site({ name: "$counter", line: 20 }));

    expect(names()).toEqual(["$counter (line 12)", "$counter (line 20)"]);
  });

  it("keeps the plain name on both, so the two share the row name the timeline writes", async () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $first = atom(0);
    const $second = atom(0);

    /** Both at module level, so both are drawn and both reach the timeline. */
    scope.store($first, site({ name: "$counter", line: 12 }));
    scope.store($second, site({ name: "$counter", line: 20 }));
    await listen();

    $first.set(1);
    $second.set(1);
    await endOfTurn();

    expect(plainNames()).toEqual(["$counter", "$counter"]);
    expect(rowNames()).toEqual(["$counter/set", "$counter/set"]);
  });

  it("warns once and names both places", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.store(atom(0), site({ name: "$counter", line: 12 }));
    scope.store(atom(0), site({ name: "$counter", line: 20 }));

    expect(warnings()).toEqual([TWO_PLACES]);
  });

  it("warns again for the third place and names all three", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.store(atom(0), site({ name: "$counter", line: 12 }));
    scope.store(atom(0), site({ name: "$counter", line: 20 }));
    scope.store(atom(0), site({ name: "$counter", line: 31 }));

    expect(names()).toEqual(["$counter (line 12)", "$counter (line 20)", "$counter (line 31)"]);
    expect(warnings()).toEqual([TWO_PLACES, THREE_PLACES]);
  });

  it("says nothing again when a reload reaches the same two places", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.store(atom(0), site({ name: "$counter", line: 12 }));
    scope.store(atom(0), site({ name: "$counter", line: 20 }));

    const reloaded = fileScope(MODULE_ID, HOME, CAP, false);

    reloaded.clear();
    reloaded.store(atom(0), site({ name: "$counter", line: 20 }));
    reloaded.store(atom(0), site({ name: "$counter", line: 12 }));

    expect(warnings()).toEqual([TWO_PLACES]);
  });

  it("names the three places the same way whichever line runs first", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.store(atom(0), site({ name: "$counter", line: 31 }));
    scope.store(atom(0), site({ name: "$counter", line: 20 }));
    scope.store(atom(0), site({ name: "$counter", line: 12 }));

    expect(warnings().at(-1)).toBe(THREE_PLACES);
  });

  it("keeps where the file sits while it renames both entries", () => {
    const vendor = fileScope("/repo/vendor/undo.ts", "vendor/undo.ts", CAP, true);

    vendor.store(atom(0), site({ name: "$counter", line: 12 }));
    vendor.store(atom(0), site({ name: "$counter", line: 20 }));

    expect(listEntries().map((entry) => entry.external)).toEqual([true, true]);
  });

  it("keeps the numbering of the site it renames", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.store(atom(0), site({ name: "$counter", line: 12 }));
    scope.store(atom(0), site({ name: "$counter", line: 12 }));
    scope.store(atom(0), site({ name: "$counter", line: 20 }));

    expect(names()).toEqual(["$counter (line 12)", "$counter (line 12) #2", "$counter (line 20)"]);
  });

  it("leaves a store an explicit group took where it is", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $counter = atom(0);

    scope.store($counter, site({ name: "$counter", line: 12 }));
    trackStores("cart", { $counter });
    scope.store(atom(0), site({ name: "$counter", line: 20 }));

    expect(getEntry($counter)).toMatchObject({ home: "cart", name: "$counter" });
  });

  it("keeps the name a top-level binding gave to one of the two stores", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $alias = atom(0);

    scope.store($alias, site({ name: "$counter", line: 12 }));
    scope.own([{ name: "$alias", value: $alias, exported: true }]);
    scope.store(atom(0), site({ name: "$counter", line: 20 }));

    expect(getEntry($alias)).toMatchObject({ name: "$alias", place: null });
    expect(names()).toEqual(["$alias", "$counter (line 20)"]);
  });

  it("moves a store the developer named twice into the group they put it in", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $alias = atom(0);

    scope.store($alias, site({ name: "$counter", line: 12 }));
    scope.own([{ name: "$alias", value: $alias, exported: true }]);
    trackStores("cart", { $alias });
    scope.store(atom(0), site({ name: "$counter", line: 20 }));

    expect(getEntry($alias)).toMatchObject({ home: "cart", name: "$alias", place: null });
  });

  it("keeps the binding's name through a reload that clashes again", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $alias = atom(0);

    scope.store($alias, site({ name: "$counter", line: 12 }));
    scope.own([{ name: "$alias", value: $alias, exported: true }]);
    scope.store(atom(0), site({ name: "$counter", line: 20 }));

    const reloaded = fileScope(MODULE_ID, HOME, CAP, false);
    const $again = atom(1);

    reloaded.clear();
    reloaded.store($again, site({ name: "$counter", line: 12 }));
    reloaded.own([{ name: "$alias", value: $again, exported: true }]);
    reloaded.store(atom(0), site({ name: "$counter", line: 20 }));

    expect(names()).toEqual(["$alias", "$counter (line 20)"]);
  });

  it("starts the claims again after a clear, so a reload does not clash with itself", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.store(atom(0), site({ name: "$counter", line: 12 }));
    scope.clear();
    scope.store(atom(0), site({ name: "$counter", line: 12 }));

    expect(names()).toEqual(["$counter"]);
  });
});

describe("a name two modules mapped to one home claim", () => {
  const SHARED = "stores";
  const A_KEY = "src/a.ts";
  const B_KEY = "src/b.ts";
  const C_KEY = "src/c.ts";
  const TWO_FILES =
    `[nanostores-devtools] "$counter" is made in 2 files that "stores" holds: ` +
    `"src/a.ts" and "src/b.ts". Each entry shows its file.`;
  const THREE_FILES =
    `[nanostores-devtools] "$counter" is made in 3 files that "stores" holds: ` +
    `"src/a.ts", "src/b.ts" and "src/c.ts". Each entry shows its file.`;

  function mapped(moduleKey: string): FileScope {
    return fileScope(moduleKey, SHARED, CAP, false);
  }

  it("shows the file on every binding for one store, not only on the one the entry took", () => {
    const a = mapped(A_KEY);
    const b = mapped(B_KEY);
    const $shared = atom(0);

    a.store($shared, site({ name: "$counter" }));
    a.own([{ name: "$counter", value: $shared, exported: true }]);
    b.own([{ name: "$counter", value: $shared, exported: true }]);

    /** Two modules, one name, one store: the repeat needs the file as much as the primary does. */
    expect(Object.keys(buildSnapshot()[SHARED] ?? {})).toEqual([
      "$counter [store] (a.ts)",
      "$counter [store] (b.ts)",
    ]);
  });

  it("keeps both stores and names the file each one came from", () => {
    const a = mapped(A_KEY);
    const b = mapped(B_KEY);

    a.store(atom(0), site({ name: "$counter" }));
    b.store(atom(0), site({ name: "$counter" }));

    expect(names()).toEqual(["$counter (a.ts)", "$counter (b.ts)"]);
  });

  it("keeps both stores a top-level binding of the developer's own named", () => {
    const a = mapped(A_KEY);
    const b = mapped(B_KEY);
    const $first = atom(0);
    const $second = atom(0);

    a.store($first, site({ name: "$counter" }));
    a.own([{ name: "$counter", value: $first, exported: true }]);
    b.store($second, site({ name: "$counter" }));
    b.own([{ name: "$counter", value: $second, exported: true }]);

    expect(getEntry($first)).toMatchObject({ name: "$counter", file: "a.ts" });
    expect(getEntry($second)).toMatchObject({ name: "$counter", file: "b.ts" });
  });

  it("keeps the name a top-level binding gave when the other module names the file", () => {
    const a = mapped(A_KEY);
    const b = mapped(B_KEY);
    const $alias = atom(0);

    a.store($alias, site({ name: "$counter" }));
    a.own([{ name: "$alias", value: $alias, exported: true }]);
    b.store(atom(0), site({ name: "$counter" }));

    expect(getEntry($alias)).toMatchObject({ name: "$alias", file: null });
    expect(names()).toEqual(["$alias", "$counter (b.ts)"]);
  });

  it("gives the same two names whichever module runs first", () => {
    const b = mapped(B_KEY);
    const a = mapped(A_KEY);

    b.store(atom(0), site({ name: "$counter" }));
    a.store(atom(0), site({ name: "$counter" }));

    expect(names()).toEqual(["$counter (b.ts)", "$counter (a.ts)"]);
  });

  it("takes as much of the path as it takes to tell two files of one name apart", () => {
    const a = fileScope("src/a/store.ts", SHARED, CAP, false);
    const b = fileScope("src/b/store.ts", SHARED, CAP, false);

    a.store(atom(0), site({ name: "$counter" }));
    b.store(atom(0), site({ name: "$counter" }));

    expect(names()).toEqual(["$counter (a/store.ts)", "$counter (b/store.ts)"]);
  });

  it("names the file in front of the place when both sides clash", () => {
    const a = mapped(A_KEY);
    const b = mapped(B_KEY);

    a.store(atom(0), site({ name: "$counter", line: 12 }));
    a.store(atom(0), site({ name: "$counter", line: 20 }));
    b.store(atom(0), site({ name: "$counter" }));

    expect(names()).toEqual([
      "$counter (a.ts, line 12)",
      "$counter (a.ts, line 20)",
      "$counter (b.ts)",
    ]);
  });

  it("keeps the numbering of the site it renames", () => {
    const a = mapped(A_KEY);
    const b = mapped(B_KEY);

    a.store(atom(0), site({ name: "$counter" }));
    a.store(atom(0), site({ name: "$counter" }));
    b.store(atom(0), site({ name: "$counter" }));

    expect(names()).toEqual(["$counter (a.ts)", "$counter (a.ts) #2", "$counter (b.ts)"]);
  });

  it("warns once and names both files", () => {
    const a = mapped(A_KEY);
    const b = mapped(B_KEY);

    a.store(atom(0), site({ name: "$counter" }));
    b.store(atom(0), site({ name: "$counter" }));

    expect(warnings()).toEqual([TWO_FILES]);
  });

  it("warns again for the third module and names all three files", () => {
    const a = mapped(A_KEY);
    const b = mapped(B_KEY);
    const c = mapped(C_KEY);

    a.store(atom(0), site({ name: "$counter" }));
    b.store(atom(0), site({ name: "$counter" }));
    c.store(atom(0), site({ name: "$counter" }));

    expect(names()).toEqual(["$counter (a.ts)", "$counter (b.ts)", "$counter (c.ts)"]);
    expect(warnings()).toEqual([TWO_FILES, THREE_FILES]);
  });

  it("says nothing again when one of the three modules reloads", () => {
    const a = mapped(A_KEY);
    const b = mapped(B_KEY);
    const c = mapped(C_KEY);

    a.store(atom(0), site({ name: "$counter" }));
    b.store(atom(0), site({ name: "$counter" }));
    c.store(atom(0), site({ name: "$counter" }));

    const reloaded = mapped(B_KEY);

    reloaded.clear();
    reloaded.store(atom(0), site({ name: "$counter" }));

    expect(warnings()).toEqual([TWO_FILES, THREE_FILES]);
  });

  it("names the three files the same way whichever module runs first", () => {
    const c = mapped(C_KEY);
    const b = mapped(B_KEY);
    const a = mapped(A_KEY);

    c.store(atom(0), site({ name: "$counter" }));
    b.store(atom(0), site({ name: "$counter" }));
    a.store(atom(0), site({ name: "$counter" }));

    expect(warnings().at(-1)).toBe(THREE_FILES);
  });

  it("leaves every name alone when each module has a home of its own", () => {
    const a = fileScope(A_KEY, "a", CAP, false);
    const b = fileScope(B_KEY, "b", CAP, false);

    a.store(atom(0), site({ name: "$counter" }));
    b.store(atom(0), site({ name: "$counter" }));

    expect(names()).toEqual(["$counter", "$counter"]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("removes the store asked for and nothing else", () => {
    const a = mapped(A_KEY);
    const b = mapped(B_KEY);
    const $dropped = atom(0);
    const $last = atom(0);

    a.store($dropped, site({ name: "$counter" }));
    b.store($last, site({ name: "$counter" }));
    trackStores("cart", { $counter: $dropped });
    untrack("cart");

    expect(names()).toEqual(["$counter (b.ts)"]);

    unregisterStore($last);

    expect(names()).toEqual([]);
  });

  it("replaces one module's own stores on a reload, saying nothing about the other", async () => {
    const a = mapped(A_KEY);
    const b = mapped(B_KEY);
    const $first = atom(0);
    const $kept = atom(0);

    a.store($first, site({ name: "$counter" }));
    a.own([{ name: "$counter", value: $first, exported: true }]);
    b.store($kept, site({ name: "$counter" }));
    b.own([{ name: "$counter", value: $kept, exported: true }]);
    await listen();

    const reloaded = mapped(A_KEY);
    const $again = atom(1);

    reloaded.clear();
    reloaded.store($again, site({ name: "$counter" }));
    reloaded.own([{ name: "$counter", value: $again, exported: true }]);

    await endOfTurn();

    expect(names()).toEqual(["$counter (b.ts)", "$counter (a.ts)"]);
    expect(getEntry($kept)).toMatchObject({ name: "$counter", file: "b.ts" });
    expect(rowNames()).toEqual(["$counter/hotReload"]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe("the per-site cap", () => {
  it("holds at the cap and drops the unmounted stores first", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $real = atom(0);

    scope.store($real, site());
    $real.listen(() => {});

    for (let call = 0; call < 1000; call += 1) {
      scope.store(atom(0), site());
    }

    expect(listEntries()).toHaveLength(CAP);
    expect(getEntry($real)).toMatchObject({ name: "$items" });
    expect(names().at(-1)).toBe("$items #1001");
  });

  it("drops the oldest when every store of the site is mounted", () => {
    const scope = fileScope(MODULE_ID, HOME, 2, false);
    const $first = atom(0);
    const $second = atom(0);
    const $third = atom(0);

    for (const $store of [$first, $second, $third]) {
      $store.listen(() => {});
      scope.store($store, site());
    }

    expect(getEntry($first)).toBeUndefined();
    expect(names()).toEqual(["$items #2", "$items #3"]);
  });

  it("keeps the store it just took, because the cap keeps the last ones", () => {
    const scope = fileScope(MODULE_ID, HOME, 2, false);
    const $first = atom(0);
    const $second = atom(0);
    const $third = atom(0);

    for (const $store of [$first, $second]) {
      $store.listen(() => {});
      scope.store($store, site());
    }

    scope.store($third, site());

    expect(getEntry($third)).toMatchObject({ name: "$items", number: 3 });
    expect(names()).toEqual(["$items #2", "$items #3"]);
  });

  it("counts one store once, however often the site hands the same one back", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $memo = atom(0);

    scope.adopt($memo, site({ name: "$memo" }));
    scope.adopt($memo, site({ name: "$memo" }));

    expect(names()).toEqual(["$memo"]);
  });

  it("runs the unhook of every store it evicts", () => {
    const scope = fileScope(MODULE_ID, HOME, 1, false);
    const $first = atom(0);
    const unhook = vi.fn();

    scope.store($first, site());

    const entry = getEntry($first);

    if (entry) {
      keepHooks(entry, unhook);
    }

    scope.store(atom(0), site());

    expect(unhook).toHaveBeenCalledTimes(1);
    expect(getEntry($first)).toBeUndefined();
  });

  it("caps each site on its own", () => {
    const scope = fileScope(MODULE_ID, HOME, 1, false);

    scope.store(atom(0), site({ line: 3 }));
    scope.store(atom(0), site({ line: 7, name: "$cart" }));

    expect(names()).toEqual(["$items", "$cart"]);
  });

  /**
   * The runtime is a published entry point, so a number like this can reach it, and none of them
   * may loop for ever. A test that finishes at all is the proof.
   */
  describe("a number no cap can be made of", () => {
    it("holds nothing at a cap below zero instead of taking from an empty list", () => {
      const scope = fileScope(MODULE_ID, HOME, -1, false);

      scope.store(atom(0), site());
      scope.store(atom(0), site());

      expect(names()).toEqual([]);
    });

    it("holds nothing at a cap of zero", () => {
      const scope = fileScope(MODULE_ID, HOME, 0, false);

      scope.store(atom(0), site());

      expect(names()).toEqual([]);
    });

    it("evicts nothing at a cap of NaN, because no length is above it", () => {
      const scope = fileScope(MODULE_ID, HOME, Number.NaN, false);

      scope.store(atom(0), site());
      scope.store(atom(0), site());

      expect(names()).toEqual(["$items", "$items #2"]);
    });
  });

  it("evicts nothing at a cap of Infinity", () => {
    const scope = fileScope(MODULE_ID, HOME, Number.POSITIVE_INFINITY, false);

    for (let call = 0; call < 200; call += 1) {
      scope.store(atom(0), site());
    }

    expect(listEntries()).toHaveLength(200);
  });
});

describe("adopt", () => {
  it("passes a value that is no store through and registers nothing", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const router = { open: () => {} };

    expect(scope.adopt(router, site({ name: "$router", type: "unknown" }))).toBe(router);
    expect(scope.adopt(7, site({ name: "$seven", type: "unknown" }))).toBe(7);
    expect(listEntries()).toEqual([]);
  });

  it("hands back a value that refuses to be read, so the module keeps evaluating", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const remote = new Proxy(
      { open: true },
      {
        getOwnPropertyDescriptor: (): never => {
          throw new Error("a trap ran");
        },
      },
    );

    expect(scope.adopt(remote, site({ name: "$remote", type: "unknown" }))).toBe(remote);
    expect(listEntries()).toEqual([]);
  });

  it("moves an already registered store here under this name and keeps its type", () => {
    const factory = fileScope("/repo/src/stores/factory.ts", "src/stores/factory.ts", CAP, false);
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $theme = atom("dark");

    factory.store($theme, site({ name: "$made", type: "map" }));
    scope.adopt($theme, site({ name: "$theme", type: "unknown" }));

    expect(listEntries()).toHaveLength(1);
    expect(getEntry($theme)).toMatchObject({
      name: "$theme",
      home: HOME,
      label: `${HOME}/$theme`,
      type: "map",
    });
  });

  it("supplies the name for a store whose creation site had none and keeps that type", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $theme = atom("dark");

    scope.store($theme, site({ name: null, type: "map" }));
    scope.adopt($theme, site({ name: "$theme", type: "unknown" }));

    expect(getEntry($theme)).toMatchObject({ name: "$theme", home: HOME, type: "map" });
  });

  it("keeps the recorded type when the store already sits in the tree as unknown", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $theme = atom("dark");

    scope.store($theme, site({ name: null, type: "map" }));
    trackStores("cart", { $theme });
    scope.adopt($theme, site({ name: "$theme", type: "unknown" }));

    expect(getEntry($theme)).toMatchObject({ home: "cart", type: "map" });
  });

  it("registers a store nothing instrumented made as unknown", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $theme = atom("dark");

    scope.adopt($theme, site({ name: "$theme", type: "unknown" }));

    expect(getEntry($theme)).toMatchObject({ name: "$theme", home: HOME, type: "unknown" });
  });

  /** The kind the package map gives the site, for a store the walk could never reach. */
  it("registers a store nothing instrumented made under the kind the site carries", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $theme = atom("dark");

    scope.adopt($theme, site({ name: "$theme", type: "map" }));

    expect(getEntry($theme)).toMatchObject({ name: "$theme", home: HOME, type: "map" });
  });

  it("keeps what callee matching read over the kind the site carries", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $theme = atom("dark");

    scope.store($theme, site({ name: null, type: "computed" }));
    scope.adopt($theme, site({ name: "$theme", type: "map" }));

    expect(getEntry($theme)).toMatchObject({ name: "$theme", type: "computed" });
  });

  it("numbers repeats of one adopt site", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.adopt(atom(0), site({ name: "$row", type: "unknown" }));
    scope.adopt(atom(0), site({ name: "$row", type: "unknown" }));

    expect(names()).toEqual(["$row", "$row #2"]);
  });
});

describe("own", () => {
  it("places the stores a bound store holds, and registers the ones nothing found", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $canUndo = atom(false);
    const $draft = Object.assign(atom<unknown>(""), { $canUndo });

    scope.store($draft, site({ name: "$draft" }));
    scope.own([{ name: "$draft", value: $draft, exported: false }]);

    expect(ownerOf($canUndo)).toBe($draft);
    expect(names()).toEqual(["$draft", "$draft.$canUndo"]);
  });

  it("walks a binding no deeper than the plugin's own option asked for", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false, 1);
    const $deep = atom(false);
    const held = { inner: { $deep } };

    scope.own([{ name: "held", value: held, exported: false }]);

    expect(names()).toEqual([]);
  });

  it("lets a binding rename a numbered store, and keeps the site's name for its owner", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $first = atom(false);
    const $second = atom(false);

    scope.store($first, site({ name: "$canUndo" }));
    scope.store($second, site({ name: "$canUndo" }));

    expect(names()).toEqual(["$canUndo", "$canUndo #2"]);

    scope.own([{ name: "$undoable", value: $second, exported: true }]);

    expect(names()).toEqual(["$canUndo", "$undoable"]);
    expect(getEntry($second)?.ownerName).toBe("$canUndo");
  });

  it("draws a node in this module's own home, whichever file made the value", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const panel = { $open: atom(false) };

    scope.own([{ name: "panel", value: panel, exported: false }]);

    expect(nodeInfoOf(panel)).toMatchObject({ name: "panel", home: HOME, external: false });
  });
});

/**
 * A known limit, pinned so it stays known: the factory's module did not re-run, so it did not
 * clear, and the caller's reload adds to what the run before it left.
 */
describe("a factory defined in one module and called from another", () => {
  const FACTORY_ID = "/repo/src/stores/factory.ts";
  const FACTORY_HOME = "src/stores/factory.ts";

  function reload(times: number, run: (caller: FileScope) => void): void {
    const caller = fileScope(MODULE_ID, HOME, 2, false);

    for (let count = 0; count < times; count += 1) {
      caller.clear();
      run(caller);
    }
  }

  it("piles the factory's entries up under the factory when the caller reloads", () => {
    const factory = fileScope(FACTORY_ID, FACTORY_HOME, 50, false);

    reload(2, () => {
      factory.store(atom(0), site());
      factory.store(atom(0), site());
    });

    expect(names()).toEqual(["$items", "$items #2", "$items #3", "$items #4"]);
  });

  it("holds that pile at the cap and drops the dead ones", () => {
    const factory = fileScope(FACTORY_ID, FACTORY_HOME, 2, false);

    reload(5, () => {
      factory.store(atom(0), site());
    });

    expect(names()).toEqual(["$items #4", "$items #5"]);
  });

  it("keeps an adopted store out of the pile, because it moves to the caller", () => {
    const factory = fileScope(FACTORY_ID, FACTORY_HOME, 50, false);

    reload(3, (caller) => {
      const $made = atom(0);

      factory.store($made, site());
      caller.adopt($made, site({ name: "$cart", line: 5, type: "unknown" }));
    });

    expect(names()).toEqual(["$cart"]);
    expect(listEntries()[0]).toMatchObject({ home: HOME, type: "atom" });
  });
});

describe("clear", () => {
  it("does nothing on a first run", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    expect(() => {
      scope.clear();
    }).not.toThrow();
    expect(listEntries()).toEqual([]);
  });

  it("removes this module's stores and numbers the next run from the start again", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $reloaded = atom(0);

    scope.store(atom(0), site());
    scope.store(atom(0), site());
    scope.clear();

    expect(listEntries()).toEqual([]);

    scope.store($reloaded, site());

    expect(getEntry($reloaded)).toMatchObject({ name: "$items" });
  });

  it("drops the owner links its own body wrote, so two saves leave what one save left", () => {
    const shared = fileScope("/repo/src/shared.ts", "src/shared.ts", CAP, false);
    const $width = atom(0);

    shared.store($width, site({ name: "$width" }));

    function save(): void {
      const page = fileScope(MODULE_ID, HOME, CAP, false);

      page.clear();
      page.own([{ name: "bounds", value: [$width], exported: true }]);
    }

    save();

    const once = JSON.stringify(buildSnapshot());

    save();

    expect(ownerLinksOf($width)).toHaveLength(1);
    expect(JSON.stringify(buildSnapshot())).toBe(once);
  });

  it("drops the parents its own body wrote for a node that outlives the reload", () => {
    const shared = fileScope("/repo/src/shared.ts", "src/shared.ts", CAP, false);
    const $w = atom(0);
    const held = { $w };

    shared.store($w, site({ name: "$w" }));

    /** `held` is the same object on every save, and the container around it is a new one. */
    function save(): void {
      const page = fileScope(MODULE_ID, HOME, CAP, false);

      page.clear();
      page.own([{ name: "a", value: { held }, exported: true }]);
    }

    save();

    const once = JSON.stringify(buildSnapshot());

    save();

    expect(parentsOf(held)).toHaveLength(1);
    expect(JSON.stringify(buildSnapshot())).toBe(once);
  });

  it("leaves the owner links another module wrote where they are", () => {
    const shared = fileScope("/repo/src/shared.ts", "src/shared.ts", CAP, false);
    const page = fileScope(MODULE_ID, HOME, CAP, false);
    const $width = atom(0);
    const bounds = [$width];

    shared.store($width, site({ name: "$width" }));
    shared.own([{ name: "bounds", value: bounds, exported: true }]);
    page.own([{ name: "layout", value: { width: $width }, exported: true }]);
    fileScope(MODULE_ID, HOME, CAP, false).clear();

    expect(ownerLinksOf($width).map((link) => link.owner)).toEqual([bounds]);
  });

  it("drops the binding names its own body wrote and keeps another module's", () => {
    const shared = fileScope("/repo/src/shared.ts", "src/shared.ts", CAP, false);
    const page = fileScope(MODULE_ID, HOME, CAP, false);
    const $draft = atom("");

    shared.store($draft, site({ name: "$draft" }));
    shared.own([{ name: "$draft", value: $draft, exported: true }]);
    page.own([{ name: "$alias", value: $draft, exported: false }]);

    expect(buildSnapshot()).toEqual({
      "src/shared.ts": { "$draft [store]": "" },
      [HOME]: { "$alias [store]": "" },
    });

    fileScope(MODULE_ID, HOME, CAP, false).clear();

    expect(buildSnapshot()).toEqual({ "src/shared.ts": { "$draft [store]": "" } });
  });

  it("takes away the placement a deleted binding made, and keeps the name it wrote", () => {
    const shared = fileScope("/repo/src/shared.ts", "src/shared.ts", CAP, false);
    const page = fileScope(MODULE_ID, HOME, CAP, false);
    const $canUndo = atom(false);
    const $draft = Object.assign(atom(""), { $canUndo });

    shared.store($draft, site({ name: "$draft" }));
    shared.store($canUndo, site({ name: "$canUndo" }));
    shared.own([{ name: "$draft", value: $draft, exported: true }]);
    page.own([{ name: "$undoable", value: $canUndo, exported: true }]);

    expect(buildSnapshot()[HOME]).toEqual({ "$undoable [store]": false });

    fileScope(MODULE_ID, HOME, CAP, false).clear();

    /** The flat slot the binding made is gone, and the store is drawn under its owner alone. */
    expect(buildSnapshot()[HOME]).toBeUndefined();
    /** The name it wrote stays on the entry: nothing kept the one the creation site gave. */
    expect(getEntry($canUndo)).toMatchObject({ name: "$undoable", home: HOME });
  });

  it("leaves another module's stores alone", () => {
    const cart = fileScope(MODULE_ID, HOME, CAP, false);
    const checkout = fileScope(
      "/repo/src/stores/checkout.ts",
      "src/stores/checkout.ts",
      CAP,
      false,
    );
    const $kept = atom(0);

    cart.store(atom(0), site());
    checkout.store($kept, site({ name: "$total" }));
    cart.clear();

    expect(names()).toEqual(["$total"]);
    expect(getEntry($kept)).toBeDefined();
  });

  it("keys off the module id, so two files sharing a display home do not wipe each other", () => {
    const first = fileScope("/repo/src/stores/cart.ts", "stores", CAP, false);
    const second = fileScope("/repo/src/features/cart.ts", "stores", CAP, false);
    const $kept = atom(0);

    first.store(atom(0), site());
    second.store($kept, site({ name: "$total" }));
    first.clear();

    expect(names()).toEqual(["$total"]);
  });

  it("leaves a store an explicit group took, whichever of the two ran first", () => {
    const early = fileScope(MODULE_ID, HOME, CAP, false);
    const late = fileScope("/repo/src/stores/checkout.ts", "src/stores/checkout.ts", CAP, false);
    const $early = atom(0);
    const $late = atom(0);

    trackStores("cart", { $early });
    early.store($early, site({ name: "$early" }));
    late.store($late, site({ name: "$late" }));
    trackStores("checkout", { $late });

    early.clear();
    late.clear();

    expect(getEntry($early)).toMatchObject({ home: "cart", name: "$early" });
    expect(getEntry($late)).toMatchObject({ home: "checkout", name: "$late" });
  });
});

describe("the rows a change draws", () => {
  it("draws an unregister row for a clear and none for an eviction", async () => {
    const scope = fileScope(MODULE_ID, HOME, 1, false);

    scope.store(atom(0), site());
    await listen();

    scope.store(atom(0), site());

    await endOfTurn();

    expect(rowNames()).toEqual(["$items/register"]);

    scope.clear();

    await endOfTurn();

    expect(rowNames()).toEqual(["$items/register", "$items/unregister"]);
  });

  it("draws one hot reload row for a module that clears and runs again in one turn", async () => {
    const first = fileScope(MODULE_ID, HOME, CAP, false);

    first.store(atom(0), site());
    await listen();

    const reloaded = fileScope(MODULE_ID, HOME, CAP, false);

    reloaded.clear();
    reloaded.store(atom(1), site());
    reloaded.store(atom(2), site({ name: "$total", line: 8 }));

    await endOfTurn();

    expect(fake.sends[0]?.action["action"]).toEqual({
      type: `${HOME}/hotReload`,
      changes: [
        { label: `${HOME}/$items`, op: "hotReload" },
        { label: `${HOME}/$total`, op: "register" },
      ],
    });
  });
});
