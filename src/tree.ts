import type { NodeInfo } from "./global.ts";
import { drawable, drawnOwner, isPlaced, nodeInfoOf, placedByDeveloper } from "./placement.ts";
import { isStore, listEntries, type NameParts, type StoreEntry } from "./registry.ts";
import { type Slot, staleNote } from "./slot.ts";

export type { Slot } from "./slot.ts";

export type TreeModel = { homes: HomeGroup[] };

/** One top level of the tree, in the order the panel should draw them. */
export type HomeGroup = { home: string; kind: HomeKind; children: TreeNode[] };

/** Groups the developer wrote by hand, then their own files, then somebody else's. */
export type HomeKind = "group" | "own" | "external";

export type TreeNode = StoreNode | SecondNode | HolderNode;

/** A store at a place of its own, with whatever it owns under it. */
export type StoreNode = {
  kind: "store";
  entry: StoreEntry;
  /** The name to draw, which is the owner's key where an owner has one. */
  name: string;
  /** What tells this one from another of the same name. `null` where nothing has to. */
  qualifier: NameParts | null;
  /** Which of several siblings that still want this name, or `null` for the only one. */
  ordinal: number | null;
  slot: Slot;
  children: TreeNode[];
};

/** The owner's copy of a store the developer placed somewhere else. Value only, no children. */
export type SecondNode = Omit<StoreNode, "kind" | "children"> & { kind: "second" };

/** A thing that holds others and has no value of its own. */
export type HolderNode = {
  kind: "holder";
  value: object;
  name: string;
  /** What built it, `Editor` or `Array`. `undefined` for a plain object. */
  type: string | undefined;
  /**
   * Whether the name is ours rather than the developer's, which is a node nothing could name. Such
   * a node always takes an ordinal, and it is a number of the whole home rather than of its
   * siblings, so two of them never read as one node.
   */
  ours: boolean;
  ordinal: number | null;
  /** Members the ownership walk left out, `0` when it walked them all. */
  skipped: number;
  children: TreeNode[];
};

/**
 * One thing the tree draws: a store's own slot, the second placement its owner keeps of a store the
 * developer placed themselves, or a node holding others and no value at all.
 */
type Held =
  | { kind: "store"; entry: StoreEntry; key?: string | undefined }
  | { kind: "second"; entry: StoreEntry; key?: string | undefined }
  | { kind: "node"; value: object; info: NodeInfo };

/** What each owner holds, what each home holds at its own top level, and which nodes are in. */
type Tree = { homes: Map<string, Held[]>; children: Map<object, Held[]>; placed: Set<object> };

/**
 * One home being built: the tree it comes out of, and how many nodes carrying a name of ours it has
 * numbered so far. The count runs across the whole file rather than per parent or per class, because
 * two `ref` nodes numbered one in one file, one an `Editor` and one a `Viewer`, would read as the
 * same node.
 */
type Pass = { tree: Tree; named: number };

/** One child of a level: the node itself, and the name the source wrote, which orders it. */
type Placement = { node: TreeNode; sortName: string };

/** The name a store is drawn under, and what tells it from a sibling of the same name. */
type Naming = { name: string; qualifier: NameParts | null };

/** Smaller than any character a name can hold, so a joined identity compares field by field. */
const PART = "\u0000";

/** Wide enough for every number a registry can hand out, so `#10` sorts after `#2`. */
const ORDER_DIGITS = 8;

/**
 * `.value` is the whole read. `get()` mounts an unmounted store and a getter runs whatever the
 * developer put behind it, and either one would make watching a store change how the app behaves.
 */
export function buildTree(): TreeModel {
  const tree: Tree = { homes: new Map(), children: new Map(), placed: new Set() };

  for (const entry of listEntries()) {
    place(tree, entry);
  }

  return {
    homes: sortHomes(tree.homes).map(([home, held]) => ({
      home,
      kind: kindOf(held),
      children: rootNodes({ tree, named: 0 }, held),
    })),
  };
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

/** A file level keeps every name whole: a store its registry name, a node the one written. */
function rootNodes(pass: Pass, held: readonly Held[]): TreeNode[] {
  const placements = held.map((one) => rootPlacement(pass, one));

  numberApart(placements);

  return fillAll(pass, sorted(placements));
}

/**
 * The children of one owner. `inside` is the node they sit in, or nothing when a store holds them.
 *
 * A clash is settled twice over: the store's own name and place first, and its home second. The
 * home is for the one clash a file level made impossible, where ownership draws stores from two
 * files into one node and two files each hold a `$history`. Both sides show it, because one bare
 * `$history` beside a `$history` from `vendor/withUndo.ts` does not say where the bare one came
 * from.
 */
function childNodes(pass: Pass, held: readonly Held[], inside: HolderNode | undefined): TreeNode[] {
  const placements = held.map((one) => childPlacement(pass, one, inside));

  keepApart(placements, ownNaming);
  keepApart(placements, homedNaming);
  numberApart(placements);

  return fillAll(pass, sorted(placements));
}

/**
 * Each node's own children, built in the order the level is drawn in, so a name of ours takes its
 * number where the developer meets it.
 */
function fillAll(pass: Pass, placements: readonly Placement[]): TreeNode[] {
  return placements.map(({ node }) => {
    fill(pass, node);

    return node;
  });
}

/**
 * A second placement is the store's value and nothing else. Its children sit at the home the
 * developer put it in, which is where the store itself is drawn, and drawing them twice would say
 * the app holds twice as many stores as it does.
 */
function fill(pass: Pass, node: TreeNode): void {
  if (node.kind === "second") {
    return;
  }

  if (node.kind === "store") {
    node.children = childNodes(pass, pass.tree.children.get(node.entry.store) ?? [], undefined);

    return;
  }

  node.children = childNodes(pass, pass.tree.children.get(node.value) ?? [], node);
}

function rootPlacement(pass: Pass, held: Held): Placement {
  if (held.kind === "node") {
    return holderPlacement(pass, held);
  }

  return {
    node: storeNode(held, held.entry.name, ownParts(held.entry)),
    sortName: sortName(held),
  };
}

/**
 * A nested store is drawn under the name its owner really holds it under, which carries nothing
 * that tells two stores apart: the parent already says which one this is. Where several stores
 * still land on one parent under one name, `keepApart` and `numberApart` below tell them apart
 * again.
 *
 * The scan reads that name off the owner, so it is the key the developer wrote and not the name the
 * store was born with. The two agree wherever a util calls its own field what it exposes it as, and
 * only where they part does it matter: `{ username: focus($values, "username") }` reads as
 * `username`, where the birth name says `$lens` and a second lens beside it takes a number.
 *
 * A frame and a class field carry no such name. Nothing there holds the store under a key: the frame
 * only knows it was born while an expression ran. Those keep the name the creation site gave, and a
 * store no site ever named keeps its registered one.
 */
function childPlacement(pass: Pass, held: Held, inside: HolderNode | undefined): Placement {
  if (held.kind === "node") {
    return holderPlacement(pass, held);
  }

  const named =
    held.key !== undefined
      ? { name: held.key, qualifier: null }
      : ownedName(held.entry, inside !== undefined && inside.skipped > 0);

  return { node: storeNode(held, named.name, named.qualifier), sortName: sortName(held) };
}

/**
 * A store a capped collection left no member node for takes the name it is registered under, and
 * everything that tells that name from another: the member it came from has no node here to say
 * which one it was.
 */
function ownedName(entry: StoreEntry, capped: boolean): Naming {
  return capped
    ? { name: entry.name, qualifier: ownParts(entry) }
    : { name: nameForOwner(entry), qualifier: null };
}

/**
 * The number a node with no name of the developer's takes is handed out here rather than when the
 * node was made, because a binding may rename a node afterwards and numbering at creation time
 * would leave gaps.
 */
function holderPlacement(pass: Pass, held: Extract<Held, { kind: "node" }>): Placement {
  const { info } = held;

  if (info.numbered) {
    pass.named += 1;
  }

  return {
    node: {
      kind: "holder",
      value: held.value,
      name: info.name,
      type: info.type,
      ours: info.numbered,
      ordinal: info.numbered ? pass.named : null,
      skipped: info.skipped,
      children: [],
    },
    sortName: info.name,
  };
}

function storeNode(
  held: Extract<Held, { kind: "store" | "second" }>,
  name: string,
  qualifier: NameParts | null,
): StoreNode | SecondNode {
  const drawn = {
    entry: held.entry,
    name,
    qualifier,
    ordinal: null,
    slot: staleNote(held.entry.store, held.entry),
  };

  return held.kind === "second"
    ? { kind: "second", ...drawn }
    : { kind: "store", ...drawn, children: [] };
}

/** The name the source wrote, which orders the tree: a qualifier or a number never moves a child. */
function sortName(held: Held): string {
  if (held.kind === "node") {
    return held.info.name;
  }

  /**
   * A member of a collection sorts by its position, and a second placement sorts where its own name
   * puts it rather than where the developer's would.
   */
  return held.key ?? (held.kind === "second" ? nameForOwner(held.entry) : held.entry.name);
}

/**
 * The name the owner knows the store by, and the store's own name where no creation site ever gave
 * one. The name the store is drawn under everywhere else is the only one left to name it by, and it
 * is what a primary placement takes as well.
 */
function nameForOwner(entry: StoreEntry): string {
  return entry.ownerName ?? entry.name;
}

/**
 * A name only one child wants stays; a name two of them want is replaced on both sides. A node keeps
 * its name here whatever happens: the only name it has is the one the developer wrote, so a clash
 * over it waits for a number instead.
 *
 * **Two siblings clash when the name clashes**, whatever each one holds and however fast it writes.
 * The type and the throttle state are words a view spells, and both move while the app runs, so a
 * name that rested on either would come and go under the developer.
 */
function keepApart(placements: readonly Placement[], rename: (entry: StoreEntry) => Naming): void {
  const wanted = countNames(placements);

  for (const { node } of placements) {
    if (node.kind === "holder" || wanted.get(nameKey(node)) === 1) {
      continue;
    }

    const { name, qualifier } = rename(node.entry);

    node.name = name;
    node.qualifier = qualifier;
  }
}

/**
 * A name two children still want is numbered, which is where a node's ordinal comes from. Both
 * sides take one, because one bare `panel` next to a `panel` numbered two does not say which of the
 * two the bare one is.
 *
 * Handed out as the tree is built, not when the node was made: until every child is in, no name is
 * known to repeat at all.
 */
function numberApart(placements: readonly Placement[]): void {
  const wanted = countNames(placements);
  const given = new Map<string, number>();

  for (const { node } of placements) {
    const key = nameKey(node);

    if (wanted.get(key) === 1) {
      continue;
    }

    const ordinal = (given.get(key) ?? 0) + 1;

    given.set(key, ordinal);
    node.ordinal = ordinal;
  }
}

function countNames(placements: readonly Placement[]): Map<string, number> {
  const wanted = new Map<string, number>();

  for (const { node } of placements) {
    const key = nameKey(node);

    wanted.set(key, (wanted.get(key) ?? 0) + 1);
  }

  return wanted;
}

/**
 * What two siblings have to share to clash: the name and whatever already tells it from another of
 * the same name. A node and a store never clash, because a store's key says it is one and a node
 * carries no such word.
 */
function nameKey(node: TreeNode): string {
  if (node.kind === "holder") {
    return ["node", node.name, ordinalDigits(node.ours ? node.ordinal : null)].join(PART);
  }

  const { qualifier } = node;

  return [
    "store",
    node.name,
    qualifier?.file ?? "",
    qualifier?.place ?? "",
    ordinalDigits(qualifier?.number ?? 1),
  ].join(PART);
}

/** The clash a file level made impossible, so the group holds the home instead of the place. */
function homedNaming(entry: StoreEntry): Naming {
  return { name: entry.name, qualifier: { file: entry.home, place: null, number: entry.number } };
}

/** The developer's own name for the store, with everything that tells it from another of it. */
function ownNaming(entry: StoreEntry): Naming {
  return {
    name: entry.name,
    qualifier: { file: entry.file, place: entry.place, number: entry.number },
  };
}

/** Nothing to say where a store was made and only one of it, so nothing has to be drawn. */
function ownParts(entry: StoreEntry): NameParts | null {
  if (entry.file === null && entry.place === null && entry.number <= 1) {
    return null;
  }

  return { file: entry.file, place: entry.place, number: entry.number };
}

function sorted(placements: readonly Placement[]): Placement[] {
  return [...placements].sort((left, right) => {
    const byName = compare(left.sortName, right.sortName);

    return byName === 0 ? compare(orderKey(left.node), orderKey(right.node)) : byName;
  });
}

/** The whole of what tells one sibling from another, in the order a key spells it. */
function orderKey(node: TreeNode): string {
  return `${nameKey(node)}${PART}${ordinalDigits(node.ordinal)}`;
}

/** Padded, so numbers order as numbers: a tenth store belongs behind the second, not in front. */
function ordinalDigits(ordinal: number | null): string {
  return ordinal === null ? "" : String(ordinal).padStart(ORDER_DIGITS, "0");
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

function kindOf(held: readonly Held[]): HomeKind {
  const kinds = ["group", "own", "external"] as const;

  return kinds[rank(held)] ?? "own";
}

/** A home is external only if everything in it is: one file of the developer's own lifts it. */
function rank(held: readonly Held[]): number {
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
