import type { Store } from "nanostores";

import {
  type DevtoolsGlobal,
  getDevtoolsGlobal,
  type NodeInfo,
  peekDevtoolsGlobal,
} from "./global.ts";
import { getEntry, isStore } from "./registry.ts";

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

/** One top-level binding: the name as the developer wrote it, and the value it holds. */
export type Binding = readonly [string, unknown];

/** The module these bindings come from, which is where a node one of them makes is drawn. */
export type ModuleHome = Pick<NodeInfo, "home" | "external">;

/** What one value holds: the members the tree draws, and the ones its cap left out. */
type Members = { drawn: Binding[]; past: Binding[] };

/** One walk: the module it runs for, and what it has already been through, which ends a cycle. */
type Scan = { module: ModuleHome; seen: Set<object> };

/**
 * The module's own top-level bindings, at the end of its body. A binding holding a store places
 * what that store holds; a binding holding anything else becomes a node, and so does every member
 * of it, which is how an array's members nest under the array.
 *
 * Nothing is registered. A store is born once and has one entry, which is what makes two names
 * for one store resolve to one store, so this decides where the tree draws it and nothing else.
 */
export function ownBindings(module: ModuleHome, bindings: readonly Binding[]): void {
  for (const [name, value] of bindings) {
    if (canHold(value)) {
      walk({ module, seen: new Set() }, value, name, undefined, 0);
    }
  }
}

/** An owner the app has let go reads as none, and the store it held is drawn flat again. */
export function ownerOf(store: Store): object | undefined {
  return peekDevtoolsGlobal()?.owners.get(store)?.deref();
}

/** What the tree knows about a value it drew as a node, or nothing for a value it never walked. */
export function nodeInfoOf(value: object): NodeInfo | undefined {
  return peekDevtoolsGlobal()?.nodes.get(value);
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
    makeNode(scan, value, name, owner, members.past.length);
  }

  for (const [key, member] of members.drawn) {
    if (isStore(member)) {
      recordOwner(member, value);
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
    recordOwner(value, owner);

    return;
  }

  if (depth >= MAX_DEPTH || !canHold(value)) {
    return;
  }

  for (const [, member] of membersOf(value).drawn) {
    if (isStore(member)) {
      recordOwner(member, owner);
    }
  }
}

/**
 * The record that makes a value a node. The first name wins: every name this mechanism has is one
 * the developer wrote, so a second binding holding the same value has nothing better to offer.
 */
function makeNode(
  scan: Scan,
  value: object,
  name: string,
  owner: object | undefined,
  skipped: number,
): void {
  const { nodes } = getDevtoolsGlobal();

  if (!nodes.has(value)) {
    nodes.set(value, {
      home: scan.module.home,
      external: scan.module.external,
      name,
      type: typeNameOf(value),
      parent: owner === undefined ? undefined : new WeakRef(owner),
      skipped,
    });
  }
}

/**
 * What built the value, read off the prototype's own `constructor` through the descriptor, so a
 * getter the developer put in the way never runs. `Object` is left off: a plain object node says
 * that much by itself, and the label is there to say what the key cannot.
 */
function typeNameOf(value: object): string | undefined {
  const prototype: object | null = Object.getPrototypeOf(value);
  const descriptor =
    prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, "constructor");
  const built: unknown = descriptor?.value;
  const name: unknown = typeof built === "function" ? built.name : undefined;

  return typeof name === "string" && name !== "" && name !== "Object" ? name : undefined;
}

/** Only an object can hold a store, so only an object is worth looking inside. */
function canHold(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * An array is named by index, a `Map` by key and a `Set` by insertion order, so every name the
 * tree draws is one the developer could write to reach that member. Anything else gives up its own
 * enumerable data properties, read through the descriptor so a getter never runs: it is the
 * developer's own code and running it would change how the app behaves.
 */
function membersOf(value: object): Members {
  if (Array.isArray(value)) {
    return capped(walked((visit) => Array.prototype.forEach.call(value, visit), indexName));
  }

  if (value instanceof Map) {
    return capped(walked((visit) => Map.prototype.forEach.call(value, visit), keyName));
  }

  if (value instanceof Set) {
    return capped(walked((visit) => Set.prototype.forEach.call(value, visit), position));
  }

  return { drawn: propertiesOf(value), past: [] };
}

/** Only a collection is capped. A plain object's keys are as many as the developer wrote. */
function capped(members: Binding[]): Members {
  return { drawn: members.slice(0, MAX_MEMBERS), past: members.slice(MAX_MEMBERS) };
}

/**
 * The built-in `forEach` called against the value, never a method of the value's own, so a subclass
 * that overrides iteration cannot run its code during a scan, and neither can the constructor that
 * `map` and `slice` would build their result through. A failure leaves the collection contributing
 * nothing.
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

/** An array member is named by the index it sits at, so a hole shifts nothing that follows it. */
function indexName(key: unknown): string | undefined {
  return typeof key === "number" ? `[${key}]` : undefined;
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
 * The first owner the registry still knows keeps the store. An owner it lost is replaced: a hot
 * reload builds a module's stores again, and a store imported from another file would otherwise
 * keep pointing at the owner the run before it made. A node holds no entry to be known by, so a
 * later scan always replaces one, and two bindings holding one store pick one arbitrarily.
 *
 * A new owner the store already holds above it is refused, itself included, because an owner chain
 * that loops would make the tree infinite. Every loop being refused is also why the chain below
 * can be walked without a bound: no chain recorded here can hold one.
 */
function recordOwner(store: Store, owner: object): void {
  const devtools = getDevtoolsGlobal();
  const known = devtools.owners.get(store)?.deref();

  if (
    (known !== undefined && isStore(known) && getEntry(known) !== undefined) ||
    chainHolds(devtools, owner, store)
  ) {
    return;
  }

  devtools.owners.set(store, new WeakRef(owner));
}

function chainHolds(devtools: DevtoolsGlobal, from: object, wanted: Store): boolean {
  let current: object | undefined = from;

  while (current !== undefined) {
    if (current === wanted) {
      return true;
    }

    current = isStore(current)
      ? devtools.owners.get(current)?.deref()
      : devtools.nodes.get(current)?.parent?.deref();
  }

  return false;
}
