import { atom } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectDevtools } from "./connect.ts";
import { resetDevtoolsGlobal } from "./global.ts";
import { getEntry, listEntries, trackStores } from "./registry.ts";
import { type FakeExtension, installFakeExtension } from "./testing/fake-extension.ts";

let fake: FakeExtension;

/** `init` is deferred to the end of the connect turn, so a test has to reach that end. */
function endOfTurn(): Promise<void> {
  return Promise.resolve();
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
      fake.uninstall();
      trackStores("cart", { $count: atom(0) });

      const handle = connectDevtools();

      await endOfTurn();

      expect(handle.connected).toBe(false);
      expect(console.warn).not.toHaveBeenCalled();
      expect(fake.inits).toHaveLength(0);
      expect(listEntries()[0]?.unhook).toEqual([]);

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
        serialize: { options: true },
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
      getEntry($count)?.unhook.push(unhook);
      handle.disconnect();

      expect(unhook).toHaveBeenCalledTimes(1);
      expect(fake.listenerCount()).toBe(0);
      expect(getEntry($count)?.unhook).toEqual([]);

      const again = connectDevtools();

      await endOfTurn();

      expect(again.connected).toBe(true);
      expect(fake.listenerCount()).toBe(1);
      expect(fake.inits).toHaveLength(2);
      expect(fake.inits[1]?.state).toEqual({ cart: { $count: 0 } });
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
      expect(fake.inits[0]?.state).toEqual({ cart: { $count: 7 } });
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
      expect(fake.inits[1]?.state).toEqual({ cart: { $count: 1 } });

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
      expect(fake.inits[2]?.state).toEqual({ cart: { $count: 2 } });
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
