import type { StoreType } from "../stores/registry.ts";

/**
 * What a package's store making exports return, keyed by the name the package exports. This is the
 * shape a developer writes in the `storeTypes` option, and the shape the built-in map is written in.
 */
export type StoreTypesOption = Readonly<Record<string, Readonly<Record<string, StoreType>>>>;

/** The same thing after the merge, keyed for lookup: package name, then export name. */
export type PackageStoreTypes = ReadonlyMap<string, ReadonlyMap<string, StoreType>>;

/**
 * The kinds the plugin ships, read off the Smart Stores list in the nanostores README. Each kind is
 * the nanostores primitive that package's own source builds the store on, so `computedAsync` is an
 * atom whatever its name says.
 *
 * The map only names kinds. Finding the store is adoption's job, so a package here and a package
 * missing from here both reach the tree the same way.
 */
export const KNOWN_STORE_TYPES: StoreTypesOption = {
  "@alexcarpenter/form": { createForm: "atom", form: "atom" },
  "@alexcarpenter/machine": { machine: "atom" },
  "@illuxiza/nanostores-immer": { atom: "atom" },
  "@logux/client": { createAuth: "atom", createClientStore: "atom", createFilter: "map" },
  "@nanostores/async": { computedAsync: "atom", computedAsyncNoCascade: "atom" },
  "@nanostores/deepmap": { deepMap: "deepMap" },
  "@nanostores/i18n": { browser: "atom", formatter: "computed", localeFrom: "atom" },
  "@nanostores/media-query": { fromMediaQuery: "atom" },
  "@nanostores/persistent": {
    persistentAtom: "atom",
    persistentBoolean: "atom",
    persistentJSON: "atom",
    persistentMap: "map",
  },
  "@nanostores/router": { createRouter: "atom" },
  "@nanostores/sql": { migrateIfNeeded: "atom" },
};

/**
 * The built-in map with a developer's own entries laid over it, per package and per export, so
 * adding a package or correcting one export costs nothing but that line. A `Map` rather than the
 * plain object it is written as, because a package or an export named `constructor` reads back off
 * an object as something that is no kind at all.
 */
export function mergeStoreTypes(added: StoreTypesOption | undefined): PackageStoreTypes {
  const merged = new Map<string, Map<string, StoreType>>();

  for (const [name, exports] of [
    ...Object.entries(KNOWN_STORE_TYPES),
    ...Object.entries(added ?? {}),
  ]) {
    const held = merged.get(name) ?? new Map<string, StoreType>();

    for (const [exported, type] of Object.entries(exports)) {
      held.set(exported, type);
    }

    merged.set(name, held);
  }

  return merged;
}
