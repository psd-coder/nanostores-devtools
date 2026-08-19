import { execFile } from "node:child_process";
import { lstat, readFile, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "src/testing/production-fixture.js");
const SELF_LINK = path.join(ROOT, "node_modules/nanostores-devtools");

/** The extension global the bridge reads. A bundle that holds this name holds the bridge. */
const BRIDGE_MARKER = "__REDUX_DEVTOOLS_EXTENSION__";

const SLOW = 120_000;

let linkedHere = false;

beforeAll(async () => {
  await run("pnpm", ["build"], { cwd: ROOT });
  linkedHere = await linkSelf();
}, SLOW);

afterAll(async () => {
  if (linkedHere) {
    await unlink(SELF_LINK);
  }
});

/**
 * Node resolves the package by its own name from inside the repo, but Vite only reads the export
 * map of a package it finds in `node_modules`, so the fixture needs the link an install would make.
 */
async function linkSelf(): Promise<boolean> {
  const present = await lstat(SELF_LINK).then(
    () => true,
    () => false,
  );

  if (present) {
    return false;
  }

  await symlink(ROOT, SELF_LINK, "dir");

  return true;
}

function runNode(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, args, { cwd: ROOT });
}

async function resolveSubpath(subpath: string, conditions: string[] = []): Promise<string> {
  const { stdout } = await runNode([
    ...conditions.map((condition) => `--conditions=${condition}`),
    "--input-type=module",
    "-e",
    `process.stdout.write(import.meta.resolve(${JSON.stringify(subpath)}))`,
  ]);

  return stdout;
}

/**
 * `NODE_ENV` is what decides Vite's `development|production` condition, and vitest sets it to
 * "test", so a build inside a test would otherwise read as neither.
 */
async function bundleFixture(conditions?: string[]): Promise<string> {
  const previous = process.env["NODE_ENV"];

  process.env["NODE_ENV"] = "production";

  try {
    const result = await build({
      root: ROOT,
      configFile: false,
      logLevel: "silent",
      ...(conditions ? { resolve: { conditions } } : {}),
      build: {
        write: false,
        minify: false,
        lib: { entry: FIXTURE, formats: ["es"], fileName: "fixture" },
      },
    });

    /** `build` also answers with a watcher or a single bundle, neither of which this asks for. */
    if (!Array.isArray(result)) {
      throw new Error("vite build did not return a bundle");
    }

    return result[0]?.output[0]?.code ?? "";
  } finally {
    if (previous === undefined) {
      delete process.env["NODE_ENV"];
    } else {
      process.env["NODE_ENV"] = previous;
    }
  }
}

describe("the export map", () => {
  it(
    "points every subpath at a file the tarball carries",
    async () => {
      const { stdout } = await run("pnpm", ["pack", "--dry-run", "--config.ignore-scripts=true"], {
        cwd: ROOT,
      });
      const shipped = new Set(stdout.split("\n"));

      expect(await resolveSubpath("nanostores-devtools")).toMatch(/dist\/index\.mjs$/);
      expect(await resolveSubpath("nanostores-devtools/vite")).toMatch(
        /dist\/discovery\/vite\.mjs$/,
      );
      expect(await resolveSubpath("nanostores-devtools/webpack")).toMatch(
        /dist\/discovery\/webpack\.mjs$/,
      );
      expect(await resolveSubpath("nanostores-devtools/rspack")).toMatch(
        /dist\/discovery\/rspack\.mjs$/,
      );
      expect(await resolveSubpath("nanostores-devtools/runtime")).toMatch(/dist\/runtime\.mjs$/);

      for (const file of [
        "dist/index.mjs",
        "dist/index.d.mts",
        "dist/noop.mjs",
        "dist/discovery/vite.mjs",
        "dist/discovery/vite.d.mts",
        "dist/discovery/webpack.mjs",
        "dist/discovery/webpack.d.mts",
        "dist/discovery/rspack.mjs",
        "dist/discovery/rspack.d.mts",
        "dist/runtime.mjs",
        "dist/runtime.d.mts",
      ]) {
        expect(shipped).toContain(file);
      }
    },
    SLOW,
  );

  it("sends the browser entry to the no-op under the production condition", async () => {
    expect(await resolveSubpath("nanostores-devtools", ["production"])).toMatch(/dist\/noop\.mjs$/);
    expect(await resolveSubpath("nanostores-devtools", ["development"])).toMatch(
      /dist\/index\.mjs$/,
    );
  });

  it("runs the no-op the production condition picked", async () => {
    const { stdout } = await runNode([
      "--conditions=production",
      "--input-type=module",
      "-e",
      `const { connectDevtools } = await import("nanostores-devtools");
       process.stdout.write(String(connectDevtools().connected));`,
    ]);

    expect(stdout).toBe("false");
  });

  it("keeps the plugin's types clear of the optional oxc-parser peer", async () => {
    const types = await readFile(path.join(ROOT, "dist/discovery/vite.d.mts"), "utf8");

    expect(types).not.toContain("oxc-parser");
  });

  /**
   * The two bundlers are no dependency of this package at all, not even an optional peer, so the
   * types each adapter publishes have to name neither one, and unplugin's own types, which do name
   * both, must stay behind the entry.
   */
  it("keeps the webpack and Rspack types clear of every bundler", async () => {
    for (const entry of ["dist/discovery/webpack.d.mts", "dist/discovery/rspack.d.mts"]) {
      const types = await readFile(path.join(ROOT, entry), "utf8");

      expect(types).not.toContain(`from "webpack"`);
      expect(types).not.toContain("@rspack/core");
      expect(types).not.toContain(`from "unplugin"`);
    }
  });
});

describe("importing the package in plain Node", () => {
  it("runs no code and throws nothing", async () => {
    const { stdout, stderr } = await runNode([
      "--input-type=module",
      "-e",
      `await import("nanostores-devtools");
       await import("nanostores-devtools/vite");
       await import("nanostores-devtools/webpack");
       await import("nanostores-devtools/rspack");
       await import("nanostores-devtools/runtime");
       if (globalThis[Symbol.for("nanostores-devtools/v1")] !== undefined) {
         process.stdout.write("the registry was created at import time");
       }`,
    ]);

    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});

describe("a vite build of an app that calls connectDevtools with no guard", () => {
  it(
    "carries none of the bridge",
    async () => {
      const code = await bundleFixture();

      expect(code).not.toContain(BRIDGE_MARKER);
    },
    SLOW,
  );

  it(
    "carries the bridge again once the development condition is asked for",
    async () => {
      const code = await bundleFixture(["module", "browser", "development"]);

      expect(code).toContain(BRIDGE_MARKER);
    },
    SLOW,
  );
});
