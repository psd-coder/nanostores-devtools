import { atom, batched, computed, deepMap, map, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDevtoolsGlobal, peekDevtoolsGlobal, resetDevtoolsGlobal } from "../global.ts";
import { ownBindings, ownField, STORE_KEYS } from "./ownership.ts";
import {
  boundNames,
  drawnParents,
  namedByBinding,
  nodeInfoOf,
  ownerLinksOf,
  rowName,
} from "../tree/placement.ts";
import {
  getEntry,
  listEntries,
  registerStore,
  type StoreEntry,
  unregisterStore,
} from "./registry.ts";

const HOME = "src/model.ts";

/** The module the bindings come from, which is where a node one of them makes is drawn. */
const FROM = { home: HOME, external: false, moduleKey: HOME };

/** A store holding other stores beside its own value, which is what `Object.assign` builds. */
function holder(value: unknown, held: Record<string, Store>): Store {
  return Object.assign(atom<unknown>(value), held);
}

/** The owner the tree expands the store under, which is the first link recorded. */
function ownerOf(store: Store): object | undefined {
  return ownerLinksOf(store)[0]?.owner;
}

/** Everything the tree draws the node under, in the order the walk recorded them. */
function parentsOf(value: object): object[] {
  const info = nodeInfoOf(value);

  return info === undefined ? [] : drawnParents(info);
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

    ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

    expect(ownerOf($canUndo)).toBe($draft);
  });

  it("leaves the store a binding holds without an owner of its own", () => {
    const $draft = holder("", { $canUndo: atom(false) });

    ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

    expect(ownerOf($draft)).toBeUndefined();
  });

  it("stops at a binding that holds no object at all", () => {
    const $open = atom(false);

    ownBindings(FROM, [
      { name: "count", value: 2, exported: false },
      { name: "missing", value: undefined, exported: false },
      { name: "make", value: () => $open, exported: false },
    ]);

    expect(ownerOf($open)).toBeUndefined();
  });

  it("skips the nanostores keys, so an atom holding a store does not nest it", () => {
    const $inner = atom(1);
    const $outer = Object.assign(atom<unknown>($inner), { events: $inner });

    ownBindings(FROM, [{ name: "$outer", value: $outer, exported: false }]);

    expect(ownerOf($inner)).toBeUndefined();
  });

  it("knows every key the store kinds nanostores ships put on themselves", () => {
    const $source = atom(0);
    const kinds = [
      atom(0),
      map({}),
      deepMap({}),
      computed($source, (value) => value),
      batched($source, (value) => value),
    ];

    for (const store of kinds) {
      expect(Object.keys(store).filter((key) => !STORE_KEYS.has(key))).toEqual([]);
    }
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
      ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);
    }).not.toThrow();
  });

  it("runs no getter while deciding whether a value is a store", () => {
    const listen = vi.fn(() => () => {});
    const lc = vi.fn(() => 0);
    const decoy = {};

    Object.defineProperty(decoy, "listen", { enumerable: true, get: listen });
    Object.defineProperty(decoy, "lc", { enumerable: true, get: lc });

    ownBindings(FROM, [{ name: "holder", value: { decoy }, exported: false }]);

    expect(listen).not.toHaveBeenCalled();
    expect(lc).not.toHaveBeenCalled();
  });

  it("mounts nothing it walks", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });

    ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

    expect($draft.lc).toBe(0);
    expect($canUndo.lc).toBe(0);
  });

  it("walks as deep as it was told to and stops there", () => {
    const $fourth = atom(4);
    const $third = holder(3, { $fourth });
    const $second = holder(2, { $third });
    const $first = holder(1, { $second });
    const $draft = holder(0, { $first });

    ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }], 3);

    expect(ownerOf($first)).toBe($draft);
    expect(ownerOf($second)).toBe($first);
    expect(ownerOf($third)).toBe($second);
    expect(ownerOf($fourth)).toBeUndefined();
  });

  it("walks well past three levels where nothing named a depth", () => {
    const $sixth = atom(6);
    const $fifth = holder(5, { $sixth });
    const $fourth = holder(4, { $fifth });
    const $third = holder(3, { $fourth });
    const $second = holder(2, { $third });
    const $first = holder(1, { $second });
    const $draft = holder(0, { $first });

    ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

    expect(ownerOf($sixth)).toBe($fifth);
  });

  it("gives a node held by two containers a parent for each of them", () => {
    const $w = atom(0);
    const shared = { $w };
    const a = { shared };
    const b = { shared };

    ownBindings(FROM, [
      { name: "a", value: a, exported: true },
      { name: "b", value: b, exported: true },
    ]);

    expect(parentsOf(shared)).toEqual([a, b]);
  });

  it("refuses to put a store under itself", () => {
    const $draft = holder("", {});

    Object.assign($draft, { $self: $draft });
    ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

    expect(ownerOf($draft)).toBeUndefined();
  });

  it("ends the walk on a cycle and refuses the edge that would loop", () => {
    const $draft = holder("", {});
    const $history = holder([], { $draft });

    Object.assign($draft, { $history });
    ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

    expect(ownerOf($history)).toBe($draft);
    expect(ownerOf($draft)).toBeUndefined();
  });

  it("keeps both owners when two stores hold one store, the first one recorded first", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });
    const $other = holder("", { $canUndo });

    track($draft, "$draft");
    track($other, "$other");
    ownBindings(FROM, [
      { name: "$draft", value: $draft, exported: false },
      { name: "$other", value: $other, exported: false },
    ]);

    expect(ownerLinksOf($canUndo).map((link) => link.owner)).toEqual([$draft, $other]);
  });

  it("records one link for one owner, however many walks reach the store through it", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });

    track($draft, "$draft");
    ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);
    ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

    expect(ownerLinksOf($canUndo)).toHaveLength(1);
  });

  it("refuses an edge that closes a loop through any of several owners", () => {
    const $canUndo = atom(false);
    const $left = holder("left", { $canUndo });
    const $right = holder("right", { $canUndo });

    track($left, "$left");
    track($right, "$right");
    ownBindings(FROM, [
      { name: "$left", value: $left, exported: false },
      { name: "$right", value: $right, exported: false },
    ]);
    Object.assign($canUndo, { $right });
    ownBindings(FROM, [{ name: "$canUndo", value: $canUndo, exported: false }]);

    expect(ownerLinksOf($right).map((link) => link.owner)).toEqual([]);
    expect(ownerLinksOf($canUndo).map((link) => link.owner)).toEqual([$left, $right]);
  });

  it("moves a store to the owner a hot reload built to replace the one it dropped", () => {
    const $canUndo = atom(false);
    const $before = holder("", { $canUndo });

    track($before, "$draft");
    ownBindings(FROM, [{ name: "$draft", value: $before, exported: false }]);
    unregisterStore($before);

    const $after = holder("", { $canUndo });

    track($after, "$draft");
    ownBindings(FROM, [{ name: "$draft", value: $after, exported: false }]);

    expect(ownerOf($canUndo)).toBe($after);
  });

  it("renames the entry a wrapper made rather than making a second one", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });

    track($draft, "$draft");
    track($canUndo, "$canUndo");
    ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

    expect(listEntries().map((entry) => entry.name)).toEqual(["$draft", "$draft.$canUndo"]);
  });

  /** A one-pass scan would name it after the key it was found at, so source order would decide. */
  it("names a store after its binding, wherever that binding stands in the list", () => {
    const $s = atom(0);

    ownBindings(FROM, [
      { name: "box", value: { inner: $s }, exported: false },
      { name: "$s", value: $s, exported: false },
    ]);

    expect(listEntries()[0]).toMatchObject({ name: "$s", ownerName: "$s" });
  });

  it("names it after the binding when that binding was written above the object as well", () => {
    const $s = atom(0);

    ownBindings(FROM, [
      { name: "$s", value: $s, exported: false },
      { name: "box", value: { inner: $s }, exported: false },
    ]);

    expect(listEntries()[0]).toMatchObject({ name: "$s", ownerName: "$s" });
  });

  it("registers a store nothing else found, under the whole path that reached it", () => {
    const $draft = holder("", { $canUndo: atom(false) });

    ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

    expect(listEntries().map((entry) => entry.name)).toEqual(["$draft", "$draft.$canUndo"]);
  });

  it("brackets a key no identifier can spell, so the whole path stays something to type", () => {
    const config = { "my-key": atom(0) };

    ownBindings(FROM, [{ name: "config", value: config, exported: false }]);

    expect(listEntries()[0]?.name).toBe(`config["my-key"]`);
  });

  /** Ten levels is rare, and the developer wrote every one of them, so none of it is left out. */
  it("prints a long path whole, with nothing left out of the middle", () => {
    const deep = { a: { b: { c: { d: { e: { f: atom(0) } } } } } };

    ownBindings(FROM, [{ name: "app", value: deep, exported: false }]);

    expect(listEntries()[0]?.name).toBe("app.a.b.c.d.e.f");
  });

  it("spells the whole path into the label, behind the file the store is drawn in", () => {
    const config = { theme: { $x: atom(0) } };

    ownBindings(FROM, [{ name: "config", value: config, exported: false }]);

    expect(listEntries()[0]?.label).toBe(`${HOME}/config.theme.$x`);
  });

  it("keeps the short key for the owner, so no tree key holds a dot nobody wrote", () => {
    const config = { theme: { $x: atom(0) } };

    ownBindings(FROM, [{ name: "config", value: config, exported: false }]);

    expect(listEntries()[0]).toMatchObject({ name: "config.theme.$x", ownerName: "$x" });
  });

  /** One key in one home is one name, so the path is the whole of what tells two of them apart. */
  it("tells two members of one key in one home apart, so neither drops the other's entry", () => {
    ownBindings(FROM, [
      { name: "one", value: { $dup: atom(1) }, exported: false },
      { name: "two", value: { $dup: atom(2) }, exported: false },
    ]);

    expect(listEntries().map((entry) => entry.name)).toEqual(["one.$dup", "two.$dup"]);
  });

  it("keeps the first path recorded, so a module loaded later adds a link and no name", () => {
    const $shared = atom(0);
    const later = { home: "src/late.ts", external: false, moduleKey: "src/late.ts" };

    ownBindings(FROM, [{ name: "left", value: { $shared }, exported: false }]);
    ownBindings(later, [{ name: "right", value: { $shared }, exported: false }]);

    expect(listEntries()[0]?.name).toBe("left.$shared");
    expect(ownerLinksOf($shared).map((link) => link.path)).toEqual([
      "left.$shared",
      "right.$shared",
    ]);
  });

  it("keeps the entry name of a store no walk ever placed", () => {
    const $loose = atom(0);

    track($loose, "$loose");
    ownBindings(FROM, [{ name: "count", value: 2, exported: false }]);

    expect(listEntries()[0]?.name).toBe("$loose");
  });

  /** One key holds one value, and the scan read it last, so the store that was there has gone. */
  it("drops the link of the store another one replaced at the same key", () => {
    const $before = atom(0);
    const $after = atom(1);
    const holding: Record<string, Store> = { $x: $before };
    const later = { home: "src/late.ts", external: false, moduleKey: "src/late.ts" };

    ownBindings(FROM, [{ name: "holder", value: holding, exported: false }]);
    holding["$x"] = $after;
    ownBindings(later, [{ name: "box", value: holding, exported: false }]);

    expect(ownerLinksOf($before)).toEqual([]);
    expect(ownerOf($after)).toBe(holding);
  });

  it("leaves the entry a wrapper already made alone, and only renames it", () => {
    const $canUndo = atom(false);

    track($canUndo, "$canUndo");
    ownBindings(FROM, [{ name: "$undoable", value: $canUndo, exported: false }]);

    expect(listEntries()).toHaveLength(1);
    expect(listEntries()[0]).toMatchObject({ name: "$undoable", type: "atom" });
  });

  describe("the name a binding gives a store", () => {
    it("renames the entry, and says the store is named, so the tree draws it flat", () => {
      const $canUndo = atom(false);

      track($canUndo, "$canUndo");
      ownBindings(FROM, [{ name: "$undoable", value: $canUndo, exported: true }]);

      expect(listEntries()[0]?.name).toBe("$undoable");
      expect(namedByBinding($canUndo)).toBe(true);
    });

    it("lets the exported binding win, whatever order the two are scanned in", () => {
      const $typed = atom("");
      const $also = atom("");

      track($typed, "$typed");
      track($also, "$typed #2");
      ownBindings(FROM, [
        { name: "$typed", value: $typed, exported: false },
        { name: "$value", value: $typed, exported: true },
        { name: "$alias", value: $typed, exported: false },
      ]);
      ownBindings(FROM, [
        { name: "$exported", value: $also, exported: true },
        { name: "$plain", value: $also, exported: false },
      ]);

      expect(listEntries().map((entry) => entry.name)).toEqual(["$value", "$exported"]);
    });

    it("takes the last of two bindings of the same kind, which is the accepted gap", () => {
      const $typed = atom("");

      track($typed, "$typed");
      ownBindings(FROM, [
        { name: "$first", value: $typed, exported: true },
        { name: "$second", value: $typed, exported: true },
      ]);

      expect(listEntries()[0]?.name).toBe("$second");
    });

    it("keeps every binding, and names the entry after the primary one", () => {
      const $typed = atom("");

      track($typed, "$typed");
      ownBindings(FROM, [
        { name: "$first", value: $typed, exported: false },
        { name: "$value", value: $typed, exported: true },
        { name: "$last", value: $typed, exported: false },
      ]);

      expect(boundNames($typed)?.primary.name).toBe("$value");
      expect(boundNames($typed)?.repeats.map((bound) => bound.name)).toEqual(["$first", "$last"]);
      expect(listEntries()[0]?.name).toBe("$value");
      /** A row points at one node, so it names the binding the entry took and no other. */
      expect(rowName(listEntries()[0] as StoreEntry)).toBe("$value");
    });

    it("names nothing from a binding in somebody else's file", () => {
      const $canUndo = atom(false);

      track($canUndo, "$canUndo");
      ownBindings({ home: "vendor/withUndo.ts", external: true, moduleKey: "vendor/withUndo.ts" }, [
        { name: "$undoable", value: $canUndo, exported: true },
      ]);

      expect(listEntries()[0]?.name).toBe("$canUndo");
      expect(namedByBinding($canUndo)).toBe(false);
    });

    it("registers a store the registry never took, and claims the name for it", () => {
      const $loose = atom(false);

      ownBindings(FROM, [{ name: "$loose", value: $loose, exported: true }]);

      expect(listEntries()[0]).toMatchObject({ name: "$loose", home: HOME, origin: "plugin" });
      expect(namedByBinding($loose)).toBe(true);
    });
  });

  describe("what the walk hands back", () => {
    it("returns every store a binding reached, at the path that reached it", () => {
      const $canUndo = atom(false);
      const $draft = holder("", { $canUndo });

      const walked = ownBindings(FROM, [{ name: "editor", value: { $draft }, exported: false }]);

      expect(walked).toEqual([
        {
          binding: "editor",
          reached: [
            { store: $draft, path: "editor.$draft" },
            { store: $canUndo, path: "editor.$draft.$canUndo" },
          ],
        },
      ]);
    });

    it("puts the store a binding holds first, under the binding's own name", () => {
      const $canUndo = atom(false);
      const $draft = holder("", { $canUndo });

      const walked = ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

      expect(walked[0]?.reached).toEqual([
        { store: $draft, path: "$draft" },
        { store: $canUndo, path: "$draft.$canUndo" },
      ]);
    });

    it("returns a row for every binding, including one that reaches no store at all", () => {
      const walked = ownBindings(FROM, [
        { name: "settings", value: { theme: "dark" }, exported: false },
        { name: "count", value: 2, exported: false },
      ]);

      expect(walked).toEqual([
        { binding: "settings", reached: [] },
        { binding: "count", reached: [] },
      ]);
    });

    it("returns nothing for a file of somebody else's, which places nothing", () => {
      const $canUndo = atom(false);

      const walked = ownBindings(
        { home: "vendor/withUndo.ts", external: true, moduleKey: "vendor/withUndo.ts" },
        [{ name: "$canUndo", value: $canUndo, exported: false }],
      );

      expect(walked).toEqual([]);
    });
  });

  it("holds the store and its owner weakly, so it keeps neither of them alive", () => {
    const $canUndo = atom(false);
    const $draft = holder("", { $canUndo });

    ownBindings(FROM, [{ name: "$draft", value: $draft, exported: false }]);

    const owners = peekDevtoolsGlobal()?.owners;

    expect(owners).toBeInstanceOf(WeakMap);
    expect(owners?.get($canUndo)?.[0]?.owner).toBeInstanceOf(WeakRef);
    expect(owners?.get($canUndo)?.[0]?.owner.deref()).toBe($draft);
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    resetDevtoolsGlobal();
    vi.restoreAllMocks();
  });

  it("keys a class instance by its binding and holds the constructor apart from that name", () => {
    const editorOne = new Editor();

    ownBindings(FROM, [{ name: "editorOne", value: editorOne, exported: false }]);

    expect(ownerOf(editorOne.$value)).toBe(editorOne);
    expect(nodeInfoOf(editorOne)).toMatchObject({ name: "editorOne", type: "Editor" });
  });

  it("reads the constructor's name through the descriptor, so a getter over it never runs", () => {
    class Sneaky {}
    let ran = 0;

    Object.defineProperty(Sneaky, "name", {
      get(): string {
        ran += 1;

        return "Sneaky";
      },
    });

    const held = new Sneaky();

    ownBindings(FROM, [{ name: "held", value: held, exported: false }]);

    expect(nameOf(held)).toBe("held");
    expect(nodeInfoOf(held)?.type).toBeUndefined();
    expect(ran).toBe(0);
  });

  it("keys a plain object a factory returned by its binding, and labels it with nothing", () => {
    const created = panel();

    ownBindings(FROM, [{ name: "panel", value: created, exported: false }]);

    expect(ownerOf(created.$open)).toBe(created);
    expect(nameOf(created)).toBe("panel");
    expect(nodeInfoOf(created)?.type).toBeUndefined();
  });

  it("walks an array by index, and nests a node inside a node", () => {
    const first = new Editor();
    const drafts = [first, new Editor()];

    ownBindings(FROM, [{ name: "drafts", value: drafts, exported: false }]);

    expect(nodeInfoOf(drafts)).toMatchObject({ name: "drafts", type: "Array" });
    expect(nameOf(first)).toBe("[0]");
    expect(parentsOf(first)).toEqual([drafts]);
    expect(ownerOf(first.$value)).toBe(first);
  });

  it("walks a Map by key, string or number", () => {
    const scratch = new Editor();
    const second = new Editor();
    const byId = new Map<string | number, Editor>([
      ["scratch", scratch],
      [2, second],
    ]);

    ownBindings(FROM, [{ name: "byId", value: byId, exported: false }]);

    expect(nodeInfoOf(byId)?.type).toBe("Map");
    expect(nameOf(scratch)).toBe(`["scratch"]`);
    expect(nameOf(second)).toBe("[2]");
  });

  it("leaves out a Map key that is neither a string nor a number", () => {
    const held = new Editor();
    const byRef = new Map([[{}, held]]);

    ownBindings(FROM, [{ name: "byRef", value: byRef, exported: false }]);

    expect(nodeInfoOf(held)).toBeUndefined();
    expect(ownerOf(held.$value)).toBeUndefined();
  });

  it("walks a Set in insertion order", () => {
    const first = new Editor();
    const second = new Editor();
    const pool = new Set([first, second]);

    ownBindings(FROM, [{ name: "pool", value: pool, exported: false }]);

    expect(nodeInfoOf(pool)?.type).toBe("Set");
    expect(nameOf(first)).toBe("[0]");
    expect(nameOf(second)).toBe("[1]");
  });

  it("records the key its owner holds a store under, a collection's and a written one alike", () => {
    const $width = atom(320);
    const panel = { open: atom(false) };

    ownBindings(FROM, [
      { name: "bounds", value: [$width], exported: false },
      { name: "panel", value: panel, exported: false },
    ]);

    expect(ownerLinksOf($width)[0]?.key).toBe("[0]");
    /** The property the developer wrote, which is the name they can look the store up by. */
    expect(ownerLinksOf(panel.open)[0]?.key).toBe("open");
  });

  it("records a key that says nothing about the name the store was born with", () => {
    const $lens = atom("");

    track($lens, "$lens");
    ownBindings(FROM, [{ name: "fields", value: { username: $lens }, exported: false }]);

    expect(ownerLinksOf($lens)[0]?.key).toBe("username");
  });

  it("reads an array by index, so a method of its own never runs", () => {
    class Loud extends Array<Editor> {
      override forEach(): never {
        throw new Error("the value's own forEach ran");
      }

      override map(): never {
        throw new Error("the value's own map ran");
      }
    }

    const first = new Editor();
    const drafts = new Loud();

    drafts.push(first);
    ownBindings(FROM, [{ name: "drafts", value: drafts, exported: false }]);

    expect(nameOf(first)).toBe("[0]");
  });

  it("runs no getter sitting at an array index, so one that throws costs the array nothing", () => {
    const first = new Editor();
    const third = new Editor();
    const hostile = vi.fn((): never => {
      throw new Error("an index getter ran");
    });
    const drafts: Editor[] = [first];

    Object.defineProperty(drafts, 1, { enumerable: true, configurable: true, get: hostile });
    drafts[2] = third;

    expect(() => {
      ownBindings(FROM, [{ name: "drafts", value: drafts, exported: false }]);
    }).not.toThrow();
    expect(hostile).not.toHaveBeenCalled();
    expect(nameOf(first)).toBe("[0]");
    expect(nameOf(third)).toBe("[2]");
  });

  it("runs no accessor an array inherits from Array.prototype", () => {
    const inherited = vi.fn(() => new Editor());
    const first = new Editor();
    const last = new Editor();
    const drafts: Editor[] = [first];

    drafts[4] = last;
    /** A hole of the array's own, so only the prototype can answer for index 3. */
    Object.defineProperty(Array.prototype, 3, { configurable: true, get: inherited });

    try {
      ownBindings(FROM, [{ name: "drafts", value: drafts, exported: false }]);
    } finally {
      Reflect.deleteProperty(Array.prototype, 3);
    }

    expect(inherited).not.toHaveBeenCalled();
    expect(nameOf(first)).toBe("[0]");
    expect(nameOf(last)).toBe("[4]");
  });

  it("lets an array that throws while being read contribute nothing", () => {
    const created = panel();
    const drafts = new Proxy([created], {
      get(): never {
        throw new Error("a read trap ran");
      },
    });

    expect(() => {
      ownBindings(FROM, [{ name: "drafts", value: drafts, exported: false }]);
    }).not.toThrow();
    expect(ownerOf(created.$open)).toBeUndefined();
  });

  it("skips a hole in an array, and keeps the index the members that are there sit at", () => {
    const third = new Editor();
    const $open = atom(false);
    const drafts: (Editor | Store)[] = [];

    drafts[2] = third;
    drafts[5] = $open;
    ownBindings(FROM, [{ name: "drafts", value: drafts, exported: false }]);

    expect(nameOf(third)).toBe("[2]");
    expect(ownerLinksOf($open)[0]?.key).toBe("[5]");
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
      ownBindings(FROM, [{ name: "hostile", value: hostile, exported: false }]);
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

    ownBindings(FROM, [{ name: "byId", value: byId, exported: false }]);

    expect(nameOf(scratch)).toBe(`["scratch"]`);
  });

  it("lets a collection that throws while iterating contribute nothing", () => {
    const $open = atom(false);
    /** A `Map` by prototype and nothing else, so the built-in `forEach` finds no contents. */
    const empty: object = Object.create(Map.prototype);
    const broken = Object.assign(empty, { $open });

    expect(() => {
      ownBindings(FROM, [{ name: "broken", value: broken, exported: false }]);
    }).not.toThrow();
    expect(ownerOf($open)).toBeUndefined();
  });

  it("gives a member past the cap no node and no owner, so the walk stops at the number", () => {
    const past = panel();
    const many = [panel(), panel(), past];

    ownBindings(FROM, [{ name: "many", value: many, exported: false, maxMembers: 2 }]);

    expect(nodeInfoOf(many)?.skipped).toBe(1);
    expect(nodeInfoOf(past)).toBeUndefined();
    expect(ownerOf(past.$open)).toBeUndefined();
  });

  it("caps a plain object built at run time by the same number", () => {
    const past = panel();
    const many = { a: panel(), b: panel(), c: past };

    ownBindings(FROM, [{ name: "many", value: many, exported: false, maxMembers: 2 }]);

    expect(nodeInfoOf(many)?.walked).toBe(2);
    expect(nodeInfoOf(many)?.skipped).toBe(1);
    expect(nodeInfoOf(past)).toBeUndefined();
    expect(ownerOf(past.$open)).toBeUndefined();
  });

  /** The number bounds the whole binding, or a developer who wrote it would see nothing change. */
  it("caps a member of a member, so the number reaches every depth", () => {
    const past = panel();
    const inner = [panel(), panel(), past];
    const many = [inner];

    ownBindings(FROM, [{ name: "many", value: many, exported: false, maxMembers: 2 }]);

    expect(nodeInfoOf(inner)?.skipped).toBe(1);
    expect(nodeInfoOf(past)).toBeUndefined();
    expect(ownerOf(past.$open)).toBeUndefined();
  });

  /** A store past the number never registers, so nothing subscribes to it and nothing checks it. */
  it("registers no store past the number", () => {
    const past = panel();

    ownBindings(FROM, [{ name: "many", value: [panel(), past], exported: false, maxMembers: 1 }]);

    expect(listEntries().map((entry) => entry.name)).toEqual(["many[0].$open"]);
  });

  /** A wrapper named it before the scan ran, so it keeps that entry and draws at its own file. */
  it("leaves a store a wrapper registered past the number with no owner of its own", () => {
    const past = panel();

    track(past.$open, "$open");
    ownBindings(FROM, [{ name: "many", value: [panel(), past], exported: false, maxMembers: 1 }]);

    expect(ownerOf(past.$open)).toBeUndefined();
    expect(nodeInfoOf(past)).toBeUndefined();
    /** No walk reached it, so there is no path to name it by and the entry keeps its own name. */
    expect(getEntry(past.$open)?.name).toBe("$open");
  });

  it("walks every member of a binding that named no number", () => {
    const last = panel();
    const many = [...Array.from({ length: 4999 }, panel), last];

    ownBindings(FROM, [{ name: "many", value: many, exported: false }]);

    expect(nodeInfoOf(many)?.skipped).toBe(0);
    expect(nodeInfoOf(last)?.name).toBe("[4999]");
    expect(ownerOf(last.$open)).toBe(last);
  });

  it("keeps the first name a binding gave a value, whichever binding holds it later", () => {
    const editorOne = new Editor();

    ownBindings(FROM, [
      { name: "editorOne", value: editorOne, exported: false },
      { name: "drafts", value: [editorOne], exported: false },
    ]);

    expect(nameOf(editorOne)).toBe("editorOne");
  });

  it("draws a node in the file its binding was written in, whoever made the value", () => {
    const created = panel();

    ownBindings({ home: "src/panel.ts", external: false, moduleKey: "src/panel.ts" }, [
      { name: "panel", value: created, exported: false },
    ]);

    expect(nodeInfoOf(created)).toMatchObject({ home: "src/panel.ts", external: false });
  });

  it("draws no node at all for a binding in somebody else's file", () => {
    const created = panel();

    ownBindings({ home: "vendor/panel.ts", external: true, moduleKey: "vendor/panel.ts" }, [
      { name: "panel", value: created, exported: false },
    ]);

    expect(nodeInfoOf(created)).toBeUndefined();
  });

  it("holds a node's parent weakly, so it keeps no instance alive", () => {
    const first = new Editor();

    ownBindings(FROM, [{ name: "drafts", value: [first], exported: false }]);

    expect(peekDevtoolsGlobal()?.nodes).toBeInstanceOf(WeakMap);
    expect(nodeInfoOf(first)?.parents[0]?.parent).toBeInstanceOf(WeakRef);
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
      ownBindings(FROM, [{ name: "drafts", value: drafts, exported: false }]);
    }).not.toThrow();
    expect(created.$open.lc).toBe(0);
  });
});

describe("a class binding", () => {
  class Panel {
    static $opened = atom(0);
  }

  beforeEach(() => {
    resetDevtoolsGlobal();
  });

  afterEach(() => {
    resetDevtoolsGlobal();
  });

  /** No instance holds a static field, so the class is the one name that reaches its store. */
  it("walks a class's own static fields and registers what it finds under the class name", () => {
    ownBindings(FROM, [{ name: "Panel", value: Panel, exported: false, isClass: true }]);

    expect(listEntries()[0]?.name).toBe("Panel.$opened");
    expect(nodeInfoOf(Panel)).toMatchObject({ name: "Panel", type: undefined });
  });

  it("leaves out what every class carries, so only the fields the developer wrote are walked", () => {
    ownBindings(FROM, [{ name: "Panel", value: Panel, exported: false, isClass: true }]);

    expect(nodeInfoOf(Panel)?.walked).toBe(1);
  });

  it("looks inside no other function, whatever it holds", () => {
    const make = (): void => {};

    Object.assign(make, { $held: atom(0) });
    ownBindings(FROM, [{ name: "make", value: make, exported: false }]);

    expect(listEntries()).toEqual([]);
  });
});

describe("a value that refuses to be read", () => {
  /** A `Proxy` whose trap throws rather than answers, which no walk of ours can tell apart. */
  function refusing(trap: "ownKeys" | "getOwnPropertyDescriptor"): object {
    return new Proxy(
      { $hidden: atom(false) },
      {
        [trap]: (): never => {
          throw new Error(`the ${trap} trap ran`);
        },
      },
    );
  }

  function panel(): { $open: Store } {
    return { $open: atom(false) };
  }

  beforeEach(() => {
    resetDevtoolsGlobal();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    resetDevtoolsGlobal();
    vi.restoreAllMocks();
  });

  it.each(["ownKeys", "getOwnPropertyDescriptor"] as const)(
    "leaves the module evaluating when a binding holds a Proxy whose %s trap throws",
    (trap) => {
      const created = panel();

      expect(() => {
        ownBindings(FROM, [
          { name: "remote", value: refusing(trap), exported: false },
          { name: "panel", value: created, exported: false },
        ]);
      }).not.toThrow();
      expect(ownerOf(created.$open)).toBe(created);
    },
  );

  it.each([
    ["an object", (held: object, created: object): unknown => ({ remote: held, panel: created })],
    ["an array", (held: object, created: object): unknown => [held, created]],
    [
      "a Map",
      (held: object, created: object): unknown =>
        new Map([
          ["remote", held],
          ["panel", created],
        ]),
    ],
    ["a Set", (held: object, created: object): unknown => new Set([held, created])],
  ])("leaves the walk standing when %s holds the refusing Proxy", (_name, build) => {
    const created = panel();

    expect(() => {
      ownBindings(FROM, [
        {
          name: "drafts",
          value: build(refusing("getOwnPropertyDescriptor"), created),
          exported: false,
        },
      ]);
    }).not.toThrow();
    expect(ownerOf(created.$open)).toBe(created);
  });

  it("walks a Proxy that answers both traps exactly as the object under it", () => {
    const created = panel();
    const held = new Proxy(created, {});

    ownBindings(FROM, [{ name: "panel", value: held, exported: false }]);

    expect(ownerOf(created.$open)).toBe(held);
    expect(nodeInfoOf(held)).toMatchObject({ name: "panel" });
  });

  it("warns once per binding, not once per read", () => {
    const held = refusing("ownKeys");

    ownBindings(FROM, [{ name: "remote", value: held, exported: false }]);
    ownBindings(FROM, [{ name: "remote", value: held, exported: false }]);

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('"remote"');
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain(HOME);
  });

  it("warns for each binding that refuses, so no second one is hidden by the first", () => {
    ownBindings(FROM, [
      { name: "remote", value: { held: refusing("ownKeys") }, exported: false },
      { name: "other", value: { held: refusing("ownKeys") }, exported: false },
    ]);

    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('"held" under "remote"');
    expect(vi.mocked(console.warn).mock.calls[1]?.[0]).toContain('"held" under "other"');
  });

  it("warns once for a binding holding two values that refuse, because one line is enough", () => {
    ownBindings(FROM, [
      {
        name: "remote",
        value: { first: refusing("ownKeys"), second: refusing("ownKeys") },
        exported: false,
      },
    ]);

    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("warns for a collection whose own read throws, the way a plain object does", () => {
    const drafts = new Proxy([panel()], {
      get(): never {
        throw new Error("a read trap ran");
      },
    });

    ownBindings(FROM, [{ name: "drafts", value: drafts, exported: false }]);

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('"drafts"');
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
    expect(nodeInfoOf(editorOne)).toMatchObject({
      name: "ref",
      ours: true,
      numbered: true,
      type: "Editor",
    });
  });

  it("keys a static field's node by the class name and labels it with nothing", () => {
    ownField(FROM, Editor.$opened, Editor);

    expect(ownerOf(Editor.$opened)).toBe(Editor);
    expect(nodeInfoOf(Editor)).toMatchObject({ name: "Editor", ours: false, numbered: false });
    expect(nodeInfoOf(Editor)?.type).toBeUndefined();
  });

  it("lets the binding scan correct the name no constructor could know yet", () => {
    const editorOne = new Editor();

    ownField(FROM, editorOne.$value, editorOne);
    ownBindings(FROM, [{ name: "editorOne", value: editorOne, exported: false }]);

    expect(nodeInfoOf(editorOne)).toMatchObject({
      name: "editorOne",
      ours: false,
      type: "Editor",
    });
  });

  it("keeps the name the developer wrote when a class field runs after the scan", () => {
    const editorOne = new Editor();

    ownBindings(FROM, [{ name: "editorOne", value: editorOne, exported: false }]);
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

    ownBindings(FROM, [{ name: "vault", value: vault, exported: false }]);

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

    ownField(
      { home: "src/editor.ts", external: false, moduleKey: "src/editor.ts" },
      editorOne.$value,
      editorOne,
    );

    expect(nodeInfoOf(editorOne)).toMatchObject({ home: "src/editor.ts", external: false });
  });

  it("draws no node for a class in somebody else's file", () => {
    const editorOne = new Editor();

    ownField(
      { home: "vendor/editor.ts", external: true, moduleKey: "vendor/editor.ts" },
      editorOne.$value,
      editorOne,
    );

    expect(nodeInfoOf(editorOne)).toBeUndefined();
  });

  it("registers nothing, so a field's store gains no entry of its own", () => {
    const editorOne = new Editor();

    ownField(FROM, editorOne.$value, editorOne);

    expect(listEntries()).toEqual([]);
  });

  it("holds the instance weakly, so it keeps nothing the app has let go alive", () => {
    const editorOne = new Editor();

    ownField(FROM, editorOne.$value, editorOne);

    expect(peekDevtoolsGlobal()?.owners.get(editorOne.$value)?.[0]?.owner).toBeInstanceOf(WeakRef);
  });

  it("keeps the instance a field ran for, which no binding scan may take away", () => {
    const editorOne = new Editor();

    ownField(FROM, editorOne.$value, editorOne);
    ownBindings(FROM, [{ name: "shared", value: { $value: editorOne.$value }, exported: false }]);

    expect(ownerOf(editorOne.$value)).toBe(editorOne);
  });
});

describe("ownerLinksOf", () => {
  beforeEach(() => {
    resetDevtoolsGlobal();
  });

  afterEach(() => {
    resetDevtoolsGlobal();
  });

  it("hands the owner and the key that owner knows the store by back as one record", () => {
    const $width = atom(320);
    const bounds = [$width];

    ownBindings(FROM, [{ name: "bounds", value: bounds, exported: false }]);

    expect(ownerLinksOf($width)).toEqual([{ owner: bounds, key: "[0]", path: "bounds[0]" }]);
  });

  it("reads an owner the app has let go as no owner, so its key goes with it", () => {
    const $open = atom(false);
    const gone: WeakRef<object> = { [Symbol.toStringTag]: "WeakRef", deref: () => undefined };

    getDevtoolsGlobal().owners.set($open, [
      { owner: gone, key: "[0]", path: undefined, pass: 1, moduleKey: HOME },
    ]);

    expect(ownerLinksOf($open)).toEqual([]);
  });
});

/**
 * `$root.value.$children` is a path the developer can type, so a store sitting inside another
 * store's value is reachable and it draws, under the store that holds it.
 */
describe("a store inside another store's value", () => {
  beforeEach(() => {
    resetDevtoolsGlobal();
  });

  afterEach(() => {
    resetDevtoolsGlobal();
    vi.restoreAllMocks();
  });

  it("draws a store found in a store's value under the store that holds it", () => {
    const $children = atom<unknown[]>([]);
    const $root = atom<unknown>({ $children });

    ownBindings(FROM, [{ name: "$root", value: $root, exported: true }]);

    expect(ownerOf($children)).toBe($root);
  });

  it("names it by the whole path, with the step into the value written in it", () => {
    const $children = atom<unknown[]>([]);
    const $root = atom<unknown>({ $children });

    ownBindings(FROM, [{ name: "$root", value: $root, exported: true }]);

    expect(getEntry($children)?.name).toBe("$root.value.$children");
  });

  /** The path names the entry, and the key alone is what the tree draws under the owner. */
  it("keys it under its owner by the last key alone, so no tree key holds a dot", () => {
    const $children = atom<unknown[]>([]);
    const $root = atom<unknown>({ $children });

    ownBindings(FROM, [{ name: "$root", value: $root, exported: true }]);

    expect(getEntry($children)?.ownerName).toBe("$children");
  });

  it("keeps walking past the first level, so a value's own members hold their stores", () => {
    const $checked = atom(false);
    const node = { $checked };
    const $root = atom<unknown>({ items: [node] });

    ownBindings(FROM, [{ name: "$root", value: $root, exported: true }]);

    expect(ownerOf($checked)).toBe(node);
    expect(getEntry($checked)?.name).toBe("$root.value.items[0].$checked");
  });

  /** The bridge never runs the app's own code to find out something, and a mount is app code. */
  it("mounts nothing it walks", () => {
    const $source = atom(1);
    const $derived = computed($source, (value) => value + 1);
    const $root = atom<unknown>({ $derived, nested: { $source } });

    ownBindings(FROM, [{ name: "$root", value: $root, exported: true }]);

    expect([$root.lc, $derived.lc, $source.lc]).toEqual([0, 0, 0]);
  });

  it("gives up nothing from a computed nothing has ever mounted", () => {
    const $inner = atom(0);
    const $seed = atom(1);
    const $derived = computed($seed, () => ({ $inner }));

    ownBindings(FROM, [{ name: "$derived", value: $derived, exported: true }]);

    expect(getEntry($inner)).toBeUndefined();
  });

  /** The stale label is the truth about the store, and what it still holds is what the app has. */
  it("walks the value a computed nothing mounts any more still holds", () => {
    const $inner = atom(0);
    const $seed = atom(1);
    const $derived = computed($seed, () => ({ $inner }));

    $derived.listen(() => {})();
    ownBindings(FROM, [{ name: "$derived", value: $derived, exported: true }]);

    expect(ownerOf($inner)).toBe($derived);
  });

  it("stops at the depth the walk was given, whichever side of the boundary the step is on", () => {
    const $held = atom(0);
    const $root = atom<unknown>({ $held });

    ownBindings(FROM, [{ name: "$root", value: $root, exported: true }], 1);

    expect(getEntry($held)).toBeUndefined();
  });

  it("caps what a store holds by the number the binding named", () => {
    const $first = atom(1);
    const $second = atom(2);
    const $third = atom(3);
    const $root = atom<unknown>({ $first, $second, $third });

    ownBindings(FROM, [{ name: "$root", value: $root, exported: true, maxMembers: 2 }]);

    expect(listEntries().map((entry) => entry.store)).toEqual([$root, $first, $second]);
  });

  /** Two stores holding each other is a loop, and an owner graph that loops draws without end. */
  it("refuses the edge that would close a loop between two stores holding each other", () => {
    const $a = atom<unknown>(null);
    const $b = atom<unknown>({ $a });

    $a.set({ $b });
    ownBindings(FROM, [{ name: "$a", value: $a, exported: true }]);

    expect(ownerOf($b)).toBe($a);
    expect(ownerOf($a)).toBeUndefined();
  });

  it("warns once when what it found has filled the registry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const held: Record<string, Store> = {};

    for (let index = 0; index < 2000; index += 1) {
      held[`$s${index}`] = atom(index);
    }

    ownBindings(FROM, [{ name: "$all", value: atom(held), exported: true }]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("stores are registered");
  });
});
