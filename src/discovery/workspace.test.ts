import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findWorkspaceRoot, climbToWorkspaceRoot } from "./workspace.ts";

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

describe("climbToWorkspaceRoot", () => {
  it("climbs to the file that marks the workspace, the way vite does", () => {
    expect(climbToWorkspaceRoot(`${process.cwd()}/src/discovery`)).toBe(process.cwd());
  });
});

describe("climbToWorkspaceRoot on a tree of its own", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "nanostores-devtools-roots-"));

    await mkdir(path.join(root, "repo/apps/web/src"), { recursive: true });
    await mkdir(path.join(root, "alone/src"), { recursive: true });
    await writeFile(path.join(root, "repo/package.json"), `{"workspaces":["apps/*"]}`);
    await writeFile(path.join(root, "repo/apps/web/package.json"), `{"name":"web"}`);
    await writeFile(path.join(root, "alone/package.json"), `{"name":"alone"}`);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("takes the package holding workspaces, not the nearest one", () => {
    expect(climbToWorkspaceRoot(path.join(root, "repo/apps/web"))).toBe(path.join(root, "repo"));
  });

  it("takes the nearest package when nothing above it marks a workspace", () => {
    expect(climbToWorkspaceRoot(path.join(root, "alone/src"))).toBe(path.join(root, "alone"));
  });
});
