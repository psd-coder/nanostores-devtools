import { describe, expect, it } from "vitest";

import { resolveStoreCap } from "./core.ts";

describe("resolveStoreCap", () => {
  it("keeps a whole number of one or more, and Infinity, which is no cap at all", () => {
    expect(resolveStoreCap(1)).toEqual({ cap: 1, warning: undefined });
    expect(resolveStoreCap(50)).toEqual({ cap: 50, warning: undefined });
    expect(resolveStoreCap(Number.POSITIVE_INFINITY)).toEqual({
      cap: Number.POSITIVE_INFINITY,
      warning: undefined,
    });
  });

  it("takes the default without a warning when the option is unset", () => {
    expect(resolveStoreCap(undefined)).toEqual({ cap: 50, warning: undefined });
  });

  it("refuses every number no store count can be made of, and names option and value", () => {
    for (const value of [-1, 0, 2.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const { cap, warning } = resolveStoreCap(value);

      expect(cap).toBe(50);
      expect(warning).toContain("maxStoresPerSite");
      expect(warning).toContain(String(value));
    }
  });
});
