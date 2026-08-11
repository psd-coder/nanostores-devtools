import {
  atom,
  batch,
  batched,
  computed,
  deepMap,
  map,
  onSet,
  type Store,
  type WritableAtom,
} from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectDevtools } from "./connect.ts";
import { resetDevtoolsGlobal } from "./global.ts";
import { registerStore, type StoreType, trackStores } from "./registry.ts";
import { type FakeExtension, installFakeExtension } from "./testing/fake-extension.ts";

let fake: FakeExtension;

function endOfTurn(): Promise<void> {
  return Promise.resolve();
}

function register(name: string, store: Store, type: StoreType = "atom"): void {
  registerStore({ store, name, home: "cart", type, origin: "plugin" });
}

/** Connect, reach the deferred `init`, then open the panel, which is when rows start flowing. */
async function listen(options?: Parameters<typeof connectDevtools>[0]): Promise<void> {
  connectDevtools(options);

  await endOfTurn();
  fake.start();
}

/** A computed only recomputes while it is mounted, so a follower test has to hold it open. */
function mount(store: Store): void {
  store.listen(() => {});
}

function frameCount(stack: string | undefined): number {
  return stack?.match(/\n\s+at /g)?.length ?? 0;
}

/** Deeper than any limit under test, so a short stack cannot pass for a trimmed one. */
function writeDeep($store: WritableAtom<number>, value: number, depth = 30): void {
  if (depth === 0) {
    $store.set(value);

    return;
  }

  writeDeep($store, value, depth - 1);
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

describe("direct write rows", () => {
  describe("one row per write", () => {
    it("draws one row for one set", async () => {
      const $counter = atom(0);

      register("$counter", $counter);
      await listen();

      $counter.set(1);

      expect(fake.sends).toHaveLength(0);

      await endOfTurn();

      expect(fake.sends).toHaveLength(1);
      expect(fake.sends[0]?.action["type"]).toBe("$counter/set");
    });

    it("coalesces nothing: three writes draw three rows", async () => {
      const $counter = atom(0);

      register("$counter", $counter);
      await listen();

      $counter.set(1);
      $counter.set(2);
      $counter.set(3);

      await endOfTurn();

      expect(fake.sends.map((call) => call.state)).toEqual([
        { cart: { $counter: 1 } },
        { cart: { $counter: 2 } },
        { cart: { $counter: 3 } },
      ]);
    });

    it("draws a row for a store of unknown type, which is what trackStores records", async () => {
      const $counter = atom(0);

      trackStores("cart", { $counter });
      await listen();

      $counter.set(1);

      await endOfTurn();

      expect(fake.sends[0]?.action["type"]).toBe("$counter/set");
      expect(fake.sends[0]?.state).toEqual({ cart: { $counter: 1 } });
    });

    it("drops the hooks it attached when a later registration changes the type", async () => {
      const $total = atom(0);

      register("$total", $total, "unknown");
      await listen();

      $total.set(1);

      await endOfTurn();

      expect(fake.sends.map((call) => call.action["type"])).toEqual(["$total/set"]);

      register("$total", $total, "computed");
      $total.set(2);

      await endOfTurn();

      expect(fake.sends.map((call) => call.action["type"])).toEqual([
        "$total/set",
        "$total/computed",
      ]);
    });

    it("hooks a store that registers after connect", async () => {
      const $late = atom(0);

      await listen();
      register("$late", $late);
      $late.set(1);

      await endOfTurn();

      expect(fake.sends[0]?.action["type"]).toBe("$late/set");
    });
  });

  describe("row names", () => {
    it("names a map write after the changed key", async () => {
      const $user = map<{ name: string }>({ name: "ann" });

      register("$user", $user, "map");
      await listen();

      $user.setKey("name", "bo");

      await endOfTurn();

      expect(fake.sends[0]?.action["type"]).toBe("$user/setKey:name");
    });

    it("names a deepMap write after the dotted path", async () => {
      const $settings = deepMap<{ theme: { color: string } }>({ theme: { color: "red" } });

      register("$settings", $settings, "deepMap");
      await listen();

      $settings.setKey("theme.color", "blue");

      await endOfTurn();

      expect(fake.sends[0]?.action["type"]).toBe("$settings/setKey:theme.color");
      expect(fake.sends[0]?.state).toEqual({ cart: { $settings: { theme: { color: "blue" } } } });
    });
  });

  describe("the tree beside a row", () => {
    it("holds the value after that write and never the next write's value", async () => {
      const $first = atom(0);
      const $second = atom(0);

      register("$first", $first);
      register("$second", $second);
      await listen();

      $first.set(1);
      $second.set(2);

      await endOfTurn();

      expect(fake.sends[0]?.state).toEqual({ cart: { $first: 1, $second: 0 } });
      expect(fake.sends[1]?.state).toEqual({ cart: { $first: 1, $second: 2 } });
    });
  });

  describe("writes that draw no row", () => {
    it("flushes the open row early when a write changes nothing", async () => {
      const $counter = atom(0);

      register("$counter", $counter);
      await listen();

      $counter.set(1);
      $counter.set(1);

      expect(fake.sends).toHaveLength(1);

      await endOfTurn();

      expect(fake.sends).toHaveLength(1);
      expect(fake.sends[0]?.state).toEqual({ cart: { $counter: 1 } });
    });

    it("flushes the open row early when the app aborts a write", async () => {
      const $counter = atom(0);

      register("$counter", $counter);
      await listen();
      onSet($counter, ({ abort, newValue }) => {
        if (newValue === 2) {
          abort();
        }
      });

      $counter.set(1);
      $counter.set(2);

      await endOfTurn();

      expect(fake.sends).toHaveLength(1);
      expect($counter.value).toBe(1);
    });
  });

  describe("the message", () => {
    it("carries type at both levels, our timestamp, and changes with no values", async () => {
      const $counter = atom(0);
      const before = Date.now();

      register("$counter", $counter);
      await listen();

      $counter.set(1);

      await endOfTurn();

      const action = fake.sends[0]?.action;

      expect(action).toEqual({
        type: "$counter/set",
        action: {
          type: "$counter/set",
          changes: [{ label: "cart/$counter", op: "set" }],
        },
        timestamp: expect.any(Number),
      });
      expect(action?.["timestamp"]).toBeGreaterThanOrEqual(before);
    });

    it("keeps the timestamp of the write that caused the row, not of the flush", async () => {
      const $counter = atom(0);

      vi.useFakeTimers();

      try {
        register("$counter", $counter);
        await listen();
        vi.setSystemTime(1000);
        $counter.set(1);
        vi.setSystemTime(9000);
        $counter.set(2);
      } finally {
        vi.useRealTimers();
      }

      expect(fake.sends[0]?.action["timestamp"]).toBe(1000);
    });

    it("puts the changed key in path", async () => {
      const $user = map<{ name: string }>({ name: "ann" });

      register("$user", $user, "map");
      await listen();

      $user.setKey("name", "bo");

      await endOfTurn();

      expect(fake.sends[0]?.action["action"]).toEqual({
        type: "$user/setKey:name",
        changes: [{ label: "cart/$user", op: "setKey", path: "name" }],
      });
    });
  });

  describe("the stack", () => {
    it("points at the developer's own code and restores Error.stackTraceLimit", async () => {
      const $counter = atom(0);
      const before = Error.stackTraceLimit;

      try {
        Error.stackTraceLimit = 3;

        register("$counter", $counter);
        await listen();

        $counter.set(1);

        expect(Error.stackTraceLimit).toBe(3);
      } finally {
        Error.stackTraceLimit = before;
      }

      await endOfTurn();

      expect(fake.sends[0]?.trace).toContain("timeline.test.ts");
      expect(fake.sends[0]?.trace).not.toContain("/src/timeline.ts");
    });

    it("captures ten frames by default", async () => {
      const $counter = atom(0);

      register("$counter", $counter);
      await listen();

      writeDeep($counter, 1);

      await endOfTurn();

      expect(frameCount(fake.sends[0]?.trace)).toBe(10);
    });

    it("captures as many frames as traceLimit asks for", async () => {
      const $counter = atom(0);

      register("$counter", $counter);
      await listen({ traceLimit: 3 });

      writeDeep($counter, 1);

      await endOfTurn();

      expect(frameCount(fake.sends[0]?.trace)).toBe(3);
    });

    it("hands the panel no stack with trace off", async () => {
      const $counter = atom(0);

      register("$counter", $counter);
      await listen({ trace: false });

      $counter.set(1);

      await endOfTurn();

      expect(fake.sends[0]?.trace).toBeUndefined();
    });
  });

  describe("a throw inside our own listener", () => {
    it("is caught, warns once for that store, and lets the drain finish", async () => {
      const $counter = atom(0);
      const $other = atom(0);
      const seen: number[] = [];

      register("$counter", $counter);
      register("$other", $other);
      await listen();
      $counter.listen((value) => {
        seen.push(value);
      });

      fake.setSendFailure("cannot serialize");
      $counter.set(1);
      $counter.set(2);
      $counter.set(3);

      expect(seen).toEqual([1, 2, 3]);
      expect(console.warn).toHaveBeenCalledTimes(1);

      fake.setSendFailure(undefined);
      $other.set(1);

      await endOfTurn();

      expect(fake.sends.at(-1)?.action["type"]).toBe("$other/set");
      expect(fake.sends.at(-1)?.state).toEqual({ cart: { $counter: 3, $other: 1 } });
    });

    it("names the store whose row failed, not the store that triggered the flush", async () => {
      const $first = atom(0);
      const $second = atom(0);

      register("$first", $first);
      register("$second", $second);
      await listen();

      $first.set(1);
      fake.setSendFailure("cannot serialize");
      $second.set(1);

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("cart/$first"));
      expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("cart/$second"));
    });

    it("is caught in the microtask flush too", async () => {
      const $counter = atom(0);

      register("$counter", $counter);
      await listen();

      fake.setSendFailure("cannot serialize");
      $counter.set(1);

      await endOfTurn();

      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(fake.sends).toHaveLength(0);
    });
  });

  describe("while not listening", () => {
    it("builds no snapshot and sends nothing", async () => {
      const $counter = atom(0);
      const $unreadable = atom(0);

      register("$counter", $counter);
      connectDevtools();

      await endOfTurn();
      register("$unreadable", $unreadable);
      Object.defineProperty($unreadable, "value", {
        get: () => {
          throw new Error("read me and the test fails");
        },
      });

      $counter.set(1);

      await endOfTurn();

      expect(fake.sends).toHaveLength(0);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it("drops a row left open when the panel stops", async () => {
      const $counter = atom(0);

      register("$counter", $counter);
      await listen();

      $counter.set(1);
      fake.stop();
      fake.start();
      $counter.set(2);

      await endOfTurn();

      expect(fake.sends.map((call) => call.action["type"])).toEqual(["$counter/set"]);
      expect(fake.sends[0]?.state).toEqual({ cart: { $counter: 2 } });
    });
  });
});

describe("computed follower rows", () => {
  it("appends the follower to the row of the write that caused it", async () => {
    const $items = atom([1, 2]);
    const $count = computed($items, (items) => items.length);

    register("$items", $items);
    register("$count", $count, "computed");
    mount($count);
    await listen();

    $items.set([1, 2, 3]);

    await endOfTurn();

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]?.action["action"]).toEqual({
      type: "$items/set",
      changes: [
        { label: "cart/$items", op: "set" },
        { label: "cart/$count", op: "computed", from: "cart/$items" },
      ],
    });
  });

  it("never closes the open row from a computed's own set", async () => {
    const $items = atom([1, 2]);
    const $count = computed($items, (items) => items.length);

    register("$items", $items);
    register("$count", $count, "computed");
    mount($count);
    await listen();

    $items.set([1, 2, 3]);

    expect(fake.sends).toHaveLength(0);

    await endOfTurn();

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]?.state).toEqual({ cart: { $count: 3, $items: [1, 2, 3] } });
  });

  it("keeps a three level chain in one row, each follower naming the one before it", async () => {
    const $a = atom(1);
    const $b = computed($a, (a) => a + 1);
    const $c = computed($b, (b) => b + 1);
    const $d = computed($c, (c) => c + 1);

    register("$a", $a);
    register("$b", $b, "computed");
    register("$c", $c, "computed");
    register("$d", $d, "computed");
    mount($d);
    await listen();

    $a.set(2);

    await endOfTurn();

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]?.action["action"]).toEqual({
      type: "$a/set",
      changes: [
        { label: "cart/$a", op: "set" },
        { label: "cart/$b", op: "computed", from: "cart/$a" },
        { label: "cart/$c", op: "computed", from: "cart/$b" },
        { label: "cart/$d", op: "computed", from: "cart/$c" },
      ],
    });
  });

  it("draws no follower for an unmounted computed, which never recomputes", async () => {
    const $items = atom([1, 2]);
    const $count = computed($items, (items) => items.length);

    register("$items", $items);
    register("$count", $count, "computed");
    await listen();

    $items.set([1, 2, 3]);

    await endOfTurn();

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]?.action["action"]).toEqual({
      type: "$items/set",
      changes: [{ label: "cart/$items", op: "set" }],
    });
  });

  it("draws its own row for a follower that finds no open row", async () => {
    const $source = atom(1);
    const $total = computed($source, (source) => source * 2);

    register("$total", $total, "computed");
    mount($total);
    await listen();

    $source.set(2);

    await endOfTurn();

    expect(fake.sends[0]?.action["type"]).toBe("$total/computed");
    /** Strict, so a `from: undefined` key on its way to the panel fails here. */
    expect(fake.sends[0]?.action["action"]).toStrictEqual({
      type: "$total/computed",
      changes: [{ label: "cart/$total", op: "computed" }],
    });
  });

  it("hands the panel no stack for a row a follower opened on its own", async () => {
    const $source = atom(1);
    const $total = computed($source, (source) => source * 2);

    register("$total", $total, "computed");
    mount($total);
    await listen();

    $source.set(2);

    await endOfTurn();

    expect(fake.sends[0]?.action["type"]).toBe("$total/computed");
    expect(fake.sends[0]?.trace).toBeUndefined();
  });

  it("closes a row with a follower in it when the next direct write opens its own", async () => {
    const $items = atom([1, 2]);
    const $count = computed($items, (items) => items.length);
    const $other = atom(0);

    register("$items", $items);
    register("$count", $count, "computed");
    register("$other", $other);
    mount($count);
    await listen();

    $items.set([1, 2, 3]);
    $other.set(1);

    expect(fake.sends).toHaveLength(1);

    await endOfTurn();

    expect(fake.sends.map((call) => call.action["action"])).toEqual([
      {
        type: "$items/set",
        changes: [
          { label: "cart/$items", op: "set" },
          { label: "cart/$count", op: "computed", from: "cart/$items" },
        ],
      },
      { type: "$other/set", changes: [{ label: "cart/$other", op: "set" }] },
    ]);
  });

  it("known limit: of two followers of one source the second names the first", async () => {
    const $items = atom([1, 2]);
    const $count = computed($items, (items) => items.length);
    const $total = computed($items, (items) => items.length * 10);

    register("$items", $items);
    register("$count", $count, "computed");
    register("$total", $total, "computed");
    mount($count);
    mount($total);
    await listen();

    $items.set([1, 2, 3]);

    await endOfTurn();

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]?.action["action"]).toEqual({
      type: "$items/set",
      changes: [
        { label: "cart/$items", op: "set" },
        { label: "cart/$count", op: "computed", from: "cart/$items" },
        { label: "cart/$total", op: "computed", from: "cart/$count" },
      ],
    });
  });

  it("known limit: inside batch() a follower attaches to the last write of the batch", async () => {
    const $items = atom([1, 2]);
    const $count = computed($items, (items) => items.length);
    const $other = atom(0);

    register("$items", $items);
    register("$count", $count, "computed");
    register("$other", $other);
    mount($count);
    await listen();

    batch(() => {
      $items.set([1, 2, 3]);
      $other.set(1);
    });

    await endOfTurn();

    expect(fake.sends.map((call) => call.action["action"])).toEqual([
      { type: "$items/set", changes: [{ label: "cart/$items", op: "set" }] },
      {
        type: "$other/set",
        changes: [
          { label: "cart/$other", op: "set" },
          { label: "cart/$count", op: "computed", from: "cart/$other" },
        ],
      },
    ]);
  });

  it("known limit: a write mid-cascade takes the followers still queued behind it", async () => {
    const $items = atom([1, 2]);
    const $other = atom(0);
    const $count = computed($items, (items) => items.length);

    register("$items", $items);
    register("$count", $count, "computed");
    register("$other", $other);

    /** Subscribed before the computed mounts, so it runs before the recompute in the same drain. */
    $items.listen(() => {
      $other.set($other.value + 1);
    });
    mount($count);
    await listen();

    $items.set([1, 2, 3]);

    await endOfTurn();

    expect(fake.sends.map((call) => call.action["action"])).toEqual([
      { type: "$items/set", changes: [{ label: "cart/$items", op: "set" }] },
      {
        type: "$other/set",
        changes: [
          { label: "cart/$other", op: "set" },
          { label: "cart/$count", op: "computed", from: "cart/$other" },
        ],
      },
    ]);
  });

  it("known limit: a batched store recomputes in a timer and draws its own row", async () => {
    const $items = atom([1, 2]);
    const $count = batched($items, (items) => items.length);

    register("$items", $items);
    register("$count", $count, "batched");
    mount($count);
    await listen();

    $items.set([1, 2, 3]);

    await endOfTurn();

    expect(fake.sends.map((call) => call.action["type"])).toEqual(["$items/set"]);

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await endOfTurn();

    expect(fake.sends.map((call) => call.action["type"])).toEqual([
      "$items/set",
      "$count/computed",
    ]);
  });
});
