import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetDevtoolsGlobal } from "./global.ts";
import { DEFAULT_VALUE_LIMITS, resolveValueLimits } from "./limits.ts";

describe("resolveValueLimits", () => {
  beforeEach(() => {
    resetDevtoolsGlobal();
    vi.spyOn(console, "warn")
      .mockImplementation(() => {})
      .mockClear();
  });

  it("falls back to the two defaults when neither option was passed", () => {
    expect(resolveValueLimits({})).toEqual(DEFAULT_VALUE_LIMITS);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("takes a whole number a walk can be held to, and Infinity for no cap", () => {
    expect(resolveValueLimits({ maxValueDepth: 0, maxValueMembers: 1 })).toEqual({
      maxValueDepth: 0,
      maxValueMembers: 1,
    });
    expect(
      resolveValueLimits({
        maxValueDepth: Number.POSITIVE_INFINITY,
        maxValueMembers: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      maxValueDepth: Number.POSITIVE_INFINITY,
      maxValueMembers: Number.POSITIVE_INFINITY,
    });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("refuses a number that is no count and says what it drew instead", () => {
    expect(resolveValueLimits({ maxValueDepth: -2 })).toEqual(DEFAULT_VALUE_LIMITS);
    expect(console.warn).toHaveBeenCalledWith(
      "[nanostores-devtools] maxValueDepth is -2 in connectDevtools(), which is no number of " +
        "levels, so the bridge draws 5 levels below a class instance instead. Pass a whole " +
        "number of 0 or more, or Infinity for no cap.",
    );
  });

  /** Zero members would draw nothing at all, which is why this one starts at one and depth at zero. */
  it("refuses zero members and every fraction", () => {
    expect(resolveValueLimits({ maxValueDepth: 1.5, maxValueMembers: 0 })).toEqual(
      DEFAULT_VALUE_LIMITS,
    );
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenLastCalledWith(
      "[nanostores-devtools] maxValueMembers is 0 in connectDevtools(), which is no number of " +
        "members, so the bridge draws 100 members below a class instance instead. Pass a whole " +
        "number of 1 or more, or Infinity for no cap.",
    );
  });

  it("warns once per option name, however often a bad one is passed", () => {
    resolveValueLimits({ maxValueDepth: -2, maxValueMembers: -2 });
    resolveValueLimits({ maxValueDepth: -9, maxValueMembers: -9 });

    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
