import type { Store } from "nanostores";

import {
  getDevtoolsGlobal,
  type ModuleScope,
  peekDevtoolsGlobal,
  type SiteState,
  type SiteStore,
} from "../global.ts";
import {
  evictStore,
  getEntry,
  makeLabel,
  registerStore,
  type StoreType,
  unregisterStore,
} from "../registry.ts";
import { warnOnce } from "../warn.ts";

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

export function fileScope(
  moduleId: string,
  home: string,
  maxStoresPerSite: number,
  external: boolean,
): FileScope {
  function take(site: CreationSite, store: Store, name: string, type: StoreType): void {
    const scope = scopeOf(moduleId);
    const state = siteState(scope, site, name);

    /** One store handed back twice is one store: a second number would rename the first entry. */
    if (state.stores.some((held) => held.store === store)) {
      return;
    }

    state.made += 1;
    claimName(scope, state, home);

    const entry = registerStore({
      store,
      name: numbered(state.display, state.made),
      home,
      type,
      origin: "plugin",
      external,
    });

    /** An explicit registration keeps the store, so this module neither owns nor drops it. */
    if (entry.home !== home) {
      return;
    }

    state.stores.push({ store, number: state.made });
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

/**
 * Two source lines wanting one name is a real clash, so both sides take the place suffix: one
 * bare `$counter` next to `$counter (line 20)` does not say which of the two lines it came from.
 */
function claimName(scope: ModuleScope, state: SiteState, home: string): void {
  const owner = scope.claims.get(state.name);

  if (owner === undefined) {
    scope.claims.set(state.name, state);

    return;
  }

  if (owner === state) {
    return;
  }

  const both = `${placeOf(owner)} and ${placeOf(state)}`;

  suffixSite(owner, home);
  suffixSite(state, home);
  warnOnce(
    "name-clash",
    makeLabel(home, state.name),
    `"${state.name}" is made in two places in "${home}": ${both}. Both entries show their place.`,
  );
}

function suffixSite(state: SiteState, home: string): void {
  if (state.display !== state.name) {
    return;
  }

  state.display = `${state.name} (${placeOf(state)})`;

  for (const held of state.stores) {
    const entry = getEntry(held.store);

    /** A store an explicit group took carries a hand-written name, which this must not touch. */
    if (entry?.home === home) {
      registerStore({
        store: held.store,
        name: numbered(state.display, held.number),
        home,
        type: entry.type,
        origin: "plugin",
        external: entry.external,
      });
    }
  }
}

function placeOf(state: SiteState): string {
  return state.fn === null ? `line ${state.line}` : `${state.fn}, line ${state.line}`;
}

function numbered(display: string, made: number): string {
  return made === 1 ? display : `${display} #${made}`;
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
  state.stores = state.stores.filter((held) => getEntry(held.store) !== undefined);

  while (state.stores.length > cap) {
    const [doomed] = state.stores.splice(doomedIndex(state.stores), 1);

    if (doomed) {
      scope.owned.delete(doomed.store);
      evictStore(doomed.store);
    }
  }
}

function doomedIndex(stores: SiteStore[]): number {
  const unmounted = stores.slice(0, -1).findIndex((held) => held.store.lc === 0);

  return unmounted === -1 ? 0 : unmounted;
}

function scopeOf(moduleId: string): ModuleScope {
  const { scopes } = getDevtoolsGlobal();
  const known = scopes.get(moduleId);

  if (known) {
    return known;
  }

  const created: ModuleScope = { owned: new Set(), sites: new Map(), claims: new Map() };

  scopes.set(moduleId, created);

  return created;
}

function siteState(scope: ModuleScope, site: CreationSite, name: string): SiteState {
  const key = [site.name, site.fn, site.line].join("\u0000");
  const known = scope.sites.get(key);

  if (known) {
    return known;
  }

  const created: SiteState = {
    name,
    fn: site.fn,
    line: site.line,
    display: name,
    made: 0,
    stores: [],
  };

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
