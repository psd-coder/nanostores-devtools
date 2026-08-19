import { describe, expect, it } from "vitest";

import { makeLabel, qualify } from "./labels.ts";

describe("makeLabel", () => {
  it("joins the home and the name with a slash", () => {
    expect(makeLabel("src/stores/cart.ts", "$items")).toBe("src/stores/cart.ts/$items");
  });
});

describe("qualify", () => {
  it("reads the file, then the function, then the line, in one group", () => {
    expect(
      qualify("$history", {
        file: "vendor/withUndo.ts",
        place: "createPanel, line 20",
        number: 1,
      }),
    ).toBe("$history (vendor/withUndo.ts, createPanel, line 20)");
  });

  it("shows only the parts there are", () => {
    expect(qualify("$counter", { file: null, place: "line 20", number: 1 })).toBe(
      "$counter (line 20)",
    );
    expect(qualify("$counter", { file: "app.ts", place: null, number: 1 })).toBe(
      "$counter (app.ts)",
    );
    expect(qualify("$count", { file: null, place: null, number: 1 })).toBe("$count");
  });

  it("puts the number last, spaced, and leaves the first store of a site without one", () => {
    expect(qualify("$items", { file: null, place: null, number: 1 })).toBe("$items");
    expect(qualify("$items", { file: null, place: "line 3", number: 3 })).toBe(
      "$items (line 3) #3",
    );
  });

  it("takes the head it is given, so a tree key and a label read the same parts", () => {
    const parts = { file: "app.ts", place: null, number: 2 };

    expect(qualify("$counter [store]", parts)).toBe("$counter [store] (app.ts) #2");
    expect(qualify("$counter", parts)).toBe("$counter (app.ts) #2");
  });
});
