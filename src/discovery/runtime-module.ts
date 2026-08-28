import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The name the injected import carries under webpack and Rspack. */
export const RUNTIME_MODULE = "nanostores-devtools/runtime";

/** The built runtime in an install, and the source file in a checkout of this repository. */
const RUNTIME_FILES = ["../runtime.mjs", "../runtime.ts"];

/**
 * The runtime file that sits beside this plugin.
 *
 * A bundler resolves an import from the file the import stands in. The plugin puts its import in
 * store files, and a store file in a package that does not depend on this one cannot reach the
 * runtime. Each adapter therefore points its own bundler at this path.
 *
 * `undefined` when the file is not where this expects it. The adapters then leave the name alone.
 */
export function ownRuntimePath(): string | undefined {
  for (const file of RUNTIME_FILES) {
    const path = fileURLToPath(new URL(file, import.meta.url)).replaceAll("\\", "/");

    if (existsSync(path)) {
      return path;
    }
  }

  return undefined;
}
