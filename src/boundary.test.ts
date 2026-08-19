import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every file outside `redux/` and `testing/` is the model, whichever folder it sits in, and
 * `src/redux/*.ts` is the view. A model file never imports a view file; the other direction is free.
 * `src/discovery/*.ts` is a bundler adapter, and it follows the model rule too, so a second adapter
 * inherits that rule instead of rediscovering it.
 *
 * A crossing fails here and is fixed in the source. A crossing written down somewhere instead is a
 * rule the next reader has to argue with before they can trust it.
 */
const VIEW_DIR = "redux";

/** They pick what the package exports, so naming the view is their job. */
const ENTRY_FILES = ["index.ts", "noop.ts"];

/** Fixtures for tests on both sides, so neither rule fits them. */
const SHARED_DIR = "testing";

type Crossing = {
  model: string;
  view: string;
  names: string[];
};

/** Matches `import … from "./x.ts"` and `export … from "./x.ts"`, over one line or several. */
const RELATIVE_IMPORT = /^(?:import|export)\s+([^;]*?)\s+from\s+"(\.[^"]+)";/gm;

/** Matches `import "./x.ts"`, which takes no names. */
const RELATIVE_SIDE_EFFECT = /^import\s+"(\.[^"]+)";/gm;

/** Matches either form, for a rule that asks which file was reached and not what it handed over. */
const RELATIVE_ANY_TARGET = /^(?:import|export)\s+(?:[^;]*?\s+from\s+)?"(\.[^"]+)";/gm;

function importedNames(clause: string): string[] {
  const braces = clause.match(/\{([^}]*)\}/);
  const inner = braces?.[1] ?? clause;

  return inner
    .split(",")
    .map(
      (name) =>
        name
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0],
    )
    .filter((name): name is string => name !== undefined && name !== "" && name !== "type");
}

function isModel(file: string): boolean {
  if (file.endsWith(".test.ts") || file.endsWith(".d.ts")) return false;
  if (ENTRY_FILES.includes(file)) return false;

  const dir = path.dirname(file);

  return dir !== VIEW_DIR && dir !== SHARED_DIR;
}

function isView(file: string): boolean {
  return path.dirname(file) === VIEW_DIR && !file.endsWith(".test.ts");
}

/** Every crossing the given sources make, whichever side they sit on. */
function findCrossings(sources: Readonly<Record<string, string>>): Crossing[] {
  const crossings: Crossing[] = [];

  for (const [file, source] of Object.entries(sources)) {
    if (!isModel(file)) continue;

    for (const [, clause, target] of source.matchAll(RELATIVE_IMPORT)) {
      if (clause === undefined || target === undefined) continue;

      const resolved = path.posix.join(path.posix.dirname(file), target);

      if (!isView(resolved)) continue;

      crossings.push({ model: file, view: resolved, names: importedNames(clause) });
    }

    for (const [, target] of source.matchAll(RELATIVE_SIDE_EFFECT)) {
      if (target === undefined) continue;

      const resolved = path.posix.join(path.posix.dirname(file), target);

      if (!isView(resolved)) continue;

      crossings.push({ model: file, view: resolved, names: [] });
    }
  }

  return crossings;
}

function readSources(): Record<string, string> {
  const sources: Record<string, string> = {};

  for (const entry of readdirSync(SRC, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;

    const file = path.posix.join(path.relative(SRC, entry.parentPath), entry.name);

    sources[file] = readFileSync(path.join(entry.parentPath, entry.name), "utf8");
  }

  return sources;
}

function describeCrossings(crossings: readonly Crossing[]): string[] {
  return crossings
    .map(({ model, view, names }) => `${model} imports ${view}: ${[...names].sort().join(", ")}`)
    .sort();
}

describe("the model and view boundary", () => {
  it("is never crossed, and nothing on either side may record a crossing", () => {
    expect(describeCrossings(findCrossings(readSources()))).toEqual([]);
  });

  it("catches a model file that reaches for the view", () => {
    const crossings = findCrossings({
      "printed.ts": `import { box } from "./redux/marker.ts";\n`,
    });

    expect(describeCrossings(crossings)).toEqual(["printed.ts imports redux/marker.ts: box"]);
  });

  it("catches a side-effect import, which takes no names", () => {
    const crossings = findCrossings({
      "printed.ts": `import "./redux/marker.ts";\n`,
    });

    expect(describeCrossings(crossings)).toEqual(["printed.ts imports redux/marker.ts: "]);
  });

  it("holds a discovery file to the same rule as a model file", () => {
    const crossings = findCrossings({
      "discovery/transform.ts": `import type { Bridge } from "../redux/connect.ts";\n`,
    });

    expect(describeCrossings(crossings)).toEqual([
      "discovery/transform.ts imports redux/connect.ts: Bridge",
    ]);
  });

  it("lets an entry file, a test and a fixture name the view", () => {
    const crossings = findCrossings({
      "index.ts": `export { connectDevtools } from "./redux/connect.ts";\n`,
      "noop.ts": `export type { Serializer } from "./redux/replacer.ts";\n`,
      "snapshot.test.ts": `import { mark } from "./redux/marker.ts";\n`,
      "testing/fake-extension.ts": `import type { ExtensionMessage } from "../redux/extension.ts";\n`,
    });

    expect(crossings).toEqual([]);
  });

  it("reads an import written over several lines", () => {
    const crossings = findCrossings({
      "platform.ts": `import {\n  box,\n  type Marked,\n} from "./redux/marker.ts";\n`,
    });

    expect(describeCrossings(crossings)).toEqual([
      "platform.ts imports redux/marker.ts: Marked, box",
    ]);
  });
});

/**
 * `values/` reads an unknown JS value and knows nothing else: not a store, not a session, not the
 * global. That makes it the one model folder with a wall, so a file that reaches out of it is a
 * sign the folder is growing a second job.
 */
const VALUES_DIR = "values";

/** `limits.ts` validates a `connectDevtools()` option, so it is the one file that has to warn. */
const VALUES_ALLOWED: Readonly<Record<string, string>> = {
  "values/limits.ts": "utils/warn.ts",
};

function findReachesOut(sources: Readonly<Record<string, string>>): string[] {
  const reaches: string[] = [];

  for (const [file, source] of Object.entries(sources)) {
    if (path.dirname(file) !== VALUES_DIR || file.endsWith(".test.ts")) continue;

    for (const [, target] of source.matchAll(RELATIVE_ANY_TARGET)) {
      if (target === undefined) continue;

      const resolved = path.posix.join(VALUES_DIR, target);

      if (path.dirname(resolved) === VALUES_DIR || VALUES_ALLOWED[file] === resolved) continue;

      reaches.push(`${file} imports ${resolved}`);
    }
  }

  return reaches.sort();
}

describe("the values wall", () => {
  it("holds, so reading a value stays a question about the value alone", () => {
    expect(findReachesOut(readSources())).toEqual([]);
  });

  it("catches a values file that reaches for a store", () => {
    const reaches = findReachesOut({
      "values/printed.ts": `import { getEntry } from "../stores/registry.ts";\n`,
    });

    expect(reaches).toEqual(["values/printed.ts imports stores/registry.ts"]);
  });

  it("lets limits.ts warn, and no other file borrow that pass", () => {
    const reaches = findReachesOut({
      "values/limits.ts": `import { warnOnce } from "../utils/warn.ts";\n`,
      "values/platform.ts": `import { warnOnce } from "../utils/warn.ts";\n`,
    });

    expect(reaches).toEqual(["values/platform.ts imports utils/warn.ts"]);
  });
});
