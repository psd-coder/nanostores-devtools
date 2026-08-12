import { atom, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { peekDevtoolsGlobal, resetDevtoolsGlobal } from "./global.ts";
import { MAX_MEMBERS, nodeInfoOf, ownBindings, ownerOf } from "./ownership.ts";
import { listEntries, registerStore, unregisterStore } from "./registry.ts";

const HOME = "src/model.ts";

/** The module the bindings come from, which is where a node one of them makes is drawn. */
const FROM = { home: HOME, external: false };

/** A store holding other stores beside its own value, which is what `Object.assign` builds. */
function holder(value: unknown, held: Record<string, Store>): Store {
  return Object.assign(atom<unknown>(value), held);
}

function track(store: Store, name: string): void {
  registerStore({ store, name, home: HOME, type: "atom", origin: "plugin", external: false });
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

    ownBindings(FROM, [["$draft", $draft]]);

    expect(ownerOf($canUndo)).toBe($draft);
  });

  it("leaves the store a binding holds without an owner of its own", () => {
    const $draft = holder("", { $canUndo: atom(false) });

    ownBindings(FROM, [["$draft", $draft]]);

    expect(ownerOf($draft)).toBeUndefined();
  });

  it("stops at a binding that holds no object at all", () => {
    const $open = atom(false);

    ownBindings(FROM, [
      ["count", 2],
      ["missing", undefined],
      ["make", () => $open],
    ]);

    expect(ownerOf($open)).toBeUndefined();
  });

  it("skips the nanostores keys, so an atom holding a store does not nest it", () => {
    const $inner = atom(1);
    const $outer = Object.assign(atom<unknown>($inner), { events: $inner });

    ownBindings(FROM, [["$outer", $outer]]);

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
      ownBindings(FROM, [["$draft", $draft]]);
    }).not.toThrow();
  });

  it("mounts nothing it walks", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });

    ownBindings(FROM, [["$draft", $draft]]);

    expect($draft.lc).toBe(0);
    expect($canUndo.lc).toBe(0);
  });

  it("walks three levels down and stops there", () => {
    const $fourth = atom(4);
    const $third = holder(3, { $fourth });
    const $second = holder(2, { $third });
    const $first = holder(1, { $second });
    const $draft = holder(0, { $first });

    ownBindings(FROM, [["$draft", $draft]]);

    expect(ownerOf($first)).toBe($draft);
    expect(ownerOf($second)).toBe($first);
    expect(ownerOf($third)).toBe($second);
    expect(ownerOf($fourth)).toBeUndefined();
  });

  it("refuses to put a store under itself", () => {
    const $draft = holder("", {});

    Object.assign($draft, { $self: $draft });
    ownBindings(FROM, [["$draft", $draft]]);

    expect(ownerOf($draft)).toBeUndefined();
  });

  it("ends the walk on a cycle and refuses the edge that would loop", () => {
    const $draft = holder("", {});
    const $history = holder([], { $draft });

    Object.assign($draft, { $history });
    ownBindings(FROM, [["$draft", $draft]]);

    expect(ownerOf($history)).toBe($draft);
    expect(ownerOf($draft)).toBeUndefined();
  });

  it("keeps the first owner the registry knows when two bindings hold one store", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });
    const $other = holder("", { $canUndo });

    track($draft, "$draft");
    track($other, "$other");
    ownBindings(FROM, [
      ["$draft", $draft],
      ["$other", $other],
    ]);

    expect(ownerOf($canUndo)).toBe($draft);
  });

  it("moves a store to the owner a hot reload built to replace the one it dropped", () => {
    const $canUndo = atom(false);
    const $before = holder("", { $canUndo });

    track($before, "$draft");
    ownBindings(FROM, [["$draft", $before]]);
    unregisterStore($before);

    const $after = holder("", { $canUndo });

    track($after, "$draft");
    ownBindings(FROM, [["$draft", $after]]);

    expect(ownerOf($canUndo)).toBe($after);
  });

  it("registers nothing, so a store already in the registry gains no second entry", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });

    track($draft, "$draft");
    track($canUndo, "$canUndo");
    ownBindings(FROM, [["$draft", $draft]]);

    expect(listEntries().map((entry) => entry.name)).toEqual(["$draft", "$canUndo"]);
  });

  it("leaves a store nothing registered out of the registry", () => {
    const $draft = holder("", { $canUndo: atom(false) });

    ownBindings(FROM, [["$draft", $draft]]);

    expect(listEntries()).toEqual([]);
  });

  it("holds the store and its owner weakly, so it keeps neither of them alive", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });

    ownBindings(FROM, [["$draft", $draft]]);

    const owners = peekDevtoolsGlobal()?.owners;

    expect(owners).toBeInstanceOf(WeakMap);
    expect(owners?.get($canUndo)).toBeInstanceOf(WeakRef);
    expect(owners?.get($canUndo)?.deref()).toBe($draft);
  });
});

describe("a node", () => {
  class Editor {
    $value = atom("");
  }

  /** One member of a collection, holding a store of its own. */
  function panel(): { $open: Store } {
    return { $open: atom(false) };
  }

  function nameOf(value: object): string | undefined {
    return nodeInfoOf(value)?.name;
  }

  beforeEach(() => {
    resetDevtoolsGlobal();
  });

  afterEach(() => {
    resetDevtoolsGlobal();
  });

  it("keys a class instance by its binding and holds the constructor apart from that name", () => {
    const editorOne = new Editor();

    ownBindings(FROM, [["editorOne", editorOne]]);

    expect(ownerOf(editorOne.$value)).toBe(editorOne);
    expect(nodeInfoOf(editorOne)).toMatchObject({ name: "editorOne", type: "Editor" });
  });

  it("keys a plain object a factory returned by its binding, and labels it with nothing", () => {
    const created = panel();

    ownBindings(FROM, [["panel", created]]);

    expect(ownerOf(created.$open)).toBe(created);
    expect(nameOf(created)).toBe("panel");
    expect(nodeInfoOf(created)?.type).toBeUndefined();
  });

  it("walks an array by index, and nests a node inside a node", () => {
    const first = new Editor();
    const drafts = [first, new Editor()];

    ownBindings(FROM, [["drafts", drafts]]);

    expect(nodeInfoOf(drafts)).toMatchObject({ name: "drafts", type: "Array" });
    expect(nameOf(first)).toBe("[0]");
    expect(nodeInfoOf(first)?.parent?.deref()).toBe(drafts);
    expect(ownerOf(first.$value)).toBe(first);
  });

  it("walks a Map by key, string or number", () => {
    const scratch = new Editor();
    const second = new Editor();
    const byId = new Map<string | number, Editor>([
      ["scratch", scratch],
      [2, second],
    ]);

    ownBindings(FROM, [["byId", byId]]);

    expect(nodeInfoOf(byId)?.type).toBe("Map");
    expect(nameOf(scratch)).toBe(`["scratch"]`);
    expect(nameOf(second)).toBe("[2]");
  });

  it("leaves out a Map key that is neither a string nor a number", () => {
    const held = new Editor();
    const byRef = new Map([[{}, held]]);

    ownBindings(FROM, [["byRef", byRef]]);

    expect(nodeInfoOf(held)).toBeUndefined();
    expect(ownerOf(held.$value)).toBeUndefined();
  });

  it("walks a Set in insertion order", () => {
    const first = new Editor();
    const second = new Editor();
    const pool = new Set([first, second]);

    ownBindings(FROM, [["pool", pool]]);

    expect(nodeInfoOf(pool)?.type).toBe("Set");
    expect(nameOf(first)).toBe("[0]");
    expect(nameOf(second)).toBe("[1]");
  });

  it("iterates an array through the built-in forEach, so a subclass override never runs", () => {
    class Loud extends Array<Editor> {
      override map(): never {
        throw new Error("the value's own map ran");
      }
    }

    const first = new Editor();
    const drafts = new Loud();

    drafts.push(first);
    ownBindings(FROM, [["drafts", drafts]]);

    expect(nameOf(first)).toBe("[0]");
  });

  it("skips a hole in an array, and keeps the index the members that are there sit at", () => {
    const third = new Editor();
    const drafts: Editor[] = [];

    drafts[2] = third;
    ownBindings(FROM, [["drafts", drafts]]);

    expect(nameOf(third)).toBe("[2]");
  });

  it("reads the constructor through the descriptor, so a getter over it never runs", () => {
    const $open = atom(false);
    const hostile: object = Object.create({
      get constructor(): never {
        throw new Error("a constructor getter ran");
      },
    });

    Object.assign(hostile, { $open });

    expect(() => {
      ownBindings(FROM, [["hostile", hostile]]);
    }).not.toThrow();
    expect(ownerOf($open)).toBe(hostile);
    expect(nodeInfoOf(hostile)?.type).toBeUndefined();
  });

  it("iterates a Map through the built-in forEach, so a subclass override never runs", () => {
    class Loud extends Map<string, Editor> {
      override forEach(): void {
        throw new Error("the value's own forEach ran");
      }
    }

    const scratch = new Editor();
    const byId = new Loud([["scratch", scratch]]);

    ownBindings(FROM, [["byId", byId]]);

    expect(nameOf(scratch)).toBe(`["scratch"]`);
  });

  it("lets a collection that throws while iterating contribute nothing", () => {
    const $open = atom(false);
    /** A `Map` by prototype and nothing else, so the built-in `forEach` finds no contents. */
    const empty: object = Object.create(Map.prototype);
    const broken = Object.assign(empty, { $open });

    expect(() => {
      ownBindings(FROM, [["broken", broken]]);
    }).not.toThrow();
    expect(ownerOf($open)).toBeUndefined();
  });

  it("gives a member past the cap no node, and hangs the stores it holds on the collection", () => {
    const past = panel();
    const many = [...Array.from({ length: MAX_MEMBERS + 1 }, panel), past];

    ownBindings(FROM, [["many", many]]);

    expect(nodeInfoOf(many)?.skipped).toBe(2);
    expect(nodeInfoOf(past)).toBeUndefined();
    expect(ownerOf(past.$open)).toBe(many);
  });

  it("keeps the first name a binding gave a value, whichever binding holds it later", () => {
    const editorOne = new Editor();

    ownBindings(FROM, [
      ["editorOne", editorOne],
      ["drafts", [editorOne]],
    ]);

    expect(nameOf(editorOne)).toBe("editorOne");
  });

  it("draws a node in the file its binding was written in, whoever made the value", () => {
    const created = panel();

    ownBindings({ home: "vendor/panel.ts", external: true }, [["panel", created]]);

    expect(nodeInfoOf(created)).toMatchObject({ home: "vendor/panel.ts", external: true });
  });

  it("holds a node's parent weakly, so it keeps no instance alive", () => {
    const first = new Editor();

    ownBindings(FROM, [["drafts", [first]]]);

    expect(peekDevtoolsGlobal()?.nodes).toBeInstanceOf(WeakMap);
    expect(nodeInfoOf(first)?.parent).toBeInstanceOf(WeakRef);
  });

  it("runs no getter and mounts nothing while walking a collection", () => {
    const created = panel();
    const drafts = [created];

    Object.defineProperty(created, "$hidden", {
      enumerable: true,
      get() {
        throw new Error("a getter was read");
      },
    });

    expect(() => {
      ownBindings(FROM, [["drafts", drafts]]);
    }).not.toThrow();
    expect(created.$open.lc).toBe(0);
  });
});
