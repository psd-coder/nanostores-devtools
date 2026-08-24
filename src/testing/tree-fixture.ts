import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

/**
 * The acceptance set for the ownership tree, held as source text and served from memory. Every case
 * here exists because something was once wrong, so each file says what its case proves.
 *
 * The app sits beside the package's own source rather than inside it, because the plugin transforms
 * no file of its own package. `vendor/` sits one level above the package, so it lands outside the
 * Vite root and reads as somebody else's code, which is what a linked library really looks like.
 */
/** The Vite root the fixture is served under, which the app's own homes are measured from. */
export const FIXTURE_ROOT: string = fileURLToPath(new URL("../../", import.meta.url)).replace(
  /\/$/,
  "",
);

/** The wider root a file outside the Vite root is measured from, which the plugin option pins. */
export const FIXTURE_PROJECT_ROOT: string = FIXTURE_ROOT.slice(0, FIXTURE_ROOT.lastIndexOf("/"));

const APP_DIR = `${FIXTURE_ROOT}/app`;
const VENDOR_DIR = `${FIXTURE_PROJECT_ROOT}/vendor`;

export const MODEL: string = `${APP_DIR}/model.ts`;
export const EDITOR: string = `${APP_DIR}/editor.ts`;
export const WORKSPACE: string = `${APP_DIR}/workspace.ts`;
export const REMOTE: string = `${APP_DIR}/remote.ts`;
export const HELPERS: string = `${APP_DIR}/helpers.ts`;
export const PANEL: string = `${APP_DIR}/panel.ts`;
export const SITES: string = `${APP_DIR}/sites.ts`;

export const MODEL_HOME = "app/model.ts";
export const EDITOR_HOME = "app/editor.ts";
export const WORKSPACE_HOME = "app/workspace.ts";
export const PANEL_HOME = "app/panel.ts";
export const REMOTE_HOME = "app/remote.ts";
export const HELPERS_HOME = "app/helpers.ts";
export const SITES_HOME = "app/sites.ts";
export const SHARED_HOME = "vendor/sharedResource.ts";
export const TRACKER_HOME = "vendor/tracker.ts";
export const UNDO_HOME = "vendor/withUndo.ts";

/**
 * `pipe(seed, a, b)` is `b(a(seed))`, `withAssign` puts its members on the atom it was handed, and
 * `withUndo` keeps its timeline in a closure. All three are trimmed copies of a real library, which
 * is what makes the tree they build worth drawing.
 */
const VENDOR: Record<string, string> = {
  [`${VENDOR_DIR}/pipe.ts`]: `
/** \`pipe(seed, a, b)\` is \`b(a(seed))\`. */
export function pipe<A, B>(seed: A, first: (input: A) => B): B;
export function pipe<A, B, C>(seed: A, first: (input: A) => B, second: (input: B) => C): C;
export function pipe(seed: unknown, ...decorators: ((input: never) => unknown)[]): unknown {
  return decorators.reduce((value, decorate) => decorate(value as never), seed);
}
`,

  [`${VENDOR_DIR}/withAssign.ts`]: `
/** The members land on the SAME atom that was passed in, which is what the binding scan finds. */
export function withAssign<Atom extends object, Actions extends object>(
  $atom: Atom,
  build: ($: Atom) => Actions,
): Atom & Actions {
  return Object.assign($atom, build($atom));
}
`,

  [`${VENDOR_DIR}/withLocalStorage.ts`]: `
import { onMount, onSet } from "nanostores";
import type { WritableAtom } from "nanostores";

/** A decorator that makes no store of its own, so it adds nothing to the tree. */
export function withLocalStorage(key: string) {
  return <Atom extends WritableAtom<string>>($atom: Atom): Atom => {
    onMount($atom, () => {
      const saved = globalThis.localStorage?.getItem(key);

      if (saved !== null && saved !== undefined) $atom.set(saved);
    });

    onSet($atom, ({ newValue }) => {
      globalThis.localStorage?.setItem(key, newValue);
    });

    return $atom;
  };
}
`,

  [`${VENDOR_DIR}/withUndo.ts`]: `
import { atom, computed, onSet } from "nanostores";
import type { ReadableAtom, StoreValue, WritableAtom } from "nanostores";

import { withAssign } from "./withAssign.ts";

type UndoOptions = { limit?: number };

type Undo<Value> = {
  undo: () => void;
  redo: () => void;
  $canUndo: ReadableAtom<boolean>;
  $canRedo: ReadableAtom<boolean>;
  $position: ReadableAtom<number>;
  $history: ReadableAtom<Value[]>;
};

type Timeline<Value> = { entries: Value[]; index: number };

/**
 * \`$timeline\` is a closure variable, so nothing at the end of the module body reaches it and the
 * binding scan cannot see it. Only a creation frame can place it under the store it belongs to.
 */
function applyUndo<Atom extends WritableAtom>(
  $atom: Atom,
  options: UndoOptions,
): Atom & Undo<StoreValue<Atom>> {
  type Value = StoreValue<Atom>;

  const limit = options.limit ?? Infinity;
  const $timeline = atom<Timeline<Value>>({ entries: [$atom.get() as Value], index: 0 });
  let internal = false;

  onSet($atom, ({ newValue }) => {
    if (internal) return;

    const { entries, index } = $timeline.get();
    const next = entries.slice(0, index + 1);

    next.push(newValue as Value);

    while (next.length - 1 > limit) next.shift();

    $timeline.set({ entries: next, index: next.length - 1 });
  });

  const applyAt = (target: number) => {
    const { entries, index } = $timeline.get();

    if (target < 0 || target >= entries.length || target === index) return;

    $timeline.set({ entries, index: target });
    internal = true;
    $atom.set(entries[target] as Value);
    internal = false;
  };

  return withAssign($atom, () => ({
    undo: () => applyAt($timeline.get().index - 1),
    redo: () => applyAt($timeline.get().index + 1),
    $canUndo: computed($timeline, ({ index }) => index > 0),
    $canRedo: computed($timeline, ({ entries, index }) => index < entries.length - 1),
    $position: computed($timeline, ({ index }) => index),
    $history: computed($timeline, ({ entries }) => entries),
  }));
}

export function withUndo(options: UndoOptions = {}) {
  return <Atom extends WritableAtom>($atom: Atom) => applyUndo($atom, options);
}
`,

  [`${VENDOR_DIR}/sharedResource.ts`]: `
import { atom } from "nanostores";

/**
 * Nothing in the app builds these. The barrel re-exports them, which is how they reach the tree:
 * a module-level library store that stays flat and sorts after every file of the developer's own.
 */
export const $requests = atom<number>(0);
export const $lastError = atom<string | null>(null);
`,

  [`${VENDOR_DIR}/tracker.ts`]: `
import { atom } from "nanostores";

/**
 * The one store the tree draws nowhere. \`$hits\` lives in a closure and \`track\` hands back a
 * function rather than a store, so the frame has nothing to make a parent out of and the binding
 * scan has nothing to walk. What the function returned holds no state, so there is nothing to read
 * \`$hits\` by and the file is no home at all.
 */
export function track() {
  const $hits = atom(0);

  return () => {
    $hits.set($hits.get() + 1);
  };
}
`,

  [`${VENDOR_DIR}/index.ts`]: `
/** One import of \`withUndo\` pulls the barrel in, which is how sharedResource.ts is drawn. */
export { pipe } from "./pipe.ts";
export { withAssign } from "./withAssign.ts";
export { withLocalStorage } from "./withLocalStorage.ts";
export { withUndo } from "./withUndo.ts";
export { $lastError, $requests } from "./sharedResource.ts";
export { track } from "./tracker.ts";
`,
};

const APP: Record<string, string> = {
  [MODEL]: `
import { atom, computed } from "nanostores";

import {
  $requests,
  pipe,
  track,
  withAssign,
  withLocalStorage,
  withUndo,
} from "${VENDOR_DIR}/index.ts";

/**
 * The frame opens without an adopt call, so a store the decorator kept in a closure is placed. The
 * \`!\` is here so the initializer both the frame and adoption look through is a TypeScript node.
 */
export const $draft = pipe(atom(""), withLocalStorage("editor-draft"), withUndo({ limit: 100 }))!;

/** The second instance, whose nested stores drop the ordinal their creation site gave them. */
export const $draft2 = pipe(atom(""), withUndo({ limit: 100 }));

/** Aliases. A member read, not a call, so call-site adoption cannot reach either one. */
export const $canUndo = $draft.$canUndo;
export const $canRedo = $draft.$canRedo;

export const $step = computed(
  [$draft.$position, $draft.$history],
  (position, history) => \`\${position + 1} / \${history.length}\`,
);

const $typed = atom("");

/** The exported binding names the store, whatever order the two bindings are scanned in. */
export const $value = $typed;

export function type(next: string): void {
  const previous = $typed.get();

  $typed.set(next);

  if (next.endsWith(" ") || next.length < previous.length) $draft.set(next);
}

export function undo(): void {
  $draft.undo();
  $typed.set($draft.get());
}

export function redo(): void {
  $draft.redo();
  $typed.set($draft.get());
}

/** An alias under a name of the developer's own choosing, not the property's name. */
export const $undoable = $draft2.$canUndo;

/** An alias to a store holding real data, which is what makes a repeat cost something. */
export const $entries = $draft.$history;

/** A store with no \`$\` in its name that owns others, so only \`(value)\` tells it from a node. */
export const counter = withAssign(atom(0), ($count) => ({
  $doubled: computed($count, (count) => count * 2),
}));

/** A library store the app uses. Imported, not built here and bound to no new name, so it stays. */
export const $busy = computed($requests, (count) => count > 0);

export function load(): void {
  $requests.set($requests.get() + 1);
  countHit();
}

/** \`track\` returns a function, so the store it made is reachable from nothing in this file. */
const countHit = track();

/** A second, unexported binding for the same store. The exported name still wins. */
const $alias = $typed;

export function touchAlias(): void {
  $alias.set($alias.get());
}
`,

  [EDITOR]: `
import { atom } from "nanostores";

/** A field initializer runs with \`this\` bound to a new instance, which then holds its stores. */
export class Editor {
  /** A static field belongs to the class, not to any instance, so the class name keys it. */
  static $opened = atom(0);

  $value = atom("");
  $count = atom(0);

  constructor(readonly title: string) {}
}

export const editorOne = new Editor("first");
export const editorTwo = new Editor("second");

/** An array is walked by index, so a node nests inside a node. */
export const drafts = [new Editor("draft a"), new Editor("draft b")];

/** A \`Map\` with string keys reads like an object, so its entries are named by the key. */
export const byId = new Map([["scratch", new Editor("scratch")]]);

/**
 * A bare store held in a collection. The position is the only name that says which member it is,
 * so the key the collection knows it by has to beat the name the store was born with.
 */
export const $width = atom(320);
export const $height = atom(240);
export const bounds = [$width, $height];

/** The same for a \`Map\`, where the key the developer wrote is what names the member. */
export const $scratch = atom("");
export const byMode = new Map([["scratch", $scratch]]);

/** And for a \`Set\`, which has no keys at all, so insertion order is all there is. */
export const $open = atom(false);
export const $dirty = atom(true);
export const watched = new Set([$open, $dirty]);

/** One store two containers hold. Both containers draw, and the store draws under each of them. */
export const $ratio = atom(1.5);
export const wide = [$ratio];
export const tall = { ratio: $ratio };

/** A second class, so two instances nothing can name share one numbering run across the file. */
export class Viewer {
  $zoom = atom(1);
}

/** One node two containers hold. It is expanded under the first and shown under the second. */
const pinned = new Viewer();
export const left = { pinned };
export const right = { pinned };

/** A \`WeakMap\` cannot be enumerated at all, so nothing here can ever name what it holds. */
export const hidden = new WeakMap<object, Editor | Viewer>([
  [{}, new Editor("hidden")],
  [{}, new Viewer()],
]);
`,

  [`${APP_DIR}/panel.ts`]: `
import { atom } from "nanostores";

/** The factory itself. This file imports nanostores, so even the narrow gate parses it. */
export function createPanel() {
  return { open: atom(false), width: atom(320) };
}

/**
 * Ambient: it binds nothing at runtime, so the scan must skip it rather than throw. It lives here
 * rather than in \`workspace.ts\` because its type annotation reads as a \`$\` binding to the
 * narrow gate's regex, which would parse \`workspace.ts\` and leave that case nothing to prove.
 */
declare const $ambientOnly: { get: () => number };
export type AmbientKind = typeof $ambientOnly;
`,

  [WORKSPACE]: `
import { createPanel } from "./panel.ts";

/**
 * No nanostores import and no \`$\` name, so only the wide parse gate sees this file at all.
 * Without it nothing appends \`own()\` here, the binding scan never runs, and every store below
 * stays under the file that built it however good the scan is.
 */
export const panel = createPanel();
export const sidebar = createPanel();

/** A \`Set\` has no keys, so its members are named by insertion order. */
export const pool = new Set([createPanel(), createPanel()]);

/** More members than anyone reads one by one, and the walk still gives every one of them a node. */
export const many = Array.from({ length: 30 }, () => createPanel());
`,

  [REMOTE]: `
import { atom } from "nanostores";

/** A frame must not span an \`await\`: it would stay open across every other module's stores. */
export async function loadRemote() {
  return { $ready: atom(true) };
}

export const remote = await loadRemote();
`,

  [HELPERS]: `
import { atom } from "nanostores";

/**
 * The last registration says which function holds a store, so one made inside a helper and then
 * adopted at a top-level binding stops belonging to the helper and is drawn flat.
 */
function makeFlag() {
  const $inner = atom(false);

  return $inner;
}

export const $flag = makeFlag();

/**
 * A store this file keeps in a closure, which nothing at the end of the module body reaches. It is
 * the developer's own, so the creation frame still places it under what the call handed back. Its
 * value is a plain object, which draws exactly like a node until you read the key.
 */
function makeBoard() {
  const $layout = atom({ columns: 2, gap: 8 });

  return atom(\`\${$layout.get().columns} columns\`);
}

export const $board = makeBoard();

/**
 * Two closures a binding holds and no walk can open. \`readOne\` is a function, so the frame around
 * it has nothing to make a parent out of and the scan has nothing to walk, which leaves both stores
 * placed by nothing at all and drawn nowhere.
 */
export function firstRound(): () => number {
  function build() {
    const $one = atom(1);

    return () => $one.get();
  }

  return build();
}

export function secondRound(): () => number {
  function build() {
    const $two = atom(2);

    return () => $two.get();
  }

  return build();
}

export const readOne = firstRound();
export const readTwo = secondRound();
`,

  [SITES]: `
/**
 * The guard on the line the developer wrote. The blank lines here collapse and the type arguments
 * are dropped once the bundler's own TypeScript transform has been through, so a walk that ran
 * after it would record a line several above the real one.
 *
 * Two held bindings hold a store of one name, and a name two sites claim is what makes each of
 * them show its place, so the recorded line can be read straight off what the model hands out.
 */
import { atom } from "nanostores";

// @nanostores-devtools:throttle 250
export const $frame = atom<number>(0);

export const one = {
  $dup: atom<number>(1),
};

export const two = {
  $dup: atom<number>(2),
};
`,
};

const FILES: Record<string, string> = { ...VENDOR, ...APP };

/**
 * The fixture served from memory, so nothing is written to disk and the module ids read like a real
 * app's. `enforce: "pre"` keeps it ahead of the resolver that would look for these on disk.
 */
export function treeFixture(): Plugin {
  return {
    name: "tree-fixture",
    enforce: "pre",
    resolveId(id, importer) {
      if (id in FILES) {
        return id;
      }

      if (importer === undefined || !id.startsWith(".")) {
        return null;
      }

      /** Vite hands out ids with `/` separators on every platform, so posix is the right join. */
      const resolved = posix.join(posix.dirname(importer), id);

      return resolved in FILES ? resolved : null;
    },
    load: (id) => FILES[id] ?? null,
  };
}
