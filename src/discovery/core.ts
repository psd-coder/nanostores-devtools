import type { ModuleKeys, ModuleRoots } from "./module-keys.ts";
import { moduleKeys } from "./module-keys.ts";
import type { Parser } from "./parser.ts";
import { mergeStoreTypes, type StoreTypesOption } from "./store-types.ts";
import { type StoreTransform, transformStores } from "./transform.ts";

/** Everything a developer sets that no bundler has an opinion about. */
export type DiscoveryOptions = {
  fileKey?: ((path: string) => string) | undefined;
  adoptFactories?: boolean | undefined;
  maxStoresPerSite?: number | undefined;
  /**
   * Packages the plugin should read a kind off, laid over the built-in map per package and per
   * export, so adding a package or correcting one export restates nothing else.
   */
  storeTypes?: StoreTypesOption | undefined;
};

/** What an adapter adds to the options: the roots it worked out, and its own bundler's words. */
export type DiscoveryInput = DiscoveryOptions & {
  roots: ModuleRoots;
  /** Called on the first file rather than at creation, so a run that transforms nothing skips it. */
  loadParser: () => Promise<Parser>;
  /** The module id the injected import reads the runtime from. */
  runtimeModule: string;
  /** The whole hot-reload line, taking the statement that clears this module's stores. */
  hotReload: (clear: string) => string;
};

export type Discovery = {
  /** Whether this id is ours to touch at all, and what it is called if it is. */
  keysFor: (id: string) => ModuleKeys | undefined;
  /** The transform, and the warnings nobody has been told yet. */
  run: (code: string, keys: ModuleKeys) => Promise<{ result: StoreTransform; warnings: string[] }>;
};

const DEFAULT_MAX_STORES_PER_SITE = 50;

/** The cap the runtime is handed, and what the developer is told when their number is refused. */
export type StoreCap = { cap: number; warning: string | undefined };

/**
 * `Infinity` is an answer: it says no cap. Every other number a site cannot be held to is refused
 * instead of being changed into a usable one, because a silent 50 for a typed `0` is the opposite
 * of what was asked and says nothing.
 */
export function resolveStoreCap(value: number | undefined): StoreCap {
  if (value === undefined) {
    return { cap: DEFAULT_MAX_STORES_PER_SITE, warning: undefined };
  }

  if (value === Number.POSITIVE_INFINITY || (Number.isSafeInteger(value) && value >= 1)) {
    return { cap: value, warning: undefined };
  }

  return {
    cap: DEFAULT_MAX_STORES_PER_SITE,
    warning:
      `maxStoresPerSite is ${value} in your devtools options, which is no number of stores, so ` +
      `the plugin holds ${DEFAULT_MAX_STORES_PER_SITE} per site instead. Pass a whole number of 1 ` +
      `or more, or Infinity for no cap.`,
  };
}

/**
 * Everything discovery decides once a bundler has handed over its roots. An adapter is then three
 * moves: work out the roots, hand each file over, and print what comes back through its own channel.
 *
 * The ids reaching `keysFor` are already normalised. See `moduleKeys`.
 */
export function createDiscovery(input: DiscoveryInput): Discovery {
  const { cap, warning: capWarning } = resolveStoreCap(input.maxStoresPerSite);
  /**
   * Every edit re-transforms the file, and the same warning on every save teaches people to
   * skip our warnings.
   */
  const warned = new Set<string>();
  /** Merged once for the whole run: the map is the same for every file the plugin is offered. */
  const storeTypes = mergeStoreTypes(input.storeTypes);
  let parser: Promise<Parser> | undefined;

  return {
    keysFor: (id) => moduleKeys(id, input.roots, input.fileKey),

    async run(code, keys) {
      parser ??= input.loadParser();

      const result = transformStores({
        code,
        moduleKey: keys.moduleKey,
        home: keys.home,
        external: keys.external,
        maxStoresPerSite: cap,
        adoptFactories: input.adoptFactories ?? true,
        storeTypes,
        parser: await parser,
        runtimeModule: input.runtimeModule,
        hotReload: input.hotReload,
      });

      const raised = capWarning === undefined ? result.warnings : [capWarning, ...result.warnings];
      const warnings = raised.filter((warning) => !warned.has(warning));

      for (const warning of warnings) {
        warned.add(warning);
      }

      return { result, warnings };
    },
  };
}
