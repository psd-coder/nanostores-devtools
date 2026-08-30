import { atom, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectDevtools } from "../redux/connect.ts";
import { type FakeExtension, installFakeExtension } from "../testing/fake-extension.ts";
import { attachHooks } from "../timeline/hooks.ts";
import { fileScope, type FileScope } from "../runtime.ts";
import { getEntry, listEntries, onRegistryChange } from "./registry.ts";
import { nodeInfoOf, ownerLinksOf } from "../tree/placement.ts";
import { resetDevtoolsGlobal } from "../global.ts";
import type { Binding } from "./ownership.ts";

const HOME = "src/model.ts";

let fake: FakeExtension;
let unwatch: () => void;

/** The end of the turn, which is where a walk marked by a change runs. */
function endOfTurn(): Promise<void> {
  return Promise.resolve();
}

/** The walk, and then the rows the registry changes it made are collected into. */
async function settle(): Promise<void> {
  await endOfTurn();
  await endOfTurn();
}

/** Connect, reach the deferred `init`, then open the panel, which is when rows start flowing. */
async function listen(): Promise<void> {
  connectDevtools();

  await endOfTurn();
  fake.start();
}

/**
 * One module's body, walked and watched. Watching is what a connected panel does, and every test
 * here is about the walk rather than about the panel, so it is done by hand.
 */
function own(bindings: readonly Binding[], moduleKey = HOME): FileScope {
  const scope = fileScope(moduleKey, HOME, false);

  scope.own(bindings);
  attachHooks();

  return scope;
}

function ownerOf(store: Store): object | undefined {
  return ownerLinksOf(store)[0]?.owner;
}

function rowNames(): string[] {
  return fake.sends.map((call) => call.action.type);
}

beforeEach(() => {
  resetDevtoolsGlobal();
  fake = installFakeExtension();
  /** What a connected panel does: a store that joins the registry is watched the same turn. */
  unwatch = onRegistryChange((change) => {
    if (change.kind !== "unregister") {
      attachHooks();
    }
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  unwatch();
  fake.uninstall();
  vi.restoreAllMocks();
  resetDevtoolsGlobal();
});

describe("a binding walked again after something under it changed", () => {
  it("registers a store the app built after the module body had run", async () => {
    const $root = atom<unknown>({});

    own([{ name: "$root", value: $root, exported: true }]);

    const $added = atom(0);

    $root.set({ $added });
    await settle();

    expect(getEntry($added)?.name).toBe("$root.get().$added");
    expect(ownerOf($added)).toBe($root);
  });

  it("draws the register row that says the store joined", async () => {
    const $root = atom<unknown>({});

    own([{ name: "$root", value: $root, exported: true }]);
    await listen();

    const $added = atom(0);

    $root.set({ $added });
    await settle();

    expect(fake.sends.at(-1)?.action["action"]).toEqual({
      type: "$root.get().$added/register",
      changes: [{ label: `${HOME}/$root.get().$added`, op: "register" }],
    });
  });

  /** The store the walk found is watched like every other, so what it does next draws a row. */
  it("draws the changes of a store the walk found, from the turn it found it", async () => {
    const $root = atom<unknown>({});

    own([{ name: "$root", value: $root, exported: true }]);
    await listen();

    const $added = atom(0);

    $root.set({ $added });
    await settle();
    $added.set(1);
    await settle();

    expect(rowNames().at(-1)).toContain("$root.get().$added");
  });

  /**
   * One change to the developer is one walk, however many of the stores under the binding wrote in
   * that turn: checking the root of a tree writes every node in it, and the walk runs once.
   */
  it("walks once however many stores wrote in one turn", async () => {
    const $first = atom(0);
    const $second = atom(0);
    let reads = 0;
    const held = new Proxy(
      { $first, $second },
      {
        ownKeys: (target) => {
          reads += 1;

          return Reflect.ownKeys(target);
        },
      },
    );

    own([{ name: "$root", value: atom<unknown>(held), exported: true }]);
    reads = 0;

    $first.set(1);
    $second.set(2);
    await settle();

    expect(reads).toBe(1);
  });

  it("takes out a store no binding reaches any more", async () => {
    const $gone = atom(0);
    const $root = atom<unknown>({ $gone });

    own([{ name: "$root", value: $root, exported: true }]);

    expect(getEntry($gone)).toBeDefined();

    $root.set({});
    await settle();

    expect(getEntry($gone)).toBeUndefined();
    expect(listEntries().map((entry) => entry.store)).toEqual([$root]);
  });

  it("draws the unregister row that says the store left", async () => {
    const $gone = atom(0);
    const $root = atom<unknown>({ $gone });

    own([{ name: "$root", value: $root, exported: true }]);
    await listen();

    $root.set({});
    await settle();

    expect(fake.sends.at(-1)?.action["action"]).toEqual({
      type: "$root.get().$gone/unregister",
      changes: [{ label: `${HOME}/$root.get().$gone`, op: "unregister" }],
    });
  });

  it("keeps a store a second binding still reaches", async () => {
    const $shared = atom(0);
    const $root = atom<unknown>({ $shared });

    own([
      { name: "$root", value: $root, exported: true },
      { name: "spare", value: { $shared }, exported: true },
    ]);

    $root.set({});
    await settle();

    expect(getEntry($shared)).toBeDefined();
  });

  /**
   * A member removed from an array moves everything after it. The store is the same store, so it
   * keeps the name it was registered under, and the key says where it sits now.
   */
  it("keeps the name of a store the app moved, and follows it with the key", async () => {
    const $checked = atom(false);
    const first = { $checked: atom(true) };
    const second = { $checked };
    const $list = atom<unknown>([first, second]);

    own([{ name: "$list", value: $list, exported: true }]);

    expect(getEntry($checked)?.name).toBe("$list.get()[1].$checked");

    $list.set([second]);
    await settle();

    expect(getEntry($checked)?.name).toBe("$list.get()[1].$checked");
    expect(nodeInfoOf(second)?.name).toBe("[0]");
  });

  /** A reload builds a new owner, and what the run before it reached is its own to drop. */
  it("drops what a reloaded module reached, found stores included", async () => {
    const $found = atom(0);
    const scope = own([{ name: "holder", value: { $found }, exported: true }]);

    expect(getEntry($found)).toBeDefined();

    scope.clear();
    $found.set(1);
    await settle();

    expect(getEntry($found)).toBeUndefined();
  });
});
