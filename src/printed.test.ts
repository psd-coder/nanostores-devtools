import { describe, expect, it, vi } from "vitest";

import { printedFields } from "./printed.ts";

describe("printedFields", () => {
  it("reads the toString a URL writes, and nothing else", () => {
    expect(printedFields(new URL("https://a.dev/x?q=1"))).toEqual({
      "(toString)": "https://a.dev/x?q=1",
    });
  });

  it("writes (valueOf) first and (toString) second where a class has both", () => {
    class Money {
      valueOf(): number {
        return 500;
      }

      toString(): string {
        return "$5.00";
      }
    }

    const drawn = printedFields(new Money());

    expect(Object.keys(drawn)).toEqual(["(valueOf)", "(toString)"]);
    expect(drawn["(valueOf)"]).toBe(500);
    expect(drawn["(toString)"]).toBe("$5.00");
  });

  it("refuses the two Object.prototype writes, so a plain instance reads nothing", () => {
    class Empty {}

    expect(printedFields(new Empty())).toEqual({});
  });

  it("refuses a toString behind an accessor, like every other getter", () => {
    const read = vi.fn(() => () => "app code ran");

    class Sneaky {}

    Object.defineProperty(Sneaky.prototype, "toString", { get: read, configurable: true });

    expect(printedFields(new Sneaky())).toEqual({});
    expect(read).not.toHaveBeenCalled();
  });

  it("drops an answer that is no primitive and keeps one that is", () => {
    class Held {
      valueOf(): object {
        return { held: true };
      }

      toString(): string {
        return "held";
      }
    }

    class Counted {
      valueOf(): number {
        return 7;
      }
    }

    expect(printedFields(new Held())).toEqual({ "(toString)": "held" });
    expect(printedFields(new Counted())).toEqual({ "(valueOf)": 7 });
  });

  it("drops an answer of null or undefined, which says nothing", () => {
    class Blank {
      valueOf(): null {
        return null;
      }

      toString(): undefined {
        return undefined;
      }
    }

    expect(printedFields(new Blank())).toEqual({});
  });

  it("gives up the key of a method that throws and keeps the other", () => {
    class Half {
      valueOf(): never {
        throw new Error("refused");
      }

      toString(): string {
        return "still here";
      }
    }

    expect(printedFields(new Half())).toEqual({ "(toString)": "still here" });
  });

  it("finds a toString written straight onto the instance", () => {
    class Tagged {}

    const value = Object.assign(new Tagged(), { toString: () => "on the instance" });

    expect(printedFields(value)).toEqual({ "(toString)": "on the instance" });
  });

  /** The methods are called by name, so a class that publishes only the symbol says nothing. */
  it("reads nothing from a class writing only Symbol.toPrimitive", () => {
    class Primitive {
      [Symbol.toPrimitive](): string {
        return "converted";
      }
    }

    expect(printedFields(new Primitive())).toEqual({});
  });

  /** A symbol is a primitive like any other, and the encoder carries one wherever it sits. */
  it("keeps a symbol answer", () => {
    const tag = Symbol("mine");

    class Tagged {
      valueOf(): symbol {
        return tag;
      }
    }

    expect(printedFields(new Tagged())).toEqual({ "(valueOf)": tag });
  });

  it("keeps a bigint answer, which the converter draws as a node of its own", () => {
    class Big {
      valueOf(): bigint {
        return 900719925474099n;
      }
    }

    expect(printedFields(new Big())).toEqual({ "(valueOf)": 900719925474099n });
  });
});
