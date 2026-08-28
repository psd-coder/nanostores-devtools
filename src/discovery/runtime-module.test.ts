import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ownRuntimePath } from "./runtime-module.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url))
  .replaceAll("\\", "/")
  .replace(/\/$/, "");

describe("ownRuntimePath", () => {
  it("names the runtime beside the adapters, and the file is there", () => {
    expect(ownRuntimePath()).toBe(`${HERE.slice(0, -"/discovery".length)}/runtime.ts`);
    expect(existsSync(ownRuntimePath() ?? "")).toBe(true);
  });
});
