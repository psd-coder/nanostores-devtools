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
 * Which store each store is drawn under. Weak on both sides: the map holds no store held, and the
 * reference to an owner holds none either, so devtools keeps nothing alive that the app has let go.
 */
export type Owners = WeakMap<Store, WeakRef<Store>>;

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
