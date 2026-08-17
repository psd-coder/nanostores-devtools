import { stringify } from "jsan";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shippedSerializers } from "./platform.ts";
import { createReplacer } from "./replacer.ts";
import { EXTENSION_OPTIONS, labelOf, parsePanel } from "./testing/panel.ts";

const replacer = createReplacer(shippedSerializers);

describe("shippedSerializers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  /** The route a developer really has one by, read by the app rather than by the bridge. */
  it("draws the URLSearchParams a URL handed the app", () => {
    const url = new URL("https://example.com/a?q=berlin&page=2");

    expect(replacer("s", url.searchParams)).toEqual({
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
   * The round trip is here, so a label the wire drops shows up in this test rather than in the
   * panel.
   */
  it("draws a Headers the app holds, one tree end to end", () => {
    const held = { sent: new Headers({ "x-trace": "abc" }) };
    const read = parsePanel(stringify(held, replacer, null, EXTENSION_OPTIONS)) as {
      sent: Record<string, unknown>;
    };

    expect(labelOf(read.sent)).toBe("Headers");
    expect(read.sent["x-trace"]).toBe("abc");
  });

  /**
   * A rule of the developer's already ran over the tree it built, so no serializer meets a value
   * inside that result, ours included, and a `Headers` there falls to the class-instance rule with
   * nothing of its own to draw.
   */
  it("leaves a Headers inside a serializer's result to the class-instance rule", () => {
    const own = createReplacer([
      {
        match: (value) => value === "the app's own value",
        convert: () => ({ sent: new Headers({ "x-trace": "abc" }) }),
      },
      ...shippedSerializers,
    ]);
    const drawn = own("r", "the app's own value") as { sent: unknown };

    expect(own("s", drawn.sent)).toEqual({ data: {}, __serializedType__: "Headers" });
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

    expect(replacer("h", headers)).toEqual({ data: {}, __serializedType__: "Headers" });
  });
});
