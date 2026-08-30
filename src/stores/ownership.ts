import type { Store } from "nanostores";

import {
  type BoundName,
  type DevtoolsGlobal,
  getDevtoolsGlobal,
  type ModuleScope,
  type NodeInfo,
  peekDevtoolsGlobal,
  scopeOf,
} from "../global.ts";
import { makeLabel } from "./labels.ts";
import { claimBindingFile, type NameSource } from "./names.ts";
import { getEntry, isStore, registerStore, renameEntry, renameFound } from "./registry.ts";
import { storeValue } from "../tree/slot.ts";
import { describeError, warnOnce } from "../utils/warn.ts";

/**
 * What nanostores itself puts on a store. Skipped while walking, because none of it is state the
 * developer wrote. `value` is skipped here and read again as its own step, so what a store holds
 * is walked once, under a path that says how the developer would reach it.
 */
export const STORE_KEYS: ReadonlySet<string> = new Set([
  "value",
  "init",
  "lc",
  "events",
  "listen",
  "get",
  "set",
  "setKey",
  "eq",
  "eqKey",
  "subscribe",
  "notify",
  "off",
]);

/**
 * What every class carries beside the static fields the developer wrote. A static field may be
 * named any of the three, so they are skipped by name rather than by how they are defined.
 */
const CLASS_KEYS: ReadonlySet<string> = new Set(["prototype", "length", "name"]);

/**
 * How many steps into a binding the walk takes, counting a property, an index and a key alike,
 * where the plugin's `maxDepth` option names no other number. Ten is past the depth a developer
 * nests state on purpose, so what it stops is a shape nobody meant the panel to draw.
 */
const MAX_DEPTH = 10;

/**
 * What a node no name in the source reaches is keyed by. It says plainly that the name is ours,
 * rather than borrowing the class name, which the type label already holds.
 */
const UNNAMED = "ref";

/** A name that can stand after a dot, which is what decides whether a path part is bracketed. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The step from a store to what it holds, spelled the way the developer would type it. The path a
 * store found inside another store's value takes says the step, so the name stays something the
 * reader can look up in their own source.
 */
const VALUE_STEP = ".get()";

/**
 * One top-level name the module binds, and what the developer asked for about it. `exported` is
 * what settles a race between two bindings holding one store.
 */
export type Binding = {
  name: string;
  value: unknown;
  exported: boolean;
  maxMembers?: number;
  /**
   * Whether the name binds a class, whose own static properties the walk reads. Nothing else a
   * function binds is looked inside: reading the own properties of every top-level function in the
   * app would cost every one of them for the one rare shape a static store is.
   */
  isClass?: boolean;
};

/** One key and value inside a walked value. Not a binding: nothing in the source names it. */
export type Member = readonly [key: string, value: unknown];

/**
 * The module these bindings come from: where a node one of them makes is drawn, and which module
 * drew it. Every link carries that key, because a hot reload has to drop its own and nobody else's.
 */
export type ModuleHome = Pick<NodeInfo, "home" | "external"> & NameSource;

/** What one value holds: the members the tree draws, and the ones its cap left out. */
type Read = { drawn: Member[]; past: Member[] };

/**
 * A value read holds members; a value that threw at us holds a reason and nothing else, so the two
 * never mix.
 */
type Members = ({ read: true } & Read) | { read: false; reason: string };

/**
 * One store the walk reached, and where it reached it: the owner that holds it and the key it sits
 * under. A binding's whole set of them is one value, which is what two walks can be compared by.
 */
type Reach = { store: Store; path: string; key: string; owner: object };

/** One store a binding reaches, and the path the developer can type to reach it. */
export type ReachedStore = { store: Store; path: string };

/**
 * What one top-level binding reached. A binding that holds a store holds itself first, at its own
 * name, so a binding pointing straight at a store reaches one store rather than none.
 */
export type BindingReach = { binding: string; reached: ReachedStore[] };

/**
 * One walk: the module it runs for, the top-level binding it started at, and what it has already
 * been through, which ends a cycle. The binding is the name the developer can look up, so it is
 * what a warning about anything found below it says.
 */
type Scan = {
  module: ModuleHome;
  binding: string;
  seen: Set<object>;
  maxDepth: number;
  maxMembers: number | undefined;
  found: Reach[];
  /** Which walk this is, so what an older one wrote about where a value sits can be replaced. */
  pass: number;
};

/**
 * The module's own top-level bindings, at the end of its body. A binding holding a store places
 * what that store holds; a binding holding anything else becomes a node, and so does every member
 * of it, which is how an array's members nest under the array.
 *
 * **A store the walk reaches is registered here**, under the name that holds it, so a store no
 * wrapper could name still draws. A store the registry already knows keeps its entry: a store is
 * born once and has one entry, which is what makes two names for one store resolve to one store.
 *
 * **The walk hands back what it reached, and registration reads that.** A binding is walked, then
 * everything it reached is registered in the order it was reached. The same list is returned, one
 * per binding, so what a binding reaches is a value a caller can hold and compare.
 *
 * **Two passes, and not one.** Every binding claims its name first, and only then is any of them
 * walked. A top-level binding beats the key of an object holding the same store, so one pass would
 * let a walk started earlier in the file name the store after where it was found, and the order
 * the developer wrote their bindings in would decide.
 *
 * **A class is walked too**, for its own static fields, which nothing else can reach: a static
 * field belongs to the class, and no instance of it holds the store.
 *
 * **It runs again whenever something under a binding changes**, so a store the app built after
 * the module body finished is found. One walk is one pass: what it says about where a value sits
 * replaces what an older walk said, and what it says twice keeps the first answer.
 */
export function ownBindings(
  module: ModuleHome,
  bindings: readonly Binding[],
  maxDepth: number = MAX_DEPTH,
): BindingReach[] {
  if (placesNothing(module)) {
    return [];
  }

  const pass = nextPass();

  for (const { name, value, exported } of bindings) {
    if (isStore(value)) {
      claimName(module, value, name, exported);
    }
  }

  const walked: BindingReach[] = [];

  for (const { name, value, maxMembers, isClass } of bindings) {
    const found: Reach[] = [];

    if (canHold(value) || (isClass === true && typeof value === "function")) {
      walk(
        { module, binding: name, seen: new Set(), maxDepth, maxMembers, found, pass },
        value,
        name,
        name,
        undefined,
        0,
      );
    }

    register(module, found, pass);
    walked.push({ binding: name, reached: reachedBy(name, value, found) });
  }

  return walked;
}

/** The number that tells one walk from the next, shared so two copies cannot hand out one twice. */
function nextPass(): number {
  const devtools = getDevtoolsGlobal();

  devtools.pass += 1;

  return devtools.pass;
}

/**
 * Everything the walk found, registered in the order it was reached. A name is taken first and the
 * owner link written after it, per store, so a store reached under another one is registered
 * before anything below it.
 */
function register(module: ModuleHome, found: readonly Reach[], pass: number): void {
  for (const { store, path, key, owner } of found) {
    nameReached(module, store, path, key);
    recordOwner(module, store, owner, pass, key, path);
  }
}

/**
 * The stores one binding reaches, the binding's own store first. It hands out the store and the
 * path, which is what names the store and what a later walk compares.
 */
function reachedBy(name: string, value: unknown, found: readonly Reach[]): ReachedStore[] {
  const own: ReachedStore[] = isStore(value) ? [{ store: value, path: name }] : [];

  return [...own, ...found.map(({ store, path }) => ({ store, path }))];
}

/**
 * A file of somebody else's places nothing at all: not a name, not a node, not a store under one.
 * A library binds its own working state to its own top-level names too, and `resource` holding a
 * `$active` a ref count writes is the library's business, not a thing the app can act on. What the
 * app got out of that library is bound in a file of the developer's own, and that binding draws it.
 *
 * A store the file made at module level is drawn flat at its home even so, because it is what the
 * library hands out on purpose and no mechanism here is what puts it there.
 */
function placesNothing(module: ModuleHome): boolean {
  return module.external;
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
  if (placesNothing(module)) {
    return;
  }

  const statics = typeof owner === "function";
  const written = statics ? classKey(owner) : undefined;
  const pass = nextPass();

  makeNode(module, owner, undefined, {
    home: module.home,
    external: module.external,
    name: written ?? UNNAMED,
    ours: written === undefined,
    numbered: written === undefined,
    type: statics ? undefined : typeNameOf(owner),
    walked: 0,
    skipped: 0,
    pass,
  });

  recordOwner(module, store, owner, pass);
}

/**
 * A store the developer bound to a top-level name in a file of their own. They wrote that name, so
 * it beats the one the creation site gave: `export const $undoable = $draft2.$canUndo` is drawn
 * nowhere at all under a rule that only follows the path to an owner.
 *
 * **Every binding is kept, and every one of them draws.** Two names for one store are two things
 * the developer wrote, and dropping one says the app holds less than the source does.
 *
 * **The entry still takes exactly one of them.** `entry.name`, `entry.label`, the by-name index,
 * the throttle mark and every timeline row read one name, and a row can point at one node. An
 * exported binding is the name the rest of the app knows the store by, so it wins whatever order
 * the bindings are scanned in; two of the same kind pick one arbitrarily, and the last one wins.
 *
 * The entry says which file it came from where a second module the home holds writes that name too,
 * which is what keeps two files `fileKey` maps onto one home from taking each other's entry.
 */
function claimName(module: ModuleHome, store: Store, name: string, exported: boolean): void {
  const devtools = getDevtoolsGlobal();

  registerFound(module, store, name);

  const written: BoundName = {
    name,
    home: module.home,
    file: claimBindingFile(module, store, name),
    moduleKey: module.moduleKey,
    exported,
  };
  /**
   * The same module writing the same name again is one binding, not a second one. A walk that runs
   * again writes the same one, so it is left where it is and the module's list of what to drop on
   * a reload stays the length the source is.
   */
  const names = devtools.bound.get(store) ?? [];
  const already = names.findIndex((known) => sameBinding(known, written));

  if (already === -1) {
    names.push(written);
    devtools.bound.set(store, names);
    noteLink(module.moduleKey, store);
  } else {
    names[already] = written;
  }

  const primary = primaryName(names) ?? written;

  renameEntry(store, primary.name, primary.home, primary.file);
}

function sameBinding(one: BoundName, other: BoundName): boolean {
  return one.moduleKey === other.moduleKey && one.name === other.name && one.home === other.home;
}

/**
 * A name the developer could type, made of the part that reached the value and the key of the
 * member under it. A key a collection gave is already bracketed and joins straight; a bare key
 * takes a dot, unless it is no identifier, and then it is bracketed so the whole path stays
 * something the reader can look up in their own source.
 */
function joined(path: string, key: string): string {
  if (key.startsWith("[")) {
    return `${path}${key}`;
  }

  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * The store the scan has just reached, born here where the registry has never seen it. That is a
 * store no wrapper could name: one an installed package made, one a call put on the object it
 * returned, one a `new` expression built. The name it takes is the whole chain that reached it: the
 * top-level binding, then every key the walk went through.
 *
 * The whole chain, and not the last key alone, because the last key alone is not one name. Two
 * bindings holding one shape both hold a member called `open`, and one name in the registry holds
 * one store, so the second would take the first one's place and the first would draw nowhere.
 *
 * A store a wrapper already registered keeps that entry, with the line, the kind and the throttle
 * comment only the creation site knows. The walk renames it and nothing more.
 *
 * The kind comes from `creations`, where a creator call with no name of its own filed it, so a
 * store the plugin wrapped without being able to name it still draws as the type it is.
 */
function registerFound(module: ModuleHome, store: Store, name: string, ownerName?: string): void {
  if (getEntry(store) !== undefined) {
    return;
  }

  registerStore({
    store,
    name,
    home: module.home,
    type: getDevtoolsGlobal().creations.get(store) ?? "unknown",
    origin: "plugin",
    external: module.external,
    ownerName,
  });

  /** Only this list makes the module's own reload drop what its scan registered. */
  scopeOf(module.moduleKey).owned.add(store);
}

/**
 * The store the walk has just reached under a key, and the name it goes by from here. A store no
 * wrapper could name is registered; a store one already registered is renamed to the path, because
 * the name a creator call gave it is one key of one object and two objects hold a key called
 * `$open`. Its entry, its kind and its throttle comment are all kept.
 *
 * Three names beat the path, and each of them is a thing the developer wrote for this store: a
 * group they registered it into by hand, a top-level binding that holds it, and the first path a
 * scan already recorded. That last one is what stops import order moving a row header about.
 */
function nameReached(module: ModuleHome, store: Store, path: string, key: string): void {
  const known = getEntry(store);

  if (known === undefined) {
    registerFound(module, store, path, key);

    return;
  }

  if (known.origin === "explicit" || isBound(store) || pathTaken(store)) {
    return;
  }

  renameFound(store, path, module.home, key);
}

/** Whether a top-level binding of the developer's own already names the store. */
function isBound(store: Store): boolean {
  return (getDevtoolsGlobal().bound.get(store) ?? []).length > 0;
}

/**
 * Whether a scan has already recorded a chain that reaches the store. The first one wins the
 * entry's name, across modules as well, so a module loaded later adds its owner link and leaves
 * the name alone.
 */
function pathTaken(store: Store): boolean {
  return (getDevtoolsGlobal().owners.get(store) ?? []).some((link) => link.path !== undefined);
}

/**
 * The binding the entry takes: the last exported one, or the last one at all. The list is in scan
 * order, which is source order inside a module body and import order across modules, so a build
 * that changed nothing draws the same name.
 */
export function primaryName(names: readonly BoundName[]): BoundName | undefined {
  return names.filter((one) => one.exported).at(-1) ?? names.at(-1);
}

/**
 * The walk itself. `owner` is what holds this value: a store, a node, or nothing at all at the top
 * of a binding, where the value is drawn at its file level and needs no owner. `path` is the whole
 * chain that reached it, which is the name a store found under it is registered by.
 */
function walk(
  scan: Scan,
  value: object,
  name: string,
  path: string,
  owner: object | undefined,
  depth: number,
): void {
  if (depth >= scan.maxDepth || scan.seen.has(value)) {
    return;
  }

  scan.seen.add(value);

  const members = membersOf(value, scan.maxMembers);

  if (!members.read) {
    warnRefused(scan, name, members.reason);

    return;
  }

  if (!isStore(value)) {
    makeNode(scan.module, value, owner, {
      home: scan.module.home,
      external: scan.module.external,
      name,
      ours: false,
      numbered: false,
      type: typeNameOf(value),
      walked: members.drawn.length,
      skipped: members.past.length,
      pass: scan.pass,
    });

    visit(scan, members.drawn, path, value, depth);

    return;
  }

  const held = heldBy(scan, value, name, depth);

  /**
   * A store already holds a place of its own, so only another kind of value becomes a node. Its own
   * members are counted beside it, or a cap would cut them and say nothing. What the store holds is
   * counted nowhere, because `(value)` draws it whole: the cap bounds how far the walk goes, and
   * nothing the reader can see goes missing without a word.
   *
   * Written on every walk, so a reload that drops the comment clears the number it left behind.
   */
  getDevtoolsGlobal().members.set(value, {
    walked: members.drawn.length,
    skipped: members.past.length,
  });

  visit(scan, members.drawn, path, value, depth);
  visit(scan, held.drawn, `${path}${VALUE_STEP}`, value, depth + 1);
}

/**
 * What a store holds, as members of the store itself. `$root.get().$children` is a path the
 * developer can type, so a store sitting inside another store's value is reachable and it draws,
 * under the store that holds it and beside the store's own value.
 *
 * The value is read through the descriptor and never computed: the bridge does not run the app's
 * code to find out something, so an unmounted `computed` gives up whatever it still holds and a
 * store that never ran gives up nothing at all. The step counts against the depth cap like every
 * other, and the members are capped like every other value's.
 */
function heldBy(scan: Scan, store: Store, name: string, depth: number): Read {
  const nothing: Read = { drawn: [], past: [] };
  const held = storeValue(store);

  /**
   * A store whose whole value is another store is left where it is. The value slot draws that store
   * with its own type and value, and the key beside the slot would be the step itself, which is no
   * name a collection or a property gives.
   */
  if (depth + 1 >= scan.maxDepth || !canHold(held) || isStore(held) || scan.seen.has(held)) {
    return nothing;
  }

  scan.seen.add(held);

  const members = membersOf(held, scan.maxMembers);

  if (!members.read) {
    warnRefused(scan, name, members.reason);

    return nothing;
  }

  return members;
}

/**
 * Every member of one value, under the owner that holds it. The owner is what the tree draws a
 * store under, which for a member of a store's value is the store itself: the value is drawn under
 * the store's own key and what it holds sits beside it.
 */
function visit(
  scan: Scan,
  members: readonly Member[],
  path: string,
  owner: object,
  depth: number,
): void {
  for (const [key, member] of members) {
    const reached = joined(path, key);

    if (isStore(member)) {
      scan.found.push({ store: member, path: reached, key, owner });
    }

    if (canHold(member)) {
      walk(scan, member, key, reached, owner, depth + 1);
    }
  }
}

/**
 * One line for a value the walk could not read, or the developer sees a store missing from the
 * tree with nothing to look at. Keyed by the binding the walk started at rather than by the member
 * that threw, so a hostile value in a loop costs one line and a second binding still gets its own.
 */
function warnRefused(scan: Scan, name: string, reason: string): void {
  const place = name === scan.binding ? `"${name}"` : `"${name}" under "${scan.binding}"`;

  warnOnce(
    "value-refused",
    makeLabel(scan.module.home, scan.binding),
    `${place} in "${scan.module.home}" refused to be read, so nothing it holds is in the tree. ` +
      `${reason}`,
  );
}

/** Everything a node draws apart from what holds it, which is the one thing a walk never replaces. */
type Drawn = Omit<NodeInfo, "parents">;

/**
 * The record that makes a value a node. The first name the developer wrote wins: a second binding
 * holding the same value has nothing better to offer. A name of ours is replaced by a written one
 * whenever one turns up, because a class field names its instance before any binding holds it.
 *
 * **The name rule and the parent rule are separate.** A second sighting keeps the first name and
 * still appends its parent, because two containers holding one value are two references the
 * developer wrote, and both draw.
 */
function makeNode(
  module: ModuleHome,
  value: object,
  parent: object | undefined,
  node: Drawn,
): void {
  const { nodes } = getDevtoolsGlobal();
  const known = nodes.get(value);
  const info = known ?? { ...node, parents: [] };

  if (known === undefined) {
    nodes.set(value, info);
  } else if (replaces(known, node)) {
    /** Everything drawn beside the name, and never the parents, which `Drawn` leaves out. */
    Object.assign(known, node);
  }

  if (parent !== undefined) {
    addParent(module, value, info, parent);
  }
}

/**
 * Whether what this walk knows about a node replaces what the last one wrote. A name of ours never
 * replaces one the developer wrote, and a written name replaces one of ours at once, because a
 * class field names its instance before any binding holds it.
 *
 * Past that, only a position replaces a position, and only across walks. A member removed from an
 * array moves everything after it, so the index a later walk found is where the member really sits
 * now; a name is not a position and does not move, so the first walk to reach a value keeps its
 * name and import order cannot rename a row.
 */
function replaces(known: NodeInfo, node: Drawn): boolean {
  if (node.ours && !known.ours) {
    return false;
  }

  if (known.ours !== node.ours) {
    return true;
  }

  return known.pass !== node.pass && moved(known.name, node.name);
}

/**
 * Whether one key says where a member sits and the other says the same about the same value. A
 * collection names its members by position or by key, `[0]` and `["cart"]`, and only such a name
 * follows the app when the app moves the member.
 */
function moved(from: string, to: string): boolean {
  return from.startsWith("[") && to.startsWith("[");
}

/**
 * One more thing that holds the node. Refused where the node already holds the parent, because a
 * parent graph that loops would make the tree infinite, and refused where the same parent is
 * already recorded, so a second walk over one binding draws no second copy of the node.
 */
function addParent(module: ModuleHome, value: object, info: NodeInfo, parent: object): void {
  const devtools = getDevtoolsGlobal();

  info.parents = live(info.parents, (link) => link.parent);

  if (info.parents.some((link) => link.parent.deref() === parent)) {
    return;
  }

  if (parent === value || reaches(devtools, parent, value)) {
    return;
  }

  info.parents.push({ parent: new WeakRef(parent), moduleKey: module.moduleKey });
  noteLink(module.moduleKey, value);
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
  /** A class is drawn under the name that binds it, and `Function` behind that says nothing. */
  if (typeof value === "function") {
    return undefined;
  }

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
 *
 * Every read below is the app's own code on a `Proxy`, and a trap of theirs may throw rather than
 * answer. One guard here covers all four shapes: the value gives up nothing at all, the walk keeps
 * the bindings beside it, and the reason travels back so one warning can name what refused.
 */
function membersOf(value: object, limit: number | undefined): Members {
  try {
    if (Array.isArray(value)) {
      return capped(indexed(value), limit);
    }

    if (value instanceof Map) {
      return capped(
        walked((visit) => Map.prototype.forEach.call(value, visit), keyName),
        limit,
      );
    }

    if (value instanceof Set) {
      return capped(
        walked((visit) => Set.prototype.forEach.call(value, visit), position),
        limit,
      );
    }

    return capped(propertiesOf(value), limit);
  } catch (error) {
    return { read: false, reason: describeError(error) };
  }
}

/**
 * Every container is capped the same way, and only where the binding named a number. An object
 * built at run time has as many keys as its data, so a rule that capped an array and left the
 * object beside it whole would be arbitrary. The number comes from a comment the developer wrote
 * over that binding; nobody guesses one on their behalf.
 */
function capped(members: Member[], limit: number | undefined): Members {
  if (limit === undefined) {
    return { read: true, drawn: members, past: [] };
  }

  return { read: true, drawn: members.slice(0, limit), past: members.slice(limit) };
}

/**
 * Every index the array itself holds a data descriptor for, so no accessor of the app's runs and no
 * index the array only inherits is drawn. A member keeps the index it really sits at, so a hole
 * shifts nothing that follows it, and one index that is refused costs the others nothing.
 */
function indexed(value: readonly unknown[]): Member[] {
  const found: Member[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);

    if (descriptor !== undefined && "value" in descriptor) {
      found.push([`[${index}]`, descriptor.value]);
    }
  }

  return found;
}

/**
 * The built-in `forEach` called against the value, never a method of the value's own, so a subclass
 * that overrides iteration cannot run its code during a scan.
 */
function walked(
  iterate: (visit: (member: unknown, key: unknown) => void) => void,
  nameOf: (key: unknown, index: number) => string | undefined,
): Member[] {
  const found: Member[] = [];
  let index = 0;

  iterate((member, key) => {
    const name = nameOf(key, index);

    index += 1;

    if (name !== undefined) {
      found.push([name, member]);
    }
  });

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

/**
 * A class gives up its own static fields, and what every class carries beside them is skipped:
 * `prototype` holds the methods, and `length` and `name` describe the class itself.
 */
function propertiesOf(value: object): Member[] {
  const found: Member[] = [];
  const store = isStore(value);
  const isClass = typeof value === "function";

  for (const key of Object.keys(value)) {
    if ((store && STORE_KEYS.has(key)) || (isClass && CLASS_KEYS.has(key))) {
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
 * One more thing that holds the store, once per reference the developer wrote. A class field and a
 * walk both know a property name, so both are references and both accumulate.
 *
 * A new owner the store already holds above it is refused, itself included, because an owner graph
 * that loops would make the tree infinite.
 */
function recordOwner(
  module: ModuleHome,
  store: Store,
  owner: object,
  pass: number,
  key?: string,
  path?: string,
): void {
  const devtools = getDevtoolsGlobal();
  const links = live(devtools.owners.get(store) ?? [], (link) => link.owner);
  const known = links.find((link) => link.owner.deref() === owner);

  devtools.owners.set(store, links);

  /**
   * The same owner proposed again: one link, and the walk that knows a key names it. A later walk
   * names it again where both keys are positions, because an array member the app removed moves
   * everything after it and the key says which member the store is now. Inside one walk, and for
   * every name that is not a position, the first key stands.
   */
  if (known !== undefined) {
    const shifted = known.pass !== pass && known.key !== undefined && moved(known.key, key ?? "");

    if (key !== undefined && (known.key === undefined || shifted)) {
      known.key = key;
      known.path = path;
      known.pass = pass;
      known.moduleKey = module.moduleKey;
      takeKey(devtools, owner, key, store);
      /** The link is this module's from here, so its own reload has to be able to find it. */
      noteLink(module.moduleKey, store);
    }

    return;
  }

  if (owner === store || reaches(devtools, owner, store)) {
    return;
  }

  takeKey(devtools, owner, key, store);
  links.push({ owner: new WeakRef(owner), key, path, pass, moduleKey: module.moduleKey });
  noteLink(module.moduleKey, store);
}

/**
 * One owner and one key name one store. A key holds one value, and the scan reads it at the end of
 * the module body, so the last scan to walk the owner saw what was really there and any other
 * store's link to that key is out of date.
 *
 * The store that loses the link keeps its entry and draws at its own file. The app may hold it
 * somewhere no walk reached, and a store the panel drew a moment ago is worth more there than
 * nowhere at all.
 */
function takeKey(
  devtools: DevtoolsGlobal,
  owner: object,
  key: string | undefined,
  store: Store,
): void {
  if (key === undefined) {
    return;
  }

  const held = devtools.keyed.get(owner) ?? new Map<string, WeakRef<Store>>();
  const taken = held.get(key)?.deref();

  devtools.keyed.set(owner, held);
  held.set(key, new WeakRef(store));

  /**
   * Only the store this owner still holds under this key loses the link. A store that moved to
   * another key of the same owner keeps its own: it is still a member, at the key its own link
   * now names, and the store that took the key it left says nothing about it.
   */
  if (taken !== undefined && taken !== store) {
    dropOwn(devtools.owners, taken, (link) => link.owner.deref() !== owner || link.key !== key);
  }
}

/**
 * Whether the graph already leads from one value up to another, which is the whole of what keeps
 * the tree finite: an edge that would close a loop is refused, so no walk over these edges runs
 * without end.
 *
 * It searches every edge rather than one chain, because with several owners and several parents
 * there is no one chain to walk. The walk depth bounds how much graph a scan can build, so the
 * search is over a graph the developer's own source shapes.
 */
function reaches(devtools: DevtoolsGlobal, from: object, wanted: object): boolean {
  const pending: object[] = [from];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();

    if (current === wanted) {
      return true;
    }

    if (current === undefined || seen.has(current)) {
      continue;
    }

    seen.add(current);
    pending.push(...holdersOf(devtools, current));
  }

  return false;
}

/** Every step up: what holds a store, and what holds a node. */
function holdersOf(devtools: DevtoolsGlobal, value: object): object[] {
  const held = isStore(value)
    ? devtools.owners.get(value)?.map((link) => link.owner)
    : devtools.nodes.get(value)?.parents.map((link) => link.parent);

  return (held ?? []).flatMap((ref) => {
    const above = ref.deref();

    return above === undefined ? [] : [above];
  });
}

/**
 * The links whose holder the app still holds, and whose holder the tree can still draw. A store
 * owner the registry lost draws nowhere, so a link to it is worth no more than a dead reference.
 */
function live<TLink>(links: readonly TLink[], refOf: (link: TLink) => WeakRef<object>): TLink[] {
  return links.filter((link) => {
    const held = refOf(link).deref();

    return held !== undefined && !(isStore(held) && getEntry(held) === undefined);
  });
}

/**
 * The value goes on the module's sweep list, which is the only way a reload finds the links it
 * wrote: neither `owners` nor `nodes` nor `bound` can be listed. The reference is weak, so the list
 * keeps nothing alive that the app has let go.
 */
function noteLink(moduleKey: string, value: object): void {
  scopeOf(moduleKey).linked.add(new WeakRef(value));
}

/**
 * The links one module's run wrote, dropped, because its body is about to run again and write them
 * afresh. Without this a save appends where it used to overwrite, and the panel draws the store
 * under both the container the last run made and the one this run makes.
 */
export function releaseLinks(scope: ModuleScope, moduleKey: string): void {
  const devtools = peekDevtoolsGlobal();

  if (devtools === undefined) {
    return;
  }

  for (const held of scope.linked) {
    const value = held.deref();

    if (value === undefined) {
      continue;
    }

    if (isStore(value)) {
      dropOwn(devtools.owners, value, (link) => link.moduleKey !== moduleKey);
      dropOwn(devtools.bound, value, (name) => name.moduleKey !== moduleKey);

      continue;
    }

    const info = devtools.nodes.get(value);

    if (info !== undefined) {
      info.parents = info.parents.filter((link) => link.moduleKey !== moduleKey);
    }
  }
}

function dropOwn<TKey extends object, TItem>(
  index: WeakMap<TKey, TItem[]>,
  key: TKey,
  keep: (item: TItem) => boolean,
): void {
  const items = index.get(key);

  if (items !== undefined) {
    index.set(key, items.filter(keep));
  }
}
