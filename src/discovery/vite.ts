import type { Plugin } from "vite";

import { createUnplugin, type UnpluginFactory } from "unplugin";

import { createDiscovery, type Discovery, type DiscoveryOptions } from "./core.ts";
import { loadParser } from "./parser.ts";
import { findWorkspaceRoot } from "./workspace.ts";

export type VitePluginOptions = DiscoveryOptions & {
  /**
   * An absolute path a file outside the Vite root is measured from. Vite's own workspace root by
   * default, which is right for an app in a repository: a linked package reads as `packages/…`.
   * Pin it when the default sits so high that homes get long.
   */
  projectRoot?: string | undefined;
};

const RUNTIME_MODULE = "nanostores-devtools/runtime";

/**
 * `prune` is the hook that fires for a module the update was not accepted on, which is the deleted
 * file case. The clear that runs on every execution needs no hook at all, so this line is all Vite
 * spells for itself.
 */
export function viteHotReload(clear: string): string {
  return `if (import.meta.hot) import.meta.hot.prune(() => { ${clear} });`;
}

/**
 * `enforce: "pre"` puts the walk on the developer's own source, before the bundler's own TypeScript
 * transform collapses the blank lines and drops the type arguments. unplugin carries it to Vite,
 * webpack and Rspack, and drops it on Rollup and esbuild. Neither of those two runs a dev server,
 * and `apply: "serve"` holds this plugin to one, so the pair it drops costs nothing here.
 *
 * `apply: "serve"` also keeps a production build clean: Vite never loads the plugin, so nothing the
 * plugin injects can reach a bundle. unplugin has no neutral word for either that or the root the
 * bundler resolved, so both go through the `vite` key and each bundler answers them its own way.
 *
 * The id gate is its own hook, because webpack filters outside its loader, so `keysFor` runs twice
 * for a file it accepts: once to answer the gate and once to name the module.
 */
const factory: UnpluginFactory<VitePluginOptions, false> = (options) => {
  let discovery: Discovery | undefined;

  return {
    name: "nanostores-devtools",
    enforce: "pre",

    transformInclude: (id) => discovery?.keysFor(id) !== undefined,

    async transform(code, id) {
      const keys = discovery?.keysFor(id);

      if (discovery === undefined || keys === undefined) {
        return null;
      }

      const { result, warnings } = await discovery.run(code, keys);

      for (const warning of warnings) {
        this.warn(warning);
      }

      return result.changed ? { code: result.code, map: result.map } : null;
    },

    vite: {
      apply: "serve",

      async configResolved(config) {
        discovery = createDiscovery({
          ...options,
          roots: {
            root: config.root,
            projectRoot: options.projectRoot ?? (await findWorkspaceRoot(config.root)),
          },
          loadParser,
          runtimeModule: RUNTIME_MODULE,
          hotReload: viteHotReload,
        });
      },
    },
  };
};

/**
 * Vite hands out module ids and a root with `/` separators on every platform, Windows drive letters
 * included, and marks a virtual module with a leading `\0`, which is the shape discovery reads, so
 * the normalising it asks its caller for costs this adapter nothing.
 */
export function nanostoresDevtools(options: VitePluginOptions = {}): Plugin {
  return createUnplugin(factory).vite(options);
}
