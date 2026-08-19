import { describe, expect, it } from "vitest";

import { findWorkspaceRoot } from "./workspace.ts";

const ROOT = "/repo/apps/web";

describe("findWorkspaceRoot", () => {
  it("asks vite, which climbs to the file that marks the workspace", async () => {
    await expect(findWorkspaceRoot(`${process.cwd()}/src/discovery`)).resolves.toBe(process.cwd());
  });

  it("falls back to the Vite root when vite cannot be loaded", async () => {
    const missing = () => Promise.reject(new Error("Cannot find package 'vite'"));

    await expect(findWorkspaceRoot(ROOT, missing)).resolves.toBe(ROOT);
  });

  it("falls back to the Vite root when vite stopped exporting the search", async () => {
    const older = () => Promise.resolve({ createServer: () => {} });

    await expect(findWorkspaceRoot(ROOT, older)).resolves.toBe(ROOT);
  });

  it("takes what the search returns", async () => {
    const fake = () => Promise.resolve({ searchForWorkspaceRoot: () => "/repo" });

    await expect(findWorkspaceRoot(ROOT, fake)).resolves.toBe("/repo");
  });
});
