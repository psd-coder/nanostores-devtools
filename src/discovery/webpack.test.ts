import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rspack } from "@rspack/core";
import * as nanostores from "nanostores";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpack from "webpack";

import { resetDevtoolsGlobal } from "../global.ts";
import { connectDevtools } from "../redux/connect.ts";
import { listEntries, type StoreEntry } from "../stores/registry.ts";
import * as runtime from "../runtime.ts";
import { type FakeExtension, installFakeExtension } from "../testing/fake-extension.ts";
import type { BundlerPlugin } from "./bundler.ts";
import { nanostoresDevtools as rspackDevtools } from "./rspack.ts";
import { webpackHotReload, webpackId } from "./webpack-like.ts";
import { nanostoresDevtools as webpackDevtools } from "./webpack.ts";

describe("webpackHotReload", () => {
  it("spells the hot handle webpack gives a module and the hook a removed one gets", () => {
    expect(webpackHotReload("__nsdt.clear();")).toBe(
      "if (import.meta.webpackHot) import.meta.webpackHot.dispose(() => { __nsdt.clear(); });",
    );
  });
});

describe("webpackId", () => {
  it("turns a Windows path into the one shape discovery reads", () => {
    expect(webpackId("C:\\repo\\src\\app.ts")).toBe("C:/repo/src/app.ts");
    expect(webpackId("/repo/src/app.ts")).toBe("/repo/src/app.ts");
  });

  it("drops what webpack marks as synthetic instead of writing a path", () => {
    expect(webpackId("data:text/javascript,export const a = 1")).toBeUndefined();
    expect(webpackId("babel-loader!/repo/src/app.ts")).toBeUndefined();
    expect(webpackId("/repo/_virtual_%2Fvirtual%3Amine.ts")).toBeUndefined();
  });
});

/**
 * The blank line and the type argument are the whole point of the file: a plugin running a step too
 * late would read `$count` on line 3 of a file the strip loader below had already rewritten.
 */
const APP =
  `import { atom } from "nanostores";\n` +
  `import { persistentAtom } from "./factory.ts";\n` +
  `\n` +
  `export const $count = atom<number>(0);\n` +
  `\n` +
  `// @nanostores-devtools:throttle 250\n` +
  `export const $ticks = atom(0);\n` +
  `\n` +
  `export const $theme = persistentAtom("theme", "dark");\n`;

const FACTORY =
  `import { atom } from "nanostores";\n` +
  `export function persistentAtom(key, initial) {\n` +
  `  return atom(initial);\n` +
  `}\n`;

/**
 * What a real TypeScript loader does to a file, in the two ways that matter here: the type arguments
 * go and the blank lines close up. webpack has no TypeScript step of its own, so the fixture carries
 * one, and `enforce: "pre"` is what has to put our own walk in front of it.
 */
const STRIP_LOADER =
  `module.exports = function stripTypes(source) {\n` +
  `  return source.replace(/<[A-Za-z0-9_$\\[\\]{}|,. ]+>\\(/g, "(").replace(/\\n[ \\t]*\\n/g, "\\n");\n` +
  `};\n`;

const ENTRY = "app.ts";
const HOME = "app.ts";
const BUNDLE = "bundle.js";

let fixture: string;

beforeAll(async () => {
  /** macOS hands out a symlinked temp directory, and webpack reports the path it resolves to. */
  fixture = await realpath(await mkdtemp(path.join(tmpdir(), "nanostores-devtools-")));

  await writeFile(path.join(fixture, ENTRY), APP);
  await writeFile(path.join(fixture, "factory.ts"), FACTORY);
  await writeFile(path.join(fixture, "strip.cjs"), STRIP_LOADER);
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

/** The third one is a config that names no mode at all, which both bundlers read as production. */
type Build = "development" | "production" | "unset";

function shared(build: Build, plugin: BundlerPlugin) {
  return {
    ...(build === "unset" ? {} : { mode: build }),
    context: fixture,
    entry: path.join(fixture, ENTRY),
    target: "node" as const,
    devtool: false as const,
    optimization: { minimize: false },
    externals: {
      nanostores: "commonjs nanostores",
      "nanostores-devtools/runtime": "commonjs nanostores-devtools/runtime",
    },
    module: {
      rules: [{ test: /\.ts$/, use: [{ loader: path.join(fixture, "strip.cjs") }] }],
    },
    output: { path: path.join(fixture, build), filename: BUNDLE },
    plugins: [plugin],
  };
}

function readBundle(build: Build): Promise<string> {
  return readFile(path.join(fixture, build, BUNDLE), "utf8");
}

/** Both bundlers answer the same way, so both hand their answer to this: it fails, or it warns. */
function settle(
  error: Error | null | undefined,
  report: { errors?: unknown[] | undefined; warnings?: unknown[] | undefined } | undefined,
  done: (warnings: string[]) => void,
  fail: (reason: Error) => void,
): void {
  const errors = (report?.errors ?? []).map((problem) => JSON.stringify(problem));

  if (error) {
    fail(error);
  } else if (errors.length > 0) {
    fail(new Error(errors.join("\n")));
  } else {
    done((report?.warnings ?? []).map((warning) => JSON.stringify(warning)));
  }
}

function buildWithWebpack(build: Build): Promise<string[]> {
  return new Promise((done, fail) => {
    webpack(shared(build, webpackDevtools()), (error, stats) => {
      settle(error, stats?.toJson({ errors: true, warnings: true }), done, fail);
    });
  });
}

function buildWithRspack(build: Build): Promise<string[]> {
  return new Promise((done, fail) => {
    rspack(shared(build, rspackDevtools()), (error, stats) => {
      settle(error, stats?.toJson({ errors: true, warnings: true }), done, fail);
    });
  });
}

/**
 * The bundle runs in this process, so the runtime it registers through is the very module this file
 * imported and the registry it writes to is the one the assertions read. Running it a second time
 * gives the module body a second execution, which is what a hot reload is.
 */
function runBundle(code: string): void {
  const externals: Record<string, unknown> = {
    nanostores,
    "nanostores-devtools/runtime": runtime,
  };
  const holder = { exports: {} };

  // oxlint-disable-next-line no-new-func -- the bundle is ours, and a real one is the whole point
  const load = new Function("module", "exports", "require", "__dirname", "__filename", code);

  load(
    holder,
    holder.exports,
    (id: string) => {
      const found = externals[id];

      if (found === undefined) {
        throw new Error(`the bundle asked for ${id}, which the fixture does not supply`);
      }

      return found;
    },
    fixture,
    path.join(fixture, BUNDLE),
  );
}

function entryNamed(name: string): StoreEntry | undefined {
  return listEntries().find((entry) => entry.name === name);
}

const BUNDLERS = [
  { name: "webpack", build: buildWithWebpack },
  { name: "rspack", build: buildWithRspack },
];

const SLOW = 60_000;

describe.each(BUNDLERS)("a $name dev build", ({ build }) => {
  let bundle: string;
  let warnings: string[];
  let fake: FakeExtension;

  beforeAll(async () => {
    warnings = await build("development");
    bundle = await readBundle("development");
  }, SLOW);

  beforeEach(() => {
    resetDevtoolsGlobal();
    fake = installFakeExtension();
  });

  afterEach(() => {
    fake.uninstall();
    vi.restoreAllMocks();
    resetDevtoolsGlobal();
  });

  it("draws no warning from the bundler, which `import.meta.hot` would have", () => {
    expect(warnings).toEqual([]);
  });

  it("records the line the developer wrote, under a blank line and a type argument", () => {
    expect(bundle).toMatch(/"name":"\$count","line":4,"type":"atom"/);
  });

  it("keeps the rate a throttle comment named", () => {
    expect(bundle).toMatch(/"name":"\$ticks","line":7,"type":"atom","throttle":250/);
  });

  it("puts every store under the file that made it, with its own name and type", () => {
    runBundle(bundle);

    expect(entryNamed("$count")).toMatchObject({
      home: HOME,
      label: `${HOME}/$count`,
      type: "atom",
      origin: "plugin",
      external: false,
    });
    expect(entryNamed("$ticks")).toMatchObject({ home: HOME, type: "atom" });
  });

  it("adopts what a factory in another file handed back", () => {
    runBundle(bundle);

    expect(entryNamed("$theme")).toMatchObject({ home: HOME, type: "atom", origin: "plugin" });
    expect(listEntries()).toHaveLength(3);
  });

  it("holds the store to the rate its comment named", () => {
    runBundle(bundle);

    expect(entryNamed("$ticks")?.throttle).toMatchObject({ commented: true, period: 250 });
  });

  it("clears and re-registers on a second run of the module body, in one hot-reload row", async () => {
    runBundle(bundle);
    connectDevtools({ name: "fixture" });

    await Promise.resolve();
    fake.start();

    runBundle(bundle);

    await Promise.resolve();

    expect(fake.sends.map((call) => call.action.type)).toEqual([`${HOME}/hotReload`]);
    expect(listEntries()).toHaveLength(3);
  });
});

/**
 * A config naming no mode is the one that would slip past a refusal reading `mode === "production"`:
 * both bundlers build it as a production one, and both would then ship the injected import.
 */
describe.each(BUNDLERS)("a $name build outside development", ({ build }) => {
  it.each(["production", "unset"] as const)(
    "refuses a build with mode %s, out loud, and injects nothing into it",
    async (mode) => {
      const warnings: string[] = [];

      vi.spyOn(console, "warn").mockImplementation((message: string) => {
        warnings.push(message);
      });

      try {
        await build(mode);
      } finally {
        vi.restoreAllMocks();
      }

      const bundle = await readBundle(mode);

      expect(bundle).toContain("nanostores");
      expect(bundle).not.toContain("__nsdt");
      expect(bundle).not.toContain("nanostores-devtools/runtime");
      expect(warnings.join("\n")).toContain("dev-only");
      expect(warnings.join("\n")).toContain("development");
    },
    SLOW,
  );
});
