import type { NodeInfo } from "./global.ts";
import { keepBuilt, mark, MORE_KEY, VALUE_KEY } from "./marker.ts";
import { MAX_MEMBERS } from "./ownership.ts";
import { drawable, drawnOwner, isPlaced, nodeInfoOf, placedByDeveloper } from "./placement.ts";
import { isStore, listEntries, noted, qualify, type StoreEntry } from "./registry.ts";
import { staleNote, storeValue } from "./slot.ts";
import { isThrottled } from "./throttle.ts";

export type Snapshot = Record<string, Record<string, unknown>>;

/**
 * One thing the tree draws: a store's own slot, the second placement its owner keeps of a store the
 * developer placed themselves, or a node holding others and no value at all.
 */
type Held =
  | { kind: "store"; entry: StoreEntry; key?: string | undefined }
  | { kind: "second"; entry: StoreEntry; key?: string | undefined }
  | { kind: "node"; value: object; info: NodeInfo };

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

  const snapshot: Snapshot = keepBuilt({});

  for (const [home, held] of sortHomes(tree.homes)) {
    const pass: Pass = { tree, named: 0 };

    snapshot[home] = drawAll(pass, rootPlacements(pass, held));
  }

  return snapshot;
}

/**
 * Where one entry is drawn. A home the developer chose takes its value, at the top level of that
 * home, and its owner keeps a second placement of the same store under the name the owner knows it
 * by: without that the owner reads as incomplete, and it is also what a name of theirs is measured
 * against. One entry, one identity, two keys.
 *
 * They choose it two ways: a group they registered the store into by hand, and a top-level name
 * they bound it to in a file of their own. Either one beats the owner the ownership walk recorded,
 * because both say where this store belongs and an owner only says where the walk reached it from.
 */
function place(tree: Tree, entry: StoreEntry): void {
  if (!isPlaced(entry)) {
    return;
  }

  const chosen = placedByDeveloper(entry);
  const drawn = drawnOwner(entry.store);

  if (chosen || drawn === undefined) {
    collect(tree.homes, entry.home, { kind: "store", entry });
  }

  if (drawn === undefined) {
    return;
  }

  /** The key belongs to the owner the link named, so a store no link placed takes none. */
  const held: Held = chosen
    ? { kind: "second", entry, key: drawn.key }
    : { kind: "store", entry, key: drawn.key };

  collect(tree.children, drawn.owner, held);
  attach(tree, drawn.owner);
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
   * A second placement is the store's value and nothing else. Its children sit at the home the
   * developer put it in, which is where the store itself is drawn, and drawing them twice would say
   * the app holds twice as many stores as it does.
   */
  if (held.kind === "second") {
    return slotFor(held.entry);
  }

  if (held.kind === "store") {
    const children = pass.tree.children.get(held.entry.store);

    return children === undefined
      ? slotFor(held.entry)
      : keepBuilt({
          [VALUE_KEY]: slotFor(held.entry),
          ...drawAll(pass, childPlacements(pass, children, undefined)),
        });
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
  const node: Record<string, unknown> = keepBuilt({});

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
 * from two files in one node, and two files may each hold a `$history`. Both sides show it, as a
 * name clash inside one file shows its place, because one bare `$history [store]` beside
 * `$history [store] (vendor/withUndo.ts)` does not say which file the bare one came from.
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
 * A nested store is keyed by the name its owner really holds it under, which carries no number: the
 * parent already says which one this is. Where several stores still land on one parent under one
 * name, `keepApart` and `numberApart` below tell them apart again.
 *
 * The scan reads that name off the owner, so it is the key the developer wrote and not the name the
 * store was born with. The two agree wherever a util calls its own field what it exposes it as, and
 * only where they part does it matter: `{ username: focus($values, "username") }` reads as
 * `username`, where the birth name says `$lens` and a second lens beside it says `$lens #2`.
 *
 * A frame and a class field carry no such name. Nothing there holds the store under a key: the frame
 * only knows it was born while an expression ran. Those keep the name the creation site gave, and a
 * store no site ever named keeps its registered one.
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
    return noted(held.key, held.entry.type, isThrottled(held.entry));
  }

  return inside !== undefined && inside.skipped > 0
    ? displayName(held.entry)
    : noted(nameForOwner(held.entry), held.entry.type, isThrottled(held.entry));
}

/**
 * The name the owner knows the store by, and the store's own name where no creation site ever gave
 * one. The name the store is drawn under everywhere else is the only one left to key it by, and it
 * is what a primary placement takes as well.
 */
function nameForOwner(entry: StoreEntry): string {
  return entry.ownerName ?? entry.name;
}

/**
 * The name a node is drawn under. A node we found no name for at all is always numbered, because
 * there is nothing to put parentheses around and borrowing the class name would only repeat the type
 * label. Every other node waits for a real clash, as a store's name does.
 *
 * The number is handed out here rather than when the node was made, because a binding may rename a
 * node afterwards and numbering at creation time would leave gaps. It sits tight against the name,
 * `ref#1`, so a node's number never reads as the spaced one a store's key carries.
 */
function nodeKey(pass: Pass, info: NodeInfo): string {
  if (!info.numbered) {
    return info.name;
  }

  pass.named += 1;

  return `${info.name}#${pass.named}`;
}

function sorted(placements: readonly Placement[]): Placement[] {
  return [...placements].sort((left, right) => {
    const byName = compare(sortName(left), sortName(right));

    return byName === 0 ? compare(left.key, right.key) : byName;
  });
}

/**
 * The clash a file level made impossible, so the group holds the home instead of the place. Built
 * from the parts rather than added to the key, because a key carries one parenthesis group.
 */
function homed(entry: StoreEntry): string {
  return qualify(noted(entry.name, entry.type, isThrottled(entry)), {
    file: entry.home,
    place: null,
    number: entry.number,
  });
}

/** The name the source wrote, which orders the tree: a note or a group never moves a child. */
function sortName(placement: Placement): string {
  const { held } = placement;

  if (held.kind === "node") {
    return held.info.name;
  }

  /**
   * A member of a collection sorts by its position, and a second placement sorts where its own key
   * puts it rather than where the developer's name would.
   */
  return held.key ?? (held.kind === "second" ? nameForOwner(held.entry) : held.entry.name);
}

/**
 * A key only one child wants stays; a key two of them want is replaced on both sides. A node keeps
 * its key here whatever happens: the only name it has is the one the developer wrote, so a clash
 * over it waits for a number instead.
 */
function keepApart(
  placements: readonly Placement[],
  rename: (entry: StoreEntry) => string,
): Placement[] {
  const wanted = countKeys(placements);

  return placements.map(({ held, key }) =>
    wanted.get(key) === 1 || held.kind === "node"
      ? { held, key }
      : { held, key: rename(held.entry) },
  );
}

/**
 * A name two children still want is numbered, which is where a node's ordinal comes from. The
 * number goes last, after the group, and both sides take one, because one bare `panel [store]`
 * next to `panel [store] #2` does not say which of the two the bare one is.
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
 * The tree key, in the one order every key reads in: the name, its type in square brackets, then
 * the group saying where it was made, then the number saying which store of that place this is.
 * `name` and `label` stay as they are, because they name timeline rows and decide which two stores
 * are one, and a key that changes when adoption learns a type costs one row redrawn.
 */
function displayName(entry: StoreEntry): string {
  return qualify(noted(entry.name, entry.type, isThrottled(entry)), entry);
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
