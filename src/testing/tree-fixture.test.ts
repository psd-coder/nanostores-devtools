import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetDevtoolsGlobal } from "../global.ts";
import { ownerLinkOf } from "../placement.ts";
import { listEntries, type StoreEntry } from "../registry.ts";
import { buildSnapshot } from "../snapshot.ts";
import { nanostoresDevtools, type VitePluginOptions } from "../vite/plugin.ts";
import { labelled, panelNode } from "./shapes.ts";
import {
  EDITOR,
  EDITOR_HOME,
  FIXTURE_PROJECT_ROOT,
  FIXTURE_ROOT,
  HELPERS,
  HELPERS_HOME,
  MODEL,
  MODEL_HOME,
  PANEL,
  PANEL_HOME,
  REMOTE,
  REMOTE_HOME,
  SHARED_HOME,
  TRACKER_HOME,
  treeFixture,
  UNDO_HOME,
  WORKSPACE,
  WORKSPACE_HOME,
} from "./tree-fixture.ts";

/**
 * The acceptance set, drawn by the shipped plugin, the shipped runtime and the shipped snapshot.
 * Every case here exists because something was once wrong, so a test failing here means a case
 * that used to draw right has stopped.
 */
const RUNTIME = `${FIXTURE_ROOT}/src/vite/runtime.ts`;

/** The five stores the fixture mounts, so a computed nobody watches still reads as unmounted. */
const MOUNTED = ["$draft", "$draft2", "$entries", "$step", "$busy"];

const WORDS = ["the ", "quick ", "brown ", "fox ", "jumps "];

const TEXT = "the quick brown fox jumps ";

const HISTORY = [
  "",
  "the ",
  "the quick ",
  "the quick brown ",
  "the quick brown fox ",
  "the quick brown fox jumps ",
];

/** What the tree draws for a computed store nobody has mounted, which holds no value to show. */
const NEVER_COMPUTED = labelled("not mounted, never computed", {});

const EDITOR_NODE = { "$count [store]": 0, "$value [store]": "" };

const PANEL_NODE = panelNode(320);

async function serve(options: VitePluginOptions = {}): Promise<ViteDevServer> {
  resetDevtoolsGlobal();

  return createServer({
    configFile: false,
    logLevel: "silent",
    root: FIXTURE_ROOT,
    plugins: [nanostoresDevtools({ projectRoot: FIXTURE_PROJECT_ROOT, ...options }), treeFixture()],
    resolve: { alias: { "nanostores-devtools/vite/runtime": RUNTIME } },
    server: { fs: { allow: [FIXTURE_PROJECT_ROOT] } },
  });
}

/**
 * The fixture loaded and driven: five stores mounted and five words typed, so the tree holds real
 * data rather than the "not mounted" marker everywhere.
 *
 * The words are written straight to the two stores `model.ts` writes, rather than through the
 * function it exports, because the dev server hands a module back untyped.
 */
async function drive(server: ViteDevServer): Promise<void> {
  await server.ssrLoadModule(MODEL);
  await server.ssrLoadModule(EDITOR);
  await server.ssrLoadModule(WORKSPACE);

  for (const name of MOUNTED) {
    entryNamed(name).store.listen(() => {});
  }

  let text = "";

  for (const word of WORDS) {
    text += word;
    write("$value", text);
    write("$draft", text);
  }
}

/** One store of a creation site, which the registry keeps under one name and its own number. */
function entryNamed(name: string, number = 1): StoreEntry {
  const entry = listEntries().find((one) => one.name === name && one.number === number);

  if (entry === undefined) {
    throw new Error(`no store named "${name}" #${number} is registered`);
  }

  return entry;
}

function write(name: string, value: string): void {
  const { store } = entryNamed(name);

  if (!("set" in store)) {
    throw new Error(`"${name}" holds no writable store`);
  }

  store.set(value);
}

function homeOf(home: string): Record<string, unknown> {
  const drawn = buildSnapshot()[home];

  if (drawn === undefined) {
    throw new Error(`no home "${home}" in the tree`);
  }

  return drawn;
}

function isNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One step into a node, which the tree hands back as an unknown like every other drawn value. */
function into(node: Record<string, unknown>, key: string): Record<string, unknown> {
  const child = node[key];

  if (!isNode(child)) {
    throw new Error(`"${key}" is no node in the tree`);
  }

  return child;
}

/** Past the wrapper the panel's reviver drops before printing the type in front of the node. */
function inside(node: Record<string, unknown>, key: string): Record<string, unknown> {
  return into(into(node, key), "data");
}

function countByHome(): Record<string, number> {
  const byHome: Record<string, number> = {};

  for (const entry of listEntries()) {
    byHome[entry.home] = (byHome[entry.home] ?? 0) + 1;
  }

  return byHome;
}

describe("the fixture drawn by the shipped code", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await serve();
    await drive(server);
  });

  afterAll(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("draws what the library handed over, and nothing it kept in a closure", () => {
    expect(homeOf(MODEL_HOME)["$draft [store]"]).toEqual({
      "(value)": TEXT,
      "$canRedo [computed]": NEVER_COMPUTED,
      "$canUndo [computed]": NEVER_COMPUTED,
      "$history [computed]": HISTORY,
      "$position [computed]": 5,
    });

    /**
     * The four above sit on the atom `withUndo` gave back, so the binding scan reaches them
     * through `$draft`. `$timeline` is the closure it kept, and only the frame ever reached it.
     */
    expect(entryNamed("$timeline").home).toBe(UNDO_HOME);
    expect(ownerLinkOf(entryNamed("$timeline").store)).toBeUndefined();
  });

  it("draws none of the second instance's closure either", () => {
    expect(homeOf(MODEL_HOME)["$draft2 [store]"]).toEqual({
      "(value)": "",
      "$canRedo [computed]": NEVER_COMPUTED,
      "$canUndo [computed]": NEVER_COMPUTED,
      "$history [computed]": NEVER_COMPUTED,
      "$position [computed]": NEVER_COMPUTED,
    });
    /** The registry still holds it and still numbers it; only the tree has no place for it. */
    expect(entryNamed("$timeline", 2)).toMatchObject({ home: UNDO_HOME });
  });

  it("keeps the developer's name for an alias, and a second placement on its owner", () => {
    const model = homeOf(MODEL_HOME);

    expect(entryNamed("$canUndo")).toMatchObject({ home: MODEL_HOME, ownerName: "$canUndo" });
    expect(model["$canUndo [computed]"]).toEqual(NEVER_COMPUTED);
    expect(into(model, "$draft [store]")).toHaveProperty(["$canUndo [computed]"]);
  });

  it("does not lose the chosen name when the alias renames the store", () => {
    const model = homeOf(MODEL_HOME);

    expect(entryNamed("$undoable")).toMatchObject({ home: MODEL_HOME, ownerName: "$canUndo" });
    expect(model["$undoable [computed]"]).toEqual(NEVER_COMPUTED);
    expect(into(model, "$draft2 [store]")).toHaveProperty(["$canUndo [computed]"]);
  });

  it("draws both placements of a store holding real data", () => {
    const model = homeOf(MODEL_HOME);

    expect(model["$entries [computed]"]).toEqual(HISTORY);
    expect(into(model, "$draft [store]")["$history [computed]"]).toEqual(HISTORY);
  });

  it("wraps a store with no $ in its name in (value), because it owns another", () => {
    expect(homeOf(MODEL_HOME)["counter [store]"]).toEqual({
      "(value)": 0,
      "$doubled [computed]": NEVER_COMPUTED,
    });
  });

  it("attributes nothing for using a library store, and keeps the derived one local", () => {
    expect(homeOf(MODEL_HOME)["$busy [computed]"]).toBe(false);
    expect(entryNamed("$requests").home).toBe(SHARED_HOME);
    expect(entryNamed("$busy").home).toBe(MODEL_HOME);
  });

  it("names the exported binding's store, whatever order the two bindings are scanned in", () => {
    const model = homeOf(MODEL_HOME);

    expect(model["$value [store]"]).toBe(TEXT);
    expect(Object.keys(model)).not.toContain("$typed");
    expect(Object.keys(model)).not.toContain("$alias");
  });

  it("names a class instance by its binding and not by its class", () => {
    const editor = homeOf(EDITOR_HOME);

    expect(inside(editor, "editorOne")).toEqual(EDITOR_NODE);
    expect(inside(editor, "editorTwo")).toEqual(EDITOR_NODE);
    expect(into(editor, "editorOne")["__serializedType__"]).toBe("Editor");
  });

  it("gives a static field to the class, keyed by the class name and carrying no label", () => {
    expect(homeOf(EDITOR_HOME)["Editor"]).toEqual({ "$opened [store]": 0 });
  });

  it("walks an array by index, and nests a node inside a node", () => {
    expect(homeOf(EDITOR_HOME)["drafts"]).toEqual(
      labelled("Array", {
        "[0]": labelled("Editor", EDITOR_NODE),
        "[1]": labelled("Editor", EDITOR_NODE),
      }),
    );
  });

  it("walks a Map by key, and lets the scan correct the frame's own name for the instance", () => {
    expect(homeOf(EDITOR_HOME)["byId"]).toEqual(
      labelled("Map", { '["scratch"]': labelled("Editor", EDITOR_NODE) }),
    );
  });

  it("walks a Set in insertion order", () => {
    expect(homeOf(WORKSPACE_HOME)["pool"]).toEqual(
      labelled("Set", { "[0]": PANEL_NODE, "[1]": PANEL_NODE }),
    );
    expect(Object.keys(inside(homeOf(WORKSPACE_HOME), "pool"))).toEqual(["[0]", "[1]"]);
  });

  it("keys a bare store in a collection by its position, and keeps its own flat name", () => {
    const editor = homeOf(EDITOR_HOME);

    expect(editor["bounds"]).toEqual(labelled("Array", { "[0] [store]": 320, "[1] [store]": 240 }));
    expect(editor["byMode"]).toEqual(labelled("Map", { '["scratch"] [store]': "" }));
    expect(editor["watched"]).toEqual(
      labelled("Set", { "[0] [store]": false, "[1] [store]": true }),
    );
    expect(Object.keys(inside(editor, "watched"))).toEqual(["[0] [store]", "[1] [store]"]);
    /** The name the developer wrote still holds the flat slot, and the collection the second one. */
    expect(editor["$width [store]"]).toBe(320);
    expect(entryNamed("$width").ownerName).toBe("$width");
  });

  it("gives an unenumerable holder its binding back, and numbers refs across the file", () => {
    expect(homeOf(EDITOR_HOME)["hidden"]).toEqual(
      labelled("WeakMap", {
        "ref#1": labelled("Editor", EDITOR_NODE),
        "ref#2": labelled("Viewer", { "$zoom [store]": 1 }),
      }),
    );
  });

  it("attributes a factory result once the parse gate is widened", () => {
    const workspace = homeOf(WORKSPACE_HOME);

    expect(workspace["panel"]).toEqual(PANEL_NODE);
    expect(workspace["sidebar"]).toEqual(PANEL_NODE);
    /** Nothing is left behind in the file that holds the factory. */
    expect(Object.keys(buildSnapshot())).not.toContain(PANEL_HOME);
  });

  it("tells a plain-object node from a store, which only the key word separates", () => {
    expect(homeOf(WORKSPACE_HOME)["panel"]).toEqual(PANEL_NODE);
    expect(Object.keys(homeOf(WORKSPACE_HOME))).toContain("panel");
  });

  it("says what a capped collection left out, and loses none of its stores", () => {
    const many = inside(homeOf(WORKSPACE_HOME), "many");
    const walked = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`[${index}]`, PANEL_NODE]),
    );
    const past = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        [`open [store] #${30 + index}`, false],
        [`width [store] #${30 + index}`, 320],
      ]).flat(),
    );

    expect(many).toEqual({
      ...walked,
      ...past,
      "…": labelled(
        "5 more members past the 25 walked; their stores are listed here without a node of " +
          "their own",
        {},
      ),
    });
  });

  it("draws nothing for a store nothing else names, so its file is no home at all", () => {
    expect(buildSnapshot()[TRACKER_HOME]).toBeUndefined();
    expect(listEntries().some((entry) => entry.home === TRACKER_HOME)).toBe(true);
  });

  it("keeps a module-level library store flat, and sorts every external file last", () => {
    expect(homeOf(SHARED_HOME)).toEqual({ "$lastError [store]": null, "$requests [store]": 0 });
    expect(Object.keys(buildSnapshot())).toEqual([
      EDITOR_HOME,
      MODEL_HOME,
      WORKSPACE_HOME,
      SHARED_HOME,
    ]);
  });
});

/**
 * The first count invariant, which caught a real bug once and cannot be checked by reading the
 * tree: counting per file proves nothing, because ownership deliberately moves a store out of the
 * file that built it and into the file that owns it.
 */
describe("the draw-once invariant", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await serve();
    await drive(server);
  });

  afterAll(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /**
   * How often each store turns up in the drawn tree. Every store first gets a value nothing else
   * holds, so counting needs no guess about which drawn key is a store's slot and which is a node:
   * `{ entries, index }` and `{ $hits: 0 }` are the same shape, and only the value separates them.
   *
   * Every store is mounted first, or an unmounted computed would be drawn as a marker holding no
   * value at all. The write goes through `Reflect.set` because a store's `value` is typed
   * read-only, and `set()` would recompute and notify.
   */
  function countPlacements(): Map<string, number> {
    const entries = listEntries();

    for (const entry of entries) {
      entry.store.listen(() => {});
    }

    const tokens = entries.map((entry, index) => {
      const token = `slot#${index}`;

      Reflect.set(entry.store, "value", token);

      return [entry.label, `"${token}"`] as const;
    });
    const drawn = JSON.stringify(buildSnapshot());

    return new Map(tokens.map(([label, token]) => [label, drawn.split(token).length - 1]));
  }

  it("draws every store it draws at all once, plus one for each second placement", () => {
    /** One note, whatever else happens: silence would read as "this is all of it". */
    expect(JSON.stringify(buildSnapshot()).split('"…"').length - 1).toBe(1);
    expect(listEntries()).toHaveLength(107);

    const counts = countPlacements();
    const placements = [...counts.values()];

    /** One label per entry, so a label two entries shared would drop the count below 107. */
    expect(counts.size).toBe(107);
    /** Draw-once, the first form: no store is drawn twice over. */
    expect(placements.filter((times) => times > 2)).toEqual([]);
    /**
     * The stores the tree draws nowhere. `track()` keeps its own in a closure and hands back a
     * function, so nothing places it and what the function returned holds no state to see it by.
     * Both `$timeline`s are `withUndo`'s working state: the frame caught them, and a frame places
     * nothing born in somebody else's file, because a store that file hands over is adopted at the
     * call site and reached through a property instead.
     */
    expect([...counts].filter(([, times]) => times === 0).map(([label]) => label)).toEqual([
      `${UNDO_HOME}/$timeline`,
      `${UNDO_HOME}/$timeline #2`,
      `${TRACKER_HOME}/$hits`,
    ]);
    /**
     * Draw-once, the second form. A store the developer bound to a top-level name of their own is
     * drawn once at that name and once more under its owner, so 104 is the count of the stores
     * drawn at all and 113 with those second placements.
     */
    expect(placements.reduce((sum, times) => sum + times, 0)).toBe(113);
    expect(
      [...counts]
        .filter(([, times]) => times === 2)
        .map(([label]) => label)
        .sort(),
    ).toEqual([
      `${EDITOR_HOME}/$dirty`,
      `${EDITOR_HOME}/$height`,
      `${EDITOR_HOME}/$open`,
      `${EDITOR_HOME}/$scratch`,
      `${EDITOR_HOME}/$width`,
      `${MODEL_HOME}/$canRedo`,
      `${MODEL_HOME}/$canUndo`,
      `${MODEL_HOME}/$entries`,
      `${MODEL_HOME}/$undoable`,
    ]);
  });
});

/**
 * Today's number, not a fixed one. `model.ts` calls a factory that builds five stores inside
 * `vendor/withUndo.ts`, and reloading `model.ts` wipes only what `model.ts` registered, so the
 * library's own entries pile up. Open decision 1 in the spec is the change that would fix it, and
 * it has not been approved, so this records what the count is instead.
 */
describe("reloading a module", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await serve();
  });

  afterAll(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  /** What a hot reload does to a module: drop it from the graph and run its body again. */
  async function reload(): Promise<void> {
    const { moduleGraph } = server.environments.ssr;
    const node = moduleGraph.getModuleById(MODEL);

    if (node !== undefined) {
      moduleGraph.invalidateModule(node);
    }

    await server.ssrLoadModule(MODEL, { fixStacktrace: false });
  }

  it("grows the registry by seven entries on every reload", async () => {
    await server.ssrLoadModule(MODEL);

    const totals = [listEntries().length];

    for (let round = 0; round < 3; round += 1) {
      await reload();
      totals.push(listEntries().length);
    }

    expect(totals).toEqual([20, 27, 34, 41]);
    /** The pile-up sits in the files the factories live in, never in the module reloaded. */
    expect(countByHome()).toEqual({
      [MODEL_HOME]: 11,
      [SHARED_HOME]: 2,
      [TRACKER_HOME]: 4,
      [UNDO_HOME]: 24,
    });
  });
});

/**
 * Three cases the main load leaves out. The last two are behaviour the tree depends on that no spec
 * line asks for, so each gets a case of its own.
 */
describe("an await, a helper and two functions of one name", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await serve();
    await server.ssrLoadModule(REMOTE);
    await server.ssrLoadModule(HELPERS);
  });

  afterAll(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("opens no frame across an await, and still places the store by its binding", () => {
    expect(homeOf(REMOTE_HOME)).toEqual({ remote: { "$ready [store]": true } });
    /** The frame is gone, so the enclosing function is all that was left to fall back on. */
    expect(entryNamed("$ready").fn).toBe("loadRemote");
  });

  it("draws a store a helper made and a binding adopted flat, not under the helper", () => {
    expect(homeOf(HELPERS_HOME)["$flag [store]"]).toBe(false);
    expect(entryNamed("$flag").fn).toBeNull();
  });

  /**
   * The frame keeps its full reach inside the developer's own files. `$layout` is a closure of
   * `makeBoard`, so no walk at the end of the module body finds it, and only the frame does. It
   * also draws a plain object and nothing else, exactly as a node does, so the `[store]` on the key
   * is the whole of what tells the two apart.
   */
  it("places a store this file kept in a closure, holding an object like a node", () => {
    expect(homeOf(HELPERS_HOME)["$board [store]"]).toEqual({
      "(value)": "2 columns",
      "$layout [store]": { columns: 2, gap: 8 },
    });
  });

  it("draws nothing for the stores two functions of one name kept in a closure", () => {
    expect(Object.keys(homeOf(HELPERS_HOME))).toEqual(["$board [store]", "$flag [store]"]);
  });
});

/**
 * `declare const $ambientOnly` is a normal declarator in the AST but binds nothing once the types
 * are stripped, so listing it in `own()` throws a `ReferenceError` and takes the module down.
 * Loading the file at all is what proves the scan skipped it.
 */
describe("a file carrying an ambient declaration", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await serve();
  });

  afterAll(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("loads, and registers nothing for a declaration that binds nothing", async () => {
    await expect(server.ssrLoadModule(PANEL)).resolves.toBeDefined();
    expect(listEntries()).toEqual([]);
  });
});
