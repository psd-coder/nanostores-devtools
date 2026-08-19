import type { Store } from "nanostores";

import {
  getDevtoolsGlobal,
  type ModuleScope,
  peekDevtoolsGlobal,
  type SiteState,
  type SiteStore,
} from "./global.ts";
import { claimSiteName, releaseSiteNames, siteParts } from "./stores/names.ts";
import {
  beginFrame,
  type Binding,
  type BindingHome,
  endFrame,
  noteBirth,
  ownBindings,
  ownField,
} from "./stores/ownership.ts";
import {
  evictStore,
  getEntry,
  isStore,
  registerStore,
  type StoreType,
  unregisterStore,
} from "./stores/registry.ts";
import type { ThrottleComment } from "./timeline/throttle.ts";

export type { StoreType };

/** Module, name, enclosing function and line: one place in the source where a store is made. */
export type CreationSite = {
  name: string | null;
  fn: string | null;
  line: number;
  type: StoreType;
  /**
   * What a comment standing over the statement said: a bare mark, the rate in milliseconds it holds
   * the store to, or `false` from `// @devtools-no-throttle`, which spares it the automatic catch.
   */
  throttle?: ThrottleComment;
};

export type FileScope = {
  store: <TStore>(store: TStore, site: CreationSite, owner?: object) => TStore;
  adopt: <TValue>(value: TValue, site: CreationSite) => TValue;
  own: (bindings: readonly Binding[]) => void;
  begin: () => void;
  end: <TValue>(value: TValue, site: CreationSite) => TValue;
  clear: () => void;
};

export function fileScope(
  moduleKey: string,
  home: string,
  maxStoresPerSite: number,
  external: boolean,
): FileScope {
  /**
   * Where a node this module names is drawn, which every placement it asks for is handed, and the
   * key that tells it from another module the display home holds as well.
   */
  const module: BindingHome = { home, external, moduleKey };

  function take(site: CreationSite, store: Store, name: string, type: StoreType): void {
    const scope = scopeOf(moduleKey);
    const state = siteState(scope, site, name);

    /** One store handed back twice is one store: a second number would rename the first entry. */
    if (state.stores.some((held) => held.store === store)) {
      return;
    }

    state.made += 1;
    claimSiteName(scope, state, module);

    /** A store the registry does not know yet is born here, which is what an open frame catches. */
    if (getEntry(store) === undefined) {
      noteBirth(store);
    }

    const entry = registerStore({
      store,
      name: state.name,
      home,
      type,
      origin: "plugin",
      external,
      fn: site.fn,
      throttle: site.throttle,
      ...siteParts(state, state.made),
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
     *
     * `owner` is the `this` of a class field initializer: the new instance, or the class itself
     * for a static field.
     */
    store(store, site, owner) {
      if (isStore(store)) {
        if (site.name === null) {
          getDevtoolsGlobal().creations.set(store, site.type);
        } else {
          take(site, store, site.name, site.type);
        }

        if (owner !== undefined) {
          ownField(module, store, owner);
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
     * The end of the module body, where every top-level binding holds its value. It places the
     * stores a binding holds and registers nothing, so where a store is drawn is the only thing
     * this can change.
     */
    own(bindings) {
      ownBindings(module, bindings);
    },

    /**
     * The frame around one top-level initializer, opened before the expression runs and closed on
     * the value it returned. It is the only mechanism that reaches a store the expression kept in
     * a closure, where no property walk can find it.
     */
    begin() {
      beginFrame();
    },

    end(value, site) {
      endFrame(module, value, site.name);

      return value;
    },

    /**
     * The top of the module body runs this on every execution, so it is nothing on a first run
     * and the hot-reload wipe on every later one. It touches no other module and it must not
     * bring the registry into being, because a module that declares no store registers nothing.
     */
    clear() {
      const devtools = peekDevtoolsGlobal();
      const scope = devtools?.scopes.get(moduleKey);

      if (!devtools || !scope) {
        return;
      }

      releaseSiteNames(scope, module);
      devtools.scopes.delete(moduleKey);

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
  /**
   * An empty list is still longer than a cap below zero, so the loop would take from nothing for
   * ever. A floor of zero holds no store at all, the one just taken included.
   */
  const limit = Math.max(cap, 0);

  if (state.stores.length <= limit) {
    return;
  }

  /** A store the registry lost to somebody else's label holds no slot here either. */
  state.stores = state.stores.filter((held) => getEntry(held.store) !== undefined);

  while (state.stores.length > limit) {
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

function scopeOf(moduleKey: string): ModuleScope {
  const { scopes } = getDevtoolsGlobal();
  const known = scopes.get(moduleKey);

  if (known) {
    return known;
  }

  const created: ModuleScope = { owned: new Set(), sites: new Map(), claims: new Map() };

  scopes.set(moduleKey, created);

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
    file: null,
    placed: false,
    made: 0,
    stores: [],
  };

  scope.sites.set(key, created);

  return created;
}
