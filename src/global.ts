import type { Store } from "nanostores";

import { forgetDrawn } from "./tree/drawn.ts";
import type { RegistryChange, StoreEntry, StoreType } from "./stores/registry.ts";
import type { Session } from "./session.ts";

export type ChangeListener = (change: RegistryChange) => void;

/** One store a creation site made, with the number that names it: `$items #3`. */
export type SiteStore = { store: Store; number: number };

/** One place in the source where a store is made, plus the live ones it holds, oldest first. */
export type SiteState = {
  name: string;
  fn: string | null;
  line: number;
  /** The file the name says it came from, once a second module sharing the home claims `name`. */
  file: string | null;
  /** Whether the name says the place it was made, once a second site here claims `name`. */
  placed: boolean;
  made: number;
  stores: SiteStore[];
};

/**
 * One module's hold on one name at one display home, and everything named after it, so a name
 * that turns ambiguous later renames what it already gave out.
 */
export type NameHolder = {
  /** The file every entry of this holder names, and nothing while the module holds the name alone. */
  file: string | null;
  sites: SiteState[];
  /**
   * The stores a top-level binding of the module's own named, which the sites do not hold. Weak,
   * so a name the app has let go keeps nothing alive.
   */
  bound: WeakRef<Store>[];
};

/** Which modules took one name at one display home, keyed by the module key. */
export type NameClaim = Map<string, NameHolder>;

/**
 * One instrumented module's own bookkeeping. It outlives the module body, because a hot reload
 * runs that body again and the new run has to drop what the old one left behind.
 */
export type ModuleScope = {
  owned: Set<Store>;
  sites: Map<string, SiteState>;
  /** Which sites took a plain name, so the one arriving next can rename every one of them. */
  claims: Map<string, SiteState[]>;
};

/**
 * Which mechanism drew an owner edge, which is what decides whether another one may replace it: a
 * frame only knows that a store was born while an expression ran, and the other two know a name.
 */
export type OwnerSource = "frame" | "scan" | "field";

/** What one store is drawn under, what put it there, and the key that owner knows it by. */
export type OwnerLink = {
  owner: WeakRef<object>;
  source: OwnerSource;
  /**
   * The key a collection knows the store by, `[0]` or `["scratch"]`. A position or a map key is the
   * only name that says which member the store is, and the name it was born with cannot say it.
   * Nothing for every other owner, where the store's own name is already the key.
   */
  key: string | undefined;
};

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
  /** Which store holds each name, keyed by the name key the registry builds. */
  byName: Map<string, Store>;
  /** The next registration number. Handed out here, so two copies of the package share the count. */
  nextId: number;
  changeListeners: Set<ChangeListener>;
  warned: Set<string>;
  /** Keyed by the module key, never the display home, so two files cannot wipe each other. */
  scopes: Map<string, ModuleScope>;
  /**
   * Which module took each name at each display home, keyed by the label the name makes. `fileKey`
   * can map two modules onto one home, and this is what keeps the two `$counter`s they hold apart.
   */
  homeNames: Map<string, NameClaim>;
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
  /** The creation frames open right now, the innermost last. Empty between two ticks. */
  frames: OpenFrame[];
  session?: Session | undefined;
};

/**
 * The marker is the shape of what sits behind the key, not the package version, so two
 * copies of the same major share one registry instead of drawing half a tree each.
 *
 * That promise is what keeps the shape here: everything two copies must agree on sits behind this
 * one key, and this file states that shape in full, so one read shows the whole agreement. A type
 * that is no part of that shared shape lives with the module that owns it.
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
    byName: new Map(),
    nextId: 1,
    changeListeners: new Set(),
    warned: new Set(),
    scopes: new Map(),
    homeNames: new Map(),
    creations: new WeakMap(),
    owners: new WeakMap(),
    bound: new WeakMap(),
    nodes: new WeakMap(),
    frames: [],
  };

  holder()[GLOBAL_KEY] = created;

  return created;
}

export function peekDevtoolsGlobal(): DevtoolsGlobal | undefined {
  return holder()[GLOBAL_KEY];
}

/**
 * The drawn set lives in its own module rather than behind the shared key, because it is one
 * connection's own record and not a shape two copies of the package have to agree on. It is dropped
 * here even so, or a store the last run drew would still count as drawn for the next one.
 */
export function resetDevtoolsGlobal(): void {
  delete holder()[GLOBAL_KEY];
  forgetDrawn();
}
