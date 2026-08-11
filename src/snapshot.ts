import { listEntries, type StoreEntry } from "./registry.ts";

export type Snapshot = Record<string, Record<string, unknown>>;

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
      node[entry.name] = entry.store.value;
    }

    snapshot[home] = node;
  }

  return snapshot;
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
