import { stringify } from "jsan";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDevtoolsGlobal } from "./global.ts";
import { box, mark } from "./marker.ts";
import { createReplacer, type Serializer } from "./replacer.ts";

/**
 * What `options: true` means to the extension. Its own bundle holds this object and hands it to
 * jsan, so `refs: false` is what a repeated value meets. jsan's own boolean expansion leaves
 * `refs` unset, which turns every repeat into a pointer, and that is not what runs in the panel.
 */
const EXTENSION_OPTIONS = {
  refs: false,
  date: true,
  function: true,
  regex: true,
  undefined: true,
  error: true,
  symbol: true,
  map: true,
  set: true,
  nan: true,
  infinity: true,
};

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
        new Map([["a", 1]]),
        new Set([1, 2]),
        /ab+c/gi,
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Symbol("s"),
        function add(a: number, b: number): number {
          return a + b;
        },
        [1, 2],
        { a: 1 },
        Object.create(null),
        null,
        "text",
        7,
        true,
      ];

      for (const value of values) {
        expect(replacer("k", value)).toBe(value);
      }
    });

    it("leaves a wrapper the snapshot builder already made alone", () => {
      const wrapper = mark("Unmounted", box(1));

      expect(replacer("k", wrapper)).toBe(wrapper);
      expect(replacer("data", wrapper.data)).toBe(wrapper.data);
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
        data: { $$value: "[object Object]" },
        __serializedType__: "Empty",
      });
    });

    it("reads no getter, so a URL takes the String(value) rescue", () => {
      expect(replacer("u", new URL("https://example.com/a?b=1"))).toEqual({
        data: { $$value: "https://example.com/a?b=1" },
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
        data: { $$value: "[object DataView]" },
        __serializedType__: "DataView",
      });
    });
  });

  describe("BigInt", () => {
    it("becomes a decimal string under $$value and does not throw", () => {
      expect(replacer("n", 9007199254740993n)).toEqual({
        data: { $$value: "9007199254740993" },
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
        data: { $$value: '<div id="app" class="root">' },
        __serializedType__: "HTMLDivElement",
      });
    });

    it("shows a bare tag for a node with no attributes", () => {
      expect(replacer("el", new FakeNode("SPAN"))).toEqual({
        data: { $$value: "<span>" },
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

    it("hands what convert returned straight to jsan, never back through our rules", () => {
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
        '{"n":{"data":{"$$value":"9007199254740993"},"__serializedType__":"BigInt"}}',
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
        data: { $$value: "nope" },
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
        data: { $$value: "bad match" },
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
        data: { $$value: "plain string" },
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
