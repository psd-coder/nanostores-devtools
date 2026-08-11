import type { Store } from "nanostores";

import {
  getDevtoolsGlobal,
  type ModuleScope,
  peekDevtoolsGlobal,
  type SiteState,
} from "../global.ts";
import {
  evictStore,
  getEntry,
  registerStore,
  type StoreType,
  unregisterStore,
} from "../registry.ts";

export type { StoreType };

/** Module, name, enclosing function and line: one place in the source where a store is made. */
export type CreationSite = {
  name: string | null;
  fn: string | null;
  line: number;
  type: StoreType;
};

export type FileScope = {
  store: <TStore>(store: TStore, site: CreationSite) => TStore;
  adopt: <TValue>(value: TValue, site: CreationSite) => TValue;
  clear: () => void;
};

export function fileScope(moduleId: string, home: string, maxStoresPerSite: number): FileScope {
  function take(site: CreationSite, store: Store, name: string, type: StoreType): void {
    const scope = scopeOf(moduleId);
    const state = siteState(scope, site);

    /** One store handed back twice is one store: a second number would rename the first entry. */
    if (state.stores.includes(store)) {
      return;
    }

    state.made += 1;

    const entry = registerStore({
      store,
      name: state.made === 1 ? name : `${name} #${state.made}`,
      home,
      type,
      origin: "plugin",
    });

    /** An explicit registration keeps the store, so this module neither owns nor drops it. */
    if (entry.home !== home) {
      return;
    }

    state.stores.push(store);
    scope.owned.add(store);
    enforceCap(scope, state, maxStoresPerSite);
  }

  return {
    /**
     * A creation site with no name records its type and stays out of the tree: every store one
     * factory line makes carries the same name, and only the call site knows the right one.
     */
    store(store, site) {
      if (isStore(store)) {
        if (site.name === null) {
          getDevtoolsGlobal().creations.set(store, site.type);
        } else {
          take(site, store, site.name, site.type);
        }
      }

      return store;
    },

    adopt(value, site) {
      if (isStore(value) && site.name !== null) {
        take(site, value, site.name, adoptedType(value, site));
      }

      return value;
    },

    /**
     * The top of the module body runs this on every execution, so it is nothing on a first run
     * and the hot-reload wipe on every later one. It touches no other module and it must not
     * bring the registry into being, because a module that declares no store registers nothing.
     */
    clear() {
      const devtools = peekDevtoolsGlobal();
      const scope = devtools?.scopes.get(moduleId);

      if (!devtools || !scope) {
        return;
      }

      devtools.scopes.delete(moduleId);

      for (const store of scope.owned) {
        /** A store an explicit group took is drawn there now, so this module no longer owns it. */
        if (getEntry(store)?.home === home) {
          unregisterStore(store);
        }
      }
    },
  };
}

/** A type the store already carries beats the one an adopt site can give, which is none. */
function adoptedType(store: Store, site: CreationSite): StoreType {
  const registered = getEntry(store)?.type;

  if (registered !== undefined && registered !== "unknown") {
    return registered;
  }

  return peekDevtoolsGlobal()?.creations.get(store) ?? site.type;
}

/**
 * Unmounted first and oldest of those first, but never the store just taken: the cap keeps the
 * last stores of a site, and a factory that makes the app's real store early and then makes many
 * short-lived ones would otherwise lose the one store the developer came to look at.
 */
function enforceCap(scope: ModuleScope, state: SiteState, cap: number): void {
  if (state.stores.length <= cap) {
    return;
  }

  /** A store the registry lost to somebody else's label holds no slot here either. */
  state.stores = state.stores.filter((store) => getEntry(store) !== undefined);

  while (state.stores.length > cap) {
    const [doomed] = state.stores.splice(doomedIndex(state.stores), 1);

    if (doomed) {
      scope.owned.delete(doomed);
      evictStore(doomed);
    }
  }
}

function doomedIndex(stores: Store[]): number {
  const unmounted = stores.slice(0, -1).findIndex((store) => store.lc === 0);

  return unmounted === -1 ? 0 : unmounted;
}

function scopeOf(moduleId: string): ModuleScope {
  const { scopes } = getDevtoolsGlobal();
  const known = scopes.get(moduleId);

  if (known) {
    return known;
  }

  const created: ModuleScope = { owned: new Set(), sites: new Map() };

  scopes.set(moduleId, created);

  return created;
}

function siteState(scope: ModuleScope, site: CreationSite): SiteState {
  const key = [site.name, site.fn, site.line].join("\u0000");
  const known = scope.sites.get(key);

  if (known) {
    return known;
  }

  const created: SiteState = { made: 0, stores: [] };

  scope.sites.set(key, created);

  return created;
}

/** The wrapped expression is whatever the developer wrote, so a value that is no store passes. */
function isStore(value: unknown): value is Store {
  return (
    typeof value === "object" &&
    value !== null &&
    "listen" in value &&
    typeof value.listen === "function" &&
    "lc" in value &&
    typeof value.lc === "number"
  );
}
