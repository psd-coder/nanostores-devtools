import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDevtoolsGlobal } from "../global.ts";
import { warnOnce } from "./warn.ts";

describe("warnOnce", () => {
  beforeEach(() => {
    resetDevtoolsGlobal();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDevtoolsGlobal();
  });

  it("prefixes the message and uses console.warn", () => {
    warnOnce("clash", "cart/$items", "two stores want cart/$items");

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith("[nanostores-devtools] two stores want cart/$items");
  });

  it("stays quiet on a repeat of the same problem for the same subject", () => {
    warnOnce("clash", "cart/$items", "first");
    warnOnce("clash", "cart/$items", "second");

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith("[nanostores-devtools] first");
  });

  it("speaks again for the same problem on another subject", () => {
    warnOnce("clash", "cart/$items", "first");
    warnOnce("clash", "cart/$count", "second");

    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("speaks again for another problem on the same subject", () => {
    warnOnce("clash", "cart/$items", "first");
    warnOnce("conversion", "cart/$items", "second");

    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
