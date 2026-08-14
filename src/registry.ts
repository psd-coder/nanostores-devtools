import type { Store } from "nanostores";

import { chainValue } from "./descriptor.ts";
import {
  type ChangeListener,
  type DevtoolsGlobal,
  getDevtoolsGlobal,
  peekDevtoolsGlobal,
} from "./global.ts";
import { detachEntryHooks } from "./unhook.ts";
import { warnOnce } from "./warn.ts";

export type StoreType = "atom" | "map" | "deepMap" | "computed" | "batched" | "unknown";

/**
 * The word the panel prints for a type, in the tree key and in `__serializedType__` alike, so the
 * two can never drift apart.
 *
 * An `atom` and a type nothing worked out share the plain word: the two say how much we learned
 * rather than anything about the store, and the reader can do nothing with the difference. The
 * type itself keeps them apart, because the marker rules and the timeline still need it.
 */
export function storeWord(type: StoreType | undefined): string {
  return type === undefined || type === "unknown" || type === "atom" ? "store" : type;
}

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
  /**
   * The name whatever owns the store knows it by, which is the one its creation site gave it. It
   * stays as it was when a binding of the developer's renames the entry, because the owner drawing
   * a second placement of the store still knows it under its own key.
   */
  ownerName: string;
  label: string;
  type: StoreType;
  origin: StoreOrigin;
  /** Whether the home is a file of somebody else's, which sorts it after the developer's own. */
  external: boolean;
  /**
   * The function the store was made inside, from its creation site, and `null` for one made at
   * module level.
   */
  fn: string | null;
  everMounted: boolean;
  unhook: (() => void)[];
};

export type Registration = {
  store: Store;
  name: string;
  home: string;
  /** The name the site gave before the registry numbered it: `$canUndo` behind `$canUndo #2`. */
  ownerName?: string;
  type: StoreType;
  origin: StoreOrigin;
  external: boolean;
  fn: string | null;
};

/** Where an entry is drawn: its name, the home it sits in, and whether that home is theirs. */
type EntryPlace = Pick<Registration, "name" | "home" | "external">;

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

/**
 * Shape, not `instanceof`: a store is a plain object, and two copies of nanostores make two.
 *
 * Both keys are read through a descriptor, because this runs against every value the walk meets and
 * a plain read would run a getter the app wrote. Every store nanostores builds keeps `listen` and
 * `lc` as its own data properties, so refusing an accessor costs nothing there and only turns away
 * an object that put its own code behind either name.
 */
export function isStore(value: unknown): value is Store {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    typeof chainValue(value, "listen") === "function" && typeof chainValue(value, "lc") === "number"
  );
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
    ownerName: registration.ownerName ?? registration.name,
    label,
    type: registration.type,
    origin: registration.origin,
    external: registration.external,
    fn: registration.fn,
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
    registerStore({
      store,
      name,
      home: group,
      type: "unknown",
      origin: "explicit",
      external: false,
      fn: null,
    });
  }
}

/**
 * The name a top-level binding of the developer's own gives a store, which beats the one its
 * creation site gave it. The store keeps its identity and its entry, so this is one entry under a
 * new name: the tree draws it, and the rows the timeline writes read it too.
 *
 * A name a group was given by hand is left alone, as it is everywhere else: the developer wrote
 * that one as well, and they wrote it for this store rather than for whatever holds it.
 */
export function renameEntry(store: Store, name: string, home: string): void {
  const devtools = peekDevtoolsGlobal();
  const entry = devtools?.entries.get(store);

  if (!devtools || !entry || entry.origin === "explicit" || makeLabel(home, name) === entry.label) {
    return;
  }

  /** Only a file of the developer's own renames a store, so the home it moves to is theirs. */
  moveEntry(devtools, entry, { name, home, external: false });
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
    dropEntry(devtools, store, true);
  }
}

export function unregisterStore(store: Store): void {
  drop(store, true);
}

/**
 * The per-site cap's way out. It says nothing, because the registration that caused the eviction
 * draws the only row the two of them get together (spec 6.5).
 */
export function evictStore(store: Store): void {
  drop(store, false);
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
    detachEntryHooks(entry);
    notifyChange(devtools, { kind: "update" });
  }

  if (registration.origin === "plugin" && entry.origin === "explicit") {
    return entry;
  }

  /**
   * The site that registered last says which function holds the store: one made inside a helper
   * and then adopted at a top-level binding is no longer a store only that helper knows about. The
   * name its owner knows it by comes from the same site, for the same reason.
   */
  entry.fn = registration.fn;
  entry.ownerName = registration.ownerName ?? registration.name;

  if (label === entry.label) {
    entry.origin = registration.origin;
    entry.external = registration.external;

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

  entry.origin = registration.origin;
  moveEntry(devtools, entry, registration);

  return entry;
}

/**
 * The entry under a new label, which is how every name and every home change: one store keeps one
 * entry, and the label index moves with it. Where that home sits moves with it too.
 */
function moveEntry(devtools: DevtoolsGlobal, entry: StoreEntry, to: EntryPlace): void {
  const label = makeLabel(to.home, to.name);

  devtools.byLabel.delete(entry.label);
  takeLabel(devtools, label, entry.store);

  entry.name = to.name;
  entry.home = to.home;
  entry.label = label;
  entry.external = to.external;

  notifyChange(devtools, { kind: "update" });
}

/**
 * A label already held by another store is replaced without a word: from here that is
 * indistinguishable from a hot reload, and warning on every edit teaches people to ignore us.
 */
function takeLabel(devtools: DevtoolsGlobal, label: string, store: Store): void {
  const holder = devtools.byLabel.get(label);

  if (holder && holder !== store) {
    dropEntry(devtools, holder, true);
  }

  devtools.byLabel.set(label, store);
}

function drop(store: Store, notify: boolean): void {
  const devtools = peekDevtoolsGlobal();

  if (devtools) {
    dropEntry(devtools, store, notify);
  }
}

function dropEntry(devtools: DevtoolsGlobal, store: Store, notify: boolean): boolean {
  const entry = devtools.entries.get(store);

  if (!entry) {
    return false;
  }

  detachEntryHooks(entry);
  devtools.entries.delete(store);

  if (devtools.byLabel.get(entry.label) === store) {
    devtools.byLabel.delete(entry.label);
  }

  if (notify) {
    notifyChange(devtools, { kind: "unregister", entry });
  }

  return true;
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
