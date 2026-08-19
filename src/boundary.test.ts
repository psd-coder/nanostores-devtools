import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.dirname(fileURLToPath(import.meta.url));

/**
 * `src/*.ts` is the model and `src/redux/*.ts` is the view. A model file never imports a view file;
 * the other direction is free. `src/vite/*.ts` follows the model rule, because the injected runtime
 * registers stores and a second bundler adapter must inherit that rule instead of rediscovering it.
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

type Exception = {
  model: string;
  /** Every view file this model file still reaches for, and the names it takes from each. */
  views: Record<string, string[]>;
  /** The ticket that removes this crossing. */
  clearedBy: string;
};

/**
 * One line per crossing the source still makes, each naming the ticket that clears it. The test
 * compares this list to what the source really does, so a new crossing and a stale line fail the
 * same way. It is empty: every model file today answers without naming the view.
 */
const EXCEPTIONS: Exception[] = [];

function allowedCrossings(): Crossing[] {
  return EXCEPTIONS.flatMap(({ model, views }) =>
    Object.entries(views).map(([view, names]) => ({ model, view, names })),
  );
}

/** Matches `import … from "./x.ts"` and `export … from "./x.ts"`, over one line or several. */
const RELATIVE_IMPORT = /^(?:import|export)\s+([^;]*?)\s+from\s+"(\.[^"]+)";/gm;

/** Matches `import "./x.ts"`, which takes no names. */
const RELATIVE_SIDE_EFFECT = /^import\s+"(\.[^"]+)";/gm;

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
  it("crosses only where the written exception list says it may", () => {
    expect(describeCrossings(findCrossings(readSources()))).toEqual(
      describeCrossings(allowedCrossings()),
    );
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

  it("holds a vite file to the same rule as a model file", () => {
    const crossings = findCrossings({
      "vite/runtime.ts": `import type { Bridge } from "../redux/connect.ts";\n`,
    });

    expect(describeCrossings(crossings)).toEqual([
      "vite/runtime.ts imports redux/connect.ts: Bridge",
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
