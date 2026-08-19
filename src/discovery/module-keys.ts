import { fileURLToPath } from "node:url";

/** The two roots a home is measured from: the bundler's root first, and the wider one outside it. */
export type ModuleRoots = { root: string; projectRoot: string };

/** A file's place in the tree, and whether it is the developer's own file or somebody else's. */
export type FileHome = { home: string; external: boolean };

/** Where a store's home comes from, and the key a hot reload clears. */
export type ModuleKeys = FileHome & { moduleKey: string };

const SCRIPT = /\.[cm]?[jt]sx?$/;

/**
 * Where this package's own code sits, read from this file. A normal install sits under
 * `node_modules` and is skipped already, but `link:../nanostores-devtools` does not: without this
 * the plugin would transform our own runtime and inject into it an import of itself. It stops at the
 * code directory rather than the package root, so it skips our code and nothing else beside it.
 */
const OWN_CODE = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");

/**
 * The module key stays measured from the bundler's root, whatever `fileKey` displays and wherever
 * the home comes from, so two files that share a display home still clear only their own stores. Two
 * roots can name the same path, and only one root can keep the key unique.
 *
 * Every id and every root reaching here is already normalised: absolute, with `/` separators on
 * every platform and a leading `\0` on a virtual module. Normalising is the caller's job.
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
 * A file inside the bundler's root keeps its short path. One outside it is measured from the project
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
 * Both paths are normalised before they reach here, Windows drive letters included, so plain
 * segments are all this needs and macOS and Windows read the same.
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
