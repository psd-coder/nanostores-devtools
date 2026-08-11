import type { Store } from "nanostores";

import type { Bridge } from "./connect.ts";
import type { RegistryChange, StoreEntry, StoreType } from "./registry.ts";

export type ChangeListener = (change: RegistryChange) => void;

/** How many stores one creation site has made, and the live ones it still holds, oldest first. */
export type SiteState = { made: number; stores: Store[] };

/**
 * One instrumented module's own bookkeeping. It outlives the module body, because a hot reload
 * runs that body again and the new run has to drop what the old one left behind.
 */
export type ModuleScope = { owned: Set<Store>; sites: Map<string, SiteState> };

export type DevtoolsGlobal = {
  entries: Map<Store, StoreEntry>;
  byLabel: Map<string, Store>;
  changeListeners: Set<ChangeListener>;
  warned: Set<string>;
  /** Keyed by the module id, never the display home, so two files cannot wipe each other. */
  scopes: Map<string, ModuleScope>;
  /** The type of a store made at a creation site with no name, until an adopt call names it. */
  creations: WeakMap<Store, StoreType>;
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
