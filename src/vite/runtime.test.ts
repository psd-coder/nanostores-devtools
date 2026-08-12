import { atom } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectDevtools } from "../connect.ts";
import { resetDevtoolsGlobal } from "../global.ts";
import { nodeInfoOf, ownerOf } from "../ownership.ts";
import { getEntry, listEntries, trackStores } from "../registry.ts";
import { type FakeExtension, installFakeExtension } from "../testing/fake-extension.ts";
import { type CreationSite, type FileScope, fileScope } from "./runtime.ts";

const MODULE_ID = "/repo/src/stores/cart.ts";
const HOME = "src/stores/cart.ts";
const CAP = 50;

let fake: FakeExtension;

function site(overrides: Partial<CreationSite> = {}): CreationSite {
  return { name: "$items", fn: null, line: 3, type: "atom", ...overrides };
}

function names(): string[] {
  return listEntries().map((entry) => entry.name);
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
  it("suffixes both entries with the enclosing function and the line", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.store(atom(0), site({ name: "$counter", fn: "makeCart", line: 12 }));
    scope.store(atom(0), site({ name: "$counter", line: 20 }));

    expect(names()).toEqual(["$counter (makeCart, line 12)", "$counter (line 20)"]);
  });

  it("warns once and names both places", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.store(atom(0), site({ name: "$counter", fn: "makeCart", line: 12 }));
    scope.store(atom(0), site({ name: "$counter", line: 20 }));
    scope.store(atom(0), site({ name: "$counter", line: 31 }));

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain("makeCart, line 12");
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain("line 20");
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

  it("starts the claims again after a clear, so a reload does not clash with itself", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.store(atom(0), site({ name: "$counter", line: 12 }));
    scope.clear();
    scope.store(atom(0), site({ name: "$counter", line: 12 }));

    expect(names()).toEqual(["$counter"]);
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

    expect(getEntry($third)).toMatchObject({ name: "$items #3" });
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
    getEntry($first)?.unhook.push(unhook);
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
});

describe("adopt", () => {
  it("passes a value that is no store through and registers nothing", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const router = { open: () => {} };

    expect(scope.adopt(router, site({ name: "$router", type: "unknown" }))).toBe(router);
    expect(scope.adopt(7, site({ name: "$seven", type: "unknown" }))).toBe(7);
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

  it("numbers repeats of one adopt site", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);

    scope.adopt(atom(0), site({ name: "$row", type: "unknown" }));
    scope.adopt(atom(0), site({ name: "$row", type: "unknown" }));

    expect(names()).toEqual(["$row", "$row #2"]);
  });
});

describe("own", () => {
  it("places the stores a bound store holds, and registers nothing new", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const $canUndo = atom(false);
    const $draft = Object.assign(atom<unknown>(""), { $canUndo });

    scope.store($draft, site({ name: "$draft" }));
    scope.own([["$draft", $draft]]);

    expect(ownerOf($canUndo)).toBe($draft);
    expect(names()).toEqual(["$draft"]);
  });

  it("draws a node in this module's own home, whichever file made the value", () => {
    const scope = fileScope(MODULE_ID, HOME, CAP, false);
    const panel = { $open: atom(false) };

    scope.own([["panel", panel]]);

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
      factory.store(atom(0), site({ fn: "makeCart" }));
      factory.store(atom(0), site({ fn: "makeCart" }));
    });

    expect(names()).toEqual(["$items", "$items #2", "$items #3", "$items #4"]);
  });

  it("holds that pile at the cap and drops the dead ones", () => {
    const factory = fileScope(FACTORY_ID, FACTORY_HOME, 2, false);

    reload(5, () => {
      factory.store(atom(0), site({ fn: "makeCart" }));
    });

    expect(names()).toEqual(["$items #4", "$items #5"]);
  });

  it("keeps an adopted store out of the pile, because it moves to the caller", () => {
    const factory = fileScope(FACTORY_ID, FACTORY_HOME, 50, false);

    reload(3, (caller) => {
      const $made = atom(0);

      factory.store($made, site({ fn: "makeCart" }));
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

    expect(rowNames()).toEqual(["$items #2/register"]);

    scope.clear();

    await endOfTurn();

    expect(rowNames()).toEqual(["$items #2/register", "$items #2/unregister"]);
  });
});
