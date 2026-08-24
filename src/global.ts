import type { Store } from "nanostores";

import type { RegistryChange, StoreEntry, StoreType } from "./stores/registry.ts";
import type { Session } from "./session.ts";

export type ChangeListener = (change: RegistryChange) => void;

/** One store a creation site made, with the number that names it: `$items #3`. */
export type SiteStore = { store: Store; number: number };

/** One place in the source where a store is made, plus the live ones it holds, oldest first. */
export type SiteState = {
  name: string;
  line: number;
  /** The file the name says it came from, once a second module sharing the home claims `name`. */
  file: string | null;
  /** Whether the name says the place it was made, once a second site here claims `name`. */
  placed: boolean;
  made: number;
  /**
   * Every store this site registered. A name that turns ambiguous later renames all of them, and
   * the runtime reads the list to spot one store handed back twice. A factory called twice from one
   * module body registers twice at one site, so it is a list and not one slot.
   */
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
  /**
   * Every value this run of the module linked into the graph: a store it gave an owner link or a
   * binding name, and a node it gave a parent. A `WeakMap` cannot be listed, so a reload has no
   * other way to find the links it has to drop. Held weakly, so the list keeps nothing alive.
   *
   * A `Set` rather than an array, because the app owns `Array.prototype` and an accessor it defines
   * on an index there makes a `push` past that index throw.
   */
  linked: Set<WeakRef<object>>;
};

/**
 * One top-level binding that holds a store: where it is written, and what it calls the store. The
 * home rides along because two bindings in two modules put one store at two different homes, and a
 * name with no home cannot be drawn.
 */
export type BoundName = {
  name: string;
  home: string;
  /** The file the name shows, once a second module the home holds writes that name too. */
  file: string | null;
  /** The module that wrote it, so a hot reload drops exactly its own. */
  moduleKey: string;
  /** Whether the developer exported it, which is what settles which binding the entry takes. */
  exported: boolean;
};

/** What one store is drawn under, the key that owner knows it by, and the path that reached it. */
export type OwnerLink = {
  owner: WeakRef<object>;
  /** The module whose run drew the edge, so a hot reload of that module drops exactly its own. */
  moduleKey: string;
  /**
   * The key a collection knows the store by, `[0]` or `["scratch"]`. A position or a map key is the
   * only name that says which member the store is, and the name it was born with cannot say it.
   * Nothing for every other owner, where the store's own name is already the key.
   */
  key: string | undefined;
  /**
   * The whole chain the scan walked to reach the store through this owner, `right.$shared`. The
   * entry takes the first one of them and the rest are what a change lists beside it, so a
   * developer holding one store in two places sees both. Nothing for a link no scan drew.
   */
  path: string | undefined;
};

/**
 * What each store is drawn under: another store, or a node holding it, once per reference the
 * developer wrote. Weak on both sides: the map holds no store held, and the reference to an owner
 * holds none either, so devtools keeps nothing alive that the app has let go.
 *
 * Every link is a reference the developer wrote, and every one of them draws.
 */
export type Owners = WeakMap<Store, OwnerLink[]>;

/** What holds a node, on the same terms an `OwnerLink` holds a store. */
export type ParentLink = { parent: WeakRef<object>; moduleKey: string };

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
  /**
   * What holds the node, a store or another node, so a collection's member nests under it. One per
   * reference the developer wrote: two containers holding one node both draw it.
   */
  parents: ParentLink[];
  /** How many members the walk drew, which is the number the binding's own cap named. */
  walked: number;
  /** How many members the walk left out, past the number the binding named. */
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
   * Which store sits at each key of each owner, so a second store found at a key another one
   * already took drops that one's link. One key holds one value, and the scan reads it at the end
   * of a module body, so the last scan to walk the owner saw the truth.
   *
   * Weak on both sides: the owner keeps nothing alive, and neither does the store behind a key.
   */
  keyed: WeakMap<object, Map<string, WeakRef<Store>>>;
  /**
   * Every top-level binding of the developer's own that holds each store. All of them draw, and
   * the one the primary rule picks is written onto the entry, because the whole point is that the
   * registry draws it.
   */
  bound: WeakMap<Store, BoundName[]>;
  /** The nodes drawing has made, which hold stores the registry keeps no place for. */
  nodes: Nodes;
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
    keyed: new WeakMap(),
    bound: new WeakMap(),
    nodes: new WeakMap(),
  };

  holder()[GLOBAL_KEY] = created;

  return created;
}

/**
 * One module's own bookkeeping, made on first use. `scopes` is part of the shape two copies of the
 * package share, so the one call that brings a scope into being sits with it.
 */
export function scopeOf(moduleKey: string): ModuleScope {
  const { scopes } = getDevtoolsGlobal();
  const known = scopes.get(moduleKey);

  if (known) {
    return known;
  }

  const created: ModuleScope = {
    owned: new Set(),
    sites: new Map(),
    claims: new Map(),
    linked: new Set(),
  };

  scopes.set(moduleKey, created);

  return created;
}

export function peekDevtoolsGlobal(): DevtoolsGlobal | undefined {
  return holder()[GLOBAL_KEY];
}

export function resetDevtoolsGlobal(): void {
  delete holder()[GLOBAL_KEY];
}
