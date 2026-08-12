import { atom, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { peekDevtoolsGlobal, resetDevtoolsGlobal } from "./global.ts";
import {
  beginFrame,
  endFrame,
  MAX_MEMBERS,
  nodeInfoOf,
  noteBirth,
  ownBindings,
  ownerOf,
  ownField,
} from "./ownership.ts";
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
    expect(owners?.get($canUndo)?.owner).toBeInstanceOf(WeakRef);
    expect(owners?.get($canUndo)?.owner.deref()).toBe($draft);
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

describe("ownField", () => {
  class Editor {
    static $opened = atom(false);

    $value = atom("");
  }

  beforeEach(() => {
    resetDevtoolsGlobal();
  });

  afterEach(() => {
    resetDevtoolsGlobal();
  });

  it("draws a store made in an instance field under a node for that instance", () => {
    const editorOne = new Editor();

    ownField(FROM, editorOne.$value, editorOne);

    expect(ownerOf(editorOne.$value)).toBe(editorOne);
    expect(nodeInfoOf(editorOne)).toMatchObject({ name: "ref", ours: true, type: "Editor" });
  });

  it("keys a static field's node by the class name and labels it with nothing", () => {
    ownField(FROM, Editor.$opened, Editor);

    expect(ownerOf(Editor.$opened)).toBe(Editor);
    expect(nodeInfoOf(Editor)).toMatchObject({ name: "Editor", ours: false });
    expect(nodeInfoOf(Editor)?.type).toBeUndefined();
  });

  it("lets the binding scan correct the name no constructor could know yet", () => {
    const editorOne = new Editor();

    ownField(FROM, editorOne.$value, editorOne);
    ownBindings(FROM, [["editorOne", editorOne]]);

    expect(nodeInfoOf(editorOne)).toMatchObject({
      name: "editorOne",
      ours: false,
      type: "Editor",
    });
  });

  it("keeps the name the developer wrote when a class field runs after the scan", () => {
    const editorOne = new Editor();

    ownBindings(FROM, [["editorOne", editorOne]]);
    ownField(FROM, editorOne.$value, editorOne);

    expect(nodeInfoOf(editorOne)?.name).toBe("editorOne");
  });

  it("gives two instances of one class a node each, holding its own fields", () => {
    const editorOne = new Editor();
    const editorTwo = new Editor();

    ownField(FROM, editorOne.$value, editorOne);
    ownField(FROM, editorTwo.$value, editorTwo);

    expect(ownerOf(editorOne.$value)).toBe(editorOne);
    expect(ownerOf(editorTwo.$value)).toBe(editorTwo);
  });

  it("places a private field, which the walk over the instance never sees", () => {
    class Vault {
      #hidden = atom(0);

      constructor() {
        ownField(FROM, this.#hidden, this);
      }

      get hidden(): Store {
        return this.#hidden;
      }
    }

    const vault = new Vault();

    ownBindings(FROM, [["vault", vault]]);

    expect(ownerOf(vault.hidden)).toBe(vault);
    expect(nodeInfoOf(vault)).toMatchObject({ name: "vault", type: "Vault" });
  });

  it("reads the class name through the descriptor, so a getter over it never runs", () => {
    class Sneaky {}

    Object.defineProperty(Sneaky, "name", {
      get(): never {
        throw new Error("a name getter ran");
      },
    });

    expect(() => {
      ownField(FROM, atom(false), Sneaky);
    }).not.toThrow();
    expect(nodeInfoOf(Sneaky)).toMatchObject({ name: "ref", ours: true });
  });

  it("keys the node with ours when a static field shadows the class's own name", () => {
    class Sneaky {}

    Object.defineProperty(Sneaky, "name", { value: { written: false } });

    ownField(FROM, atom(false), Sneaky);

    expect(nodeInfoOf(Sneaky)?.name).toBe("ref");
  });

  it("draws the node in the module the field was written in", () => {
    const editorOne = new Editor();

    ownField({ home: "vendor/editor.ts", external: true }, editorOne.$value, editorOne);

    expect(nodeInfoOf(editorOne)).toMatchObject({ home: "vendor/editor.ts", external: true });
  });

  it("registers nothing, so a field's store gains no entry of its own", () => {
    const editorOne = new Editor();

    ownField(FROM, editorOne.$value, editorOne);

    expect(listEntries()).toEqual([]);
  });

  it("holds the instance weakly, so it keeps nothing the app has let go alive", () => {
    const editorOne = new Editor();

    ownField(FROM, editorOne.$value, editorOne);

    expect(peekDevtoolsGlobal()?.owners.get(editorOne.$value)?.owner).toBeInstanceOf(WeakRef);
  });

  it("keeps the instance a field ran for, which no binding scan may take away", () => {
    const editorOne = new Editor();

    ownField(FROM, editorOne.$value, editorOne);
    ownBindings(FROM, [["shared", { $value: editorOne.$value }]]);

    expect(ownerOf(editorOne.$value)).toBe(editorOne);
  });
});

describe("the creation frame", () => {
  class Editor {
    $value = atom("");
  }

  /** A store born while the frame is open, and the `this` of the field it was made in, if any. */
  function born(store: Store, owner?: object): void {
    noteBirth(store);

    if (owner !== undefined) {
      ownField(FROM, store, owner);
    }
  }

  beforeEach(() => {
    resetDevtoolsGlobal();
  });

  afterEach(() => {
    resetDevtoolsGlobal();
  });

  it("draws a store held in a closure under the store the expression returned", () => {
    const $timeline = atom<string[]>([]);
    const $draft = atom("");

    beginFrame();
    born($draft);
    born($timeline);
    endFrame(FROM, $draft, "$draft");

    expect(ownerOf($timeline)).toBe($draft);
    expect(ownerOf($draft)).toBeUndefined();
  });

  it("names a node after the binding when the expression returned anything else", () => {
    const $timeline = atom<string[]>([]);
    const model = { title: "" };

    beginFrame();
    born($timeline);
    endFrame(FROM, model, "model");

    expect(ownerOf($timeline)).toBe(model);
    expect(nodeInfoOf(model)).toMatchObject({ name: "model", ours: false, type: undefined });
  });

  it("keys the node with ours when the binding gave it no name", () => {
    const model = { title: "" };

    beginFrame();
    born(atom(0));
    endFrame(FROM, model, null);

    expect(nodeInfoOf(model)).toMatchObject({ name: "ref", ours: true });
  });

  it("hangs the node a store already sits in under the binding, holding its own fields", () => {
    beginFrame();

    const editor = new Editor();

    born(editor.$value, editor);

    const hidden = new WeakMap([[{}, editor]]);

    endFrame(FROM, hidden, "hidden");

    expect(nodeInfoOf(hidden)).toMatchObject({ name: "hidden", type: "WeakMap", ours: false });
    expect(nodeInfoOf(editor)?.parent?.deref()).toBe(hidden);
    expect(ownerOf(editor.$value)).toBe(editor);
  });

  it("reaches a store a factory made in a class field, which adoption places nowhere", () => {
    const $made = atom(0);

    beginFrame();

    const editor = new Editor();

    born($made);
    endFrame(FROM, editor, "editorOne");

    expect(ownerOf($made)).toBe(editor);
    expect(nodeInfoOf(editor)).toMatchObject({ name: "editorOne", type: "Editor", ours: false });
  });

  it("hands the stores of a frame inside a frame up to the outer one", () => {
    const $inner = atom(0);
    const $part = atom("");
    const model = { title: "" };

    beginFrame();
    beginFrame();
    born($part);
    born($inner);
    endFrame(FROM, $part, "$part");
    endFrame(FROM, model, "model");

    expect(ownerOf($inner)).toBe(model);
    expect(ownerOf($part)).toBe(model);
  });

  it("lets the binding scan correct it, so a Map member keeps the key it sits at", () => {
    const scratch = { $open: atom(false) };
    const byId = new Map([["scratch", scratch]]);

    beginFrame();
    born(scratch.$open);
    endFrame(FROM, byId, "byId");

    expect(ownerOf(scratch.$open)).toBe(byId);

    ownBindings(FROM, [["byId", byId]]);

    expect(ownerOf(scratch.$open)).toBe(scratch);
    expect(nodeInfoOf(scratch)?.name).toBe(`["scratch"]`);
  });

  it("lets a class field correct it, because a field knows a name and a frame does not", () => {
    const $made = atom(0);

    beginFrame();
    born($made);
    endFrame(FROM, { title: "" }, "model");

    const editor = new Editor();

    ownField(FROM, $made, editor);

    expect(ownerOf($made)).toBe(editor);
  });

  it("counts what a capped collection left out, as the walk over it does", () => {
    const many = Array.from({ length: MAX_MEMBERS + 2 }, () => ({ $open: atom(false) }));

    beginFrame();
    endFrame(FROM, many, "many");

    expect(nodeInfoOf(many)?.skipped).toBe(2);
  });

  it("refuses a node edge that would loop, whatever the expression returned", () => {
    beginFrame();

    const editor = new Editor();

    born(editor.$value, editor);
    endFrame(FROM, editor.$value, "$value");

    expect(nodeInfoOf(editor)?.parent).toBeUndefined();
    expect(ownerOf(editor.$value)).toBe(editor);
  });

  it("draws no node for an initializer that returned no object at all", () => {
    const $timeline = atom<string[]>([]);

    beginFrame();
    born($timeline);
    endFrame(FROM, 3, "count");

    expect(ownerOf($timeline)).toBeUndefined();
  });

  it("places nothing while no frame is open, and brings no registry into being", () => {
    const $stray = atom(0);

    born($stray);
    endFrame(FROM, { title: "" }, "model");

    expect(ownerOf($stray)).toBeUndefined();
    expect(peekDevtoolsGlobal()).toBeUndefined();
  });

  it("drops a frame the expression threw out of, one microtask later", async () => {
    const $stray = atom(0);

    expect(() => {
      beginFrame();

      throw new Error("the initializer threw");
    }).toThrow();

    await Promise.resolve();

    born($stray);
    endFrame(FROM, { title: "" }, "model");

    expect(peekDevtoolsGlobal()?.frames).toEqual([]);
    expect(ownerOf($stray)).toBeUndefined();
  });

  it("books one drop for the outermost frame, not one for every frame it holds", () => {
    const book = vi.spyOn(globalThis, "queueMicrotask");

    beginFrame();
    beginFrame();

    expect(book).toHaveBeenCalledTimes(1);

    book.mockRestore();
  });
});
