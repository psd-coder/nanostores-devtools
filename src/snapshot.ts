import type { Store } from "nanostores";

import type { NodeInfo } from "./global.ts";
import { mark } from "./marker.ts";
import {
  enclosingNode,
  MAX_MEMBERS,
  namedByBinding,
  nodeInfoOf,
  ownerKeyOf,
  ownerOf,
} from "./ownership.ts";
import { getEntry, isStore, listEntries, type StoreEntry, type StoreType } from "./registry.ts";
import { staleNote, storeValue } from "./slot.ts";

export type Snapshot = Record<string, Record<string, unknown>>;

/**
 * The two types the tree writes no note for: an atom is the plain case that needs no word, and an
 * unknown type would state a guess. Every other type names itself.
 */
const UNNOTED: ReadonlySet<StoreType> = new Set<StoreType>(["atom", "unknown"]);

/** Where a store that owns others keeps its own value, so its children can sit beside it. */
const SELF_KEY = "(value)";

/** What a capped collection says it left out, so silence never reads as "this is all of it". */
const MORE_KEY = "…";

/**
 * One thing the tree draws: a store's own slot, the second placement its owner keeps of a store the
 * developer named themselves, or a node holding others and no value at all.
 */
type Held =
  | { kind: "store"; entry: StoreEntry; key?: string | undefined }
  | { kind: "second"; entry: StoreEntry; key?: string | undefined }
  | { kind: "node"; value: object; info: NodeInfo };

/**
 * What a store is drawn under, and the key that owner knows it by. The key belongs to the owner and
 * not to the store, so a store in an array is `[0]` there while keeping its own name everywhere
 * else.
 */
type Drawn = { owner: object; key: string | undefined };

/** One key in the tree, and what sits behind it. Built for one snapshot: ownership can change. */
type Placement = { key: string; held: Held };

/** What each owner holds, what each home holds at its own top level, and which nodes are in. */
type Tree = { homes: Map<string, Held[]>; children: Map<object, Held[]>; placed: Set<object> };

/**
 * One home being drawn: the tree it comes out of, and how many nodes carrying a name of ours it has
 * numbered so far. The count runs across the whole file rather than per parent or per class, because
 * two `ref#1`s in one file, one an `Editor` and one a `Viewer`, would read as the same node.
 */
type Pass = { tree: Tree; named: number };

/**
 * `.value` is the whole read. `get()` mounts an unmounted store and a getter runs whatever the
 * developer put behind it, and either one would make watching a store change how the app behaves.
 */
export function buildSnapshot(): Snapshot {
  const tree: Tree = { homes: new Map(), children: new Map(), placed: new Set() };

  for (const entry of listEntries()) {
    place(tree, entry);
  }

  const snapshot: Snapshot = {};

  for (const [home, held] of sortHomes(tree.homes)) {
    const pass: Pass = { tree, named: 0 };

    snapshot[home] = drawAll(pass, rootPlacements(pass, held));
  }

  return snapshot;
}

/**
 * Where one entry is drawn. A name the developer bound the store to takes its value, at the file
 * level, and its owner keeps a second placement of the same store under the name the owner knows it
 * by: without that the owner reads as incomplete, and it is also what a name of theirs is measured
 * against. One entry, one identity, two keys.
 *
 * A store they named is theirs to hold, so the function it was made inside no longer holds it.
 */
function place(tree: Tree, entry: StoreEntry): void {
  const named = namedByBinding(entry.store);
  const drawn = drawnOwner(entry.store);
  const owner = drawn?.owner ?? (named ? undefined : enclosingOwner(entry));

  if (named || owner === undefined) {
    collect(tree.homes, entry.home, { kind: "store", entry });
  }

  if (owner === undefined) {
    return;
  }

  /** The key belongs to the owner the link named, so the function fallback above takes none. */
  const key = drawn?.key;

  collect(
    tree.children,
    owner,
    named ? { kind: "second", entry, key } : { kind: "store", entry, key },
  );
  attach(tree, owner);
}

/**
 * The owner a store is drawn under, with the key that owner knows it by. A store owner the registry
 * lost holds no place in the tree, so a store under it would be drawn nowhere at all and is drawn at
 * its own home instead.
 */
function drawnOwner(store: Store): Drawn | undefined {
  const owner = ownerOf(store);

  return owner !== undefined && drawable(owner) ? { owner, key: ownerKeyOf(store) } : undefined;
}

/**
 * The last resort, reached only by a store every other mechanism left alone: the function it was
 * made inside holds it. One made at module level has no enclosing function and stays flat, which is
 * the right answer, because the file it was written in is already its only holding.
 */
function enclosingOwner(entry: StoreEntry): object | undefined {
  return entry.fn === null
    ? undefined
    : enclosingNode({ home: entry.home, external: entry.external }, entry.fn);
}

function drawable(owner: object): boolean {
  return isStore(owner) ? getEntry(owner) !== undefined : nodeInfoOf(owner) !== undefined;
}

/**
 * A node holds no value of its own, so it reaches the tree only where a store puts it: inside the
 * node or the store that holds it, or at the top level of the file its name was written in.
 */
function attach(tree: Tree, owner: object): void {
  const info = isStore(owner) ? undefined : nodeInfoOf(owner);

  if (info === undefined || tree.placed.has(owner)) {
    return;
  }

  tree.placed.add(owner);

  const parent = info.parent?.deref();
  const held: Held = { kind: "node", value: owner, info };

  if (parent === undefined || !drawable(parent)) {
    collect(tree.homes, info.home, held);

    return;
  }

  collect(tree.children, parent, held);
  attach(tree, parent);
}

function collect<TKey>(index: Map<TKey, Held[]>, key: TKey, held: Held): void {
  const known = index.get(key);

  if (known) {
    known.push(held);
  } else {
    index.set(key, [held]);
  }
}

/**
 * A store that owns nothing is drawn as v1 draws it: its name, its value. One that owns others
 * becomes a node holding its own value under `(value)`.
 *
 * Only a store that owns something is wrapped. A value with nothing under it would gain a nesting
 * level for nothing.
 */
function draw(pass: Pass, held: Held): unknown {
  /**
   * A second placement is the store's value and nothing else. Its children sit under the name the
   * developer gave it, which is where the store itself is drawn, and drawing them twice would say
   * the app holds twice as many stores as it does.
   */
  if (held.kind === "second") {
    return slotFor(held.entry);
  }

  if (held.kind === "store") {
    const children = pass.tree.children.get(held.entry.store);

    return children === undefined
      ? slotFor(held.entry)
      : {
          [SELF_KEY]: slotFor(held.entry),
          ...drawAll(pass, childPlacements(pass, children, undefined)),
        };
  }

  const node = drawAll(
    pass,
    childPlacements(pass, pass.tree.children.get(held.value) ?? [], held.info),
  );

  if (held.info.skipped > 0) {
    node[MORE_KEY] = mark(
      `${held.info.skipped} more members past the ${MAX_MEMBERS} walked; their stores are ` +
        `listed here without a node of their own`,
      {},
    );
  }

  /**
   * The extension's own wrapper, which the panel's reviver drops before printing the type in front
   * of the value, so what built a node costs no key and no nesting level of its own.
   */
  return held.info.type === undefined ? node : mark(held.info.type, node);
}

function drawAll(pass: Pass, placements: readonly Placement[]): Record<string, unknown> {
  const node: Record<string, unknown> = {};

  for (const placement of placements) {
    node[placement.key] = draw(pass, placement.held);
  }

  return node;
}

/** A file level keeps every name whole: a store its registry name, a node the one written. */
function rootPlacements(pass: Pass, held: readonly Held[]): Placement[] {
  const wanted = held.map((one) => ({
    held: one,
    key: one.kind === "node" ? nodeKey(pass, one.info) : displayName(one.entry),
  }));

  return sorted(numberApart(wanted));
}

/**
 * The keys one owner's children take. `inside` is the node they sit in, or nothing when a store
 * holds them.
 *
 * Then the home, for the one clash a file level used to make impossible: ownership draws stores
 * from two files in one node, and two files may each hold a `$history`. Both sides take the
 * suffix, as a name clash inside one file does, because one bare `$history` beside
 * `$history (vendor/withUndo.ts)` does not say which file the bare one came from.
 */
function childPlacements(
  pass: Pass,
  held: readonly Held[],
  inside: NodeInfo | undefined,
): Placement[] {
  const wanted = held.map((one) => ({ held: one, key: childKey(pass, one, inside) }));

  return sorted(numberApart(keepApart(keepApart(wanted, displayName), homed)));
}

/**
 * A nested store is keyed by the name its owner knows it by, which carries no number: the parent
 * already says which one this is. Where several stores from one creation site land on one parent,
 * `keepApart` and `numberApart` below tell them apart again.
 *
 * A member of a collection takes the key that collection holds it under, because a position or a map
 * key is the only name that says which member it is: a tuple carries its meaning in the order, and
 * the name a store was born with says nothing about where it sits.
 *
 * On a collection that left members out, a store no member of it names takes the name it is
 * registered under instead, because the member it came from has no node here to say which one that
 * was, and the number is then all that says it.
 */
function childKey(pass: Pass, held: Held, inside: NodeInfo | undefined): string {
  if (held.kind === "node") {
    return nodeKey(pass, held.info);
  }

  if (held.key !== undefined) {
    return noted(held.key, held.entry.type);
  }

  return inside !== undefined && inside.skipped > 0
    ? displayName(held.entry)
    : noted(held.entry.ownerName, held.entry.type);
}

/**
 * The name a node is drawn under. A node we found no name for at all is always numbered, because
 * there is nothing to put parentheses around and borrowing the class name would only repeat the type
 * label. Every other node waits for a real clash, as a store's name does.
 *
 * The number is handed out here rather than when the node was made, because a binding may rename a
 * node afterwards and numbering at creation time would leave gaps. It sits tight against the name,
 * `ref#1`, so a node's number never reads as the spaced one a store's name carries.
 */
function nodeKey(pass: Pass, info: NodeInfo): string {
  if (!info.numbered) {
    return info.name;
  }

  pass.named += 1;

  return `${info.name}#${pass.named}`;
}

function sorted(placements: readonly Placement[]): Placement[] {
  return [...placements].sort((left, right) => compare(sortName(left), sortName(right)));
}

function homed(entry: StoreEntry, key: string): string {
  return `${key} (${entry.home})`;
}

/** The name the source wrote, which orders the tree: a note or a suffix never moves a child. */
function sortName(placement: Placement): string {
  const { held } = placement;

  if (held.kind === "node") {
    return held.info.name;
  }

  /**
   * A member of a collection sorts by its position, and a second placement sorts where its own key
   * puts it rather than where the developer's name would.
   */
  return held.key ?? (held.kind === "second" ? held.entry.ownerName : held.entry.name);
}

/**
 * A key only one child wants stays; a key two of them want is replaced on both sides. A node keeps
 * its key here whatever happens: the only name it has is the one the developer wrote, so a clash
 * over it waits for a number instead.
 */
function keepApart(
  placements: readonly Placement[],
  rename: (entry: StoreEntry, key: string) => string,
): Placement[] {
  const wanted = countKeys(placements);

  return placements.map(({ held, key }) =>
    wanted.get(key) === 1 || held.kind === "node"
      ? { held, key }
      : { held, key: rename(held.entry, key) },
  );
}

/**
 * A name two children still want is numbered, which is where a node's ordinal comes from. Both
 * sides take a number, as both sides of a name clash take the place suffix, because one bare
 * `panel` next to `panel #2` does not say which of the two the bare one is.
 *
 * Handed out as the tree is drawn, not when the node was made: until every child is in, no name is
 * known to repeat at all.
 */
function numberApart(placements: readonly Placement[]): Placement[] {
  const wanted = countKeys(placements);
  const given = new Map<string, number>();

  return placements.map(({ held, key }) => {
    if (wanted.get(key) === 1) {
      return { held, key };
    }

    const ordinal = (given.get(key) ?? 0) + 1;

    given.set(key, ordinal);

    return { held, key: `${key} #${ordinal}` };
  });
}

function countKeys(placements: readonly Placement[]): Map<string, number> {
  const wanted = new Map<string, number>();

  for (const { key } of placements) {
    wanted.set(key, (wanted.get(key) ?? 0) + 1);
  }

  return wanted;
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

function slotFor(entry: StoreEntry): unknown {
  const note = staleNote(entry.store, entry);

  return note === undefined ? storeValue(entry.store) : mark(note.label, note.data);
}

/**
 * Groups are written by hand and there are few of them, so they belong on top. A home holding
 * at least one explicitly registered store counts as a group, which settles a group named
 * after a file. Then the developer's own files, and last the files that are somebody else's:
 * they keep their own top-level nodes, because a wrapper node holding them all would cost a click
 * to reach anything inside and say nothing itself.
 */
function sortHomes(homes: Map<string, Held[]>): [string, Held[]][] {
  return [...homes].sort(([leftHome, left], [rightHome, right]) => {
    const byKind = rank(left) - rank(right);

    return byKind === 0 ? compare(leftHome, rightHome) : byKind;
  });
}

/** A home is external only if everything in it is: one file of the developer's own lifts it. */
function rank(held: Held[]): number {
  if (held.some((one) => one.kind === "store" && one.entry.origin === "explicit")) {
    return 0;
  }

  return held.every((one) => (one.kind === "node" ? one.info.external : one.entry.external))
    ? 2
    : 1;
}

/** Code unit order, not `localeCompare`, so the tree reads the same under every locale. */
function compare(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}
