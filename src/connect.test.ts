import { stringify } from "jsan";
import { atom, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectDevtools } from "./connect.ts";
import { resetDevtoolsGlobal } from "./global.ts";
import { getEntry, listEntries, trackStores } from "./registry.ts";
import { type FakeExtension, installFakeExtension } from "./testing/fake-extension.ts";
import { EXTENSION_OPTIONS } from "./testing/panel.ts";
import { hasHooks, keepHooks } from "./unhook.ts";

let fake: FakeExtension;

/** `init` is deferred to the end of the connect turn, so a test has to reach that end. */
function endOfTurn(): Promise<void> {
  return Promise.resolve();
}

/** `trackStores` records every store as `unknown`, so an unmounted one reaches the panel marked. */
function stale(value: unknown): unknown {
  return { data: { "(value)": value }, __serializedType__: "not mounted, may be stale" };
}

function hooked(store: Store): boolean {
  const entry = getEntry(store);

  return entry !== undefined && hasHooks(entry);
}

describe("connectDevtools", () => {
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

  describe("the handle", () => {
    it("connects when the extension is there", () => {
      expect(connectDevtools().connected).toBe(true);
      expect(fake.configs).toHaveLength(1);
    });

    it("is a quiet no-op with no extension", async () => {
      const $count = atom(0);

      fake.uninstall();
      trackStores("cart", { $count });

      const handle = connectDevtools();

      await endOfTurn();

      expect(handle.connected).toBe(false);
      expect(console.warn).not.toHaveBeenCalled();
      expect(fake.inits).toHaveLength(0);
      expect(hooked($count)).toBe(false);

      handle.disconnect();
    });

    it("is a quiet no-op when the extension throws", async () => {
      globalThis.__REDUX_DEVTOOLS_EXTENSION__ = {
        connect: () => {
          throw new Error("boom");
        },
      };

      const handle = connectDevtools();

      await endOfTurn();

      expect(handle.connected).toBe(false);
      expect(console.warn).not.toHaveBeenCalled();
      expect(fake.inits).toHaveLength(0);
    });

    it("warns once on a second call and hands back the first handle", () => {
      const first = connectDevtools();
      const second = connectDevtools();

      expect(second).toBe(first);
      expect(fake.configs).toHaveLength(1);
      expect(console.warn).toHaveBeenCalledTimes(1);

      connectDevtools();

      expect(console.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe("the config", () => {
    it("carries our type, the full features object and our defaults", () => {
      connectDevtools();

      expect(fake.configs[0]).toEqual({
        name: "nanostores",
        type: "nanostores",
        maxAge: 500,
        serialize: { replacer: expect.any(Function), options: true },
        trace: expect.any(Function),
        features: {
          pause: true,
          export: true,
          lock: false,
          persist: false,
          import: false,
          jump: false,
          skip: false,
          reorder: false,
          dispatch: false,
          test: false,
        },
      });
    });

    it("takes the options it is given", () => {
      connectDevtools({ name: "my-app", maxAge: 20 });

      expect(fake.configs[0]).toMatchObject({ name: "my-app", maxAge: 20 });
    });

    it("reads an explicit undefined as an absent key", () => {
      connectDevtools({ name: undefined, maxAge: undefined, trace: undefined });

      expect(fake.configs[0]).toMatchObject({ name: "nanostores", maxAge: 500 });
      expect(fake.configs[0]?.trace).toBeTypeOf("function");
    });

    it("hands the user serializers to the replacer it passes", () => {
      connectDevtools({
        serializers: [{ match: (value) => value === 7, convert: () => "seven" }],
      });

      const serialize = fake.configs[0]?.serialize;
      const replacer = typeof serialize === "object" ? serialize.replacer : undefined;

      expect(replacer?.("n", 7)).toBe("seven");
      expect(replacer?.("n", 9007199254740993n)).toEqual({
        data: { "(value)": "9007199254740993" },
        __serializedType__: "BigInt",
      });
    });

    it("hands the two value caps to the replacer it passes", () => {
      class Holder {
        a = 1;
        b = { deep: true };
      }

      connectDevtools({ maxValueDepth: 0, maxValueMembers: 1 });

      const serialize = fake.configs[0]?.serialize;
      const replacer = typeof serialize === "object" ? serialize.replacer : undefined;

      expect(replacer?.("h", new Holder())).toEqual({
        data: {
          a: 1,
          "…": {
            data: {},
            __serializedType__: "1 more members past the 1 drawn under a class instance",
          },
        },
        __serializedType__: "Holder",
      });
    });

    it("warns once and falls back to the default where a value cap is no count", () => {
      class Holder {
        deep = { down: { down: { down: { down: { down: { down: "past five" } } } } } };
      }

      connectDevtools({ maxValueDepth: -2 });

      const serialize = fake.configs[0]?.serialize;
      const replacer = typeof serialize === "object" ? serialize.replacer : undefined;

      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.warn).toHaveBeenCalledWith(
        "[nanostores-devtools] maxValueDepth is -2 in connectDevtools(), which is no number of " +
          "levels, so the bridge draws 5 levels below a class instance instead. Pass a whole " +
          "number of 0 or more, or Infinity for no cap.",
      );

      /** The default of 5 is really the one in force: the sixth level below the instance is cut. */
      expect(stringify(new Holder(), replacer, null, EXTENSION_OPTIONS)).toContain(
        "past the 5 levels drawn under a class instance",
      );
    });

    it("leaves trace out entirely with the option off, and never passes traceLimit", () => {
      connectDevtools({ trace: false, traceLimit: 25 });

      expect(fake.configs[0] && "trace" in fake.configs[0]).toBe(false);
      expect(fake.configs[0] && "traceLimit" in fake.configs[0]).toBe(false);
    });
  });

  describe("disconnect", () => {
    it("closes the connection, detaches every hook and leaves the registry alone", async () => {
      const $count = atom(0);
      const unhook = vi.fn();

      trackStores("cart", { $count });

      const handle = connectDevtools();

      await endOfTurn();

      const entry = getEntry($count);

      if (entry) {
        keepHooks(entry, unhook);
      }

      handle.disconnect();

      expect(unhook).toHaveBeenCalledTimes(1);
      expect(fake.listenerCount()).toBe(0);
      expect(hooked($count)).toBe(false);
      expect(listEntries()).toHaveLength(1);

      const again = connectDevtools();

      await endOfTurn();

      expect(again.connected).toBe(true);
      expect(fake.listenerCount()).toBe(1);
      expect(fake.inits).toHaveLength(2);
      expect(fake.inits[1]?.state).toEqual({ cart: { "$count [store]": stale(0) } });
    });

    it("does nothing twice over", async () => {
      const handle = connectDevtools();

      await endOfTurn();
      handle.disconnect();
      handle.disconnect();

      expect(fake.listenerCount()).toBe(0);
    });

    it("drops the deferred init when it happens in the connect turn", async () => {
      connectDevtools().disconnect();

      await endOfTurn();

      expect(fake.inits).toHaveLength(0);
    });
  });

  describe("the first init", () => {
    it("fires at the end of the connect turn, not synchronously", async () => {
      connectDevtools();

      expect(fake.inits).toHaveLength(0);

      trackStores("cart", { $count: atom(7) });

      await endOfTurn();

      expect(fake.inits).toHaveLength(1);
      expect(fake.inits[0]?.state).toEqual({ cart: { "$count [store]": stale(7) } });
    });

    /** jsan runs inside the extension's `init`, so one unserializable store throws at our call. */
    it("survives an init the extension cannot serialize, and warns once", async () => {
      fake.setInitFailure("Do not know how to serialize a BigInt");
      trackStores("cart", { $count: atom(0) });
      connectDevtools();

      await endOfTurn();
      fake.start();

      expect(fake.inits).toHaveLength(0);
      expect(console.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe("the listening flag", () => {
    it("sends nothing while the panel is closed", async () => {
      connectDevtools();

      await endOfTurn();
      trackStores("cart", { $count: atom(0) });

      expect(fake.sends).toHaveLength(0);
    });

    it("re-inits on the way into listening and ignores a second START", async () => {
      connectDevtools();

      await endOfTurn();
      trackStores("cart", { $count: atom(1) });
      fake.start();

      expect(fake.inits).toHaveLength(2);
      expect(fake.inits[1]?.state).toEqual({ cart: { "$count [store]": stale(1) } });

      fake.start();

      expect(fake.inits).toHaveLength(2);
    });

    it("re-inits with the current tree after STOP then START", async () => {
      connectDevtools();

      await endOfTurn();
      fake.start();
      fake.stop();
      trackStores("cart", { $count: atom(2) });
      fake.start();

      expect(fake.inits).toHaveLength(3);
      expect(fake.inits[2]?.state).toEqual({ cart: { "$count [store]": stale(2) } });
    });

    it("ignores a START whose source is not the extension", async () => {
      connectDevtools();

      await endOfTurn();
      fake.deliver({ type: "START", state: undefined, id: undefined, source: "@devtools-page" });
      trackStores("cart", { $count: atom(0) });

      expect(fake.inits).toHaveLength(1);
      expect(fake.sends).toHaveLength(0);
    });

    it("stops listening after disconnect", async () => {
      const handle = connectDevtools();

      await endOfTurn();
      fake.start();
      handle.disconnect();
      fake.start();

      expect(fake.inits).toHaveLength(2);
    });
  });
});
