import { stringify } from "jsan";
import { atom, computed, deepMap, map, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDevtoolsGlobal } from "./global.ts";
import { box, mark } from "./marker.ts";
import { isStore, registerStore, type StoreType } from "./registry.ts";
import { createReplacer, type Serializer } from "./replacer.ts";
import { MAX_WALKED_NODES } from "./slot.ts";
import { EXTENSION_OPTIONS, labelOf, parsePanel } from "./testing/panel.ts";

class Point {
  x = 1;
  y = 2;
}

class Empty {}

class FakeNode {
  nodeName: string;
  attributes: { name: string; value: string }[];

  constructor(nodeName: string, attributes: { name: string; value: string }[] = []) {
    this.nodeName = nodeName;
    this.attributes = attributes;
  }
}

/** Named after the real class, because the label the panel shows is the constructor name. */
class HTMLDivElement extends FakeNode {}

const replacer = createReplacer([]);

/** Reads `data` off a marked value and fails the test when the value is not marked at all. */
function markedData(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("__serializedType__" in value)) {
    throw new Error(`not a marked value: ${String(value)}`);
  }

  return "data" in value ? value.data : undefined;
}

function markedKeys(value: unknown): string[] {
  const data = markedData(value);

  return typeof data === "object" && data !== null ? Object.keys(data) : [];
}

/** The real encoder, run the way the extension runs it, so a loop fails here the way it fails there. */
function write(
  value: unknown,
  through: (key: string, value: unknown) => unknown = replacer,
): string {
  return stringify(value, through, null, EXTENSION_OPTIONS);
}

/** jsan writes a `Map` and a `Set` as one escaped string, so the quotes come back for reading. */
function unescaped(written: string): string {
  return written.replaceAll('\\"', '"');
}

function register(store: Store, type: StoreType, name = "$s"): void {
  registerStore({
    store,
    name,
    home: "src/stores.ts",
    type,
    origin: "plugin",
    external: false,
    fn: null,
  });
}

function throwing(): unknown {
  const value = new Empty();

  Object.defineProperty(value, "toString", {
    value: () => {
      throw new Error("nope");
    },
  });

  return value;
}

describe("createReplacer", () => {
  beforeEach(() => {
    resetDevtoolsGlobal();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetDevtoolsGlobal();
  });

  describe("what jsan keeps", () => {
    it("returns every value jsan renders natively untouched", () => {
      const values: unknown[] = [
        new Date(0),
        /ab+c/gi,
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Symbol("s"),
        function add(a: number, b: number): number {
          return a + b;
        },
        null,
        "text",
        7,
        true,
      ];

      for (const value of values) {
        expect(replacer("k", value)).toBe(value);
      }
    });

    /**
     * The panel draws one node kind for a `Map`, a `Set` and anything else iterable, and that node
     * writes `Iterable` over the type it worked out, so a collection jsan renders natively cannot
     * say which of the two it is. Keying it is what buys the name back.
     */
    it("keys a Map and a Set instead, so each one keeps its own name", () => {
      expect(write(new Map([["a", 1]]))).toBe(
        '{"data":{"[\\"a\\"]":1},"__serializedType__":"Map"}',
      );
      expect(write(new Set([1, 2]))).toBe('{"data":{"[0]":1,"[1]":2},"__serializedType__":"Set"}');
    });

    it("keys an empty collection too, so it still says what it is", () => {
      expect(write(new Set())).toBe('{"data":{},"__serializedType__":"Set"}');
      expect(write(new Map())).toBe('{"data":{},"__serializedType__":"Map"}');
    });

    it("keeps a Map key no name in the source can spell, in jsan's own shape", () => {
      const key = { id: 1 };

      expect(unescaped(write(new Map<unknown, unknown>([[key, "held"]])))).toContain(
        '"[entry 0]":{"[key]":{"id":1},"[value]":"held"}',
      );
    });

    it("numbers such an entry by its place among all of them, named ones included", () => {
      const value = new Map<unknown, unknown>([
        ["first", 1],
        [{ id: 2 }, 2],
      ]);

      expect(unescaped(write(value))).toContain('"[entry 1]"');
    });

    it("reads both collections through the built-in forEach, so no override of theirs runs", () => {
      const ran = vi.fn();

      class Sneaky extends Set<number> {
        override forEach(): void {
          ran();
        }
      }

      expect(write(new Sneaky([1]))).toBe('{"data":{"[0]":1},"__serializedType__":"Set"}');
      expect(ran).not.toHaveBeenCalled();
    });

    it("leaves a wrapper the snapshot builder already made unmarked", () => {
      const wrapper = mark("Unmounted", box(1));

      expect(replacer("k", wrapper)).toEqual(wrapper);
      expect(replacer("data", wrapper.data)).toEqual(wrapper.data);
    });
  });

  describe("a plain object and an array", () => {
    it("hands jsan a copy rather than the value the app holds", () => {
      const rows: unknown[] = [{ a: 1 }, Object.create(null), [1, 2]];

      for (const value of rows) {
        const handed = replacer("k", value);

        expect(handed).not.toBe(value);
        expect(handed).toEqual(value);
      }
    });

    it("leaves out an own getter of a plain object without running it", () => {
      const read = vi.fn(() => "ran");
      const value = { a: 1 };

      Object.defineProperty(value, "later", { get: read, enumerable: true });

      expect(write(value)).toBe('{"a":1}');
      expect(read).not.toHaveBeenCalled();
    });

    it("leaves out an own accessor index of an array without running it", () => {
      const read = vi.fn(() => "ran");
      const value = [1, 2, 3];

      Object.defineProperty(value, 1, { get: read, enumerable: true, configurable: true });

      expect(write(value)).toBe('[1,{"$jsan":"u"},3]');
      expect(read).not.toHaveBeenCalled();
    });

    it("keeps a key order the developer would read, and every key jsan sent before", () => {
      expect(write({ b: 1, a: { c: [2, 3] } })).toBe('{"b":1,"a":{"c":[2,3]}}');
    });

    it("leaves out a method, so a model object shows the state it holds and nothing else", () => {
      const node = { id: "node-1", $open: atom(false), toggle: () => {}, add(): void {} };

      expect(Object.keys(replacer("n", node) as object)).toEqual(["id", "$open [store]"]);
    });

    it("leaves a method inside an array where it sits, because an index is a position", () => {
      expect(write([1, () => {}, 3])).toBe('[1,{"$jsan":"f() => { /* ... */ }"},3]');
    });

    it("shows what the value holds now on a second write", () => {
      const value: Record<string, unknown> = { a: 1, gone: 2 };

      expect(write(value)).toBe('{"a":1,"gone":2}');

      value["a"] = 9;
      delete value["gone"];

      expect(write(value)).toBe('{"a":9}');
    });

    it("shows what an array holds now on a second write", () => {
      const value = [1, 2, 3];

      expect(write(value)).toBe("[1,2,3]");

      value.length = 1;

      expect(write(value)).toBe("[1]");
    });

    it("terminates on a value that holds itself, and keeps every key around it", () => {
      const object: Record<string, unknown> = { a: 1 };

      object["self"] = object;
      object["b"] = 2;

      expect(write(object)).toBe('{"a":1,"self":{"$jsan":"$"},"b":2}');
      expect(write(object)).toBe('{"a":1,"self":{"$jsan":"$"},"b":2}');
    });

    it("writes a value the app holds in two places out twice", () => {
      const shared = { x: 1 };

      expect(write({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    });

    it("never runs an array accessor while looking for the store its value holds", () => {
      const read = vi.fn(() => "ran");
      const list: unknown[] = [1, 2];

      Object.defineProperty(list, 1, { get: read, enumerable: true, configurable: true });

      const $list = atom<unknown>(list);

      register($list, "atom", "$list");

      expect(write($list)).toBe('{"data":[1,{"$jsan":"u"}],"__serializedType__":"store"}');
      expect(read).not.toHaveBeenCalled();
    });

    it("puts the type of a store the copy holds in the key, and its value in bare", () => {
      const $inner = atom(1);

      register($inner, "atom", "$inner");

      expect(write({ inner: $inner })).toBe('{"inner [store]":1}');
    });
  });

  describe("Error", () => {
    it("keeps name, message, stack, cause and its own extra fields", () => {
      const error = Object.assign(new Error("boom", { cause: "why" }), { code: "E42" });

      expect(replacer("e", error)).toEqual({
        data: {
          name: "Error",
          message: "boom",
          stack: expect.any(String),
          cause: "why",
          code: "E42",
        },
        __serializedType__: "Error",
      });
    });

    it("uses the subclass name and leaves cause out when there is none", () => {
      class HttpError extends Error {
        status = 404;

        constructor(message: string) {
          super(message);
          this.name = "HttpError";
        }
      }

      const marked = replacer("e", new HttpError("nope"));

      expect(marked).toEqual({
        data: { name: "HttpError", message: "nope", stack: expect.any(String), status: 404 },
        __serializedType__: "HttpError",
      });
      expect(markedKeys(marked)).not.toContain("cause");
    });

    it("falls back to Error when the constructor name is unreadable", () => {
      const error = new Error("boom");

      Object.defineProperty(error, "constructor", { value: undefined });

      expect(replacer("e", error)).toMatchObject({ __serializedType__: "Error" });
    });

    it("keeps name, message and stack for every place name can sit", () => {
      class HttpError extends Error {}
      class Named extends Error {
        constructor(message: string) {
          super(message);
          this.name = "Named";
        }
      }

      const rows: [Error, string][] = [
        [new Error("boom"), "Error"],
        [new TypeError("boom"), "TypeError"],
        [new HttpError("boom"), "Error"],
        [new Named("boom"), "Named"],
      ];

      for (const [error, name] of rows) {
        expect(markedData(replacer("e", error))).toMatchObject({
          name,
          message: "boom",
          stack: expect.any(String),
        });
      }
    });

    it("keeps a cause the app set to undefined", () => {
      const marked = replacer("e", new Error("boom", { cause: undefined }));

      expect(markedKeys(marked)).toContain("cause");
      expect(markedData(marked)).toMatchObject({ cause: undefined });
    });

    it.each(["name", "message", "cause"])("never calls an own %s getter", (key) => {
      const error = new Error("boom");
      const get = vi.fn(() => "app code ran");

      Object.defineProperty(error, key, { get, configurable: true });

      expect(markedKeys(replacer("e", error))).not.toContain(key);
      expect(get).not.toHaveBeenCalled();
    });

    it.each(["name", "message"])("gives the stack up rather than run a %s getter", (key) => {
      const error = new Error("boom");
      const get = vi.fn(() => "app code ran");

      /** The engine's stack getter builds its first line out of these two. */
      Object.defineProperty(error, key, { get, configurable: true });

      expect(markedKeys(replacer("e", error))).not.toContain("stack");
      expect(get).not.toHaveBeenCalled();
    });

    it("keeps the stack when only cause carries a getter", () => {
      const error = new Error("boom");
      const get = vi.fn(() => "app code ran");

      Object.defineProperty(error, "cause", { get, configurable: true });

      expect(markedData(replacer("e", error))).toMatchObject({ stack: expect.any(String) });
      expect(get).not.toHaveBeenCalled();
    });

    it("never calls a name getter the app put on a prototype", () => {
      class Sneaky extends Error {}

      const get = vi.fn(() => "app code ran");

      Object.defineProperty(Sneaky.prototype, "name", { get, configurable: true });

      expect(markedKeys(replacer("e", new Sneaky("boom")))).not.toContain("name");
      expect(get).not.toHaveBeenCalled();
    });

    it("never calls a message getter the app put on a prototype", () => {
      class Sneaky extends Error {}

      const get = vi.fn(() => "app code ran");

      Object.defineProperty(Sneaky.prototype, "message", { get, configurable: true });

      /** Built with no message, so the instance carries none and the prototype's is what we reach. */
      expect(markedKeys(replacer("e", new Sneaky()))).not.toContain("message");
      expect(get).not.toHaveBeenCalled();
    });

    it("reads a message the app left as a data property on a prototype", () => {
      class Written extends Error {}

      Object.defineProperty(Written.prototype, "message", { value: "written message" });

      expect(markedData(replacer("e", new Written()))).toMatchObject({
        message: "written message",
      });
    });

    it("refuses a stack getter the app wrote on a prototype", () => {
      class Sneaky extends Error {}

      const get = vi.fn(() => "app stack");

      Object.defineProperty(Sneaky.prototype, "stack", { get, configurable: true });

      const error = new Sneaky("boom");

      /** The engine's own accessor shadows the prototype's, so the app's is only reachable here. */
      delete error.stack;

      expect(markedKeys(replacer("e", error))).not.toContain("stack");
      expect(get).not.toHaveBeenCalled();
    });

    it("reads a stack the app left as a data property on a prototype", () => {
      class Written extends Error {}

      Object.defineProperty(Written.prototype, "stack", { value: "written stack" });

      const error = new Written("boom");

      delete error.stack;

      expect(markedData(replacer("e", error))).toMatchObject({ stack: "written stack" });
    });

    it("leaves stack out when the error has none at all", () => {
      const error = new Error("boom");

      delete error.stack;

      expect(markedKeys(replacer("e", error))).not.toContain("stack");
    });
  });

  describe("class instances", () => {
    it("keeps the constructor name and the own enumerable fields", () => {
      expect(replacer("p", new Point())).toEqual({
        data: { x: 1, y: 2 },
        __serializedType__: "Point",
      });
    });

    it("falls back to String(value) when there are no own fields", () => {
      expect(replacer("e", new Empty())).toEqual({
        data: { "(value)": "[object Object]" },
        __serializedType__: "Empty",
      });
    });

    it("leaves out an own method field, and takes the rescue when that is all there was", () => {
      class Cart {
        $total = atom(0);
        clear = (): void => {};
      }

      class Actions {
        run = (): void => {};
      }

      expect(markedKeys(replacer("c", new Cart()))).toEqual(["$total [store]"]);
      expect(replacer("a", new Actions())).toEqual({
        data: { "(value)": "[object Object]" },
        __serializedType__: "Actions",
      });
    });

    it("reads no getter, so a URL takes the String(value) rescue", () => {
      expect(replacer("u", new URL("https://example.com/a?b=1"))).toEqual({
        data: { "(value)": "https://example.com/a?b=1" },
        __serializedType__: "URL",
      });
    });

    it("never calls an own enumerable getter and leaves its key out", () => {
      const value = new Point();
      const get = vi.fn(() => "app code ran");

      Object.defineProperty(value, "trapped", { enumerable: true, get });

      expect(replacer("p", value)).toEqual({
        data: { x: 1, y: 2 },
        __serializedType__: "Point",
      });
      expect(get).not.toHaveBeenCalled();
    });

    it("skips symbol keys rather than walking them", () => {
      const value = new Point();

      Object.defineProperty(value, Symbol("hidden"), { value: 3, enumerable: true });

      expect(replacer("p", value)).toEqual({
        data: { x: 1, y: 2 },
        __serializedType__: "Point",
      });
    });
  });

  describe("typed arrays", () => {
    it("becomes a plain array under its own type name", () => {
      expect(replacer("b", new Uint8Array([1, 2]))).toEqual({
        data: [1, 2],
        __serializedType__: "Uint8Array",
      });
    });

    it("leaves a DataView to the class instance rule, because it has no elements", () => {
      expect(replacer("v", new DataView(new ArrayBuffer(2)))).toEqual({
        data: { "(value)": "[object DataView]" },
        __serializedType__: "DataView",
      });
    });
  });

  describe("BigInt", () => {
    it("becomes a decimal string under (value) and does not throw", () => {
      expect(replacer("n", 9007199254740993n)).toEqual({
        data: { "(value)": "9007199254740993" },
        __serializedType__: "BigInt",
      });
    });
  });

  describe("DOM nodes", () => {
    beforeEach(() => {
      vi.stubGlobal("Node", FakeNode);
    });

    it("shows the opening tag only, with its attributes", () => {
      const node = new HTMLDivElement("DIV", [
        { name: "id", value: "app" },
        { name: "class", value: "root" },
      ]);

      expect(replacer("el", node)).toEqual({
        data: { "(value)": '<div id="app" class="root">' },
        __serializedType__: "HTMLDivElement",
      });
    });

    it("shows a bare tag for a node with no attributes", () => {
      expect(replacer("el", new FakeNode("SPAN"))).toEqual({
        data: { "(value)": "<span>" },
        __serializedType__: "FakeNode",
      });
    });
  });

  describe("the constructor name", () => {
    it("keeps the label for every value the four callers pass", () => {
      vi.stubGlobal("Node", FakeNode);

      class HttpError extends Error {}

      const rows: [unknown, string][] = [
        [new Error("boom"), "Error"],
        [new HttpError("nope"), "HttpError"],
        [new Uint8Array([1, 2]), "Uint8Array"],
        [new HTMLDivElement("DIV"), "HTMLDivElement"],
        [new Point(), "Point"],
      ];

      for (const [value, type] of rows) {
        expect(replacer("k", value)).toMatchObject({ __serializedType__: type });
      }
    });

    it("never calls a getter the app put on constructor, and falls back", () => {
      class Sneaky {
        x = 1;
      }

      const get = vi.fn(() => Point);

      Object.defineProperty(Sneaky.prototype, "constructor", { get });

      expect(replacer("s", new Sneaky())).toEqual({
        data: { x: 1 },
        __serializedType__: "Object",
      });
      expect(get).not.toHaveBeenCalled();
    });

    it("never calls a getter the app put on the constructor's name, and falls back", () => {
      class NameOnly {
        x = 1;
      }

      const get = vi.fn(() => "Sneaky");

      Object.defineProperty(NameOnly, "name", { get });

      expect(replacer("n", new NameOnly())).toEqual({
        data: { x: 1 },
        __serializedType__: "Object",
      });
      expect(get).not.toHaveBeenCalled();
    });

    it("reads past an own constructor getter to the prototype, so the label survives", () => {
      const value = new Point();
      const get = vi.fn(() => Empty);

      Object.defineProperty(value, "constructor", { get });

      expect(replacer("p", value)).toEqual({
        data: { x: 1, y: 2 },
        __serializedType__: "Point",
      });
      expect(get).not.toHaveBeenCalled();
    });

    it("falls back for a value with no prototype left to read a constructor off", () => {
      const bytes = new Uint8Array([1, 2]);

      Object.setPrototypeOf(bytes, null);

      expect(replacer("b", bytes)).toMatchObject({ __serializedType__: "Object" });
    });

    it("takes an own constructor the developer set by hand over the prototype's", () => {
      const value = new Point();

      Object.defineProperty(value, "constructor", { value: Empty });

      expect(replacer("p", value)).toMatchObject({ __serializedType__: "Empty" });
    });
  });

  describe("a store held inside a value", () => {
    it("draws the store's own value under the type its registry entry carries", () => {
      const $inner = atom({ id: 1, name: "city" });

      register($inner, "atom");

      expect(replacer("0", $inner)).toEqual({
        data: { id: 1, name: "city" },
        __serializedType__: "store",
      });
    });

    it("keeps every key a nanostores atom carries out of the snapshot", () => {
      const $inner = atom("Berlin");

      register($inner, "atom");
      $inner.listen(() => {});

      const written = write({ $rows: [$inner] });

      for (const key of [
        "get",
        "init",
        "lc",
        "listen",
        "notify",
        "off",
        "set",
        "subscribe",
        "events",
        "starting",
      ]) {
        expect(written).not.toContain(`"${key}"`);
      }
    });

    it("marks a store in every position a value can hold one", () => {
      class Field {
        $held: Store;

        constructor(store: Store) {
          this.$held = store;
        }
      }

      const $inner = atom("Berlin");

      register($inner, "atom");

      /** A `Map` key is jsan's own half of an entry we could not name, so a store there is wrapped. */
      const wrapped: [string, unknown][] = [["a Map key", new Map([[$inner, "held"]])]];

      for (const [where, holder] of wrapped) {
        expect(unescaped(write(holder)), where).toContain(
          '{"data":{"(value)":"Berlin"},"__serializedType__":"store"}',
        );
      }

      /** A name the app wrote, and a position of ours, are ours to spell, so these take the key. */
      const keyed: [string, unknown, string][] = [
        ["an array member", [$inner], '"[0] [store]":"Berlin"'],
        ["a Map value", new Map([["held", $inner]]), '"["held"] [store]":"Berlin"'],
        ["a Set member", new Set([$inner]), '"[0] [store]":"Berlin"'],
        ["a plain object property", { held: $inner }, '"held [store]":"Berlin"'],
        ["a class instance field", new Field($inner), '"$held [store]":"Berlin"'],
        [
          "an Error's own field",
          Object.assign(new Error("boom"), { held: $inner }),
          '"held [store]":"Berlin"',
        ],
      ];

      for (const [where, holder, drawn] of keyed) {
        expect(unescaped(write(holder)), where).toContain(drawn);
      }
    });

    it("marks a store two levels deep at each level", () => {
      const $leaf = atom("deep");
      const $branch = atom({ $leaf });

      register($leaf, "atom", "$leaf");
      register($branch, "atom", "$branch");

      expect(write({ $branch })).toBe('{"$branch [store]":{"$leaf [store]":"deep"}}');
    });

    it("gives a computed, a map and a deepMap each their own type", () => {
      const $source = atom(1);
      const $computed = computed($source, (value) => value + 1);
      const $map = map({ a: 1 });
      const $deepMap = deepMap({ b: { c: 2 } });
      const stop = $computed.listen(() => {});

      register($computed, "computed", "$computed");
      register($map, "map", "$map");
      register($deepMap, "deepMap", "$deepMap");

      expect(replacer("k", $computed)).toEqual({
        data: { "(value)": 2 },
        __serializedType__: "computed",
      });
      expect(replacer("k", $map)).toEqual({ data: { a: 1 }, __serializedType__: "map" });
      expect(replacer("k", $deepMap)).toEqual({
        data: { b: { c: 2 } },
        __serializedType__: "deepMap",
      });

      stop();
    });

    it("draws a store the registry never saw as a store rather than a plain object", () => {
      const $loose = atom(1);

      $loose.listen(() => {});

      expect(replacer("k", $loose)).toEqual({
        data: { "(value)": 1 },
        __serializedType__: "store",
      });
    });

    it("boxes a value the panel's reviver would not unwrap", () => {
      const $text = atom("Berlin");
      const $nothing = atom<unknown>(null);

      register($text, "atom", "$text");
      register($nothing, "atom", "$nothing");

      expect(replacer("k", $text)).toEqual({
        data: { "(value)": "Berlin" },
        __serializedType__: "store",
      });
      /** `typeof null` is `"object"`, so the reviver would take it and then fail to write to it. */
      expect(replacer("k", $nothing)).toEqual({
        data: { "(value)": null },
        __serializedType__: "store",
      });
    });

    it("never calls a value getter on an object that only looks like a store", () => {
      const get = vi.fn(() => "app code ran");
      const lookalike = { listen: () => () => {}, lc: 1 };

      Object.defineProperty(lookalike, "value", { get, enumerable: true });

      expect(replacer("k", lookalike)).toEqual({
        data: { "(value)": undefined },
        __serializedType__: "store",
      });
      expect(get).not.toHaveBeenCalled();
    });

    it("keeps the note an unmounted store gets at the top level, over the type", () => {
      const $unknown = atom(1);

      register($unknown, "unknown");

      expect(replacer("k", $unknown)).toEqual({
        data: { "(value)": 1 },
        __serializedType__: "not mounted, may be stale",
      });
    });

    it("terminates on a store whose value holds the store itself", () => {
      const $self = atom<unknown>(null);

      register($self, "atom");
      $self.set($self);

      expect(write($self)).toBe('{"data":{"(value)":{"$jsan":"$"}},"__serializedType__":"store"}');
    });

    it("boxes a store its own value holds back, where a bare value would go out as a pointer", () => {
      const shared: Record<string, unknown> = {};
      const $inner = atom<unknown>(shared);

      shared["self"] = $inner;
      register($inner, "atom");

      expect(write(shared)).toBe(
        '{"self":{"data":{"(value)":{"$jsan":"$"}},"__serializedType__":"store"}}',
      );
    });

    it("follows a second store's value to the store it is marking", () => {
      const shared: Record<string, unknown> = {};
      const $outer = atom<unknown>(shared);
      const $middle = atom<unknown>({ back: $outer });

      shared["middle"] = $middle;
      register($outer, "atom", "$outer");
      register($middle, "atom", "$middle");

      expect(markedKeys(replacer("k", $outer))).toEqual(["(value)"]);
    });

    it("leaves two stores holding one plain object bare, with a label on each", () => {
      const shared = { total: 12 };
      const $a = atom(shared);
      const $b = atom(shared);

      register($a, "atom", "$a");
      register($b, "atom", "$b");

      expect(write({ $a, $b })).toBe('{"$a [store]":{"total":12},"$b [store]":{"total":12}}');
    });

    it("boxes a value with more nodes than the walk may look at", () => {
      const $wide = atom(Array.from({ length: MAX_WALKED_NODES + 1 }, () => ({})));

      register($wide, "atom");

      expect(markedKeys(replacer("k", $wide))).toEqual(["(value)"]);
    });

    it("reads no more of a wide array than the walk may look at", () => {
      const wide = Array.from({ length: MAX_WALKED_NODES * 3 }, () => 0);
      let indexReads = 0;
      const counted = new Proxy(wide, {
        getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
          if (String(Number(key)) === key) {
            indexReads += 1;
          }

          return Object.getOwnPropertyDescriptor(target, key);
        },
      });
      const $wide = atom<unknown>(counted);

      register($wide, "atom");

      expect(markedKeys(replacer("k", $wide))).toEqual(["(value)"]);

      /** One past the budget: enough to line up all it may look at, and one more to say it stopped. */
      expect(indexReads).toBe(MAX_WALKED_NODES + 1);
    });

    it("runs no getter the app put on a value while it looks for the store", () => {
      const get = vi.fn(() => "app code ran");
      const value = {};

      Object.defineProperty(value, "hidden", { get, enumerable: true });

      const $held = atom(value);

      register($held, "atom");

      expect(markedData(replacer("k", $held))).toBe(value);
      expect(get).not.toHaveBeenCalled();
    });

    it("ends on a value that comes round to itself without holding the store", () => {
      const value: Record<string, unknown> = { name: "leaf" };

      value["self"] = value;
      value["again"] = { first: value, second: value };

      const $held = atom(value);

      register($held, "atom");

      expect(markedData(replacer("k", $held))).toBe(value);
    });

    it("lets a user serializer matching a store win", () => {
      const custom = createReplacer([{ match: isStore, convert: () => "theirs" }]);
      const $inner = atom(1);

      register($inner, "atom");

      expect(custom("k", $inner)).toBe("theirs");
    });

    it("draws the reported shape: one store holding an array of stores", () => {
      const $first = atom({ id: 1, name: "city", value: "Berlin" });
      const $second = atom({ id: 2, name: "street", value: "Unter den Linden" });
      const $rows = atom([$first, $second]);

      register($first, "atom", "$first");
      register($second, "atom", "$second");
      register($rows, "atom", "$rows");

      expect(write({ $rows })).toBe(
        '{"$rows [store]":{"data":{' +
          '"[0] [store]":{"id":1,"name":"city","value":"Berlin"},' +
          '"[1] [store]":{"id":2,"name":"street","value":"Unter den Linden"}' +
          '},"__serializedType__":"Array"}}',
      );
    });
  });

  describe("what the panel ends up with", () => {
    beforeEach(() => {
      vi.stubGlobal("Node", FakeNode);
    });

    /** The keys the panel shows, which tell a boxed value from a bare one. */
    function drawnKeys(value: unknown): string[] {
      return typeof value === "object" && value !== null ? Object.keys(value) : [];
    }

    /**
     * A store handed straight to the encoder, which is the one place left where a wrapper is the only
     * place a type can go, so the boxing rule below is what keeps the label on. A store at a name the
     * app wrote, or at an array position, takes the key instead, and the two tests at the end of this
     * block are that shape.
     *
     * The round trip is the whole point: the label lives on the object the reviver writes it onto, so
     * a wire shape can be right while the label the developer reads is gone.
     */
    function held(value: unknown): unknown {
      const $held = atom<unknown>(value);

      register($held, "atom", "$held");

      return parsePanel(write($held));
    }

    it("boxes every value that would otherwise arrive with the store's label gone", () => {
      const rows: [string, unknown][] = [
        ["a Date", new Date(0)],
        ["a Map", new Map([["a", 1]])],
        ["a Set", new Set([1])],
        ["a RegExp", /a/],
        ["a typed array", new Uint8Array([1])],
        ["a DOM node", new HTMLDivElement("DIV")],
        ["an Error", new Error("boom")],
        ["a class instance", new Point()],
        ["a store", atom(1)],
        ["a primitive", 12],
        ["null", null],
      ];

      for (const [where, value] of rows) {
        const slot = held(value);

        expect(labelOf(slot), where).toBe("store");
        expect(drawnKeys(slot), where).toEqual(["(value)"]);
      }
    });

    it("keeps the inner label too, where the boxed value carries one of its own", () => {
      const rows: [unknown, string][] = [
        [new Uint8Array([1]), "Uint8Array"],
        [new HTMLDivElement("DIV"), "HTMLDivElement"],
        [new Error("boom"), "Error"],
        [new Point(), "Point"],
        [atom(1), "not mounted, may be stale"],
      ];

      for (const [value, type] of rows) {
        const inside = Reflect.get(Object(held(value)), "(value)");

        expect(labelOf(inside), type).toBe(type);
      }
    });

    it("lets a plain object and an array in bare, with the label in front", () => {
      const cart = held({ total: 12 });
      const items = held(["milk"]);

      expect(labelOf(cart)).toBe("store");
      expect(drawnKeys(cart)).toEqual(["total"]);
      expect(labelOf(items)).toBe("store");
      expect(drawnKeys(items)).toEqual(["0"]);
    });

    it("gives a Date and a RegExp back as themselves inside the box", () => {
      const rows: [unknown, (drawn: unknown) => boolean][] = [
        [new Date(0), (value) => value instanceof Date],
        [/a/, (value) => value instanceof RegExp],
      ];

      for (const [value, isItself] of rows) {
        expect(isItself(Reflect.get(Object(held(value)), "(value)")), String(value)).toBe(true);
      }
    });

    /**
     * A collection we key carries its own label, and two labels cannot sit on one object, so the
     * box is still what keeps the store's own label off it. The reason changed, the shape did not.
     */
    it("keeps a Map and a Set boxed, each one keeping its own label under the store's", () => {
      for (const [value, type] of [
        [new Set([1]), "Set"],
        [new Map([["a", 1]]), "Map"],
      ] as const) {
        const drawn = held(value);

        expect(labelOf(drawn), type).toBe("store");
        expect(labelOf(Reflect.get(Object(drawn), "(value)")), type).toBe(type);
      }
    });

    it("puts the type in the key at a property, so nothing is wrapped and nothing is boxed", () => {
      const $cart = atom<unknown>({ total: 12 });
      const $flag = atom<unknown>(false);

      register($cart, "atom", "$cart");
      register($flag, "atom", "$flag");

      const tree = Object(parsePanel(write({ cart: $cart, flag: $flag })));

      expect(Object.keys(tree)).toEqual(["cart [store]", "flag [store]"]);
      expect(tree["cart [store]"]).toEqual({ total: 12 });
      expect(labelOf(tree["cart [store]"])).toBeUndefined();
      /** The whole point: a primitive arrives as itself, where the box cost it a click before. */
      expect(tree["flag [store]"]).toBe(false);
    });

    it("keeps the marker at a property, with the type still in the key beside it", () => {
      const $total = computed(atom(1), (count) => count + 1);

      register($total, "computed", "$total");

      const tree = Object(parsePanel(write({ total: $total })));

      expect(Object.keys(tree)).toEqual(["total [computed]"]);
      expect(labelOf(tree["total [computed]"])).toBe("not mounted, never computed");
    });
  });

  describe("user serializers", () => {
    it("runs before every rule of ours and the first match wins", () => {
      const custom = createReplacer([
        { match: (value) => value instanceof Point, convert: () => "first" },
        { match: (value) => value instanceof Point, convert: () => "second" },
      ]);

      expect(custom("p", new Point())).toBe("first");
    });

    it("matches primitives as well as objects", () => {
      const custom = createReplacer([{ match: (value) => value === 7, convert: () => "seven" }]);

      expect(custom("n", 7)).toBe("seven");
    });

    it("hands what convert returned to jsan as it is, with no rule of ours on top", () => {
      const custom = createReplacer([
        { match: (value) => value === "big", convert: () => 9007199254740993n },
      ]);

      expect(custom("k", "big")).toBe(9007199254740993n);
    });

    it("falls through to our rules when nothing matches", () => {
      const custom = createReplacer([{ match: () => false, convert: () => "never" }]);

      expect(custom("p", new Point())).toEqual({
        data: { x: 1, y: 2 },
        __serializedType__: "Point",
      });
    });
  });

  describe("a serializer result jsan walks back into", () => {
    it("draws a result holding its own input instead of taking the tree down", () => {
      const custom = createReplacer([
        { match: (value) => value instanceof Point, convert: (value) => ({ point: value }) },
      ]);

      expect(write({ p: new Point() }, custom)).toBe(
        '{"p":{"point":{"data":{"x":1,"y":2},"__serializedType__":"Point"}}}',
      );
    });

    it("draws a result holding its own input two levels down", () => {
      const custom = createReplacer([
        {
          match: (value) => value instanceof Point,
          convert: (value) => ({ outer: { inner: value } }),
        },
      ]);

      expect(write({ p: new Point() }, custom)).toBe(
        '{"p":{"outer":{"inner":{"data":{"x":1,"y":2},"__serializedType__":"Point"}}}}',
      );
    });

    it("draws a result holding its own input inside an array", () => {
      const custom = createReplacer([
        { match: (value) => value instanceof Point, convert: (value) => [value] },
      ]);

      expect(write({ p: new Point() }, custom)).toBe(
        '{"p":[{"data":{"x":1,"y":2},"__serializedType__":"Point"}]}',
      );
    });

    it("draws a result holding its own input inside a Map", () => {
      const custom = createReplacer([
        {
          match: (value) => value instanceof Point,
          convert: (value) => new Map([["point", value]]),
        },
      ]);

      expect(unescaped(write({ p: new Point() }, custom))).toContain(
        '{"data":{"x":1,"y":2},"__serializedType__":"Point"}',
      );
    });

    it("draws a result with none of its input inside exactly as it did before", () => {
      const custom = createReplacer([
        { match: (value) => value instanceof Point, convert: () => ({ theirs: [1, "two"] }) },
      ]);

      expect(write({ p: new Point() }, custom)).toBe('{"p":{"theirs":[1,"two"]}}');
    });

    it("leaves the values inside a result to our rules, not to a later serializer", () => {
      const custom = createReplacer([
        { match: (value) => value instanceof Point, convert: (value) => ({ point: value }) },
        { match: (value) => value instanceof Point, convert: () => "second" },
      ]);

      expect(write({ p: new Point() }, custom)).toBe(
        '{"p":{"point":{"data":{"x":1,"y":2},"__serializedType__":"Point"}}}',
      );
    });

    it("converts the same value again where the app holds it a second time", () => {
      const custom = createReplacer([
        { match: (value) => value instanceof Point, convert: (value) => ({ point: value }) },
      ]);
      const twin = new Point();
      const drawn = '{"point":{"data":{"x":1,"y":2},"__serializedType__":"Point"}}';

      expect(write({ left: twin, right: twin }, custom)).toBe(`{"left":${drawn},"right":${drawn}}`);
    });

    it("keeps a serializer running on a value the next row holds again", () => {
      const custom = createReplacer([
        { match: (value) => value instanceof Point, convert: (value) => ({ point: value }) },
      ]);
      const point = new Point();
      const drawn = '{"p":{"point":{"data":{"x":1,"y":2},"__serializedType__":"Point"}}}';

      expect(write({ p: point }, custom)).toBe(drawn);
      expect(write({ p: point }, custom)).toBe(drawn);
    });

    it("draws the next tree the same way after a result the walk never came back for", async () => {
      const custom = createReplacer([
        {
          match: (value) => value instanceof Point,
          convert: (value) => ({ point: value, toJSON: () => "short" }),
        },
      ]);
      const point = new Point();

      expect(write({ p: point }, custom)).toBe('{"p":"short"}');

      await Promise.resolve();

      expect(write({ p: point }, custom)).toBe('{"p":"short"}');
    });

    it("costs one slot a ConversionError when a result reaches its input through a getter", () => {
      const custom = createReplacer([
        {
          match: (value) => value instanceof Point,
          convert: (value) => ({
            get point(): unknown {
              return value;
            },
          }),
        },
      ]);
      const written = write({ p: new Point(), other: "kept" }, custom);

      expect(written).toContain('"__serializedType__":"ConversionError"');
      expect(written).toContain('"other":"kept"');
      expect(console.warn).toHaveBeenCalled();
    });

    it("costs one slot a ConversionError when such a result also carries a Map", () => {
      const custom = createReplacer([
        {
          match: (value) => value instanceof Point,
          convert: (value) => ({
            seen: new Map([["a", 1]]),
            get point(): unknown {
              return value;
            },
          }),
        },
      ]);
      const written = write({ p: new Point(), other: "kept" }, custom);

      expect(written).toContain('"__serializedType__":"ConversionError"');
      expect(written).toContain('"other":"kept"');
    });
  });

  /**
   * jsan writes a `Map` and a `Set` by walking a list it builds out of them, and it only reaches
   * that far for a collection a serializer of the developer's returned: every one the app holds is
   * keyed here first, so jsan never sees it.
   */
  describe("a Map and a Set, and the list jsan builds out of a serializer's own", () => {
    const arrays: Serializer[] = [{ match: Array.isArray, convert: () => "converted" }];
    const points: Serializer[] = [
      { match: (value) => value instanceof Point, convert: () => "theirs" },
    ];

    it("runs a serializer on a value the app holds inside a Map", () => {
      expect(unescaped(write(new Map([["p", new Point()]]), createReplacer(points)))).toContain(
        '"["p"]":"theirs"',
      );
    });

    it("runs a serializer on a key the app holds inside a Map", () => {
      expect(unescaped(write(new Map([[new Point(), 1]]), createReplacer(points)))).toContain(
        '"[entry 0]":{"[key]":"theirs","[value]":1}',
      );
    });

    it("runs a serializer on a member the app holds inside a Set", () => {
      expect(unescaped(write(new Set([new Point()]), createReplacer(points)))).toContain(
        '"[0]":"theirs"',
      );
    });

    it("runs a serializer on an array the app holds inside a Map", () => {
      expect(unescaped(write(new Map([["a", [1, 2]]]), createReplacer(arrays)))).toContain(
        '"["a"]":"converted"',
      );
    });

    it("runs a serializer on an array the app holds inside a Set", () => {
      expect(unescaped(write(new Set([[1, 2]]), createReplacer(arrays)))).toContain(
        '"[0]":"converted"',
      );
    });

    /**
     * We read both collections into an array of our own on the way to keying them. It never leaves
     * this module, so a serializer of the developer's must never be asked about it.
     */
    it("shows a serializer matching arrays no array of ours", () => {
      const rows: unknown[] = [
        new Map<string, unknown>([["a", 1]]),
        new Set([1, 2]),
        new Map<string, unknown>([["outer", new Map([["inner", 1]])]]),
      ];

      for (const value of rows) {
        expect(write(value, createReplacer(arrays)), String(value)).toBe(write(value));
      }
    });

    it("shows it none inside a Map a store holds either", () => {
      const $held = atom<unknown>(new Map([["a", 1]]));

      register($held, "atom", "$held");

      expect(write({ $held }, createReplacer(arrays))).toBe(write({ $held }));
    });

    it("keeps them off the pairs of a Map a serializer's own result holds", () => {
      const custom = createReplacer([
        {
          match: (value) => value instanceof Point,
          convert: () => new Map<string, unknown>([["a", 1]]),
        },
        ...arrays,
      ]);

      expect(unescaped(write({ p: new Point() }, custom))).toContain('m[["a",1]]');
    });

    it("keeps drawing a Map after a serializer result the walk never came back for", async () => {
      const custom = createReplacer([
        { match: (value) => value === "gone", convert: () => ({ toJSON: () => "short" }) },
        ...arrays,
      ]);
      const value = new Map<string, unknown>([["a", 1]]);

      expect(write({ dropped: "gone", value }, custom)).toContain("short");

      await Promise.resolve();

      expect(write(value, custom)).toBe(write(value));
    });
  });

  describe("a marked value that comes round again", () => {
    it("writes a class instance holding itself instead of taking the tree down", () => {
      class Holder {
        self: unknown = this;
      }

      expect(write(new Holder())).toBe(
        '{"data":{"self":{"$jsan":"$"}},"__serializedType__":"Holder"}',
      );
    });

    it("writes an error whose own field holds the error", () => {
      const error: Error & { own?: unknown } = new Error("boom");

      error.own = error;

      expect(write(error)).toContain('"own":{"$jsan":"$"}');
    });

    /**
     * jsan writes a collection of its own by calling `stringify` again on a list built out of it,
     * and that second call starts a fresh path of its own, so a loop leading back out of the
     * collection is one it cannot see and it walks until the stack ends. Keying both collections
     * keeps the whole tree inside one walk, which is the walk that spots the loop.
     */
    it("writes a loop through a Map or a Set instead of taking the tree down", () => {
      const set = new Set<unknown>();
      const map = new Map<unknown, unknown>();
      const keyed = new Map<unknown, unknown>();
      const holder: Record<string, unknown> = {};

      set.add(set);
      map.set("self", map);
      keyed.set(holder, holder);
      holder["back"] = keyed;

      expect(write(set)).toBe('{"data":{"[0]":{"$jsan":"$"}},"__serializedType__":"Set"}');
      expect(unescaped(write(map))).toBe(
        '{"data":{"["self"]":{"$jsan":"$"}},"__serializedType__":"Map"}',
      );
      /** The key and the value are siblings, so jsan writes the second one again rather than as a
       * pointer, and only the way back up to the collection is one. */
      expect(unescaped(write(keyed))).toBe(
        '{"data":{"[entry 0]":{"[key]":{"back":{"$jsan":"$"}},' +
          '"[value]":{"back":{"$jsan":"$"}}}},"__serializedType__":"Map"}',
      );
    });

    it("terminates on a loop three objects long", () => {
      class Ring {
        next: unknown = null;
      }

      const first = new Ring();
      const second = new Ring();
      const third = new Ring();

      first.next = second;
      second.next = third;
      third.next = first;

      expect(write(first)).toContain('"next":{"$jsan":"$"}');
    });

    it("writes the same instance in two places twice, as it does with no cache at all", () => {
      const twin = new Point();

      expect(write({ left: twin, right: twin })).toBe(
        '{"left":{"data":{"x":1,"y":2},"__serializedType__":"Point"},' +
          '"right":{"data":{"x":1,"y":2},"__serializedType__":"Point"}}',
      );
    });

    it("keeps writing a BigInt, which no cache can hold", () => {
      expect(write({ n: 9007199254740993n })).toBe(
        '{"n":{"data":{"(value)":"9007199254740993"},"__serializedType__":"BigInt"}}',
      );
    });

    it("keeps writing a slot that threw, which no cache can hold either", () => {
      expect(write({ k: throwing() })).toContain('"__serializedType__":"ConversionError"');
    });

    it("hands back one wrapper per value, carrying what the value holds now", () => {
      const point = new Point();
      const first = replacer("a", point);

      point.x = 9;

      const second = replacer("b", point);

      expect(second).toBe(first);
      expect(markedData(second)).toEqual({ x: 9, y: 2 });
    });

    it("shows the second walk's value rather than the first walk's", () => {
      const once = createReplacer([]);
      const point = new Point();
      const first = write(point, once);

      point.x = 9;

      expect(first).toContain('"x":1');
      expect(write(point, once)).toContain('"x":9');
    });

    it("leaves a custom serializer's result out of the cache", () => {
      const custom = createReplacer([
        { match: (value) => value instanceof Point, convert: () => ({ theirs: true }) },
      ]);
      const point = new Point();

      expect(custom("a", point)).not.toBe(custom("b", point));
    });
  });

  describe("ConversionError", () => {
    it("fills the one slot when our own conversion throws", () => {
      expect(replacer("k", throwing())).toEqual({
        data: { "(value)": "nope" },
        __serializedType__: "ConversionError",
      });
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it("fills the one slot when a user match throws", () => {
      const custom = createReplacer([
        {
          match: () => {
            throw new Error("bad match");
          },
          convert: () => "never",
        },
      ]);

      expect(custom("k", 1)).toEqual({
        data: { "(value)": "bad match" },
        __serializedType__: "ConversionError",
      });
    });

    it("fills the one slot when a user convert throws", () => {
      const custom = createReplacer([
        {
          match: () => true,
          convert: () => {
            throw "plain string";
          },
        },
      ]);

      expect(custom("k", 1)).toEqual({
        data: { "(value)": "plain string" },
        __serializedType__: "ConversionError",
      });
    });

    it("warns once per key and keeps converting the rest of the tree", () => {
      replacer("same", throwing());
      replacer("same", throwing());

      expect(console.warn).toHaveBeenCalledTimes(1);

      replacer("other", throwing());

      expect(console.warn).toHaveBeenCalledTimes(2);
      expect(replacer("p", new Point())).toEqual({
        data: { x: 1, y: 2 },
        __serializedType__: "Point",
      });
    });
  });

  it("shortens nothing at any size", () => {
    const long = "x".repeat(50_000);
    const bag = new Point();

    for (let index = 0; index < 500; index += 1) {
      Object.defineProperty(bag, `field${index}`, { value: long, enumerable: true });
    }

    expect(replacer("s", long)).toBe(long);
    expect(markedKeys(replacer("p", bag))).toHaveLength(502);
    expect(markedData(replacer("b", new Uint8Array(10_000)))).toHaveLength(10_000);
  });

  it("emits an object or an array as data for every row of the table", () => {
    vi.stubGlobal("Node", FakeNode);

    const serializers: Serializer[] = [];
    const rows: unknown[] = [
      Object.assign(new Error("boom", { cause: "why" }), { code: "E42" }),
      new Point(),
      new Empty(),
      new Uint8Array([1, 2]),
      9007199254740993n,
      new HTMLDivElement("DIV", [{ name: "id", value: "app" }]),
      throwing(),
    ];

    for (const row of rows) {
      const data = markedData(createReplacer(serializers)("k", row));

      expect(data).toBeTypeOf("object");
      expect(data).not.toBeNull();
    }
  });
});
