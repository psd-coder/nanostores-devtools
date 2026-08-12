import type { Store } from "nanostores";

import type { Bridge } from "./connect.ts";
import type { RegistryChange, StoreEntry, StoreType } from "./registry.ts";

export type ChangeListener = (change: RegistryChange) => void;

/** One store a creation site made, with the number that names it: `$items #3`. */
export type SiteStore = { store: Store; number: number };

/** One place in the source where a store is made, plus the live ones it holds, oldest first. */
export type SiteState = {
  name: string;
  fn: string | null;
  line: number;
  /** What the entries are named. It grows a place suffix once a second site claims `name`. */
  display: string;
  made: number;
  stores: SiteStore[];
};

/**
 * One instrumented module's own bookkeeping. It outlives the module body, because a hot reload
 * runs that body again and the new run has to drop what the old one left behind.
 */
export type ModuleScope = {
  owned: Set<Store>;
  sites: Map<string, SiteState>;
  /** Which site took a plain name first, so the second one can rename both. */
  claims: Map<string, SiteState>;
};

/**
 * Which mechanism drew an owner edge, which is what decides whether another one may replace it: a
 * frame only knows that a store was born while an expression ran, and the other two know a name.
 */
export type OwnerSource = "frame" | "scan" | "field";

/** What one store is drawn under, and what put it there. */
export type OwnerLink = { owner: WeakRef<object>; source: OwnerSource };

/**
 * What each store is drawn under: another store, or a node holding it. Weak on both sides: the map
 * holds no store held, and the reference to an owner holds none either, so devtools keeps nothing
 * alive that the app has let go.
 */
export type Owners = WeakMap<Store, OwnerLink>;

/**
 * One creation frame, open while a top-level initializer runs, holding the stores born while it
 * was. A store kept in a closure is reachable from nothing, so this is all that places it.
 */
export type OpenFrame = { stores: Store[] };

/**
 * A thing in the tree that holds others and has no value of its own: a class instance, an object a
 * factory returned, an array, a `Map` or a `Set`. The value itself is the node, so a node is looked
 * up by identity and never by the name it carried when a store was placed under it.
 */
export type NodeInfo = {
  /** The file the binding that named it was written in, and whether that file is somebody else's. */
  home: string;
  external: boolean;
  /** As the developer wrote it: a binding, a property key, an array index, a `Map` key. */
  name: string;
  /**
   * Whether the name is ours rather than the developer's, which is what lets a name written in the
   * source replace one we invented. A written name is never replaced.
   */
  ours: boolean;
  /**
   * Whether the key always takes an ordinal, even where no other node wants the same name. A node
   * we found no name at all for needs it (`ref#1` says which one it is and nothing else does), and
   * a node named after something written does not, so it waits for a real clash like every other.
   */
  numbered: boolean;
  /**
   * What built the value, `Editor` or `Array`. Its own field rather than part of the name, because
   * the tree draws the two apart: the name is the key, and this is the label behind it. `Object`
   * says nothing a plain object node does not already say, so it is left out.
   */
  type: string | undefined;
  /** What holds the node, a store or another node, so a collection's member nests under it. */
  parent: WeakRef<object> | undefined;
  /** How many members of a collection the walk left out past its cap. */
  skipped: number;
};

/** What each walked value stands for in the tree. Weak, so devtools keeps no instance alive. */
export type Nodes = WeakMap<object, NodeInfo>;

export type DevtoolsGlobal = {
  entries: Map<Store, StoreEntry>;
  byLabel: Map<string, Store>;
  changeListeners: Set<ChangeListener>;
  warned: Set<string>;
  /** Keyed by the module id, never the display home, so two files cannot wipe each other. */
  scopes: Map<string, ModuleScope>;
  /** The type of a store made at a creation site with no name, until an adopt call names it. */
  creations: WeakMap<Store, StoreType>;
  /** What each store is drawn under, which the registry knows nothing about. */
  owners: Owners;
  /**
   * Which stores a top-level binding of the developer's own names, and whether the developer
   * exported that binding. The flag settles which of two bindings for one store wins; the name
   * itself is written onto the entry, because the whole point is that the registry draws it.
   */
  bound: WeakMap<Store, boolean>;
  /** The nodes drawing has made, which hold stores the registry keeps no place for. */
  nodes: Nodes;
  /**
   * The node standing for one enclosing function, keyed by its home and its name, so every store
   * that function made and nothing else placed lands in one node. Held strongly: a marker object
   * is what the node is, so nothing else keeps it alive.
   */
  functions: Map<string, object>;
  /** The creation frames open right now, the innermost last. Empty between two ticks. */
  frames: OpenFrame[];
  bridge?: Bridge | undefined;
};

/**
 * The marker is the shape of what sits behind the key, not the package version, so two
 * copies of the same major share one registry instead of drawing half a tree each.
 */
export const GLOBAL_KEY: unique symbol = Symbol.for("nanostores-devtools/v1");

type GlobalHolder = { [GLOBAL_KEY]?: DevtoolsGlobal };

/** The one cast in the package: `globalThis` cannot be typed with a symbol key any other way. */
function holder(): GlobalHolder {
  return globalThis as GlobalHolder;
}

export function getDevtoolsGlobal(): DevtoolsGlobal {
  const existing = holder()[GLOBAL_KEY];

  if (existing) {
    return existing;
  }

  const created: DevtoolsGlobal = {
    entries: new Map(),
    byLabel: new Map(),
    changeListeners: new Set(),
    warned: new Set(),
    scopes: new Map(),
    creations: new WeakMap(),
    owners: new WeakMap(),
    bound: new WeakMap(),
    nodes: new WeakMap(),
    functions: new Map(),
    frames: [],
  };

  holder()[GLOBAL_KEY] = created;

  return created;
}

export function peekDevtoolsGlobal(): DevtoolsGlobal | undefined {
  return holder()[GLOBAL_KEY];
}

export function resetDevtoolsGlobal(): void {
  delete holder()[GLOBAL_KEY];
}
