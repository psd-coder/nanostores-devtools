import { atom, deepMap, map, onSet, type Store, type WritableAtom } from "nanostores";
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

describe("direct write rows", () => {
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

      expect(fake.sends).toHaveLength(1);

      register("$total", $total, "computed");
      $total.set(2);

      await endOfTurn();

      expect(fake.sends).toHaveLength(1);
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
