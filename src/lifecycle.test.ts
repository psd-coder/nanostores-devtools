import { atom, computed, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectDevtools } from "./connect.ts";
import { resetDevtoolsGlobal } from "./global.ts";
import { getEntry, registerStore, type StoreType } from "./registry.ts";
import { type FakeExtension, installFakeExtension } from "./testing/fake-extension.ts";

const HOME = "src/stores/cart.ts";

let fake: FakeExtension;

function endOfTurn(): Promise<void> {
  return Promise.resolve();
}

function register(name: string, store: Store, type: StoreType = "atom", home = HOME): void {
  registerStore({ store, name, home, type, origin: "plugin", external: false });
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
      { [HOME]: { $counter: 1, $other: 0 } },
      { [HOME]: { $counter: 1, $other: 0 } },
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
    expect(fake.sends[0]?.state).toEqual({ [HOME]: { $source: 1, "$total [computed]": 2 } });
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

describe("register and unregister rows", () => {
  it("draws no row for a store that lands in the connect turn", async () => {
    const $early = atom(7);

    connectDevtools();
    register("$early", $early);

    await endOfTurn();
    fake.start();
    await endOfTurn();

    expect(fake.sends).toHaveLength(0);
    expect(fake.inits[0]?.state).toEqual({ [HOME]: { $early: 7 } });
  });

  it("draws no row in the connect turn even with the panel already listening", async () => {
    const $early = atom(7);

    connectDevtools();
    fake.start();
    register("$early", $early);

    await endOfTurn();

    expect(fake.sends).toHaveLength(0);
    expect(fake.inits.at(-1)?.state).toEqual({ [HOME]: { $early: 7 } });
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
    expect(fake.sends[0]?.state).toEqual({ [HOME]: { $late: 0 } });
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

  it("draws one unregister row and one register row for a module reloaded in one run", async () => {
    register("$count", atom(0));
    register("$total", atom(0));
    await listen();

    register("$count", atom(1));
    register("$total", atom(2));

    await endOfTurn();

    expect(rowNames()).toEqual([`${HOME}/unregister`, `${HOME}/register`]);
    expect(fake.sends[0]?.action["action"]).toEqual({
      type: `${HOME}/unregister`,
      changes: [
        { label: `${HOME}/$count`, op: "unregister" },
        { label: `${HOME}/$total`, op: "unregister" },
      ],
    });
    expect(fake.sends[1]?.state).toEqual({ [HOME]: { $count: 1, $total: 2 } });
  });
});

describe("lifecycleEvents off", () => {
  it("draws none of the four rows and lets the tree lag until the next write", async () => {
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
    expect(fake.sends[0]?.state).toEqual({ [HOME]: { $counter: 1, $late: 0 } });
  });
});

describe("while not listening", () => {
  it("sends none of the four rows", async () => {
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
