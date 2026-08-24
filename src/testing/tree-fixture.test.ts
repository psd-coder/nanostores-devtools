import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetDevtoolsGlobal } from "../global.ts";
import { listEntries, type StoreEntry } from "../stores/registry.ts";
import { buildSnapshot } from "../redux/render.ts";
import { nanostoresDevtools, type VitePluginOptions } from "../discovery/vite.ts";
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
  SITES,
  SITES_HOME,
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
const RUNTIME = `${FIXTURE_ROOT}/src/runtime.ts`;

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
    resolve: { alias: { "nanostores-devtools/runtime": RUNTIME } },
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
     * through `$draft`. `$timeline` is the closure it kept: nothing the app holds leads to it, so
     * after the gate it is not registered at all and the library's own file has no entry left.
     */
    expect(listEntries().filter((entry) => entry.home === UNDO_HOME)).toEqual([]);
  });

  it("draws none of the second instance's closure either", () => {
    expect(homeOf(MODEL_HOME)["$draft2 [store]"]).toEqual({
      "(value)": "",
      "$canRedo [computed]": NEVER_COMPUTED,
      "$canUndo [computed]": NEVER_COMPUTED,
      "$history [computed]": NEVER_COMPUTED,
      "$position [computed]": NEVER_COMPUTED,
    });
    /** The second instance keeps its own closure store the same way: nowhere in the registry. */
    expect(listEntries().filter((entry) => entry.home === UNDO_HOME)).toEqual([]);
  });

  it("keeps the developer's name for an alias, and a repeat on its owner", () => {
    const model = homeOf(MODEL_HOME);

    expect(entryNamed("$canUndo")).toMatchObject({ home: MODEL_HOME, ownerName: "$canUndo" });
    expect(model["$canUndo [computed]"]).toEqual(NEVER_COMPUTED);
    expect(into(model, "$draft [store]")).toHaveProperty(["$canUndo [computed]"]);
  });

  it("does not lose the chosen name when the alias renames the store", () => {
    const model = homeOf(MODEL_HOME);

    /**
     * The binding is what registers the store now, so `ownerName` is the binding's own name rather
     * than the property's. The tree key beside it still reads `$canUndo`, off the owner link.
     */
    expect(entryNamed("$undoable")).toMatchObject({ home: MODEL_HOME, ownerName: "$undoable" });
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

  it("draws all three bindings for one store, and lets the exported one name the entry", () => {
    const model = homeOf(MODEL_HOME);

    expect(model["$value [store]"]).toBe(TEXT);
    expect(model["$typed [store]"]).toBe(TEXT);
    expect(model["$alias [store]"]).toBe(TEXT);
    expect(entryNamed("$value").name).toBe("$value");
  });

  it("draws a store two containers hold under each of them, and both containers", () => {
    const editor = homeOf(EDITOR_HOME);

    expect(editor["wide"]).toEqual(labelled("Array", { "[0] [store]": 1.5 }));
    expect(editor["tall"]).toEqual({ "ratio [store]": 1.5 });
  });

  it("expands a node under its first container and says where the second one draws it", () => {
    const editor = homeOf(EDITOR_HOME);

    expect(editor["left"]).toEqual({ pinned: labelled("Viewer", { "$zoom [store]": 1 }) });
    expect(editor["right"]).toEqual({
      pinned: labelled("Viewer", { "(drawn under)": `${EDITOR_HOME}/left` }),
    });
  });

  it("names a class instance by its binding and not by its class", () => {
    const editor = homeOf(EDITOR_HOME);

    expect(inside(editor, "editorOne")).toEqual(EDITOR_NODE);
    expect(inside(editor, "editorTwo")).toEqual(EDITOR_NODE);
    expect(into(editor, "editorOne")["__serializedType__"]).toBe("Editor");
  });

  /**
   * A static field belongs to the class, and no instance of it holds the store. The class is the
   * one name that reaches it, so the scan walks a class binding's own static properties.
   */
  it("draws a static field under the class that holds it", () => {
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

  it("walks a Map by key, and lets the scan name the instance the class field left as ours", () => {
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
    /** The name the developer wrote still holds the flat slot, and the collection a repeat. */
    expect(editor["$width [store]"]).toBe(320);
    expect(entryNamed("$width").ownerName).toBe("$width");
  });

  /**
   * A `WeakMap` gives up no members, so the two instances inside it are reached by nothing, and a
   * class field names no store of its own any more. What it holds is drawn nowhere at all.
   */
  it("draws nothing for a holder nothing can enumerate", () => {
    expect(homeOf(EDITOR_HOME)["hidden"]).toBeUndefined();
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

  it("walks a long collection whole, giving every member a node of its own", () => {
    const many = inside(homeOf(WORKSPACE_HOME), "many");

    expect(many).toEqual(
      Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`[${index}]`, PANEL_NODE])),
    );
  });

  /** `track()` hands back a function, so nothing the app holds leads to the store it made. */
  it("draws nothing for a store nothing else names, and registers nothing either", () => {
    expect(buildSnapshot()[TRACKER_HOME]).toBeUndefined();
    expect(listEntries().some((entry) => entry.home === TRACKER_HOME)).toBe(false);
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

  it("draws every store it draws at all once per reference the developer wrote", () => {
    /** No note anywhere: nothing in the fixture asks for a number, so nothing is left out. */
    expect(JSON.stringify(buildSnapshot()).split('"…"').length - 1).toBe(0);
    expect(listEntries()).toHaveLength(103);

    const counts = countPlacements();
    const placements = [...counts.values()];

    /** One label per entry, so a label two entries shared would drop the count below 103. */
    expect(counts.size).toBe(103);
    /**
     * Nothing is registered and drawn nowhere. Every store the registry holds is one a name of the
     * developer's own reaches, so the tree has a place for all of them. The stores that used to sit
     * in this list are the ones the held rule took out: `withUndo`'s own `$timeline` and the one
     * `track()` keeps in a closure are made inside a function body and registered by nothing.
     */
    expect([...counts].filter(([, times]) => times === 0).map(([label]) => label)).toEqual([]);
    /**
     * Draw-once: a store is drawn once for each reference the developer wrote and never twice for
     * one. A name they bound and a container they put it in are both references, so a store with a
     * flat name and one owner draws twice, and one with three references draws three times. All 103
     * draw at all, and 116 counts every repeat beside them.
     */
    expect(placements.reduce((sum, times) => sum + times, 0)).toBe(116);
    expect(
      [...counts]
        .filter(([, times]) => times > 1)
        .map(([label, times]) => `${label} x${times}`)
        .sort(),
    ).toEqual([
      `${EDITOR_HOME}/$dirty x2`,
      `${EDITOR_HOME}/$height x2`,
      `${EDITOR_HOME}/$open x2`,
      /** Bound flat, and held by two containers, so three references and three placements. */
      `${EDITOR_HOME}/$ratio x3`,
      `${EDITOR_HOME}/$scratch x2`,
      `${EDITOR_HOME}/$width x2`,
      `${MODEL_HOME}/$canRedo x2`,
      `${MODEL_HOME}/$canUndo x2`,
      `${MODEL_HOME}/$entries x2`,
      `${MODEL_HOME}/$undoable x2`,
      /** Three top-level bindings for one store: `$value`, `$typed` and `$alias`. */
      `${MODEL_HOME}/$value x3`,
    ]);
  });
});

/**
 * The registry holds still across a reload. `model.ts` calls a factory that builds five stores
 * inside `vendor/withUndo.ts`, and those are registered by the scan `model.ts` runs, at
 * `model.ts`, so the module's own `clear()` drops every one of them. Nothing is registered in the
 * library's own file any more, so nothing is left there to pile up.
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

  it("holds the same entries after every reload", async () => {
    await server.ssrLoadModule(MODEL);

    const totals = [listEntries().length];

    for (let round = 0; round < 3; round += 1) {
      await reload();
      totals.push(listEntries().length);
    }

    expect(totals).toEqual([17, 17, 17, 17]);
    /** Two homes, and the library's own file is not one of them. */
    expect(countByHome()).toEqual({
      [MODEL_HOME]: 15,
      [SHARED_HOME]: 2,
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

  it("places a store made inside an awaited call by the binding that took the result", () => {
    expect(homeOf(REMOTE_HOME)).toEqual({ remote: { "$ready [store]": true } });
  });

  it("draws a store a helper made and a binding adopted flat, not under the helper", () => {
    expect(homeOf(HELPERS_HOME)["$flag [store]"]).toBe(false);
  });

  /**
   * `$layout` is a closure of `makeBoard`, so no walk at the end of the module body finds it and no
   * name in the source holds it. It is the developer's own store and it is still drawn nowhere: a
   * store a function keeps to itself is theirs to register by hand. What `$board` draws is its own
   * value, a plain object that reads exactly like a node, so the `[store]` on the key is the whole
   * of what tells the two apart.
   */
  it("draws nothing for a store this file kept in a closure, and draws the value it handed back", () => {
    expect(homeOf(HELPERS_HOME)["$board [store]"]).toEqual("2 columns");
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

/**
 * The line a creation site records is the line in the file the developer opened. Two sites in
 * `sites.ts` claim `$dup`, and a name two sites claim is what makes each of them show its place,
 * so the line is a string the model hands out rather than a number nothing spells.
 */
const WRONG_LINE =
  "the plugin read a line off source somebody else had already rewritten. It has to walk the " +
  "developer's own file first, before the bundler's own TypeScript transform collapses the blank " +
  "lines and drops the type arguments, or every line it records sends a developer to the wrong " +
  "place in their own file";

describe("the line a creation site records", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await serve();
    await server.ssrLoadModule(SITES);
  });

  afterAll(async () => {
    await server.close();
    resetDevtoolsGlobal();
  });

  it("names the line in the developer's own file, not the line after the types are stripped", () => {
    const places = listEntries()
      .filter((entry) => entry.name.endsWith("$dup"))
      .map((entry) => entry.place);

    expect(places, WRONG_LINE).toEqual(["line 16", "line 20"]);
  });

  it("spells that line into the name the panel and the warnings read", () => {
    const labels = listEntries()
      .filter((entry) => entry.name.endsWith("$dup"))
      .map((entry) => entry.label);

    expect(labels, WRONG_LINE).toEqual([
      `${SITES_HOME}/one.$dup (line 16)`,
      `${SITES_HOME}/two.$dup (line 20)`,
    ]);
  });

  /** The whole file, so nothing can be added to it that moves those two lines unnoticed. */
  it("draws every store the file makes, and nothing else", () => {
    expect(homeOf(SITES_HOME)).toEqual({
      "$frame [store, throttled]": 0,
      one: { "$dup [store]": 1 },
      two: { "$dup [store]": 2 },
    });
  });
});
