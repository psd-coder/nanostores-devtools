import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

import { loadParser, type Parser } from "./parser.ts";
import { transformStores } from "./transform.ts";
import { findWorkspaceRoot } from "./workspace.ts";

export type VitePluginOptions = {
  fileKey?: ((path: string) => string) | undefined;
  adoptFactories?: boolean | undefined;
  maxStoresPerSite?: number | undefined;
  /**
   * An absolute path a file outside the Vite root is measured from. Vite's own workspace root by
   * default, which is right for an app in a repository: a linked package reads as `packages/…`.
   * Pin it when the default sits so high that homes get long.
   */
  projectRoot?: string | undefined;
  /**
   * Whether every source file is parsed, which is what sees `const panel = createPanel()` and puts
   * the stores that factory returns under `panel`. On by default: it costs about 0.02 ms per file,
   * paid once per file per dev server run, because Vite caches the transform. Turn it off in a very
   * large repository, and a file is parsed again only when it imports nanostores or binds a `$`
   * name.
   */
  parseEveryFile?: boolean | undefined;
};

/** The two roots a home is measured from: the Vite root first, and the wider one outside it. */
export type ModuleRoots = { root: string; projectRoot: string };

/** A file's place in the tree, and whether it is the developer's own file or somebody else's. */
export type FileHome = { home: string; external: boolean };

/** Where a store's home comes from, and the key a hot reload clears. */
export type ModuleKeys = FileHome & { moduleKey: string };

const DEFAULT_MAX_STORES_PER_SITE = 50;

const SCRIPT = /\.[cm]?[jt]sx?$/;

/**
 * Where this package's own code sits, read from this file. A normal install sits under
 * `node_modules` and is skipped already, but `link:../nanostores-devtools` does not: without this
 * the plugin would transform our own runtime and inject into it an import of itself. It stops at the
 * code directory rather than the package root, so it skips our code and nothing else beside it.
 */
const OWN_CODE = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");

/**
 * `apply: "serve"` keeps a production build clean: it never loads this plugin, so nothing the
 * plugin injects can reach a bundle. `enforce: "pre"` puts the walk on the developer's own
 * source, before another plugin has rewritten it.
 */
export function nanostoresDevtools(options: VitePluginOptions = {}): Plugin {
  let roots: ModuleRoots = { root: "", projectRoot: "" };
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

    async configResolved(config) {
      roots = {
        root: config.root,
        projectRoot: options.projectRoot ?? (await findWorkspaceRoot(config.root)),
      };
    },

    async transform(code, id) {
      const keys = moduleKeys(id, roots, options.fileKey);

      if (keys === undefined) {
        return null;
      }

      parser ??= loadParser();

      const result = transformStores({
        code,
        moduleKey: keys.moduleKey,
        home: keys.home,
        external: keys.external,
        maxStoresPerSite: options.maxStoresPerSite ?? DEFAULT_MAX_STORES_PER_SITE,
        adoptFactories: options.adoptFactories ?? true,
        parseEveryFile: options.parseEveryFile ?? true,
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
 * The module key stays measured from the Vite root, whatever `fileKey` displays and wherever the
 * home comes from, so two files that share a display home still clear only their own stores. Two
 * roots can name the same path, and only one root can keep the key unique.
 */
export function moduleKeys(
  id: string,
  roots: ModuleRoots,
  fileKey?: ((path: string) => string) | undefined,
): ModuleKeys | undefined {
  const [file] = id.split("?");

  if (
    file === undefined ||
    id.startsWith("\0") ||
    file.includes("/node_modules/") ||
    file.startsWith(OWN_CODE)
  ) {
    return undefined;
  }

  if (!SCRIPT.test(file)) {
    return undefined;
  }

  const { home, external } = fileHome(roots, file);

  return { moduleKey: relativeTo(roots.root, file), home: fileKey?.(home) ?? home, external };
}

/**
 * A file inside the Vite root keeps its short path. One outside it is measured from the project
 * root instead of climbing out, because `../packages/nanobots/src/withUndo.ts` is a path nobody
 * has in their editor.
 */
export function fileHome(roots: ModuleRoots, file: string): FileHome {
  const inside = relativeTo(roots.root, file);

  if (!inside.startsWith("../")) {
    return { home: inside, external: false };
  }

  const measured = relativeTo(roots.projectRoot, file);

  /** A file the project root cannot reach either keeps its full path, which still opens. */
  return { home: measured.startsWith("../") ? file : measured, external: true };
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
