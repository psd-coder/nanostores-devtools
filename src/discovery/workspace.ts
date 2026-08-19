import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Vite finds the workspace root itself: it climbs until it meets a lockfile or a workspace file, so
 * a linked package reads as `packages/…` and a dependency as `node_modules/…`.
 */
type WorkspaceSearch = { searchForWorkspaceRoot: (current: string) => string };

/**
 * Vite is an optional peer, so a setup that runs this plugin without it keeps working: the Vite
 * root comes back untouched, and every home is then measured from it.
 */
export async function findWorkspaceRoot(
  root: string,
  load: () => Promise<unknown> = () => import("vite"),
): Promise<string> {
  try {
    const module = await load();

    return hasSearch(module) ? module.searchForWorkspaceRoot(root) : root;
  } catch {
    return root;
  }
}

function hasSearch(module: unknown): module is WorkspaceSearch {
  return (
    typeof module === "object" &&
    module !== null &&
    "searchForWorkspaceRoot" in module &&
    typeof module.searchForWorkspaceRoot === "function"
  );
}

/** What marks the top of a workspace, in the two spellings that are a file of their own. */
const WORKSPACE_FILES = ["pnpm-workspace.yaml", "lerna.json"];

/**
 * The same climb, written out for a bundler that ships no search of its own. It walks up from the
 * bundler's root until it meets a workspace file or a `package.json` holding `workspaces`, and takes
 * the nearest package directory when nothing above marks a workspace at all.
 *
 * Synchronous on purpose: webpack builds its plugin inside `apply`, which cannot wait, and a root
 * that arrives after the first file would leave that file measured from the wrong place.
 */
export function climbToWorkspaceRoot(start: string): string {
  let current = start;
  let packageRoot: string | undefined;

  for (;;) {
    if (marksWorkspace(current)) {
      return current;
    }

    if (packageRoot === undefined && existsSync(join(current, "package.json"))) {
      packageRoot = current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return packageRoot ?? start;
    }

    current = parent;
  }
}

function marksWorkspace(directory: string): boolean {
  if (WORKSPACE_FILES.some((file) => existsSync(join(directory, file)))) {
    return true;
  }

  try {
    const manifest: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));

    return (
      typeof manifest === "object" &&
      manifest !== null &&
      "workspaces" in manifest &&
      Boolean(manifest.workspaces)
    );
  } catch {
    return false;
  }
}
