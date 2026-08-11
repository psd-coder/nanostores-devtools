import type { Store } from "nanostores";

import {
  type ChangeListener,
  type DevtoolsGlobal,
  getDevtoolsGlobal,
  peekDevtoolsGlobal,
} from "./global.ts";
import { warnOnce } from "./warn.ts";

export type StoreType = "atom" | "map" | "deepMap" | "computed" | "batched" | "unknown";

/**
 * The types that work their value out from other stores instead of taking a write. They follow
 * the row that caused them, and an unmounted one holds a value nothing keeps up to date.
 */
export const DERIVED: ReadonlySet<StoreType> = new Set<StoreType>(["computed", "batched"]);

export type StoreOrigin = "plugin" | "explicit";

export type StoreEntry = {
  store: Store;
  name: string;
  home: string;
  label: string;
  type: StoreType;
  origin: StoreOrigin;
  everMounted: boolean;
  unhook: (() => void)[];
};

export type Registration = {
  store: Store;
  name: string;
  home: string;
  type: StoreType;
  origin: StoreOrigin;
};

/**
 * What moved, for a listener that draws a row for it. `update` covers a store that was already
 * here and only changed its name, home or type, which is nobody's timeline row.
 */
export type RegistryChange =
  | { kind: "register"; entry: StoreEntry }
  | { kind: "unregister"; entry: StoreEntry }
  | { kind: "update" };

const TOTAL_WARNING_AT = 2000;

export function makeLabel(home: string, name: string): string {
  return `${home}/${name}`;
}

export function registerStore(registration: Registration): StoreEntry {
  const devtools = getDevtoolsGlobal();
  const label = makeLabel(registration.home, registration.name);
  const known = devtools.entries.get(registration.store);

  if (known) {
    return relabelEntry(devtools, known, registration, label);
  }

  takeLabel(devtools, label, registration.store);

  const entry: StoreEntry = {
    store: registration.store,
    name: registration.name,
    home: registration.home,
    label,
    type: registration.type,
    origin: registration.origin,
    everMounted: false,
    unhook: [],
  };

  devtools.entries.set(registration.store, entry);
  warnOnSize(devtools);
  notifyChange(devtools, { kind: "register", entry });

  return entry;
}

export function trackStores(group: string, stores: Readonly<Record<string, Store>>): void {
  const firstName = new Map<Store, string>();

  for (const [name, store] of Object.entries(stores)) {
    const taken = firstName.get(store);

    if (taken !== undefined) {
      warnOnce(
        "one-store-two-names",
        makeLabel(group, taken),
        `"${name}" and "${taken}" in group "${group}" are the same store. Keeping "${taken}".`,
      );
      continue;
    }

    firstName.set(store, name);
    registerStore({ store, name, home: group, type: "unknown", origin: "explicit" });
  }
}

export function untrack(group: string): void {
  const devtools = peekDevtoolsGlobal();

  if (!devtools) {
    return;
  }

  const doomed: Store[] = [];

  for (const entry of devtools.entries.values()) {
    if (entry.home === group) {
      doomed.push(entry.store);
    }
  }

  for (const store of doomed) {
    dropEntry(devtools, store);
  }
}

export function listEntries(): StoreEntry[] {
  return [...(peekDevtoolsGlobal()?.entries.values() ?? [])];
}

export function getEntry(store: Store): StoreEntry | undefined {
  return peekDevtoolsGlobal()?.entries.get(store);
}

export function getEntryByLabel(label: string): StoreEntry | undefined {
  const devtools = peekDevtoolsGlobal();

  if (!devtools) {
    return undefined;
  }

  const store = devtools.byLabel.get(label);

  return store === undefined ? undefined : devtools.entries.get(store);
}

export function detachHooks(): void {
  for (const entry of peekDevtoolsGlobal()?.entries.values() ?? []) {
    clearHooks(entry);
  }
}

export function onRegistryChange(listener: ChangeListener): () => void {
  const { changeListeners } = getDevtoolsGlobal();

  changeListeners.add(listener);

  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * A second registration for a store already in the map. The explicit label wins whenever it
 * arrives, and `type` only ever comes from the plugin, because an explicit call has none to
 * give and passes `unknown`.
 */
function relabelEntry(
  devtools: DevtoolsGlobal,
  entry: StoreEntry,
  registration: Registration,
  label: string,
): StoreEntry {
  /** The type decides which hooks an entry carries, so the ones attached under the old one go. */
  if (registration.type !== "unknown" && registration.type !== entry.type) {
    entry.type = registration.type;
    clearHooks(entry);
    notifyChange(devtools, { kind: "update" });
  }

  if (registration.origin === "plugin" && entry.origin === "explicit") {
    return entry;
  }

  if (label === entry.label) {
    entry.origin = registration.origin;

    return entry;
  }

  if (
    registration.origin === "explicit" &&
    entry.origin === "explicit" &&
    registration.home !== entry.home
  ) {
    warnOnce(
      "store-in-two-groups",
      entry.label,
      `"${entry.name}" moved from group "${entry.home}" to "${registration.home}". A store lives in one group.`,
    );
  }

  devtools.byLabel.delete(entry.label);
  takeLabel(devtools, label, entry.store);

  entry.name = registration.name;
  entry.home = registration.home;
  entry.label = label;
  entry.origin = registration.origin;

  notifyChange(devtools, { kind: "update" });

  return entry;
}

/**
 * A label already held by another store is replaced without a word: from here that is
 * indistinguishable from a hot reload, and warning on every edit teaches people to ignore us.
 */
function takeLabel(devtools: DevtoolsGlobal, label: string, store: Store): void {
  const holder = devtools.byLabel.get(label);

  if (holder && holder !== store) {
    dropEntry(devtools, holder);
  }

  devtools.byLabel.set(label, store);
}

function dropEntry(devtools: DevtoolsGlobal, store: Store): boolean {
  const entry = devtools.entries.get(store);

  if (!entry) {
    return false;
  }

  clearHooks(entry);
  devtools.entries.delete(store);

  if (devtools.byLabel.get(entry.label) === store) {
    devtools.byLabel.delete(entry.label);
  }

  notifyChange(devtools, { kind: "unregister", entry });

  return true;
}

function clearHooks(entry: StoreEntry): void {
  for (const unhook of entry.unhook) {
    unhook();
  }

  entry.unhook.length = 0;
}

function warnOnSize(devtools: DevtoolsGlobal): void {
  if (devtools.entries.size < TOTAL_WARNING_AT) {
    return;
  }

  warnOnce(
    "registry-size",
    "",
    `${devtools.entries.size} stores are registered. Nothing is dropped, but the panel and every write get slower from here.`,
  );
}

/** A snapshot, so a listener that subscribes or unsubscribes mid-run does not change this pass. */
function notifyChange(devtools: DevtoolsGlobal, change: RegistryChange): void {
  for (const listener of Array.from(devtools.changeListeners)) {
    listener(change);
  }
}
