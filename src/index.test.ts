import { describe, expect, it } from "vitest";

import { describeSnapshot } from "./index.ts";

describe("describeSnapshot", () => {
  it("prints the store name and its value", () => {
    expect(describeSnapshot({ name: "$counter", value: 1 })).toBe("$counter = 1");
  });

  it("serialises object values", () => {
    expect(describeSnapshot({ name: "$user", value: { id: "u_1" } })).toBe('$user = {"id":"u_1"}');
  });
});
