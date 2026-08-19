import type { Plugin } from "vite";

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
 * `apply: "serve"` keeps a production build clean: it never loads this plugin, so nothing the
 * plugin injects can reach a bundle. `enforce: "pre"` puts the walk on the developer's own
 * source, before another plugin has rewritten it.
 *
 * Vite hands out module ids and a root with `/` separators on every platform, Windows drive letters
 * included, and marks a virtual module with a leading `\0`, which is the shape discovery reads, so
 * the normalising it asks its caller for costs this adapter nothing.
 */
export function nanostoresDevtools(options: VitePluginOptions = {}): Plugin {
  let discovery: Discovery | undefined;

  return {
    name: "nanostores-devtools",
    apply: "serve",
    enforce: "pre",

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
  };
}
