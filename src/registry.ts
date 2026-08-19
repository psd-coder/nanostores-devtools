import type { Store } from "nanostores";

import { chainValue } from "./descriptor.ts";
import {
  type ChangeListener,
  type DevtoolsGlobal,
  getDevtoolsGlobal,
  peekDevtoolsGlobal,
} from "./global.ts";
import { makeLabel, qualify } from "./labels.ts";
import {
  applyComment,
  clearThrottle,
  createThrottleState,
  resolveMark,
  type ThrottleComment,
  type ThrottleState,
} from "./throttle.ts";
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
  /** This registration, whatever it ends up called. Handed out once and never reused. */
  id: number;
  name: string;
  home: string;
  /**
   * The name whatever owns the store knows it by, which is the one its creation site gave it. It
   * stays as it was when a binding of the developer's renames the entry, because the owner drawing
   * a second placement of the store still knows it under its own key.
   *
   * `null` where no creation site ever named the store, which is a store a group registered by
   * hand and the plugin never saw.
   */
  ownerName: string | null;
  /** Text for a reader, never an identity: `id` says which store this is, `nameKey` which name. */
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
  /** The file the name says it came from, once a second module the home holds claims it too. */
  file: string | null;
  /** Where in the file it was made, `makeCart, line 12`, once a second site here claims the name. */
  place: string | null;
  /** Which store of its creation site this is, counting from one. */
  number: number;
  everMounted: boolean;
  /** How fast the store writes, whether it is marked, and the row it is holding back. */
  throttle: ThrottleState;
  unhook: (() => void)[];
};

/** What tells a store from another one of the same name, read by the label and the tree key alike. */
export type NameParts = Pick<StoreEntry, "file" | "place" | "number">;

export type Registration = {
  store: Store;
  name: string;
  home: string;
  type: StoreType;
  origin: StoreOrigin;
  external: boolean;
  fn: string | null;
  /**
   * What the comment over the store's creation site said: nothing, a bare mark, the rate in
   * milliseconds it holds the store to, or `false` from `// @devtools-no-throttle`.
   */
  throttle?: ThrottleComment;
} & Partial<NameParts>;

/** A name in full: the home, the name, and everything that tells it from another one the same. */
type NamePlace = Pick<StoreEntry, "name" | "home"> & NameParts;

/** Where an entry is drawn: its name and what qualifies it, its home, and whose home that is. */
type EntryPlace = NamePlace & Pick<StoreEntry, "external">;

/**
 * What moved, for a listener that draws a row for it. `update` covers a store that was already
 * here and only changed its name, home or type, which is nobody's timeline row.
 */
export type RegistryChange =
  | { kind: "register"; entry: StoreEntry }
  | { kind: "unregister"; entry: StoreEntry }
  | { kind: "update" };

const TOTAL_WARNING_AT = 2000;

/**
 * A separator no part can hold, so two names cannot make one key: a home, a name and a place are
 * all written by a developer, and every character they can type has to stay theirs.
 */
const NAME_SEPARATOR = "\u0000";

/**
 * The name as a key: everything that decides whether two records name the same thing, and no
 * spelling. It answers that one question, which is what the name index and the hot-reload merge
 * both ask. Never show it to a reader: `label` is the string for that.
 */
export function nameKey(place: NamePlace): string {
  return [place.home, place.name, place.file, place.place, place.number].join(NAME_SEPARATOR);
}

function labelOf(place: EntryPlace): string {
  return makeLabel(place.home, qualify(place.name, place));
}

/**
 * Only a creation site names a store for its owner. An explicit registration says where the store
 * is rooted and nothing about what holds it: the name it carries is a group key, and the owner
 * holds no member under that name. So it gives none.
 */
function ownerNameOf(registration: Registration): string | null {
  return registration.origin === "explicit" ? null : registration.name;
}

function entryPlace(registration: Registration): EntryPlace {
  return {
    name: registration.name,
    home: registration.home,
    external: registration.external,
    file: registration.file ?? null,
    place: registration.place ?? null,
    number: registration.number ?? 1,
  };
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
  const to = entryPlace(registration);
  const known = devtools.entries.get(registration.store);

  if (known) {
    return relabelEntry(devtools, known, registration, to);
  }

  takeName(devtools, nameKey(to), registration.store);

  const entry: StoreEntry = {
    ...to,
    id: devtools.nextId++,
    store: registration.store,
    ownerName: ownerNameOf(registration),
    label: labelOf(to),
    type: registration.type,
    origin: registration.origin,
    fn: registration.fn,
    everMounted: false,
    throttle: createThrottleState(registration.throttle),
    unhook: [],
  };

  resolveMark(entry);
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
 *
 * `file` is the only qualifier a written name can need: the place and the number tell two stores of
 * one creation site apart, and this name came from neither.
 */
export function renameEntry(store: Store, name: string, home: string, file: string | null): void {
  const devtools = peekDevtoolsGlobal();
  const entry = devtools?.entries.get(store);

  /** Only a file of the developer's own renames a store, so the home it moves to is theirs. */
  const to: EntryPlace = { name, home, external: false, file, place: null, number: 1 };

  if (!devtools || !entry || entry.origin === "explicit" || nameKey(to) === nameKey(entry)) {
    return;
  }

  moveEntry(devtools, entry, to);
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

/** Who holds a name, without a scan. The parts left out are the ones a plain name never takes. */
export function findEntry(
  home: string,
  name: string,
  parts?: Partial<NameParts>,
): StoreEntry | undefined {
  const devtools = peekDevtoolsGlobal();

  if (!devtools) {
    return undefined;
  }

  const store = devtools.byName.get(nameKey({ home, name, ...defaultParts(parts) }));

  return store === undefined ? undefined : devtools.entries.get(store);
}

function defaultParts(parts?: Partial<NameParts>): NameParts {
  return { file: parts?.file ?? null, place: parts?.place ?? null, number: parts?.number ?? 1 };
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
  to: EntryPlace,
): StoreEntry {
  /**
   * An explicit registration says nothing about the comment and so leaves it as it was, while the
   * plugin's carries whatever the file says now, an edited rate included.
   */
  if (registration.origin === "plugin") {
    applyComment(entry.throttle, registration.throttle);
  }

  /** The type decides which hooks an entry carries, so the ones attached under the old one go. */
  if (registration.type !== "unknown" && registration.type !== entry.type) {
    entry.type = registration.type;
    detachEntryHooks(entry);
    notifyChange(devtools, { kind: "update" });
  }

  if (registration.origin === "plugin" && entry.origin === "explicit") {
    resolveMark(entry);

    return entry;
  }

  /**
   * The site that registered last says which function holds the store: one made inside a helper
   * and then adopted at a top-level binding is no longer a store only that helper knows about.
   *
   * An explicit registration clears the function, and that is right: it passes none, and a store
   * the developer placed is drawn where they put it rather than under the function that built it.
   */
  entry.fn = registration.fn;

  const ownerName = ownerNameOf(registration);

  if (ownerName !== null) {
    entry.ownerName = ownerName;
  }

  if (nameKey(to) === nameKey(entry)) {
    entry.origin = registration.origin;
    entry.external = registration.external;
    resolveMark(entry);

    return entry;
  }

  if (
    registration.origin === "explicit" &&
    entry.origin === "explicit" &&
    registration.home !== entry.home
  ) {
    warnOnce(
      "store-in-two-groups",
      String(entry.id),
      `"${entry.name}" moved from group "${entry.home}" to "${registration.home}". A store lives in one group.`,
    );
  }

  entry.origin = registration.origin;
  moveEntry(devtools, entry, to);

  return entry;
}

/**
 * The entry under a new label, which is how every name and every home change: one store keeps one
 * entry, and the label index moves with it. Where that home sits moves with it too.
 */
function moveEntry(devtools: DevtoolsGlobal, entry: StoreEntry, to: EntryPlace): void {
  devtools.byName.delete(nameKey(entry));
  takeName(devtools, nameKey(to), entry.store);

  entry.name = to.name;
  entry.home = to.home;
  entry.label = labelOf(to);
  entry.external = to.external;
  entry.file = to.file;
  entry.place = to.place;
  entry.number = to.number;

  /** The option matches on the name, so a store renamed into a match is throttled from here on. */
  resolveMark(entry);
  notifyChange(devtools, { kind: "update" });
}

/**
 * A name already held by another store is replaced without a word: from here that is
 * indistinguishable from a hot reload, and warning on every edit teaches people to ignore us.
 */
function takeName(devtools: DevtoolsGlobal, key: string, store: Store): void {
  const holder = devtools.byName.get(key);

  if (holder && holder !== store) {
    dropEntry(devtools, holder, true);
  }

  devtools.byName.set(key, store);
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
  /** A timer holding an entry the registry has dropped would draw a row for a store nobody has. */
  clearThrottle(entry);
  devtools.entries.delete(store);

  if (devtools.byName.get(nameKey(entry)) === store) {
    devtools.byName.delete(nameKey(entry));
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
