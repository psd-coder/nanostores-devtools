import type { Store } from "nanostores";

import {
  type DevtoolsGlobal,
  getDevtoolsGlobal,
  type NodeInfo,
  type OwnerLink,
  type OwnerSource,
  peekDevtoolsGlobal,
} from "./global.ts";
import { claimBindingFile, type NameSource } from "./names.ts";
import { getEntry, isStore, renameEntry } from "./registry.ts";

/**
 * What nanostores itself puts on a store. Skipped while walking, or an atom holding a store would
 * nest that store under the atom instead of leaving it where the developer put it.
 */
const STORE_KEYS: ReadonlySet<string> = new Set([
  "value",
  "init",
  "lc",
  "events",
  "listen",
  "get",
  "set",
  "setKey",
  "subscribe",
  "notify",
  "off",
]);

/** How many steps into a binding the walk takes, counting a property, an index and a key alike. */
const MAX_DEPTH = 3;

/** How many members of one collection become nodes of their own. */
export const MAX_MEMBERS = 25;

/**
 * What a node no name in the source reaches is keyed by. It says plainly that the name is ours,
 * rather than borrowing the class name, which the type label already holds.
 */
const UNNAMED = "ref";

/**
 * One top-level binding: the name as the developer wrote it, the value it holds, and whether they
 * exported it, which is what settles a race between two bindings holding one store.
 */
export type Binding = readonly [string, unknown, boolean?];

/** The module these bindings come from, which is where a node one of them makes is drawn. */
export type ModuleHome = Pick<NodeInfo, "home" | "external">;

/** A module running its own body, which is the one thing that knows the file its bindings sit in. */
export type BindingHome = ModuleHome & NameSource;

/** What one value holds: the members the tree draws, and the ones its cap left out. */
type Members = {
  drawn: Binding[];
  past: Binding[];
  /** Whether a collection named these members itself, by a position or by a map key. */
  collection: boolean;
};

/** One walk: the module it runs for, and what it has already been through, which ends a cycle. */
type Scan = { module: ModuleHome; seen: Set<object> };

/**
 * The module's own top-level bindings, at the end of its body. A binding holding a store places
 * what that store holds; a binding holding anything else becomes a node, and so does every member
 * of it, which is how an array's members nest under the array.
 *
 * No store is registered here. A store is born once and has one entry, which is what makes two
 * names for one store resolve to one store, so this decides where the tree draws it and what the
 * entry it already has is called.
 */
export function ownBindings(module: BindingHome, bindings: readonly Binding[]): void {
  for (const [name, value, exported = false] of bindings) {
    if (!module.external && isStore(value)) {
      claimName(module, value, name, exported);
    }

    if (canHold(value)) {
      walk({ module, seen: new Set() }, value, name, undefined, 0);
    }
  }
}

/**
 * A frame opens before a top-level initializer runs. The two mechanisms above see what is reachable
 * at the end of the module body, and a store held only in a closure is reachable from nothing, so
 * what the frame catches is all that places it.
 *
 * The outermost frame books the drop, and no frame inside it books another: a frame must close in
 * the same tick, and one whose expression threw would otherwise catch every store made anywhere
 * from then on.
 *
 * This is the one call that brings the registry into being for a module that may register nothing.
 * A frame that waited for one would catch nothing at all: the first store born inside it is what
 * creates it, and by then the frame was already skipped.
 */
export function beginFrame(): void {
  const { frames } = getDevtoolsGlobal();

  if (frames.length === 0) {
    queueMicrotask(() => {
      frames.length = 0;
    });
  }

  frames.push({ stores: [] });
}

/** A store born while a frame is open, which that frame places when it closes. */
export function noteBirth(store: Store): void {
  peekDevtoolsGlobal()?.frames.at(-1)?.stores.push(store);
}

/**
 * The frame closes, which is when everything it caught is placed: children are born before the
 * parent exists, so nothing can be placed while it is open. The store the expression returned
 * becomes the parent, and anything else becomes a node named after the binding.
 *
 * A frame opened inside an open frame hands its stores up, so an outer binding still sees
 * everything built beneath it.
 */
export function endFrame(module: ModuleHome, value: unknown, name: string | null): void {
  const devtools = peekDevtoolsGlobal();

  if (devtools === undefined) {
    return;
  }

  const frame = devtools.frames.pop();

  if (frame === undefined) {
    return;
  }

  const outer = devtools.frames.at(-1);

  if (outer !== undefined) {
    outer.stores.push(...frame.stores);

    return;
  }

  const holder = frameHolder(module, value, name);

  if (holder === undefined) {
    return;
  }

  for (const store of frame.stores) {
    hangUnder(devtools, holder, store);
  }
}

/**
 * A store made in a class field initializer, where `this` is what holds it. `typeof owner ===
 * "function"` is the whole test that tells the two cases apart: a static initializer's `this` is
 * the constructor, so its node is keyed by the class name and carries no type label, because the
 * key already says what the label would.
 *
 * An instance has no name here. The binding that will hold it does not exist while the constructor
 * runs, so the node is `ref` until the binding scan corrects it.
 */
export function ownField(module: ModuleHome, store: Store, owner: object): void {
  const statics = typeof owner === "function";
  const written = statics ? classKey(owner) : undefined;

  makeNode(owner, {
    home: module.home,
    external: module.external,
    name: written ?? UNNAMED,
    ours: written === undefined,
    numbered: written === undefined,
    type: statics ? undefined : typeNameOf(owner),
    parent: undefined,
    skipped: 0,
  });

  recordOwner(store, owner, "field");
}

/**
 * The last resort, for a store no other mechanism placed: the function it was made inside holds it.
 * Ask for it when the tree is drawn and not when the store is made, because only by then has every
 * other mechanism had its turn.
 *
 * The parentheses are the one part of the key that is ours. `track` is written in the source and
 * only the decision to make a node out of it is ours, which is why the key is not the one a node
 * with no name at all takes.
 *
 * One node per function name per home, so every store that function made lands in the same one.
 * Two functions of one name in one file share it: a name is all the creation site records.
 */
export function enclosingNode(module: ModuleHome, fn: string): object {
  const { functions } = getDevtoolsGlobal();
  /** A NUL fits in neither a path nor a function name, so no two pairs can share one key. */
  const key = [module.home, fn].join("\u0000");
  const known = functions.get(key);

  if (known !== undefined) {
    return known;
  }

  const node = {};

  functions.set(key, node);
  makeNode(node, {
    home: module.home,
    external: module.external,
    name: `${fn}()`,
    ours: true,
    numbered: false,
    type: undefined,
    parent: undefined,
    skipped: 0,
  });

  return node;
}

/**
 * A store the developer bound to a top-level name in a file of their own. They wrote that name, so
 * it beats the one the creation site gave: `export const $undoable = $draft2.$canUndo` is drawn
 * nowhere at all under a rule that only follows the path to an owner. A binding inside somebody
 * else's file is no name the developer chose, so it claims nothing.
 *
 * An exported binding is the name the rest of the app knows the store by, so it wins whatever order
 * the two bindings are scanned in. Two bindings of the same kind pick one arbitrarily, and the last
 * one scanned is the one that wins.
 *
 * The entry says which file it came from where a second module the home holds writes that name too,
 * which is what keeps two files `fileKey` maps onto one home from taking each other's entry.
 */
function claimName(module: BindingHome, store: Store, name: string, exported: boolean): void {
  const { bound } = getDevtoolsGlobal();

  if (getEntry(store) === undefined || (bound.get(store) === true && !exported)) {
    return;
  }

  bound.set(store, exported);
  renameEntry(store, name, module.home, claimBindingFile(module, store, name));
}

/**
 * The walk itself. `owner` is what holds this value: a store, a node, or nothing at all at the top
 * of a binding, where the value is drawn at its file level and needs no owner.
 */
function walk(
  scan: Scan,
  value: object,
  name: string,
  owner: object | undefined,
  depth: number,
): void {
  if (depth >= MAX_DEPTH || scan.seen.has(value)) {
    return;
  }

  scan.seen.add(value);

  const members = membersOf(value);

  /** A store already holds a place of its own, so only another kind of value becomes a node. */
  if (!isStore(value)) {
    makeNode(value, {
      home: scan.module.home,
      external: scan.module.external,
      name,
      ours: false,
      numbered: false,
      type: typeNameOf(value),
      parent: owner === undefined ? undefined : new WeakRef(owner),
      skipped: members.past.length,
    });
  }

  for (const [key, member] of members.drawn) {
    if (isStore(member)) {
      recordOwner(member, value, "scan", members.collection ? key : undefined);
    }

    if (canHold(member)) {
      walk(scan, member, key, value, depth + 1);
    }
  }

  for (const [, member] of members.past) {
    placeStores(member, value, depth + 1);
  }
}

/**
 * A member past the cap gets no node of its own, so the stores it holds sit on the collection
 * itself, keeping the names the registry gave them. Dropping them would read as "this is all of
 * it", which is worse than a long list, because the developer stops looking.
 */
function placeStores(value: unknown, owner: object, depth: number): void {
  if (isStore(value)) {
    recordOwner(value, owner, "scan");

    return;
  }

  if (depth >= MAX_DEPTH || !canHold(value)) {
    return;
  }

  for (const [, member] of membersOf(value).drawn) {
    if (isStore(member)) {
      recordOwner(member, owner, "scan");
    }
  }
}

/**
 * What the closing frame draws its stores under: the store the expression returned, or a node named
 * after the binding. A value that holds nothing gets no node, so what it made stays flat.
 */
function frameHolder(module: ModuleHome, value: unknown, name: string | null): object | undefined {
  if (!canHold(value)) {
    return undefined;
  }

  if (!isStore(value)) {
    makeNode(value, {
      home: module.home,
      external: module.external,
      name: name ?? UNNAMED,
      ours: name === null,
      numbered: name === null,
      type: typeNameOf(value),
      parent: undefined,
      skipped: membersOf(value).past.length,
    });
  }

  return value;
}

/**
 * The top of what already holds the store is what moves, not the store itself: a node a class field
 * made keeps its own fields and hangs under the binding whole, which is what gets an unenumerable
 * holder its binding back.
 */
function hangUnder(devtools: DevtoolsGlobal, holder: object, store: Store): void {
  const top = topHolder(devtools, store);

  if (top === holder) {
    return;
  }

  if (isStore(top)) {
    recordOwner(top, holder, "frame");

    return;
  }

  const info = devtools.nodes.get(top);

  if (info !== undefined && !chainHolds(devtools, holder, top)) {
    info.parent = new WeakRef(holder);
  }
}

/** What holds a store at the very top of its chain, which is the store itself when nothing does. */
function topHolder(devtools: DevtoolsGlobal, store: Store): object {
  let current: object = store;
  let above = holderOf(devtools, current);

  while (above !== undefined) {
    current = above;
    above = holderOf(devtools, current);
  }

  return current;
}

/**
 * The record that makes a value a node. The first name the developer wrote wins: a second binding
 * holding the same value has nothing better to offer. A name of ours is replaced by a written one
 * whenever one turns up, because a class field names its instance before any binding holds it.
 */
function makeNode(value: object, node: NodeInfo): void {
  const { nodes } = getDevtoolsGlobal();
  const known = nodes.get(value);

  if (known === undefined || (known.ours && !node.ours)) {
    nodes.set(value, node);
  }
}

/**
 * The class's own name, read through the descriptor so a getter never runs, and taken only while it
 * is still a string: a static field or getter named `name` shadows the one every class carries.
 */
function classKey(owner: object): string | undefined {
  const name: unknown = Object.getOwnPropertyDescriptor(owner, "name")?.value;

  return typeof name === "string" && name !== "" ? name : undefined;
}

/**
 * What built the value, read off the prototype's own `constructor` through the descriptor, and its
 * name read the same way, so no getter the developer put in either place runs. `Object` is left
 * off: a plain object node says that much by itself, and the label is there to say what the key
 * cannot.
 */
function typeNameOf(value: object): string | undefined {
  const prototype: object | null = Object.getPrototypeOf(value);
  const descriptor =
    prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, "constructor");
  const built: unknown = descriptor?.value;
  const name: unknown =
    typeof built === "function" ? Object.getOwnPropertyDescriptor(built, "name")?.value : undefined;

  return typeof name === "string" && name !== "" && name !== "Object" ? name : undefined;
}

/** Only an object can hold a store, so only an object is worth looking inside. */
function canHold(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * An array is named by index, a `Map` by key and a `Set` by insertion order, so every name the
 * tree draws is one the developer could write to reach that member. An array gives up its own
 * indices and anything else its own enumerable keys. Both read through the descriptor and take
 * only a data one, so a getter never runs: it is the developer's own code and running it would
 * change how the app behaves. A `Map` and a `Set` keep their members in an internal slot instead,
 * which no property of the app's sits in front of.
 */
function membersOf(value: object): Members {
  if (Array.isArray(value)) {
    return capped(indexed(value));
  }

  if (value instanceof Map) {
    return capped(walked((visit) => Map.prototype.forEach.call(value, visit), keyName));
  }

  if (value instanceof Set) {
    return capped(walked((visit) => Set.prototype.forEach.call(value, visit), position));
  }

  return { drawn: propertiesOf(value), past: [], collection: false };
}

/**
 * Only a collection is capped, and only a collection names its members itself. A plain object's keys
 * are as many as the developer wrote, and each one already names the member it holds.
 */
function capped(members: Binding[]): Members {
  return {
    drawn: members.slice(0, MAX_MEMBERS),
    past: members.slice(MAX_MEMBERS),
    collection: true,
  };
}

/**
 * Every index the array itself holds a data descriptor for, so no accessor of the app's runs and no
 * index the array only inherits is drawn. A member keeps the index it really sits at, so a hole
 * shifts nothing that follows it, and one index that is refused costs the others nothing. A read
 * that throws, which now takes a `Proxy` trap, leaves the array contributing nothing.
 */
function indexed(value: readonly unknown[]): Binding[] {
  const found: Binding[] = [];

  try {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);

      if (descriptor !== undefined && "value" in descriptor) {
        found.push([`[${index}]`, descriptor.value]);
      }
    }
  } catch {
    return [];
  }

  return found;
}

/**
 * The built-in `forEach` called against the value, never a method of the value's own, so a subclass
 * that overrides iteration cannot run its code during a scan. A failure leaves the collection
 * contributing nothing.
 */
function walked(
  iterate: (visit: (member: unknown, key: unknown) => void) => void,
  nameOf: (key: unknown, index: number) => string | undefined,
): Binding[] {
  const found: Binding[] = [];
  let index = 0;

  try {
    iterate((member, key) => {
      const name = nameOf(key, index);

      index += 1;

      if (name !== undefined) {
        found.push([name, member]);
      }
    });
  } catch {
    return [];
  }

  return found;
}

/** A `Set` holds no keys, so its members are named by the order they were put in. */
function position(_key: unknown, index: number): string {
  return `[${index}]`;
}

/**
 * A `Map` key that is neither a string nor a number is left out, because there is no name for it
 * that exists in the source.
 */
function keyName(key: unknown): string | undefined {
  return typeof key === "string" || typeof key === "number"
    ? `[${JSON.stringify(key)}]`
    : undefined;
}

function propertiesOf(value: object): Binding[] {
  const found: Binding[] = [];
  const store = isStore(value);

  for (const key of Object.keys(value)) {
    if (store && STORE_KEYS.has(key)) {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor !== undefined && "value" in descriptor) {
      found.push([key, descriptor.value]);
    }
  }

  return found;
}

/**
 * A new owner the store already holds above it is refused, itself included, because an owner chain
 * that loops would make the tree infinite. Every loop being refused is also why a chain can be
 * walked without a bound: no chain recorded here can hold one.
 */
function recordOwner(store: Store, owner: object, source: OwnerSource, key?: string): void {
  const devtools = getDevtoolsGlobal();
  const known = devtools.owners.get(store);

  if (chainHolds(devtools, owner, store) || (known !== undefined && keeps(known, source))) {
    return;
  }

  devtools.owners.set(store, { owner: new WeakRef(owner), source, key });
}

/**
 * Whether the edge already recorded stays. A frame only knows that a store was born while some
 * expression ran; the binding scan and `this` in a class field both know a property name, so either
 * may correct a frame and neither corrects the other.
 *
 * One mechanism running again is a hot reload or a second binding: the first owner the registry
 * still knows keeps the store, and a node, which holds no entry to be known by, gives way.
 */
function keeps(known: OwnerLink, source: OwnerSource): boolean {
  const held = known.owner.deref();

  /** Nothing draws the owner any more, so whatever proposes one now is the better answer. */
  if (held === undefined || (isStore(held) && getEntry(held) === undefined)) {
    return false;
  }

  if (known.source !== source) {
    return known.source !== "frame";
  }

  return isStore(held);
}

function chainHolds(devtools: DevtoolsGlobal, from: object, wanted: object): boolean {
  let current: object | undefined = from;

  while (current !== undefined) {
    if (current === wanted) {
      return true;
    }

    current = holderOf(devtools, current);
  }

  return false;
}

/** One step up: what holds a store, or what holds a node. */
function holderOf(devtools: DevtoolsGlobal, value: object): object | undefined {
  return isStore(value)
    ? devtools.owners.get(value)?.owner.deref()
    : devtools.nodes.get(value)?.parent?.deref();
}
