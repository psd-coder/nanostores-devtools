import { describe, expect, it } from "vitest";

import { chainDescriptor, chainValue, ownFields } from "./descriptor.ts";

/** A `Proxy` whose traps throw rather than answer, which is what a hostile value does to a walk. */
function refusing(target: object, trap: "ownKeys" | "getOwnPropertyDescriptor"): object {
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
