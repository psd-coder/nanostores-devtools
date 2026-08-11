import type { Plugin } from "vite";

import { loadParser, type Parser } from "./parser.ts";
import { transformStores } from "./transform.ts";

export type VitePluginOptions = {
  fileKey?: ((path: string) => string) | undefined;
  adoptFactories?: boolean | undefined;
  maxStoresPerSite?: number | undefined;
};

/** Where a store's home comes from, and the key a hot reload clears. Both root-relative. */
export type ModuleKeys = { moduleKey: string; home: string };

const DEFAULT_MAX_STORES_PER_SITE = 50;

const SCRIPT = /\.[cm]?[jt]sx?$/;

/**
 * `apply: "serve"` keeps a production build clean: it never loads this plugin, so nothing the
 * plugin injects can reach a bundle. `enforce: "pre"` puts the walk on the developer's own
 * source, before another plugin has rewritten it.
 */
export function nanostoresDevtools(options: VitePluginOptions = {}): Plugin {
  let root = "";
  let parser: Promise<Parser> | undefined;
  /**
   * Every edit re-transforms the file, and the same warning on every save teaches people to
   * skip our warnings.
   */
  const warned = new Set<string>();

  return {
    name: "nanostores-devtools",
    apply: "serve",
    enforce: "pre",

    configResolved(config) {
      root = config.root;
    },

    async transform(code, id) {
      const keys = moduleKeys(id, root, options.fileKey);

      if (keys === undefined) {
        return null;
      }

      parser ??= loadParser();

      const result = transformStores({
        code,
        moduleKey: keys.moduleKey,
        home: keys.home,
        maxStoresPerSite: options.maxStoresPerSite ?? DEFAULT_MAX_STORES_PER_SITE,
        parser: await parser,
      });

      for (const warning of result.warnings) {
        if (!warned.has(warning)) {
          warned.add(warning);
          this.warn(warning);
        }
      }

      return result.changed ? { code: result.code, map: result.map } : null;
    },
  };
}

/**
 * The module key stays the plain project-relative path, whatever `fileKey` displays, so two files
 * that share a display home still clear only their own stores.
 */
export function moduleKeys(
  id: string,
  root: string,
  fileKey?: ((path: string) => string) | undefined,
): ModuleKeys | undefined {
  const [file] = id.split("?");

  if (file === undefined || id.startsWith("\0") || file.includes("/node_modules/")) {
    return undefined;
  }

  if (!SCRIPT.test(file)) {
    return undefined;
  }

  const moduleKey = relativeTo(root, file);

  return { moduleKey, home: fileKey?.(moduleKey) ?? moduleKey };
}

/**
 * Vite hands out module ids and a root with `/` separators on every platform, Windows drive
 * letters included, so plain segments are all this needs and macOS and Windows read the same.
 */
function relativeTo(root: string, file: string): string {
  const from = root.split("/").filter(Boolean);
  const to = file.split("/").filter(Boolean);
  let shared = 0;

  while (shared < from.length && from[shared] === to[shared]) {
    shared += 1;
  }

  const climb = Array.from({ length: from.length - shared }, () => "..");

  return [...climb, ...to.slice(shared)].join("/");
}
