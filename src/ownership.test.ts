import { atom, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDevtoolsGlobal, peekDevtoolsGlobal, resetDevtoolsGlobal } from "./global.ts";
import {
  beginFrame,
  endFrame,
  MAX_MEMBERS,
  noteBirth,
  ownBindings,
  ownField,
} from "./ownership.ts";
import { namedByBinding, nodeInfoOf, ownerLinkOf } from "./placement.ts";
import { listEntries, registerStore, unregisterStore } from "./registry.ts";

const HOME = "src/model.ts";

/** The module the bindings come from, which is where a node one of them makes is drawn. */
const FROM = { home: HOME, external: false, moduleKey: HOME };

/** A store holding other stores beside its own value, which is what `Object.assign` builds. */
function holder(value: unknown, held: Record<string, Store>): Store {
  return Object.assign(atom<unknown>(value), held);
}

function track(store: Store, name: string): void {
  registerStore({
    store,
    name,
    home: HOME,
    type: "atom",
    origin: "plugin",
    external: false,
    fn: null,
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

    ownBindings(FROM, [["$draft", $draft]]);

    expect(ownerLinkOf($canUndo)?.owner).toBe($draft);
  });

  it("leaves the store a binding holds without an owner of its own", () => {
    const $draft = holder("", { $canUndo: atom(false) });

    ownBindings(FROM, [["$draft", $draft]]);

    expect(ownerLinkOf($draft)?.owner).toBeUndefined();
  });

  it("stops at a binding that holds no object at all", () => {
    const $open = atom(false);

    ownBindings(FROM, [
      ["count", 2],
      ["missing", undefined],
      ["make", () => $open],
    ]);

    expect(ownerLinkOf($open)?.owner).toBeUndefined();
  });

  it("skips the nanostores keys, so an atom holding a store does not nest it", () => {
    const $inner = atom(1);
    const $outer = Object.assign(atom<unknown>($inner), { events: $inner });

    ownBindings(FROM, [["$outer", $outer]]);

    expect(ownerLinkOf($inner)?.owner).toBeUndefined();
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

  it("runs no getter while deciding whether a value is a store", () => {
    const listen = vi.fn(() => () => {});
    const lc = vi.fn(() => 0);
    const decoy = {};

    Object.defineProperty(decoy, "listen", { enumerable: true, get: listen });
    Object.defineProperty(decoy, "lc", { enumerable: true, get: lc });

    ownBindings(FROM, [["holder", { decoy }]]);

    expect(listen).not.toHaveBeenCalled();
    expect(lc).not.toHaveBeenCalled();
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

    expect(ownerLinkOf($first)?.owner).toBe($draft);
    expect(ownerLinkOf($second)?.owner).toBe($first);
    expect(ownerLinkOf($third)?.owner).toBe($second);
    expect(ownerLinkOf($fourth)?.owner).toBeUndefined();
  });

  it("refuses to put a store under itself", () => {
    const $draft = holder("", {});

    Object.assign($draft, { $self: $draft });
    ownBindings(FROM, [["$draft", $draft]]);

    expect(ownerLinkOf($draft)?.owner).toBeUndefined();
  });

  it("ends the walk on a cycle and refuses the edge that would loop", () => {
    const $draft = holder("", {});
    const $history = holder([], { $draft });

    Object.assign($draft, { $history });
    ownBindings(FROM, [["$draft", $draft]]);

    expect(ownerLinkOf($history)?.owner).toBe($draft);
    expect(ownerLinkOf($draft)?.owner).toBeUndefined();
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

    expect(ownerLinkOf($canUndo)?.owner).toBe($draft);
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

    expect(ownerLinkOf($canUndo)?.owner).toBe($after);
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

  describe("the name a binding gives a store", () => {
    it("renames the entry, and says the store is named, so the tree draws it flat", () => {
      const $canUndo = atom(false);

      track($canUndo, "$canUndo");
      ownBindings(FROM, [["$undoable", $canUndo, true]]);

      expect(listEntries()[0]?.name).toBe("$undoable");
      expect(namedByBinding($canUndo)).toBe(true);
    });

    it("lets the exported binding win, whatever order the two are scanned in", () => {
      const $typed = atom("");
      const $also = atom("");

      track($typed, "$typed");
      track($also, "$typed #2");
      ownBindings(FROM, [
        ["$typed", $typed, false],
        ["$value", $typed, true],
        ["$alias", $typed, false],
      ]);
      ownBindings(FROM, [
        ["$exported", $also, true],
        ["$plain", $also, false],
      ]);

      expect(listEntries().map((entry) => entry.name)).toEqual(["$value", "$exported"]);
    });

    it("takes the last of two bindings of the same kind, which is the accepted gap", () => {
      const $typed = atom("");

      track($typed, "$typed");
      ownBindings(FROM, [
        ["$first", $typed, true],
        ["$second", $typed, true],
      ]);

      expect(listEntries()[0]?.name).toBe("$second");
    });

    it("names nothing from a binding in somebody else's file", () => {
      const $canUndo = atom(false);

      track($canUndo, "$canUndo");
      ownBindings({ home: "vendor/withUndo.ts", external: true, moduleKey: "vendor/withUndo.ts" }, [
        ["$undoable", $canUndo, true],
      ]);

      expect(listEntries()[0]?.name).toBe("$canUndo");
      expect(namedByBinding($canUndo)).toBe(false);
    });

    it("claims no store the registry never took", () => {
      const $loose = atom(false);

      ownBindings(FROM, [["$loose", $loose, true]]);

      expect(namedByBinding($loose)).toBe(false);
    });
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    resetDevtoolsGlobal();
    vi.restoreAllMocks();
  });

  it("keys a class instance by its binding and holds the constructor apart from that name", () => {
    const editorOne = new Editor();

    ownBindings(FROM, [["editorOne", editorOne]]);

    expect(ownerLinkOf(editorOne.$value)?.owner).toBe(editorOne);
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

    ownBindings(FROM, [["held", held]]);

    expect(nameOf(held)).toBe("held");
    expect(nodeInfoOf(held)?.type).toBeUndefined();
    expect(ran).toBe(0);
  });

  it("keys a plain object a factory returned by its binding, and labels it with nothing", () => {
    const created = panel();

    ownBindings(FROM, [["panel", created]]);

    expect(ownerLinkOf(created.$open)?.owner).toBe(created);
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
    expect(ownerLinkOf(first.$value)?.owner).toBe(first);
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
    expect(ownerLinkOf(held.$value)?.owner).toBeUndefined();
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

  it("records the key its owner holds a store under, a collection's and a written one alike", () => {
    const $width = atom(320);
    const panel = { open: atom(false) };

    ownBindings(FROM, [
      ["bounds", [$width]],
      ["panel", panel],
    ]);

    expect(ownerLinkOf($width)?.key).toBe("[0]");
    /** The property the developer wrote, which is the name they can look the store up by. */
    expect(ownerLinkOf(panel.open)?.key).toBe("open");
  });

  it("records a key that says nothing about the name the store was born with", () => {
    const $lens = atom("");

    track($lens, "$lens");
    ownBindings(FROM, [["fields", { username: $lens }]]);

    expect(ownerLinkOf($lens)?.key).toBe("username");
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
    ownBindings(FROM, [["drafts", drafts]]);

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
      ownBindings(FROM, [["drafts", drafts]]);
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
      ownBindings(FROM, [["drafts", drafts]]);
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
      ownBindings(FROM, [["drafts", drafts]]);
    }).not.toThrow();
    expect(ownerLinkOf(created.$open)?.owner).toBeUndefined();
  });

  it("skips a hole in an array, and keeps the index the members that are there sit at", () => {
    const third = new Editor();
    const $open = atom(false);
    const drafts: (Editor | Store)[] = [];

    drafts[2] = third;
    drafts[5] = $open;
    ownBindings(FROM, [["drafts", drafts]]);

    expect(nameOf(third)).toBe("[2]");
    expect(ownerLinkOf($open)?.key).toBe("[5]");
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
    expect(ownerLinkOf($open)?.owner).toBe(hostile);
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
    expect(ownerLinkOf($open)?.owner).toBeUndefined();
  });

  it("gives a member past the cap no node, and hangs the stores it holds on the collection", () => {
    const past = panel();
    const many = [...Array.from({ length: MAX_MEMBERS + 1 }, panel), past];

    ownBindings(FROM, [["many", many]]);

    expect(nodeInfoOf(many)?.skipped).toBe(2);
    expect(nodeInfoOf(past)).toBeUndefined();
    expect(ownerLinkOf(past.$open)?.owner).toBe(many);
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

    ownBindings({ home: "src/panel.ts", external: false, moduleKey: "src/panel.ts" }, [
      ["panel", created],
    ]);

    expect(nodeInfoOf(created)).toMatchObject({ home: "src/panel.ts", external: false });
  });

  it("draws no node at all for a binding in somebody else's file", () => {
    const created = panel();

    ownBindings({ home: "vendor/panel.ts", external: true, moduleKey: "vendor/panel.ts" }, [
      ["panel", created],
    ]);

    expect(nodeInfoOf(created)).toBeUndefined();
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
          ["remote", refusing(trap)],
          ["panel", created],
        ]);
      }).not.toThrow();
      expect(ownerLinkOf(created.$open)?.owner).toBe(created);
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
      ownBindings(FROM, [["drafts", build(refusing("getOwnPropertyDescriptor"), created)]]);
    }).not.toThrow();
    expect(ownerLinkOf(created.$open)?.owner).toBe(created);
  });

  it("walks a Proxy that answers both traps exactly as the object under it", () => {
    const created = panel();
    const held = new Proxy(created, {});

    ownBindings(FROM, [["panel", held]]);

    expect(ownerLinkOf(created.$open)?.owner).toBe(held);
    expect(nodeInfoOf(held)).toMatchObject({ name: "panel" });
  });

  it("warns once per binding, not once per read", () => {
    const held = refusing("ownKeys");

    ownBindings(FROM, [["remote", held]]);
    ownBindings(FROM, [["remote", held]]);

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('"remote"');
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain(HOME);
  });

  it("warns for each binding that refuses, so no second one is hidden by the first", () => {
    ownBindings(FROM, [
      ["remote", { held: refusing("ownKeys") }],
      ["other", { held: refusing("ownKeys") }],
    ]);

    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('"held" under "remote"');
    expect(vi.mocked(console.warn).mock.calls[1]?.[0]).toContain('"held" under "other"');
  });

  it("warns once for a binding holding two values that refuse, because one line is enough", () => {
    ownBindings(FROM, [["remote", { first: refusing("ownKeys"), second: refusing("ownKeys") }]]);

    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("warns for a collection whose own read throws, the way a plain object does", () => {
    const drafts = new Proxy([panel()], {
      get(): never {
        throw new Error("a read trap ran");
      },
    });

    ownBindings(FROM, [["drafts", drafts]]);

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

    expect(ownerLinkOf(editorOne.$value)?.owner).toBe(editorOne);
    expect(nodeInfoOf(editorOne)).toMatchObject({
      name: "ref",
      ours: true,
      numbered: true,
      type: "Editor",
    });
  });

  it("keys a static field's node by the class name and labels it with nothing", () => {
    ownField(FROM, Editor.$opened, Editor);

    expect(ownerLinkOf(Editor.$opened)?.owner).toBe(Editor);
    expect(nodeInfoOf(Editor)).toMatchObject({ name: "Editor", ours: false, numbered: false });
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

    expect(ownerLinkOf(editorOne.$value)?.owner).toBe(editorOne);
    expect(ownerLinkOf(editorTwo.$value)?.owner).toBe(editorTwo);
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

    expect(ownerLinkOf(vault.hidden)?.owner).toBe(vault);
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

    ownField({ home: "src/editor.ts", external: false }, editorOne.$value, editorOne);

    expect(nodeInfoOf(editorOne)).toMatchObject({ home: "src/editor.ts", external: false });
  });

  it("draws no node for a class in somebody else's file", () => {
    const editorOne = new Editor();

    ownField({ home: "vendor/editor.ts", external: true }, editorOne.$value, editorOne);

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

    expect(peekDevtoolsGlobal()?.owners.get(editorOne.$value)?.owner).toBeInstanceOf(WeakRef);
  });

  it("keeps the instance a field ran for, which no binding scan may take away", () => {
    const editorOne = new Editor();

    ownField(FROM, editorOne.$value, editorOne);
    ownBindings(FROM, [["shared", { $value: editorOne.$value }]]);

    expect(ownerLinkOf(editorOne.$value)?.owner).toBe(editorOne);
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

    expect(ownerLinkOf($timeline)?.owner).toBe($draft);
    expect(ownerLinkOf($draft)?.owner).toBeUndefined();
  });

  it("names a node after the binding when the expression returned anything else", () => {
    const $timeline = atom<string[]>([]);
    const model = { title: "" };

    beginFrame();
    born($timeline);
    endFrame(FROM, model, "model");

    expect(ownerLinkOf($timeline)?.owner).toBe(model);
    expect(nodeInfoOf(model)).toMatchObject({ name: "model", ours: false, type: undefined });
  });

  it("places nothing when the frame ran in somebody else's file", () => {
    const $active = atom(false);
    const resource = { acquire: () => {} };

    beginFrame();
    born($active);
    endFrame({ home: "vendor/history.ts", external: true }, resource, "resource");

    expect(ownerLinkOf($active)).toBeUndefined();
    expect(nodeInfoOf(resource)).toBeUndefined();
  });

  it("still hands its stores up to an outer frame from somebody else's file", () => {
    const $active = atom(false);
    const model = { title: "" };
    const resource = { acquire: () => {} };

    beginFrame();
    beginFrame();
    born($active);
    endFrame({ home: "vendor/history.ts", external: true }, resource, "resource");
    endFrame(FROM, model, "model");

    expect(ownerLinkOf($active)?.owner).toBe(model);
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
    expect(ownerLinkOf(editor.$value)?.owner).toBe(editor);
  });

  it("reaches a store a factory made in a class field, which adoption places nowhere", () => {
    const $made = atom(0);

    beginFrame();

    const editor = new Editor();

    born($made);
    endFrame(FROM, editor, "editorOne");

    expect(ownerLinkOf($made)?.owner).toBe(editor);
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

    expect(ownerLinkOf($inner)?.owner).toBe(model);
    expect(ownerLinkOf($part)?.owner).toBe(model);
  });

  it("lets the binding scan correct it, so a Map member keeps the key it sits at", () => {
    const scratch = { $open: atom(false) };
    const byId = new Map([["scratch", scratch]]);

    beginFrame();
    born(scratch.$open);
    endFrame(FROM, byId, "byId");

    expect(ownerLinkOf(scratch.$open)?.owner).toBe(byId);

    ownBindings(FROM, [["byId", byId]]);

    expect(ownerLinkOf(scratch.$open)?.owner).toBe(scratch);
    expect(nodeInfoOf(scratch)?.name).toBe(`["scratch"]`);
  });

  it("lets a class field correct it, because a field knows a name and a frame does not", () => {
    const $made = atom(0);

    beginFrame();
    born($made);
    endFrame(FROM, { title: "" }, "model");

    const editor = new Editor();

    ownField(FROM, $made, editor);

    expect(ownerLinkOf($made)?.owner).toBe(editor);
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
    expect(ownerLinkOf(editor.$value)?.owner).toBe(editor);
  });

  it("draws no node for an initializer that returned no object at all", () => {
    const $timeline = atom<string[]>([]);

    beginFrame();
    born($timeline);
    endFrame(FROM, 3, "count");

    expect(ownerLinkOf($timeline)?.owner).toBeUndefined();
  });

  it("places nothing while no frame is open, and brings no registry into being", () => {
    const $stray = atom(0);

    born($stray);
    endFrame(FROM, { title: "" }, "model");

    expect(ownerLinkOf($stray)?.owner).toBeUndefined();
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
    expect(ownerLinkOf($stray)?.owner).toBeUndefined();
  });

  it("books one drop for the outermost frame, not one for every frame it holds", () => {
    const book = vi.spyOn(globalThis, "queueMicrotask");

    beginFrame();
    beginFrame();

    expect(book).toHaveBeenCalledTimes(1);

    book.mockRestore();
  });
});

describe("ownerLinkOf", () => {
  beforeEach(() => {
    resetDevtoolsGlobal();
  });

  afterEach(() => {
    resetDevtoolsGlobal();
  });

  it("hands the owner and the key that owner knows the store by back as one record", () => {
    const $width = atom(320);
    const bounds = [$width];

    ownBindings(FROM, [["bounds", bounds]]);

    expect(ownerLinkOf($width)).toEqual({ owner: bounds, key: "[0]" });
  });

  it("reads an owner the app has let go as no owner, so its key goes with it", () => {
    const $open = atom(false);
    const gone: WeakRef<object> = { [Symbol.toStringTag]: "WeakRef", deref: () => undefined };

    getDevtoolsGlobal().owners.set($open, { owner: gone, source: "scan", key: "[0]" });

    expect(ownerLinkOf($open)).toBeUndefined();
  });
});
