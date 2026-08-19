import process from "node:process";

import type { UnpluginContextMeta, UnpluginFactory } from "unplugin";

import type { BundlerPluginOptions } from "./bundler.ts";
import { createDiscovery, type Discovery } from "./core.ts";
import type { ModuleKeys } from "./module-keys.ts";
import { loadParser } from "./parser.ts";
import { climbToWorkspaceRoot } from "./workspace.ts";

const RUNTIME_MODULE = "nanostores-devtools/runtime";

function refusal(mode: string | undefined): string {
  return (
    `nanostores-devtools is a dev-only plugin and did nothing: this build has mode ` +
    `${mode ?? "unset"}, and it runs under mode "development" alone. Add it to your development ` +
    `config, so nothing it injects can reach a shipped bundle.`
  );
}

/**
 * `import.meta.hot` warns under webpack, which spells the same handle `import.meta.webpackHot` and
 * offers no `prune`. `dispose` is the nearest: it runs for every module an update replaces or
 * removes, and it runs before the new body does, so its clear cannot wipe a re-registration.
 */
export function webpackHotReload(clear: string): string {
  return `if (import.meta.webpackHot) import.meta.webpackHot.dispose(() => { ${clear} });`;
}

/** An absolute path, in either the POSIX spelling or a Windows one with a drive letter. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:\/)/;

/**
 * webpack hands over the platform's own path, so Windows gives `\`, and it marks a synthetic module
 * with no `\0` of its own. What it does instead is stop writing a path: a data URI, a loader chain
 * and its own runtime modules are all requests rather than files, and unplugin puts a virtual module
 * in a `_virtual_` directory under the context. Discovery only ever wants a file on disk.
 */
export function webpackId(resource: string): string | undefined {
  const id = resource.replaceAll("\\", "/");

  if (!ABSOLUTE.test(id) || id.includes("/_virtual_")) {
    return undefined;
  }

  return id;
}

/** The two things a compiler is asked, spelled the same way by webpack and by Rspack. */
type BundlerConfig = { mode?: string | undefined; context?: string | undefined };

function bundlerConfig(meta: UnpluginContextMeta): BundlerConfig {
  if (meta.framework === "webpack") {
    return meta.webpack.compiler.options;
  }

  if (meta.framework === "rspack") {
    return meta.rspack.compiler.options;
  }

  return {};
}

/**
 * Vite says `apply: "serve"` and is never loaded by a build. webpack has no such flag, so the
 * refusal is ours to write, and `mode` is what it reads. It has to be a yes list rather than a no
 * list: webpack and Rspack both read an unset `mode` as production, so anything but `development`
 * may ship. A refusal says so once and out loud, because the id gate below fails closed, and a
 * silent skip would leave the developer looking for a plugin that never ran.
 */
function startDiscovery(
  options: BundlerPluginOptions,
  meta: UnpluginContextMeta,
): Discovery | undefined {
  const { mode, context } = bundlerConfig(meta);

  if (mode !== "development") {
    console.warn(refusal(mode));

    return undefined;
  }

  const root = (context ?? process.cwd()).replaceAll("\\", "/");

  return createDiscovery({
    ...options,
    roots: { root, projectRoot: climbToWorkspaceRoot(root) },
    loadParser,
    runtimeModule: RUNTIME_MODULE,
    hotReload: webpackHotReload,
  });
}

function keysFor(discovery: Discovery | undefined, id: string): ModuleKeys | undefined {
  const file = webpackId(id);

  return file === undefined ? undefined : discovery?.keysFor(file);
}

/**
 * `enforce: "pre"` is webpack's own word for the same idea Vite spells the same way: run on the raw
 * file, before the TypeScript transform in the user's own rules collapses the blank lines and drops
 * the type arguments. unplugin turns it into a `pre` rule in `module.rules`, which webpack runs
 * ahead of every normal loader.
 *
 * The roots are read while the compiler applies the plugin, which is synchronous, so discovery
 * exists before the first file is offered to the gate. That is why the climb has to be synchronous
 * too: a root that arrives later would leave the files ahead of it measured from nowhere.
 */
export const webpackLikeFactory: UnpluginFactory<BundlerPluginOptions, false> = (options, meta) => {
  const discovery = startDiscovery(options, meta);

  return {
    name: "nanostores-devtools",
    enforce: "pre",

    transformInclude: (id) => keysFor(discovery, id) !== undefined,

    async transform(code, id) {
      const keys = keysFor(discovery, id);

      if (discovery === undefined || keys === undefined) {
        return null;
      }

      const { result, warnings } = await discovery.run(code, keys);

      for (const warning of warnings) {
        this.warn(warning);
      }

      return result.changed ? { code: result.code, map: result.map } : null;
    },
  };
};
