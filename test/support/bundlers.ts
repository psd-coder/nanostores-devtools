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

import type { Apps } from "./apps.ts";

/** What both node bundlers take a plugin as, spelled the way the package publishes it. */
type BundlerPlugin = { apply(compiler: unknown): void };
type PluginFactory<TPlugin> = (options?: object) => TPlugin;

type Mode = "development" | "production";

/** A dev run holds whatever the bundler needs closed once the stores it registered are read. */
export type DevRun = { stop: () => Promise<void> };

export type Bundler = {
  name: string;
  dev: (apps: Apps) => Promise<DevRun>;
  production: (apps: Apps) => Promise<string>;
  /** Words the plugin has to print during a production build. Empty means it has to stay quiet. */
  productionWarnings: string[];
};

const BUNDLE = "bundle.cjs";

/** The plugin under test is the packed one, loaded from the app's own `node_modules`. */
async function pluginFrom<TPlugin>(apps: Apps, subpath: string): Promise<PluginFactory<TPlugin>> {
  const require = createRequire(`${apps.app}/`);
  const loaded = (await import(require.resolve(`nanostores-devtools/${subpath}`))) as {
    nanostoresDevtools: PluginFactory<TPlugin>;
  };

  return loaded.nanostoresDevtools;
}

/** The bundle runs in this process, so the stores it registers land in the shared global registry. */
export function runBundle(apps: Apps, code: string): void {
  const holder = { exports: {} };
  // oxlint-disable-next-line no-new-func -- the bundle is ours, and running a real one is the point
  const load = new Function("module", "exports", "require", code);

  load(holder, holder.exports, createRequire(`${apps.app}/`));
}

export async function startViteServer(apps: Apps): Promise<ViteDevServer> {
  const plugin = await pluginFrom<Plugin>(apps, "vite");

  return createServer({
    configFile: false,
    logLevel: "silent",
    root: apps.app,
    server: { middlewareMode: true },
    plugins: [plugin()],
  });
}

/**
 * Vite loads no plugin in a production build, so the plugin is still handed over: a bundle that
 * carries nothing of it is what proves `apply: "serve"` holds.
 */
async function buildWithVite(apps: Apps): Promise<string> {
  const plugin = await pluginFrom<Plugin>(apps, "vite");
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: apps.app,
    plugins: [plugin()],
    build: {
      write: false,
      minify: false,
      lib: { entry: `${apps.app}/src/entry.js`, formats: ["cjs"], fileName: "app" },
    },
  });
  const bundles = Array.isArray(result) ? result : [result];

  return bundles
    .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
    .map((chunk) => (chunk.type === "chunk" ? chunk.code : ""))
    .join("\n");
}

function config(apps: Apps, subpath: string, mode: Mode, plugin: BundlerPlugin) {
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

/** Both node bundlers answer the same way: an error, a list of errors, or the bundle they wrote. */
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
    done(readFile(`${where}/${BUNDLE}`, "utf8"));
  }
}

async function buildWithWebpack(apps: Apps, mode: Mode): Promise<string> {
  const plugin = await pluginFrom<BundlerPlugin>(apps, "webpack");
  const settings = config(apps, "webpack", mode, plugin());

  return new Promise((done, fail) => {
    webpack(settings, (error, stats) => {
      settle(settings.output.path, error, stats?.toJson({ errors: true }), done, fail);
    });
  });
}

async function buildWithRspack(apps: Apps, mode: Mode): Promise<string> {
  const plugin = await pluginFrom<BundlerPlugin>(apps, "rspack");
  const settings = config(apps, "rspack", mode, plugin());

  return new Promise((done, fail) => {
    rspack(settings, (error, stats) => {
      settle(settings.output.path, error, stats?.toJson({ errors: true }), done, fail);
    });
  });
}

/** A node bundler registers its stores by running its dev bundle in this process. */
function nodeBundler(name: string, bundle: (apps: Apps, mode: Mode) => Promise<string>): Bundler {
  return {
    name,
    async dev(apps) {
      runBundle(apps, await bundle(apps, "development"));

      return { stop: () => Promise.resolve() };
    },
    production: (apps) => bundle(apps, "production"),
    productionWarnings: ["dev-only", "development"],
  };
}

/**
 * Neither node bundler has a dev-only flag of its own, so the plugin refuses a build that is not in
 * development mode and says so out loud. Vite has `apply: "serve"` and stays quiet.
 */
export const BUNDLERS: Bundler[] = [
  {
    name: "Vite",
    /**
     * The SSR run is where a resolution the store file cannot make shows first: Vite hands a bare
     * import to Node, which looks from the file it stands in, and the theme package does not depend
     * on this one.
     */
    async dev(apps) {
      const server = await startViteServer(apps);

      await createServerModuleRunner(server.environments.ssr).import("/src/entry.js");

      return { stop: () => server.close() };
    },
    production: buildWithVite,
    productionWarnings: [],
  },
  nodeBundler("webpack", buildWithWebpack),
  nodeBundler("Rspack", buildWithRspack),
];
