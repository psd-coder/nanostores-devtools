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
