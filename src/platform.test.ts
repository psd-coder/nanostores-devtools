import { stringify } from "jsan";
import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetBuiltins } from "./builtins.ts";
import { shippedSerializers } from "./platform.ts";
import { createReplacer } from "./replacer.ts";
import { EXTENSION_OPTIONS, labelOf, parsePanel } from "./testing/panel.ts";

const replacer = createReplacer(shippedSerializers);

describe("shippedSerializers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    forgetBuiltins();
  });

  it("draws a Headers as its header names, where no getter could be read", () => {
    const headers = new Headers({ "content-type": "application/json", "x-trace": "abc" });

    expect(replacer("h", headers)).toEqual({
      data: { "content-type": "application/json", "x-trace": "abc" },
      __serializedType__: "Headers",
    });
  });

  it("draws a FormData as its entries, numbering a name that repeats", () => {
    const form = new FormData();

    form.append("tag", "red");
    form.append("note", "hi");
    form.append("tag", "blue");

    const drawn = replacer("f", form) as { data: Record<string, unknown> };

    expect(Object.keys(drawn.data)).toEqual(["tag", "note", "tag #2"]);
    expect(drawn.data["tag"]).toBe("red");
    expect(drawn.data["tag #2"]).toBe("blue");
  });

  it("draws a URLSearchParams as named keys rather than one query string", () => {
    expect(replacer("q", new URLSearchParams("q=berlin&page=2"))).toEqual({
      data: { q: "berlin", page: "2" },
      __serializedType__: "URLSearchParams",
    });
  });

  /** The route a developer really has one by: `searchParams` is a getter on `URL.prototype`. */
  it("draws the URLSearchParams a URL keeps behind its getter", () => {
    const drawn = replacer("u", new URL("https://example.com/a?q=berlin&page=2")) as {
      data: Record<string, unknown>;
    };

    expect(replacer("s", drawn.data["searchParams"])).toEqual({
      data: { q: "berlin", page: "2" },
      __serializedType__: "URLSearchParams",
    });
  });

  it("says how big a buffer is, which the buffer keeps off its own key list", () => {
    expect(replacer("b", new ArrayBuffer(8))).toEqual({
      data: { byteLength: 8 },
      __serializedType__: "ArrayBuffer",
    });
    expect(replacer("s", new SharedArrayBuffer(16))).toEqual({
      data: { byteLength: 16 },
      __serializedType__: "SharedArrayBuffer",
    });
  });

  it("says how big a DataView is and where it starts", () => {
    expect(replacer("v", new DataView(new ArrayBuffer(8), 2, 4))).toEqual({
      data: { byteLength: 4, byteOffset: 2 },
      __serializedType__: "DataView",
    });
  });

  it("draws a boxed primitive as the primitive, not one key per character", () => {
    expect(replacer("s", new String("berlin"))).toEqual({
      data: { "(value)": "berlin" },
      __serializedType__: "String",
    });
    expect(replacer("n", new Number(42))).toEqual({
      data: { "(value)": 42 },
      __serializedType__: "Number",
    });
    expect(replacer("b", new Boolean(false))).toEqual({
      data: { "(value)": false },
      __serializedType__: "Boolean",
    });
  });

  it("runs no method a subclass overrode", () => {
    const ran = vi.fn();

    class Loud extends Headers {
      override forEach(): void {
        ran();
      }
    }

    expect(replacer("h", new Loud({ "x-trace": "abc" }))).toEqual({
      data: { "x-trace": "abc" },
      __serializedType__: "Headers",
    });
    expect(ran).not.toHaveBeenCalled();
  });

  /**
   * One tree, both rules: the class-instance rule reads `headers` off a built-in getter and this
   * list draws what it handed back. The round trip is here too, so a label the wire drops shows up
   * in this test rather than in the panel.
   */
  it("draws a Headers the getter read handed back, one tree end to end", () => {
    const held = { sent: new Response("hi", { headers: { "x-trace": "abc" } }) };
    const read = parsePanel(stringify(held, replacer, null, EXTENSION_OPTIONS)) as {
      sent: { headers: Record<string, unknown> };
    };

    expect(labelOf(read.sent)).toBe("Response");
    expect(labelOf(read.sent.headers)).toBe("Headers");
    expect(read.sent.headers["x-trace"]).toBe("abc");
  });

  /** A built-in getter still refuses on a detached buffer, and that costs the one slot. */
  it("costs one slot a ConversionError where a built-in getter refuses", () => {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);

    vi.spyOn(console, "warn").mockImplementation(() => {});
    buffer.transfer();

    const drawn = replacer("v", view) as { __serializedType__: string };

    expect(drawn.__serializedType__).toBe("ConversionError");
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("declines rather than throwing where its global is missing", () => {
    const headers = new Headers({ "x-trace": "abc" });

    vi.stubGlobal("Headers", undefined);
    forgetBuiltins();

    expect(replacer("h", headers)).toEqual({
      data: { "(value)": "[object Headers]" },
      __serializedType__: "Headers",
    });
  });
});
