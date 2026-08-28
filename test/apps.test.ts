import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { rspack } from "@rspack/core";
import {
  build,
  createServer,
  createServerModuleRunner,
  type Plugin,
  type ViteDevServer,
} from "vite";
import webpack from "webpack";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resetDevtoolsGlobal } from "../src/global.ts";
import { listEntries } from "../src/stores/registry.ts";
import { type Apps, installApps } from "./support/apps.ts";

/** Packing, installing and three real builds. */
const SLOW = 120_000;

/** What both bundlers take a plugin as, spelled the way the package publishes it. */
type BundlerPlugin = { apply(compiler: unknown): void };
type PluginFactory<TPlugin> = (options?: object) => TPlugin;

let apps: Apps;

/** The plugin under test is the packed one, loaded from the app's own `node_modules`. */
async function pluginFrom<TPlugin>(subpath: string): Promise<PluginFactory<TPlugin>> {
  const require = createRequire(`${apps.app}/`);
  const loaded = (await import(require.resolve(`nanostores-devtools/${subpath}`))) as {
    nanostoresDevtools: PluginFactory<TPlugin>;
  };

  return loaded.nanostoresDevtools;
}

function names(): string[] {
  return listEntries()
    .map((entry) => entry.name)
    .sort();
}

beforeAll(async () => {
  apps = await installApps();
}, SLOW);

afterAll(async () => {
  await apps.remove();
});

describe("a Vite dev server", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    resetDevtoolsGlobal();

    const plugin = await pluginFrom<Plugin>("vite");

    server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: apps.app,
      server: { middlewareMode: true },
      plugins: [plugin()],
    });
  }, SLOW);

  afterAll(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /**
   * The SSR run is where a resolution the store file cannot make shows first: Vite hands a bare
   * import to Node, which looks from the file it stands in, and the theme package does not depend
   * on this one.
   */
  it("registers the app's stores and the stores of a package beside it", async () => {
    const runner = createServerModuleRunner(server.environments.ssr);

    await runner.import("/src/entry.js");

    expect(names()).toEqual(["$count", "$theme", "$user"]);
  });

  it("serves the browser one runtime, which both store files import", async () => {
    const client = server.environments.client;
    const inside = await client.transformRequest("/src/counter.js");
    const outside = await client.transformRequest(`/@fs${apps.theme}`);
    const imported = /from "([^"]*runtime[^"]*)"/.exec(inside?.code ?? "")?.[1];

    expect(imported).toBeDefined();
    expect(outside?.code).toContain(imported);
    expect(await client.transformRequest(imported ?? "")).not.toBeNull();
  });

  it(
    "carries nothing the plugin injects into a production build",
    async () => {
      const plugin = await pluginFrom<Plugin>("vite");
      const result = await build({
        configFile: false,
        logLevel: "silent",
        root: apps.app,
        plugins: [plugin()],
        build: {
          write: false,
          lib: { entry: `${apps.app}/src/entry.js`, formats: ["es"], fileName: "app" },
        },
      });

      const bundles = Array.isArray(result) ? result : [result];
      const code = bundles
        .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
        .map((chunk) => (chunk.type === "chunk" ? chunk.code : ""))
        .join("\n");

      expect(code).toContain(`"dark"`);
      expect(code).not.toContain("__nsdt");
      expect(code).not.toContain("fileScope");
      expect(code).not.toContain("nanostores-devtools/runtime");
    },
    SLOW,
  );
});

const BUNDLE = "bundle.cjs";

type Mode = "development" | "production";

function config(subpath: string, mode: Mode, plugin: BundlerPlugin) {
  return {
    mode,
    context: apps.app,
    entry: `${apps.app}/src/entry.js`,
    target: "node" as const,
    devtool: false as const,
    optimization: { minimize: false },
    output: { path: `${apps.root}/${subpath}/${mode}`, filename: BUNDLE },
    plugins: [plugin],
  };
}

/** Both bundlers answer the same way: an error, a list of errors, or the bundle they wrote. */
function settle(
  where: string,
  error: Error | null | undefined,
  report: { errors?: unknown[] | undefined } | undefined,
  done: (bundle: Promise<string>) => void,
  fail: (reason: Error) => void,
): void {
  const errors = (report?.errors ?? []).map((problem) => JSON.stringify(problem));

  if (error) {
    fail(error);
  } else if (errors.length > 0) {
    fail(new Error(errors.join("\n")));
  } else {
    done(readFile(`${apps.root}/${where}/${BUNDLE}`, "utf8"));
  }
}

function buildWithWebpack(mode: Mode, plugin: BundlerPlugin): Promise<string> {
  return new Promise((done, fail) => {
    webpack(config("webpack", mode, plugin), (error, stats) => {
      settle(`webpack/${mode}`, error, stats?.toJson({ errors: true }), done, fail);
    });
  });
}

function buildWithRspack(mode: Mode, plugin: BundlerPlugin): Promise<string> {
  return new Promise((done, fail) => {
    rspack(config("rspack", mode, plugin), (error, stats) => {
      settle(`rspack/${mode}`, error, stats?.toJson({ errors: true }), done, fail);
    });
  });
}

/** The bundle runs in this process, so the stores it registers land in the registry read above. */
function runBundle(code: string): void {
  const holder = { exports: {} };
  // oxlint-disable-next-line no-new-func -- the bundle is ours, and running a real one is the point
  const load = new Function("module", "exports", "require", code);

  load(holder, holder.exports, createRequire(`${apps.app}/`));
}

const BUNDLERS = [
  { name: "webpack", subpath: "webpack", build: buildWithWebpack },
  { name: "Rspack", subpath: "rspack", build: buildWithRspack },
];

describe.each(BUNDLERS)("a $name dev build", ({ subpath, build: bundleWith }) => {
  beforeAll(async () => {
    resetDevtoolsGlobal();

    const plugin = await pluginFrom<BundlerPlugin>(subpath);

    runBundle(await bundleWith("development", plugin()));
  }, SLOW);

  afterAll(() => {
    resetDevtoolsGlobal();
  });

  it("registers the app's stores and the stores of a package beside it", () => {
    expect(names()).toEqual(["$count", "$theme", "$user"]);
  });
});

/**
 * Neither bundler has a dev-only flag of its own, so the plugin refuses a build that is not in
 * development mode. Nothing it injects may reach a shipped bundle, and nothing may register when
 * one runs.
 */
describe.each(BUNDLERS)("a $name production build", ({ subpath, build: bundleWith }) => {
  let bundle: string;
  let warnings: string[];

  beforeAll(async () => {
    resetDevtoolsGlobal();
    warnings = [];

    const plugin = await pluginFrom<BundlerPlugin>(subpath);
    const warn = vi.spyOn(console, "warn").mockImplementation((message: string) => {
      warnings.push(message);
    });

    try {
      bundle = await bundleWith("production", plugin());
    } finally {
      warn.mockRestore();
    }
  }, SLOW);

  afterAll(() => {
    resetDevtoolsGlobal();
  });

  it("says out loud that it did nothing", () => {
    expect(warnings.join("\n")).toContain("dev-only");
    expect(warnings.join("\n")).toContain("development");
  });

  it("carries the app's own stores and nothing of the plugin's", () => {
    expect(bundle).toContain(`"dark"`);
    expect(bundle).not.toContain("__nsdt");
    expect(bundle).not.toContain("fileScope");
    expect(bundle).not.toContain("nanostores-devtools/runtime");
  });

  it("registers nothing when it runs", () => {
    runBundle(bundle);

    expect(names()).toEqual([]);
  });
});
