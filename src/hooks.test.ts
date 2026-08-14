import { atom, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectDevtools } from "./connect.ts";
import { resetDevtoolsGlobal } from "./global.ts";
import { getEntry, registerStore, type StoreType } from "./registry.ts";
import { type FakeExtension, installFakeExtension } from "./testing/fake-extension.ts";
import { hasHooks } from "./unhook.ts";

const HOME = "src/stores/cart.ts";

let fake: FakeExtension;

function endOfTurn(): Promise<void> {
  return Promise.resolve();
}

function register(store: Store, name: string, type: StoreType = "atom"): void {
  registerStore({ store, name, home: HOME, type, origin: "plugin", external: false, fn: null });
}

function hooked(store: Store): boolean {
  const entry = getEntry(store);

  return entry !== undefined && hasHooks(entry);
}

function rowTypes(): string[] {
  return fake.sends.map((send) => send.action.type);
}

describe("hooks", () => {
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

  it("attaches nothing until a bridge is open, and detaches on disconnect", async () => {
    const $count = atom(0);

    register($count, "$count");

    expect(hooked($count)).toBe(false);

    const handle = connectDevtools();

    await endOfTurn();

    expect(hooked($count)).toBe(true);

    handle.disconnect();

    expect(hooked($count)).toBe(false);
  });

  /** Every registry change sweeps every entry, so the guard runs far more often than a register. */
  it("attaches one set of hooks however often the registry is swept", async () => {
    const $count = atom(0);

    register($count, "$count");
    connectDevtools();

    await endOfTurn();
    register($count, "$count");
    register(atom(0), "$other");
    fake.start();
    $count.listen(() => {});

    await endOfTurn();

    expect(rowTypes()).toEqual(["$count/mount"]);
  });

  it("drops the hooks of the old type and attaches the ones the new type needs", async () => {
    const $count = atom(0);

    register($count, "$count", "atom");
    connectDevtools();

    await endOfTurn();
    fake.start();
    $count.set(1);

    await endOfTurn();

    expect(rowTypes()).toEqual(["$count/set"]);

    register($count, "$count", "computed");
    $count.set(2);

    await endOfTurn();

    expect(rowTypes()).toEqual(["$count/set", "$count/computed"]);
  });
});
