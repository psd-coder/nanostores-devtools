import { atom, computed, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectDevtools } from "./connect.ts";
import { resetDevtoolsGlobal } from "./global.ts";
import { ownBindings } from "./ownership.ts";
import { getEntry, registerStore, type StoreType, unregisterStore } from "./registry.ts";
import { type FakeExtension, installFakeExtension } from "./testing/fake-extension.ts";

const HOME = "src/stores/cart.ts";

let fake: FakeExtension;

function endOfTurn(): Promise<void> {
  return Promise.resolve();
}

function register(name: string, store: Store, type: StoreType = "atom", home = HOME): void {
  registerStore({ store, name, home, type, origin: "plugin", external: false, fn: null });
}

/** Connect, reach the deferred `init`, then open the panel, which is when rows start flowing. */
async function listen(options?: Parameters<typeof connectDevtools>[0]): Promise<void> {
  connectDevtools(options);

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

describe("mount and unmount rows", () => {
  it("draws a mount row for the first listener and an unmount row for the last", async () => {
    const $counter = atom(0);

    register("$counter", $counter);
    await listen();

    const unbind = $counter.listen(() => {});

    await endOfTurn();

    expect(fake.sends[0]?.action["action"]).toEqual({
      type: "$counter/mount",
      changes: [{ label: `${HOME}/$counter`, op: "mount" }],
    });

    unbind();

    await endOfTurn();

    expect(fake.sends[1]?.action["action"]).toEqual({
      type: "$counter/unmount",
      changes: [{ label: `${HOME}/$counter`, op: "unmount" }],
    });
  });

  it("coalesces nothing: mounting three stores draws three rows", async () => {
    const $first = atom(0);
    const $second = atom(0);
    const $third = atom(0);

    register("$first", $first);
    register("$second", $second);
    register("$third", $third);
    await listen();

    $first.listen(() => {});
    $second.listen(() => {});
    $third.listen(() => {});

    await endOfTurn();

    expect(rowNames()).toEqual(["$first/mount", "$second/mount", "$third/mount"]);
  });

  it("closes the open write row first, so each row carries its own tree", async () => {
    const $counter = atom(0);
    const $other = atom(0);

    register("$counter", $counter);
    register("$other", $other);
    await listen();

    $counter.set(1);
    $other.listen(() => {});

    await endOfTurn();

    expect(rowNames()).toEqual(["$counter/set", "$other/mount"]);
    expect(fake.sends.map((call) => call.state)).toEqual([
      { [HOME]: { "$counter [store]": 1, "$other [store]": 0 } },
      { [HOME]: { "$counter [store]": 1, "$other [store]": 0 } },
    ]);
  });

  it("lets the recompute a mount causes join the mount row", async () => {
    const $source = atom(1);
    const $total = computed($source, (source) => source * 2);

    register("$source", $source);
    register("$total", $total, "computed");
    /** Mounted before connect, so the source itself draws no row of its own here. */
    $source.listen(() => {});
    await listen();

    $total.listen(() => {});

    await endOfTurn();

    expect(fake.sends[0]?.action["action"]).toStrictEqual({
      type: "$total/mount",
      changes: [
        { label: `${HOME}/$total`, op: "mount" },
        /** The row is this store's own, so the recompute has no other store to name. */
        { label: `${HOME}/$total`, op: "computed", from: undefined },
      ],
    });
    expect(fake.sends[0]?.state).toEqual({
      [HOME]: { "$source [store]": 1, "$total [computed]": 2 },
    });
  });
});

describe("everMounted", () => {
  it("is set from the first mount and survives the unmount", async () => {
    const $counter = atom(0);

    register("$counter", $counter);
    await listen();

    expect(getEntry($counter)?.everMounted).toBe(false);

    const unbind = $counter.listen(() => {});

    expect(getEntry($counter)?.everMounted).toBe(true);

    unbind();

    expect(getEntry($counter)?.everMounted).toBe(true);
  });

  it("is set with lifecycleEvents off, because the tree reads it and no row does", async () => {
    const $counter = atom(0);

    register("$counter", $counter);
    await listen({ lifecycleEvents: false });

    $counter.listen(() => {});

    expect(getEntry($counter)?.everMounted).toBe(true);
  });

  it("is set for a store already mounted when we hook it, which fires no onStart", async () => {
    const $counter = atom(0);

    $counter.listen(() => {});
    register("$counter", $counter);
    await listen();

    expect(getEntry($counter)?.everMounted).toBe(true);
  });
});

describe("register, unregister and hot reload rows", () => {
  it("draws no row for a store that lands in the connect turn", async () => {
    const $early = atom(7);

    connectDevtools();
    register("$early", $early);

    await endOfTurn();
    fake.start();
    await endOfTurn();

    expect(fake.sends).toHaveLength(0);
    expect(fake.inits[0]?.state).toEqual({ [HOME]: { "$early [store]": 7 } });
  });

  it("draws no row in the connect turn even with the panel already listening", async () => {
    const $early = atom(7);

    connectDevtools();
    fake.start();
    register("$early", $early);

    await endOfTurn();

    expect(fake.sends).toHaveLength(0);
    expect(fake.inits.at(-1)?.state).toEqual({ [HOME]: { "$early [store]": 7 } });
  });

  it("draws a register row for a store that arrives after the connect turn", async () => {
    const $late = atom(0);

    await listen();
    register("$late", $late);

    await endOfTurn();

    expect(fake.sends[0]?.action["action"]).toEqual({
      type: "$late/register",
      changes: [{ label: `${HOME}/$late`, op: "register" }],
    });
    expect(fake.sends[0]?.state).toEqual({ [HOME]: { "$late [store]": 0 } });
  });

  it("coalesces one module's registrations into one row naming each store", async () => {
    await listen();
    register("$first", atom(1));
    register("$second", atom(2));
    register("$third", atom(3));

    await endOfTurn();

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]?.action["action"]).toEqual({
      type: `${HOME}/register`,
      changes: [
        { label: `${HOME}/$first`, op: "register" },
        { label: `${HOME}/$second`, op: "register" },
        { label: `${HOME}/$third`, op: "register" },
      ],
    });
  });

  it("coalesces per module, so two modules in one turn draw a row each", async () => {
    await listen();
    register("$first", atom(1));
    register("$second", atom(2));
    register("$other", atom(3), "atom", "src/stores/user.ts");
    register("$more", atom(4), "atom", "src/stores/user.ts");

    await endOfTurn();

    expect(rowNames()).toEqual([`${HOME}/register`, "src/stores/user.ts/register"]);
  });

  it("draws one hot reload row for a module that leaves and comes back in one run", async () => {
    register("$count", atom(0));
    register("$total", atom(0));
    await listen();

    register("$count", atom(1));
    register("$total", atom(2));

    await endOfTurn();

    expect(rowNames()).toEqual([`${HOME}/hotReload`]);
    expect(fake.sends[0]?.action["action"]).toEqual({
      type: `${HOME}/hotReload`,
      changes: [
        { label: `${HOME}/$count`, op: "hotReload" },
        { label: `${HOME}/$total`, op: "hotReload" },
      ],
    });
    expect(fake.sends[0]?.state).toEqual({ [HOME]: { "$count [store]": 1, "$total [store]": 2 } });
  });

  it("names the hot reload row after the only store it moved", async () => {
    register("$count", atom(0));
    await listen();

    register("$count", atom(1));

    await endOfTurn();

    expect(fake.sends[0]?.action["action"]).toEqual({
      type: "$count/hotReload",
      changes: [{ label: `${HOME}/$count`, op: "hotReload" }],
    });
  });

  it("says which stores a hot reload added and which it dropped", async () => {
    const $gone = atom(0);

    register("$count", atom(0));
    register("$gone", $gone);
    await listen();

    unregisterStore($gone);
    register("$count", atom(1));
    register("$fresh", atom(2));

    await endOfTurn();

    expect(fake.sends[0]?.action["action"]).toEqual({
      type: `${HOME}/hotReload`,
      changes: [
        { label: `${HOME}/$gone`, op: "unregister" },
        { label: `${HOME}/$count`, op: "hotReload" },
        { label: `${HOME}/$fresh`, op: "register" },
      ],
    });
  });

  it("keeps the unregister row for a module that drops its last store", async () => {
    const $count = atom(0);

    register("$count", $count);
    await listen();

    unregisterStore($count);

    await endOfTurn();

    expect(fake.sends[0]?.action["action"]).toEqual({
      type: "$count/unregister",
      changes: [{ label: `${HOME}/$count`, op: "unregister" }],
    });
  });

  it("pairs per module, so one module reloading leaves another module's row alone", async () => {
    const OTHER = "src/stores/user.ts";

    register("$count", atom(0));
    await listen();

    register("$count", atom(1));
    register("$other", atom(2), "atom", OTHER);

    await endOfTurn();

    expect(rowNames()).toEqual(["$count/hotReload", "$other/register"]);
  });
});

describe("a store the tree draws nowhere", () => {
  /** A store the plugin registered from a creation site inside a function, placed by nothing. */
  function registerMadeIn(name: string, store: Store, fn: string): void {
    registerStore({
      store,
      name,
      home: HOME,
      type: "atom",
      origin: "plugin",
      external: false,
      fn,
    });
  }

  it("draws no register row for it, and still draws one for the stores beside it", async () => {
    await listen();

    registerMadeIn("$hits", atom(0), "track");
    register("$count", atom(1));

    await endOfTurn();

    expect(rowNames()).toEqual(["$count/register"]);
  });

  it("draws no register row at all when nothing in the turn is placed", async () => {
    await listen();

    registerMadeIn("$hits", atom(0), "track");
    registerMadeIn("$misses", atom(1), "track");

    await endOfTurn();

    expect(fake.sends).toHaveLength(0);
  });

  it("draws no mount or unmount row for it", async () => {
    const $hits = atom(0);

    registerMadeIn("$hits", $hits, "track");
    await listen();

    const unbind = $hits.listen(() => {});

    unbind();

    await endOfTurn();

    expect(fake.sends).toHaveLength(0);
  });

  /** The flag is not a row: the marker a value carries reads it, so the skip must not touch it. */
  it("still records that it was mounted, which the tree reads", async () => {
    const $hits = atom(0);

    registerMadeIn("$hits", $hits, "track");
    await listen();

    $hits.listen(() => {})();

    expect(getEntry($hits)?.everMounted).toBe(true);
  });

  it("draws its write row, because that write is what changed the tree", async () => {
    const $hits = atom(0);

    registerMadeIn("$hits", $hits, "track");
    await listen();

    $hits.set(1);

    await endOfTurn();

    expect(rowNames()).toEqual(["$hits/set"]);
  });

  /**
   * A hot reload takes a whole module in one turn, and the owner may go first. The store it held
   * then has no drawn owner left, so the row names the owner alone. That is the whole of what left
   * the tree: a store drawn under an owner leaves the tree with it, and the diff shows both.
   */
  it("names the owner alone when a reload takes it before the store it held", async () => {
    const $canUndo = atom(false);
    const $draft = Object.assign(atom(""), { $canUndo });

    registerMadeIn("$canUndo", $canUndo, "withUndo");
    register("$draft", $draft);
    ownBindings({ home: HOME, external: false, moduleKey: HOME }, [["$draft", $draft, true]]);
    await listen();

    unregisterStore($draft);
    unregisterStore($canUndo);

    await endOfTurn();

    expect(fake.sends[0]?.action["action"]).toEqual({
      type: "$draft/unregister",
      changes: [{ label: `${HOME}/$draft`, op: "unregister" }],
    });
  });
});

describe("lifecycleEvents off", () => {
  it("draws none of the lifecycle rows and lets the tree lag until the next write", async () => {
    const $counter = atom(0);
    const $late = atom(0);

    register("$counter", $counter);
    await listen({ lifecycleEvents: false });

    const unbind = $counter.listen(() => {});

    unbind();
    register("$late", $late);

    await endOfTurn();

    expect(fake.sends).toHaveLength(0);

    $counter.set(1);

    await endOfTurn();

    expect(rowNames()).toEqual(["$counter/set"]);
    expect(fake.sends[0]?.state).toEqual({ [HOME]: { "$counter [store]": 1, "$late [store]": 0 } });
  });
});

describe("while not listening", () => {
  it("sends none of the lifecycle rows", async () => {
    const $counter = atom(0);

    register("$counter", $counter);
    connectDevtools();

    await endOfTurn();

    const unbind = $counter.listen(() => {});

    unbind();
    register("$late", atom(0));

    await endOfTurn();

    expect(fake.sends).toHaveLength(0);
  });

  it("drops the rows it was holding when the panel stops", async () => {
    await listen();
    register("$late", atom(0));
    fake.stop();

    await endOfTurn();
    fake.start();
    await endOfTurn();

    expect(fake.sends).toHaveLength(0);
  });
});
