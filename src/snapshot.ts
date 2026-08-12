import { box, mark } from "./marker.ts";
import { DERIVED, listEntries, type StoreEntry, type StoreType } from "./registry.ts";

export type Snapshot = Record<string, Record<string, unknown>>;

/** `set` writes `value` with no check on `lc`, so an unmounted one still holds the true value. */
const TRUSTED_UNMOUNTED: ReadonlySet<StoreType> = new Set<StoreType>(["atom", "map", "deepMap"]);

/**
 * The two types the tree writes no note for: an atom is the plain case that needs no word, and an
 * unknown type would state a guess. Every other type names itself.
 */
const UNNOTED: ReadonlySet<StoreType> = new Set<StoreType>(["atom", "unknown"]);

/**
 * `.value` is the whole read. `get()` mounts an unmounted store and a getter runs whatever the
 * developer put behind it, and either one would make watching a store change how the app behaves.
 */
export function buildSnapshot(): Snapshot {
  const homes = new Map<string, StoreEntry[]>();

  for (const entry of listEntries()) {
    const known = homes.get(entry.home);

    if (known) {
      known.push(entry);
    } else {
      homes.set(entry.home, [entry]);
    }
  }

  const snapshot: Snapshot = {};

  for (const [home, entries] of sortHomes(homes)) {
    const node: Record<string, unknown> = {};

    for (const entry of entries.sort((left, right) => compare(left.name, right.name))) {
      node[displayName(entry)] = slotFor(entry);
    }

    snapshot[home] = node;
  }

  return snapshot;
}

/**
 * The tree key, and the only place the type is written. `name` and `label` stay as they are,
 * because they name timeline rows and decide which two stores are one, and a key that changes when
 * adoption learns a type costs one row redrawn. Square brackets, so the type never reads as the
 * place suffix a name clash adds (`$counter (line 20) [computed]`).
 */
function displayName(entry: StoreEntry): string {
  return UNNOTED.has(entry.type) ? entry.name : `${entry.name} [${entry.type}]`;
}

/**
 * Only a value that cannot be trusted is marked, so the marker states the consequence and not the
 * mount state. An unknown type never gets `never computed`: it may be somebody's computed store,
 * and we cannot prove it never ran.
 */
function slotFor(entry: StoreEntry): unknown {
  const { value } = entry.store;

  if (entry.store.lc > 0 || TRUSTED_UNMOUNTED.has(entry.type)) {
    return value;
  }

  if (DERIVED.has(entry.type) && !entry.everMounted && value === undefined) {
    return mark("not mounted, never computed", {});
  }

  return mark("not mounted, may be stale", box(value));
}

/**
 * Groups are written by hand and there are few of them, so they belong on top. A home holding
 * at least one explicitly registered store counts as a group, which settles a group named
 * after a file.
 */
function sortHomes(homes: Map<string, StoreEntry[]>): [string, StoreEntry[]][] {
  return [...homes].sort(([leftHome, left], [rightHome, right]) => {
    const byKind = rank(left) - rank(right);

    return byKind === 0 ? compare(leftHome, rightHome) : byKind;
  });
}

function rank(entries: StoreEntry[]): number {
  return entries.some((entry) => entry.origin === "explicit") ? 0 : 1;
}

/** Code unit order, not `localeCompare`, so the tree reads the same under every locale. */
function compare(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}
