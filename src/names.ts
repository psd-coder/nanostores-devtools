import type { Store } from "nanostores";

import {
  getDevtoolsGlobal,
  type ModuleScope,
  type NameClaim,
  type NameHolder,
  type SiteState,
} from "./global.ts";
import { getEntry, makeLabel, registerStore, renameEntry } from "./registry.ts";
import { warnOnce } from "./warn.ts";

/** What decides a name: the display home the entry sits in, and the module that wrote it. */
export type NameSource = { home: string; moduleKey: string };

/** `$items #3`: the number every store of a site past the first carries. */
export function numbered(display: string, made: number): string {
  return made === 1 ? display : `${display} #${made}`;
}

/**
 * A creation site taking its name, at the home its module is drawn in. Two things can already hold
 * that name: another site in the same module, and a site in another module the display home holds
 * as well. Either one renames both sides, because the developer cannot tell which of the two is
 * "first" and a name that shifts by load order is worse than two names that are both qualified.
 */
export function claimSiteName(scope: ModuleScope, state: SiteState, module: NameSource): void {
  claimInModule(scope, state, module.home);

  const holder = holdName(module, state.name);

  if (!holder.sites.includes(state)) {
    holder.sites.push(state);
  }

  nameFile(state, holder.file, module.home);
}

/**
 * What a top-level binding of the developer's own names its store. The binding's own name, unless a
 * second module sharing this home holds that name too, which is what makes the file part of it.
 * The store is held from here on, so a second module arriving later renames it as well.
 */
export function claimBindingName(module: NameSource, store: Store, name: string): string {
  const holder = holdName(module, name);

  /** A reload leaves the stores of the run before it behind, and only the registry knows they went. */
  holder.bound = holder.bound.filter((held) => {
    const kept = held.deref();

    return kept !== undefined && kept !== store && getEntry(kept) !== undefined;
  });
  holder.bound.push(new WeakRef(store));

  return withSuffix(name, holder.file);
}

/**
 * The names a module gives up when its body runs again. The module keeps its hold on each one, so
 * a file it already names it still names on the run after: a suffix that came and went on every
 * save would give the developer a new tree every time.
 */
export function releaseSiteNames(scope: ModuleScope, module: NameSource): void {
  const { homeNames } = getDevtoolsGlobal();

  for (const state of scope.sites.values()) {
    const holder = homeNames.get(makeLabel(module.home, state.name))?.get(module.moduleKey);

    if (holder) {
      holder.sites = holder.sites.filter((held) => held !== state);
    }
  }
}

/**
 * Two source lines wanting one name is a real clash, so both sides take the place suffix: one
 * bare `$counter` next to `$counter (line 20)` does not say which of the two lines it came from.
 */
function claimInModule(scope: ModuleScope, state: SiteState, home: string): void {
  const owner = scope.claims.get(state.name);

  if (owner === undefined) {
    scope.claims.set(state.name, state);

    return;
  }

  if (owner === state) {
    return;
  }

  const both = `${placeOf(owner)} and ${placeOf(state)}`;

  namePlace(owner, home);
  namePlace(state, home);
  warnOnce(
    "name-clash",
    makeLabel(home, state.name),
    `"${state.name}" is made in two places in "${home}": ${both}. Both entries show their place.`,
  );
}

/**
 * The module's hold on a name at a home, made on the first claim. A second module claiming it can
 * only happen where `fileKey` maps both onto one home, and that is the moment both start naming
 * their file: without it the two would share one label and the registry would keep one store.
 */
function holdName(module: NameSource, name: string): NameHolder {
  const { homeNames } = getDevtoolsGlobal();
  const label = makeLabel(module.home, name);
  const claim = homeNames.get(label) ?? new Map<string, NameHolder>();
  const known = claim.get(module.moduleKey);

  homeNames.set(label, claim);

  if (known) {
    return known;
  }

  const created: NameHolder = { file: null, sites: [], bound: [] };

  claim.set(module.moduleKey, created);

  if (claim.size > 1) {
    nameFiles(claim, module.home, name);
  }

  return created;
}

/**
 * Every module holding the name says which file it came from. The suffix is read off the module
 * key alone, so a reload and the other load order both give the same name, and a third module
 * joining later can only lengthen it where two file names are the same.
 */
function nameFiles(claim: NameClaim, home: string, name: string): void {
  const keys = [...claim.keys()];

  for (const [moduleKey, holder] of claim) {
    const file = shortestPath(
      moduleKey,
      keys.filter((other) => other !== moduleKey),
    );

    if (holder.file === file) {
      continue;
    }

    holder.file = file;

    for (const state of holder.sites) {
      nameFile(state, file, home);
    }

    /** Last, because a name the developer wrote beats the one the creation site gave. */
    for (const held of holder.bound) {
      const store = held.deref();
      const entry = store === undefined ? undefined : getEntry(store);

      /** Anything drawn elsewhere or under another name since has a better one than this. */
      if (store !== undefined && entry?.home === home && entry.name === name) {
        renameEntry(store, withSuffix(name, file), home);
      }
    }
  }

  warnOnce(
    "shared-home",
    makeLabel(home, name),
    `"${name}" is made in "${keys.join('" and "')}", which "${home}" holds both of. ` +
      `Both entries show their file.`,
  );
}

function nameFile(state: SiteState, file: string | null, home: string): void {
  if (file === null || state.file === file) {
    return;
  }

  state.file = file;
  redisplay(state, home);
}

function namePlace(state: SiteState, home: string): void {
  if (state.placed) {
    return;
  }

  state.placed = true;
  redisplay(state, home);
}

/** The site under a new name, which every store it already handed the old one takes as well. */
function redisplay(state: SiteState, home: string): void {
  const display = withSuffix(state.name, suffixOf(state));

  if (display === state.display) {
    return;
  }

  state.display = display;

  for (const held of state.stores) {
    const entry = getEntry(held.store);

    /** A store an explicit group took carries a hand-written name, which this must not touch. */
    if (entry?.home === home) {
      registerStore({
        store: held.store,
        name: numbered(state.display, held.number),
        ownerName: state.display,
        home,
        type: entry.type,
        origin: "plugin",
        external: entry.external,
        fn: state.fn,
      });
    }
  }
}

/** The file first, because it says where to look before the line says where in the file. */
function suffixOf(state: SiteState): string | null {
  const place = state.placed ? placeOf(state) : null;

  if (state.file === null) {
    return place;
  }

  return place === null ? state.file : `${state.file}, ${place}`;
}

function withSuffix(name: string, suffix: string | null): string {
  return suffix === null ? name : `${name} (${suffix})`;
}

function placeOf(state: SiteState): string {
  return state.fn === null ? `line ${state.line}` : `${state.fn}, line ${state.line}`;
}

/**
 * The shortest end of the path that no other module holding the name has: `a.ts`, and `a/store.ts`
 * where both files are named `store.ts`. A path no end of tells apart is kept whole, which is
 * unique in itself, because a module key names one file.
 */
function shortestPath(moduleKey: string, others: string[]): string {
  const segments = moduleKey.split("/");

  for (let depth = 1; depth < segments.length; depth += 1) {
    const end = endOf(segments, depth);

    if (others.every((other) => endOf(other.split("/"), depth) !== end)) {
      return end;
    }
  }

  return moduleKey;
}

function endOf(segments: string[], depth: number): string {
  return segments.slice(Math.max(segments.length - depth, 0)).join("/");
}
