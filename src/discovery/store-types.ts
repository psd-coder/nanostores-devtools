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

/** The merged map the run is handed, and what the developer is told about the entries refused. */
export type StoreTypesSetting = { types: PackageStoreTypes; warnings: string[] };

/** The kinds a store may carry, as a value, so an entry naming anything else can be refused. */
const STORE_TYPE_KINDS = {
  atom: true,
  map: true,
  deepMap: true,
  computed: true,
  batched: true,
  unknown: true,
} satisfies Record<StoreType, true>;

const KIND_LIST = Object.keys(STORE_TYPE_KINDS).join(", ");

function isStoreType(value: unknown): value is StoreType {
  return typeof value === "string" && Object.hasOwn(STORE_TYPE_KINDS, value);
}

/** A refused value is whatever a config held, and `JSON.stringify` throws on a few of those. */
function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return typeof value;
  }
}

/** An array reads back as exports named `0` and `1`, so it is no map of anything either. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The built-in map with a developer's own entries laid over it, per package and per export, so
 * adding a package or correcting one export costs nothing but that line. A `Map` rather than the
 * plain object it is written as, because a package or an export named `constructor` reads back off
 * an object as something that is no kind at all.
 *
 * Takes `unknown` because the option reaches a plain JavaScript config with no type to stop it. An
 * entry we cannot read is dropped rather than baked into the transformed source, and dropped one
 * entry at a time, so one typo leaves every entry beside it where it was.
 */
export function resolveStoreTypes(value: unknown): StoreTypesSetting {
  const types = new Map<string, Map<string, StoreType>>();
  const warnings: string[] = [];

  for (const [name, exports] of Object.entries(KNOWN_STORE_TYPES)) {
    types.set(name, new Map(Object.entries(exports)));
  }

  if (value === undefined) {
    return { types, warnings };
  }

  if (!isRecord(value)) {
    warnings.push(
      `storeTypes is ${describeValue(value)} in your devtools options, which is no map of ` +
        `packages, so the plugin reads the packages it ships and nothing else. Pass an object ` +
        `keyed by package name.`,
    );

    return { types, warnings };
  }

  for (const [name, exports] of Object.entries(value)) {
    if (!isRecord(exports)) {
      warnings.push(
        `storeTypes["${name}"] is ${describeValue(exports)} in your devtools options, which is ` +
          `no map of exports, so the plugin reads no kind off that package. Pass an object keyed ` +
          `by export name.`,
      );
      continue;
    }

    const held = types.get(name) ?? new Map<string, StoreType>();

    for (const [exported, kind] of Object.entries(exports)) {
      if (!isStoreType(kind)) {
        warnings.push(
          `storeTypes["${name}"]["${exported}"] is ${describeValue(kind)} in your devtools ` +
            `options, which is no store kind, so the plugin reads no kind off that export. Pass ` +
            `one of ${KIND_LIST}.`,
        );
        continue;
      }

      held.set(exported, kind);
    }

    types.set(name, held);
  }

  return { types, warnings };
}
