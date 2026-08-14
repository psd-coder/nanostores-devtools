import { describe, expect, it, vi } from "vitest";

import { chainDescriptor, chainValue, ownFields, ownIndexes } from "./descriptor.ts";

/** A `Proxy` whose traps throw rather than answer, which is what a hostile value does to a walk. */
function refusing<T extends object>(target: T, trap: "ownKeys" | "getOwnPropertyDescriptor"): T {
  return new Proxy(target, {
    [trap]: (): never => {
      throw new Error(`the ${trap} trap ran`);
    },
  });
}

describe("ownFields", () => {
  it("reads the own enumerable data keys a value gives up", () => {
    expect(ownFields({ open: true, width: 2 })).toEqual({ open: true, width: 2 });
  });

  it("takes nothing from a value whose ownKeys trap throws", () => {
    expect(ownFields(refusing({ open: true }, "ownKeys"))).toEqual({});
  });

  it("takes nothing from a value whose getOwnPropertyDescriptor trap throws", () => {
    expect(ownFields(refusing({ open: true }, "getOwnPropertyDescriptor"))).toEqual({});
  });

  it("keeps no half of a value that answered one key and refused the next", () => {
    const held = new Proxy(
      { open: true, width: 2 },
      {
        getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
          if (key === "width") {
            throw new Error("a trap ran");
          }

          return Object.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    expect(ownFields(held)).toEqual({});
  });

  it("reads a Proxy that answers both traps exactly as the object under it", () => {
    const held = new Proxy({ open: true }, {});

    expect(ownFields(held)).toEqual({ open: true });
  });
});

describe("ownIndexes", () => {
  it("copies every index the array holds", () => {
    expect(ownIndexes([1, "two", null])).toEqual([1, "two", null]);
  });

  it("leaves an accessor index as a hole and never runs it", () => {
    const read = vi.fn(() => "ran");
    const value = [1, 2];

    Object.defineProperty(value, 0, { get: read, enumerable: true, configurable: true });

    const copy = ownIndexes(value);

    expect(0 in copy).toBe(false);
    expect(copy).toHaveLength(2);
    expect(copy[1]).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps a hole a hole and ignores a key that is not an index", () => {
    const value = [1];

    value.length = 3;
    Object.assign(value, { note: "aside" });

    expect(ownIndexes(value)).toEqual([1, undefined, undefined]);
    expect(ownIndexes(value)).not.toHaveProperty("note");
  });

  it("reads length through its descriptor, so a get trap never runs", () => {
    const read = vi.fn(() => 99);
    const value = new Proxy([1], { get: read });

    expect(ownIndexes(value)).toEqual([1]);
    expect(read).not.toHaveBeenCalled();
  });

  it("takes nothing from a value whose getOwnPropertyDescriptor trap throws", () => {
    expect(ownIndexes(refusing([1], "getOwnPropertyDescriptor"))).toEqual([]);
  });

  it("takes nothing from a value that answers a length no array can have", () => {
    const held = new Proxy([1], {
      getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
        return key === "length"
          ? { value: -1, writable: true, enumerable: false, configurable: false }
          : Object.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(ownIndexes(held)).toEqual([]);
  });

  it("keeps no half of an array that answered one index and refused the next", () => {
    const held = new Proxy([1, 2], {
      getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
        if (key === "1") {
          throw new Error("a trap ran");
        }

        return Object.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(ownIndexes(held)).toEqual([]);
  });
});

describe("chainDescriptor", () => {
  it("finds the first descriptor up the prototype chain", () => {
    expect(chainDescriptor(Object.create({ open: true }), "open")?.value).toBe(true);
  });

  it("answers nothing for a value whose getOwnPropertyDescriptor trap throws", () => {
    const held = refusing({ open: true }, "getOwnPropertyDescriptor");

    expect(chainDescriptor(held, "open")).toBeUndefined();
    expect(chainValue(held, "open")).toBeUndefined();
  });

  it("answers nothing for a revoked Proxy, whose every read throws", () => {
    const { proxy, revoke } = Proxy.revocable({ open: true }, {});

    revoke();

    expect(chainDescriptor(proxy, "open")).toBeUndefined();
    expect(chainValue(proxy, "open")).toBeUndefined();
  });
});
