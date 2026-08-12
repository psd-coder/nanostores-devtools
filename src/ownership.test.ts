import { atom, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { peekDevtoolsGlobal, resetDevtoolsGlobal } from "./global.ts";
import { ownBindings, ownerOf } from "./ownership.ts";
import { listEntries, registerStore, unregisterStore } from "./registry.ts";

/** A store holding other stores beside its own value, which is what `Object.assign` builds. */
function holder(value: unknown, held: Record<string, Store>): Store {
  return Object.assign(atom<unknown>(value), held);
}

function track(store: Store, name: string): void {
  registerStore({
    store,
    name,
    home: "src/model.ts",
    type: "atom",
    origin: "plugin",
    external: false,
  });
}

describe("ownBindings", () => {
  beforeEach(() => {
    resetDevtoolsGlobal();
  });

  afterEach(() => {
    resetDevtoolsGlobal();
  });

  it("makes a store held by a store a child of it", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });

    ownBindings([["$draft", $draft]]);

    expect(ownerOf($canUndo)).toBe($draft);
  });

  it("leaves the store a binding holds without an owner of its own", () => {
    const $draft = holder("", { $canUndo: atom(false) });

    ownBindings([["$draft", $draft]]);

    expect(ownerOf($draft)).toBeUndefined();
  });

  it("stops at a value that is no store, so a plain object holds nothing yet", () => {
    const $open = atom(false);

    ownBindings([
      ["panel", { $open }],
      ["count", 2],
      ["missing", undefined],
    ]);

    expect(ownerOf($open)).toBeUndefined();
  });

  it("skips the nanostores keys, so an atom holding a store does not nest it", () => {
    const $inner = atom(1);
    const $outer = Object.assign(atom<unknown>($inner), { events: $inner });

    ownBindings([["$outer", $outer]]);

    expect(ownerOf($inner)).toBeUndefined();
  });

  it("reads through the descriptor, so a getter never runs", () => {
    const $draft = holder("", {});

    Object.defineProperty($draft, "$hidden", {
      enumerable: true,
      get() {
        throw new Error("a getter was read");
      },
    });

    expect(() => {
      ownBindings([["$draft", $draft]]);
    }).not.toThrow();
  });

  it("mounts nothing it walks", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });

    ownBindings([["$draft", $draft]]);

    expect($draft.lc).toBe(0);
    expect($canUndo.lc).toBe(0);
  });

  it("walks three levels down and stops there", () => {
    const $fourth = atom(4);
    const $third = holder(3, { $fourth });
    const $second = holder(2, { $third });
    const $first = holder(1, { $second });
    const $draft = holder(0, { $first });

    ownBindings([["$draft", $draft]]);

    expect(ownerOf($first)).toBe($draft);
    expect(ownerOf($second)).toBe($first);
    expect(ownerOf($third)).toBe($second);
    expect(ownerOf($fourth)).toBeUndefined();
  });

  it("refuses to put a store under itself", () => {
    const $draft = holder("", {});

    Object.assign($draft, { $self: $draft });
    ownBindings([["$draft", $draft]]);

    expect(ownerOf($draft)).toBeUndefined();
  });

  it("ends the walk on a cycle and refuses the edge that would loop", () => {
    const $draft = holder("", {});
    const $history = holder([], { $draft });

    Object.assign($draft, { $history });
    ownBindings([["$draft", $draft]]);

    expect(ownerOf($history)).toBe($draft);
    expect(ownerOf($draft)).toBeUndefined();
  });

  it("keeps the first owner the registry knows when two bindings hold one store", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });
    const $other = holder("", { $canUndo });

    track($draft, "$draft");
    track($other, "$other");
    ownBindings([
      ["$draft", $draft],
      ["$other", $other],
    ]);

    expect(ownerOf($canUndo)).toBe($draft);
  });

  it("moves a store to the owner a hot reload built to replace the one it dropped", () => {
    const $canUndo = atom(false);
    const $before = holder("", { $canUndo });

    track($before, "$draft");
    ownBindings([["$draft", $before]]);
    unregisterStore($before);

    const $after = holder("", { $canUndo });

    track($after, "$draft");
    ownBindings([["$draft", $after]]);

    expect(ownerOf($canUndo)).toBe($after);
  });

  it("registers nothing, so a store already in the registry gains no second entry", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });

    track($draft, "$draft");
    track($canUndo, "$canUndo");
    ownBindings([["$draft", $draft]]);

    expect(listEntries().map((entry) => entry.name)).toEqual(["$draft", "$canUndo"]);
  });

  it("leaves a store nothing registered out of the registry", () => {
    const $draft = holder("", { $canUndo: atom(false) });

    ownBindings([["$draft", $draft]]);

    expect(listEntries()).toEqual([]);
  });

  it("holds the store and its owner weakly, so it keeps neither of them alive", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });

    ownBindings([["$draft", $draft]]);

    const owners = peekDevtoolsGlobal()?.owners;

    expect(owners).toBeInstanceOf(WeakMap);
    expect(owners?.get($canUndo)).toBeInstanceOf(WeakRef);
    expect(owners?.get($canUndo)?.deref()).toBe($draft);
  });
});
