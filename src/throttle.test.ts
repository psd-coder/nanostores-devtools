import { atom, computed, map, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectDevtools, type DevtoolsOptions } from "./connect.ts";
import { resetDevtoolsGlobal } from "./global.ts";
import { ownBindings } from "./ownership.ts";
import { registerStore, type StoreType, unregisterStore } from "./registry.ts";
import { type FakeExtension, installFakeExtension } from "./testing/fake-extension.ts";

let fake: FakeExtension;

/** Well past the epoch, because a store that never drew a row carries a `lastEmit` of zero. */
const START = 1_700_000_000_000;

const WIRE_SOURCE = "@devtools-extension";

function endOfTurn(): Promise<void> {
  return Promise.resolve();
}

function register(
  name: string,
  store: Store,
  type: StoreType = "atom",
  throttle: boolean | number = false,
): void {
  registerStore({
    store,
    name,
    home: "cart",
    type,
    origin: "plugin",
    external: false,
    fn: null,
    throttle,
  });
}

async function listen(options?: DevtoolsOptions): Promise<void> {
  connectDevtools(options);

  await endOfTurn();
  fake.start();
}

/** A computed only recomputes while it is mounted. */
function mount(store: Store): void {
  store.listen(() => {});
}

function pause(status: boolean): void {
  fake.deliver({
    type: "DISPATCH",
    payload: { type: "PAUSE_RECORDING", status },
    source: WIRE_SOURCE,
  });
}

function rows(): string[] {
  return fake.sends.map((call) => String(call.action["type"]));
}

beforeEach(() => {
  resetDevtoolsGlobal();
  fake = installFakeExtension();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
  fake.uninstall();
  vi.restoreAllMocks();
  resetDevtoolsGlobal();
});

describe("a throttled store", () => {
  it("draws a row for the first write and none for the writes in that second", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    $frame.set(2);
    $frame.set(3);

    await endOfTurn();

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]?.state).toEqual({ cart: { "$frame [store, throttled]": 1 } });
  });

  it("draws the last suppressed write when the second ends, carrying the current tree", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    $frame.set(2);
    $frame.set(3);

    await endOfTurn();
    vi.advanceTimersByTime(1000);

    expect(rows()).toEqual(["$frame/set", "$frame/set"]);
    expect(fake.sends[1]?.state).toEqual({ cart: { "$frame [store, throttled]": 3 } });
  });

  it("keeps the timestamp of the write that made the row, not of the second's end", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    vi.setSystemTime(START + 200);
    $frame.set(2);

    await endOfTurn();
    vi.advanceTimersByTime(1000);

    expect(fake.sends[1]?.action["timestamp"]).toBe(START + 200);
  });

  it("captures no stack for a suppressed row", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();
    vi.advanceTimersByTime(1000);

    expect(fake.sends[0]?.trace).toContain("throttle.test.ts");
    expect(fake.sends[1]?.trace).toBeUndefined();
  });

  it("draws a lone write at once after a quiet minute, and waits for nothing", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);

    await endOfTurn();
    vi.advanceTimersByTime(60_000);
    $frame.set(2);

    await endOfTurn();

    expect(rows()).toEqual(["$frame/set", "$frame/set"]);

    vi.advanceTimersByTime(60_000);

    expect(rows()).toEqual(["$frame/set", "$frame/set"]);
  });

  it("lets a leading write clear the pending row, so the timer sends nothing after it", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();

    /** The clock moves without firing the timer, which is a background tab holding it back. */
    vi.setSystemTime(START + 5000);
    $frame.set(3);

    await endOfTurn();
    vi.advanceTimersByTime(10_000);

    expect(rows()).toEqual(["$frame/set", "$frame/set"]);
    expect(fake.sends[1]?.state).toEqual({ cart: { "$frame [store, throttled]": 3 } });
  });

  it("takes its followers into the row that survives, so one mark covers the cascade", async () => {
    const $frame = atom(0);
    const $doubled = computed($frame, (frame) => frame * 2);

    register("$frame", $frame);
    register("$doubled", $doubled, "computed");
    mount($doubled);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();

    expect(fake.sends).toHaveLength(1);

    vi.advanceTimersByTime(1000);

    expect(fake.sends[1]?.action["action"]).toEqual({
      type: "$frame/set",
      changes: [
        { label: "cart/$frame", op: "set" },
        { label: "cart/$doubled", op: "computed", from: "cart/$frame" },
      ],
    });
    expect(fake.sends[1]?.state).toEqual({
      cart: { "$doubled [computed]": 4, "$frame [store, throttled]": 2 },
    });
  });

  it("closes a row another store left open with the tree as it was before the write", async () => {
    const $frame = atom(0);
    const $other = atom(0);

    register("$frame", $frame);
    register("$other", $other);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    $other.set(1);
    $frame.set(2);

    await endOfTurn();

    expect(rows()).toEqual(["$frame/set", "$other/set"]);
    expect(fake.sends[1]?.state).toEqual({
      cart: { "$frame [store, throttled]": 1, "$other [store]": 1 },
    });
  });

  it("draws every lifecycle row, unthrottled", async () => {
    const $frame = atom(0);
    const $late = atom(0);

    register("$frame", $frame);
    await listen({ throttle: ["cart/$frame", "cart/$late"] });

    $frame.set(1);

    const unmount = $frame.subscribe(() => {});

    unmount();
    register("$late", $late);

    await endOfTurn();

    expect(rows()).toEqual(["$frame/set", "$frame/mount", "$frame/unmount", "$late/register"]);
  });
});

describe("the throttle option", () => {
  it("matches on home and name, never on the qualified label", async () => {
    const $frame = atom(0);

    registerStore({
      store: $frame,
      name: "$frame",
      home: "cart",
      type: "atom",
      origin: "plugin",
      external: false,
      fn: null,
      file: "frames.ts",
      place: "makeFrames, line 12",
      number: 2,
    });
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();

    expect(fake.sends).toHaveLength(1);
  });

  it("throttles a store renamed into a match, with no reconnect", async () => {
    const $canUndo = atom(false);

    register("$canUndo", $canUndo);
    await listen({ throttle: ["cart/$undoable"] });

    $canUndo.set(true);
    $canUndo.set(false);

    await endOfTurn();

    expect(rows()).toEqual(["$canUndo/set", "$canUndo/set"]);

    vi.advanceTimersByTime(1000);
    ownBindings({ home: "cart", external: false, moduleKey: "cart" }, [
      ["$undoable", $canUndo, true],
    ]);
    $canUndo.set(true);
    $canUndo.set(false);
    $canUndo.set(true);

    await endOfTurn();

    expect(rows()).toEqual(["$canUndo/set", "$canUndo/set", "$undoable/set"]);
  });

  it("takes a predicate, which reads the home, the name and the type", async () => {
    const $frame = atom(0);
    const seen: string[] = [];

    register("$frame", $frame, "map");
    await listen({
      throttle: (store) => {
        seen.push(`${store.home}/${store.name} [${store.type}]`);

        return store.home === "cart";
      },
    });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();

    expect(seen).toContain("cart/$frame [map]");
    expect(fake.sends).toHaveLength(1);
  });

  it("leaves a store alone when a predicate of the developer's own throws", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({
      throttle: () => {
        throw new Error("boom");
      },
    });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();

    expect(fake.sends).toHaveLength(2);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});

describe("the plugin's comment", () => {
  it("marks a store on its own, with no option at all", async () => {
    const $frame = atom(0);

    register("$frame", $frame, "atom", true);
    await listen({ autoThrottle: false });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();

    expect(fake.sends).toHaveLength(1);
  });

  it("goes away when a hot reload registers the store without it", async () => {
    const $frame = atom(0);

    register("$frame", $frame, "atom", true);
    await listen({ autoThrottle: false });
    unregisterStore($frame);
    register("$frame", $frame);

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();

    expect(fake.sends.filter((call) => call.action["type"] === "$frame/set")).toHaveLength(2);
  });

  it("holds the store to the rate it names, in milliseconds", async () => {
    const $frame = atom(0);

    register("$frame", $frame, "atom", 100);
    await listen({ autoThrottle: false });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();
    vi.advanceTimersByTime(100);

    expect(rows()).toEqual(["$frame/set", "$frame/set"]);
    expect(fake.sends[1]?.state).toEqual({ cart: { "$frame [store, throttled]": 2 } });
  });

  it("draws a write of its own once that rate is out, well inside the default second", async () => {
    const $frame = atom(0);

    register("$frame", $frame, "atom", 100);
    await listen({ autoThrottle: false });

    $frame.set(1);

    await endOfTurn();
    vi.advanceTimersByTime(100);
    $frame.set(2);

    await endOfTurn();

    expect(rows()).toEqual(["$frame/set", "$frame/set"]);
    expect(fake.sends[1]?.action["timestamp"]).toBe(START + 100);
  });

  it("takes an edited rate from the reload that registers the store again", async () => {
    const $frame = atom(0);

    register("$frame", $frame, "atom", 100);
    await listen({ autoThrottle: false });
    register("$frame", $frame, "atom", 250);

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();
    vi.advanceTimersByTime(100);

    expect(rows()).toEqual(["$frame/set"]);

    vi.advanceTimersByTime(150);

    expect(rows()).toEqual(["$frame/set", "$frame/set"]);
  });

  it("holds a bare mark to one row a second", async () => {
    const $frame = atom(0);

    register("$frame", $frame, "atom", true);
    await listen({ autoThrottle: false });

    $frame.set(1);

    await endOfTurn();
    vi.advanceTimersByTime(100);
    $frame.set(2);

    await endOfTurn();

    expect(rows()).toEqual(["$frame/set"]);
  });

  it("survives a rename, which re-runs the option and finds no match", async () => {
    const $frame = atom(0);

    register("$frame", $frame, "atom", true);
    await listen({ autoThrottle: false });
    ownBindings({ home: "cart", external: false, moduleKey: "cart" }, [["$fade", $frame, true]]);

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();

    expect(rows()).toEqual(["$fade/set"]);
  });
});

describe("autoThrottle", () => {
  it("trips on the eleventh write in a second, and the ten before it lose nothing", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen();

    for (let value = 1; value <= 11; value += 1) {
      $frame.set(value);
    }

    await endOfTurn();

    expect(fake.sends).toHaveLength(10);
    /** The tenth row goes out inside the write that trips the counter, so it is not throttled yet. */
    expect(fake.sends.at(-1)?.state).toEqual({ cart: { "$frame [store]": 10 } });

    vi.advanceTimersByTime(1000);

    expect(fake.sends).toHaveLength(11);
    expect(fake.sends.at(-1)?.state).toEqual({ cart: { "$frame [store, throttled]": 11 } });
  });

  it("takes a threshold of its own", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ autoThrottle: 2 });

    $frame.set(1);
    $frame.set(2);
    $frame.set(3);

    await endOfTurn();

    expect(fake.sends).toHaveLength(2);
  });

  it("holds a store it picked up at the next window, where its rate is under the threshold", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ autoThrottle: 2 });

    $frame.set(1);
    $frame.set(2);
    $frame.set(3);

    await endOfTurn();
    vi.advanceTimersByTime(1000);

    expect(fake.sends).toHaveLength(3);

    /** The window that just ended held one write, and the store is held back all the same. */
    vi.advanceTimersByTime(1000);
    $frame.set(4);
    $frame.set(5);

    await endOfTurn();

    expect(fake.sends).toHaveLength(4);
    expect(fake.sends.at(-1)?.state).toEqual({ cart: { "$frame [store, throttled]": 4 } });
  });

  it("keeps a store that wrote fast and then went silent for a minute throttled", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ autoThrottle: 2 });

    $frame.set(1);
    $frame.set(2);
    $frame.set(3);

    await endOfTurn();
    vi.advanceTimersByTime(60_000);
    $frame.set(4);
    $frame.set(5);

    await endOfTurn();

    /** Two full rows, the row closing the first second, then the leading write of this one. */
    expect(rows()).toEqual(["$frame/set", "$frame/set", "$frame/set", "$frame/set"]);
    expect(fake.sends.at(-1)?.state).toEqual({ cart: { "$frame [store, throttled]": 4 } });

    vi.advanceTimersByTime(1000);

    expect(fake.sends.at(-1)?.state).toEqual({ cart: { "$frame [store, throttled]": 5 } });
  });

  it("leaves a fast store alone when it is off, and throttles a marked one anyway", async () => {
    const $frame = atom(0);
    const $marked = atom(0);

    register("$frame", $frame);
    register("$marked", $marked);
    await listen({ autoThrottle: false, throttle: ["cart/$marked"] });

    for (let value = 1; value <= 20; value += 1) {
      $frame.set(value);
      $marked.set(value);
    }

    await endOfTurn();

    expect(rows().filter((type) => type === "$frame/set")).toHaveLength(20);
    expect(rows().filter((type) => type === "$marked/set")).toHaveLength(1);
  });

  it("never trips when a hundred stores each write once in one turn", async () => {
    const stores = Array.from({ length: 100 }, (_ignored, index) => {
      const store = atom(0);

      register(`$store${index}`, store);

      return store;
    });

    await listen();

    for (const store of stores) {
      store.set(1);
    }

    await endOfTurn();

    expect(fake.sends).toHaveLength(100);
  });

  it("throttles a follower that opens its own row every frame", async () => {
    const $source = atom(0);
    const $total = computed($source, (source) => source * 2);

    register("$total", $total, "computed");
    mount($total);
    await listen();

    /** One write a turn, because a row a follower opened is closed by the end of its own turn. */
    for (let value = 1; value <= 11; value += 1) {
      $source.set(value);

      await endOfTurn();
    }

    expect(fake.sends).toHaveLength(10);

    vi.advanceTimersByTime(1000);

    expect(rows()).toHaveLength(11);
    expect(fake.sends.at(-1)?.state).toEqual({ cart: { "$total [computed, throttled]": 22 } });
  });

  it("counts writes and never rows, so a throttled store stays throttled", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ autoThrottle: 2 });

    for (let second = 0; second < 3; second += 1) {
      $frame.set(second * 10 + 1);
      $frame.set(second * 10 + 2);
      $frame.set(second * 10 + 3);
      vi.advanceTimersByTime(1000);
    }

    await endOfTurn();

    /** Two full rows and one closing row in the first second, then one a second after that. */
    expect(fake.sends).toHaveLength(5);
  });

  it("warns once for the store it picked up, and never for a marked one", async () => {
    const $frame = atom(0);
    const $marked = atom(0);

    register("$frame", $frame);
    register("$marked", $marked);
    await listen({ autoThrottle: 2, throttle: ["cart/$marked"] });

    for (let value = 1; value <= 6; value += 1) {
      $frame.set(value);
      $marked.set(value);
    }

    await endOfTurn();

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("cart/$frame wrote 3 times in a second, so the bridge throttles it"),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('pass throttle: ["cart/$frame"]'),
    );
  });

  it("says the name the developer reads, not the qualified label", async () => {
    const $frame = atom(0);

    registerStore({
      store: $frame,
      name: "$frame",
      home: "cart",
      type: "atom",
      origin: "plugin",
      external: false,
      fn: null,
      file: "frames.ts",
      number: 2,
    });
    await listen({ autoThrottle: 1 });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("cart/$frame wrote"));
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("frames.ts"));
  });

  it("throttles a map by its own write rate, keys and all", async () => {
    const $user = map<Record<string, number>>({});

    register("$user", $user, "map");
    await listen({ autoThrottle: 1 });

    $user.setKey("a", 1);
    $user.setKey("b", 2);
    $user.setKey("c", 3);

    await endOfTurn();
    vi.advanceTimersByTime(1000);

    expect(rows()).toEqual(["$user/setKey:a", "$user/setKey:c"]);
    expect(fake.sends[1]?.state).toEqual({
      cart: { "$user [map, throttled]": { a: 1, b: 2, c: 3 } },
    });
  });
});

describe("a session that ends", () => {
  it("drops a pending row and its timer when the panel stops", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();
    fake.stop();
    vi.advanceTimersByTime(5000);

    expect(fake.sends).toHaveLength(1);
  });

  it("drops a pending row and its timer on disconnect", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();
    connectDevtools().disconnect();
    vi.advanceTimersByTime(5000);

    expect(fake.sends).toHaveLength(1);
  });

  it("parks nothing for a store the registry dropped while its row was still open", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    /** Open, not parked yet: the flush that would park it runs at the end of this turn. */
    $frame.set(2);
    unregisterStore($frame);

    await endOfTurn();
    vi.advanceTimersByTime(5000);

    expect(rows()).toEqual(["$frame/set", "$frame/unregister"]);
  });

  it("drops a pending row when the store leaves the registry", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();
    unregisterStore($frame);
    vi.advanceTimersByTime(5000);

    await endOfTurn();

    expect(rows()).toEqual(["$frame/set", "$frame/unregister"]);
  });
});

describe("the pause button", () => {
  it("stops the tree build, and lets the next row through when it lifts", async () => {
    const $counter = atom(0);
    const $unreadable = atom(0);

    register("$counter", $counter);
    await listen();
    pause(true);

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

    pause(false);
    $counter.set(2);

    await endOfTurn();

    expect(rows()).toEqual(["$counter/set"]);
  });

  it("drops the open row and every parked one, and answers nothing", async () => {
    const $frame = atom(0);

    register("$frame", $frame);
    await listen({ throttle: ["cart/$frame"] });

    $frame.set(1);
    $frame.set(2);

    await endOfTurn();

    const before = fake.inits.length;

    pause(true);
    vi.advanceTimersByTime(5000);

    expect(fake.sends).toHaveLength(1);
    expect(fake.inits).toHaveLength(before);
    expect(fake.errors).toHaveLength(0);
  });

  it("holds while a panel closes and opens again", async () => {
    const $counter = atom(0);

    register("$counter", $counter);
    await listen();
    pause(true);
    fake.stop();
    fake.start();

    $counter.set(1);

    await endOfTurn();

    expect(fake.sends).toHaveLength(0);

    pause(false);
    $counter.set(2);

    await endOfTurn();

    expect(rows()).toEqual(["$counter/set"]);
  });
});
