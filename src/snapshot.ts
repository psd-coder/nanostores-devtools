import type { Store } from "nanostores";

import { box, mark } from "./marker.ts";
import { ownerOf } from "./ownership.ts";
import { DERIVED, getEntry, listEntries, type StoreEntry, type StoreType } from "./registry.ts";

export type Snapshot = Record<string, Record<string, unknown>>;

/** `set` writes `value` with no check on `lc`, so an unmounted one still holds the true value. */
const TRUSTED_UNMOUNTED: ReadonlySet<StoreType> = new Set<StoreType>(["atom", "map", "deepMap"]);

/**
 * The two types the tree writes no note for: an atom is the plain case that needs no word, and an
 * unknown type would state a guess. Every other type names itself.
 */
const UNNOTED: ReadonlySet<StoreType> = new Set<StoreType>(["atom", "unknown"]);

/** Where a store that owns others keeps its own value, so its children can sit beside it. */
const SELF_KEY = "(value)";

/** The number the registry adds when one creation site made several stores: `$canUndo #2`. */
const ORDINAL = / #\d+$/;

/** What each owner holds, built for one snapshot only, because ownership can change under us. */
type Owned = Map<Store, StoreEntry[]>;

/** One key in the tree pointing at a store: the key a child takes under its owner, and its entry. */
type Placement = { key: string; entry: StoreEntry };

/**
 * `.value` is the whole read. `get()` mounts an unmounted store and a getter runs whatever the
 * developer put behind it, and either one would make watching a store change how the app behaves.
 */
export function buildSnapshot(): Snapshot {
  const homes = new Map<string, StoreEntry[]>();
  const owned: Owned = new Map();

  for (const entry of listEntries()) {
    const owner = drawnOwner(entry);

    if (owner === undefined) {
      collect(homes, entry.home, entry);
    } else {
      collect(owned, owner, entry);
    }
  }

  const snapshot: Snapshot = {};

  for (const [home, entries] of sortHomes(homes)) {
    const node: Record<string, unknown> = {};

    for (const entry of entries.sort((left, right) => compare(left.name, right.name))) {
      node[displayName(entry)] = drawEntry(entry, owned);
    }

    snapshot[home] = node;
  }

  return snapshot;
}

/**
 * The owner a store is drawn under, and only one the registry knows: an owner with no entry holds
 * no place in the tree, so a store under it would be drawn nowhere at all.
 */
function drawnOwner(entry: StoreEntry): Store | undefined {
  const owner = ownerOf(entry.store);

  return owner !== undefined && getEntry(owner) !== undefined ? owner : undefined;
}

function collect<TKey>(index: Map<TKey, StoreEntry[]>, key: TKey, entry: StoreEntry): void {
  const known = index.get(key);

  if (known) {
    known.push(entry);
  } else {
    index.set(key, [entry]);
  }
}

/**
 * A store that owns nothing is drawn as v1 draws it: its name, its value. One that owns others
 * becomes a node holding its own value under `(value)`.
 *
 * Only a store that owns something is wrapped. The panel draws a collapsed object as `{…}` with no
 * preview of what is inside, so wrapping a value the developer can already read turns it into one
 * click for nothing.
 */
function drawEntry(entry: StoreEntry, owned: Owned): unknown {
  const children = owned.get(entry.store);

  if (children === undefined) {
    return slotFor(entry);
  }

  const node: Record<string, unknown> = { [SELF_KEY]: slotFor(entry) };

  for (const child of childPlacements(children)) {
    node[child.key] = drawEntry(child.entry, owned);
  }

  return node;
}

/**
 * A nested store drops its number, because the parent already says which one this is. Only where
 * the stripped keys stay apart: several stores from one creation site can land on one parent, and
 * stripping there would collapse them onto one key and lose all but the last.
 *
 * Then the home, for the one clash a file level used to make impossible: ownership draws stores
 * from two files in one node, and two files may each hold a `$history`. Both sides take the
 * suffix, as a name clash inside one file does, because one bare `$history` beside
 * `$history (vendor/withUndo.ts)` does not say which file the bare one came from.
 */
function childPlacements(children: readonly StoreEntry[]): Placement[] {
  const stripped = children.map((entry) => ({
    entry,
    key: noted(entry.name.replace(ORDINAL, ""), entry.type),
  }));
  const numbered = keepApart(stripped, (entry) => displayName(entry));
  const homed = keepApart(numbered, (entry, key) => `${key} (${entry.home})`);

  return homed.sort((left, right) => compare(left.entry.name, right.entry.name));
}

/** A key only one child wants stays; a key two of them want is replaced on both sides. */
function keepApart(
  placements: readonly Placement[],
  rename: (entry: StoreEntry, key: string) => string,
): Placement[] {
  const wanted = new Map<string, number>();

  for (const { key } of placements) {
    wanted.set(key, (wanted.get(key) ?? 0) + 1);
  }

  return placements.map(({ entry, key }) =>
    wanted.get(key) === 1 ? { entry, key } : { entry, key: rename(entry, key) },
  );
}

/**
 * The tree key, and the only place the type is written. `name` and `label` stay as they are,
 * because they name timeline rows and decide which two stores are one, and a key that changes when
 * adoption learns a type costs one row redrawn. Square brackets, so the type never reads as the
 * place suffix a name clash adds (`$counter (line 20) [computed]`).
 */
function displayName(entry: StoreEntry): string {
  return noted(entry.name, entry.type);
}

function noted(name: string, type: StoreType): string {
  return UNNOTED.has(type) ? name : `${name} [${type}]`;
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
 * after a file. Then the developer's own files, and last the files that are somebody else's:
 * they keep their own top-level nodes, because a wrapper node holding them all would cost a click
 * to reach anything inside and say nothing itself.
 */
function sortHomes(homes: Map<string, StoreEntry[]>): [string, StoreEntry[]][] {
  return [...homes].sort(([leftHome, left], [rightHome, right]) => {
    const byKind = rank(left) - rank(right);

    return byKind === 0 ? compare(leftHome, rightHome) : byKind;
  });
}

/** A home is external only if every store in it is: one file of the developer's own lifts it. */
function rank(entries: StoreEntry[]): number {
  if (entries.some((entry) => entry.origin === "explicit")) {
    return 0;
  }

  return entries.every((entry) => entry.external) ? 2 : 1;
}

/** Code unit order, not `localeCompare`, so the tree reads the same under every locale. */
function compare(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}
