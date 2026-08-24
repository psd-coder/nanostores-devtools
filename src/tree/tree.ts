import type { BoundName, NodeInfo } from "../global.ts";
import {
  boundNames,
  drawnOwners,
  drawnParents,
  nodeInfoOf,
  placedByDeveloper,
} from "./placement.ts";
import {
  getEntry,
  isStore,
  listEntries,
  type NameParts,
  type StoreEntry,
} from "../stores/registry.ts";
import { makeLabel } from "../stores/labels.ts";
import { type Slot, staleNote } from "./slot.ts";

export type { Slot } from "./slot.ts";

export type TreeModel = { homes: HomeGroup[] };

/** One top level of the tree, in the order the panel should draw them. */
export type HomeGroup = { home: string; kind: HomeKind; children: TreeNode[] };

/** Groups the developer wrote by hand, then their own files, then somebody else's. */
export type HomeKind = "group" | "own" | "external";

export type TreeNode = StoreNode | RepeatNode | HolderNode;

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

/**
 * A reference to a store that is expanded somewhere else: the same entry, its own name, and no
 * children. The value comes along, because a store's value is the point of drawing it at all.
 */
export type RepeatNode = Omit<StoreNode, "kind" | "children"> & { kind: "repeat" };

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
  /** Members the ownership walk drew, so the note about the rest can name that number. */
  walked: number;
  /** Members the ownership walk left out, `0` when it walked them all. */
  skipped: number;
  /**
   * Where the node is expanded, and `null` for the one placement that expands it. A node two
   * containers hold draws under both, and drawing its children twice would say the app holds twice
   * as many stores as it does, so every placement past the first shows the node and stops.
   *
   * The home and the name of the holder that expands it, `app/editor.ts/left`. Its name, not the
   * key drawn there: a key takes a number from the siblings it lands beside, and this is decided
   * before any level is built.
   */
  expandedAt: string | null;
  children: TreeNode[];
};

/**
 * One thing the tree draws: a store's own slot, a repeat of a store expanded somewhere else, or a
 * node holding others and no value at all.
 */
type Held =
  | { kind: "store"; entry: StoreEntry; at: PlacedBy }
  | { kind: "repeat"; entry: StoreEntry; at: PlacedBy }
  | { kind: "node"; value: object; info: NodeInfo; expandedAt: string | null };

/**
 * What put a store's placement where it is, which is also what names it: the key its owner knows
 * it by, the top-level binding that wrote its name, or the home its entry sits at and nothing more.
 *
 * A binding carries its own name and its own home, because two bindings in two modules put one
 * store at two different homes. An owner may carry no key at all: a class field holds the store
 * under no property, so nothing there is a name.
 */
type PlacedBy =
  | { under: "owner"; key: string | undefined }
  | { under: "binding"; bound: BoundName }
  | { under: "home" };

/**
 * What each owner holds, what each home holds at its own top level, and which nodes are in: the
 * parents each node is already drawn under, and the nodes drawn at a home's own top level.
 * Attaching once per parent rather than once per node is what lets two containers each draw the
 * node they hold, while one edge still draws one node.
 */
type Tree = {
  homes: Map<string, Held[]>;
  children: Map<object, Held[]>;
  placed: Map<object, Set<object>>;
  atHome: Set<object>;
};

/**
 * One home being built: the tree it comes out of, and how many nodes carrying a name of ours it
 * has numbered so far. The count runs across the whole file rather than per parent or per class,
 * because two `ref` nodes numbered one in one file, one an `Editor` and one a `Viewer`, would read
 * as the same node.
 *
 * **Every placement takes a number, a repeat included.** The number tells one node from another
 * inside one home, so a placement that skipped it would leave a bare `ref` beside a `ref#2`.
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
  const tree: Tree = {
    homes: new Map(),
    children: new Map(),
    placed: new Map(),
    atHome: new Set(),
  };

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
 * Where one entry is drawn. **Every reference the developer wrote draws.** Two top-level bindings
 * for one store draw two nodes, and two containers holding one store both draw it, because the
 * source says the app holds it in both places and drawing one of them says it holds less.
 *
 * **One of those placements expands and the rest show the store and stop.** A repeat carries the
 * value, so the owner never reads as incomplete, and its children sit where the store itself is
 * drawn: drawing them again would say the app holds twice as many stores as it does.
 *
 * The developer chooses a home two ways: a group they registered the store into by hand, and a
 * top-level name they bound it to in a file of their own. Either one beats the owner the ownership
 * walk recorded, because both say where this store belongs and an owner only says where the walk
 * reached it from. Where neither did, the first owner recorded is the one that expands.
 */
function place(tree: Tree, entry: StoreEntry): void {
  const chosen = placedByDeveloper(entry);
  const owners = drawnOwners(entry.store);

  if (chosen || owners.length === 0) {
    collect(tree.homes, entry.home, { kind: "store", entry, at: { under: "home" } });
  }

  for (const bound of repeatedBindings(entry)) {
    collect(tree.homes, bound.home, { kind: "repeat", entry, at: { under: "binding", bound } });
  }

  owners.forEach((link, index) => {
    /** The key belongs to the owner the link named, so a store no link placed takes none. */
    const at: PlacedBy = { under: "owner", key: link.key };
    const expands = !chosen && index === 0;

    collect(
      tree.children,
      link.owner,
      expands ? { kind: "store", entry, at } : { kind: "repeat", entry, at },
    );
    attach(tree, link.owner);
  });
}

/**
 * The bindings that draw a repeat. The one the entry took already holds the flat slot, unless a
 * group took the entry instead: the developer wrote that group name for this store by hand, so
 * every binding beside it repeats.
 */
function repeatedBindings(entry: StoreEntry): BoundName[] {
  const bound = boundNames(entry.store);

  if (bound === undefined) {
    return [];
  }

  return entry.origin === "explicit" ? [bound.primary, ...bound.repeats] : bound.repeats;
}

/**
 * A node holds no value of its own, so it reaches the tree only where a store puts it: inside every
 * node or store that holds it, or at the top level of the file its name was written in when nothing
 * the tree can draw holds it at all.
 *
 * One edge draws one node, so a node reached again through a parent it already hangs from adds
 * nothing, and the walk up ends: the ownership graph refuses an edge that would close a loop.
 */
function attach(tree: Tree, owner: object): void {
  const info = isStore(owner) ? undefined : nodeInfoOf(owner);

  if (info === undefined) {
    return;
  }

  const parents = drawnParents(info);

  if (parents.length === 0) {
    if (!tree.atHome.has(owner)) {
      tree.atHome.add(owner);
      collect(tree.homes, info.home, { kind: "node", value: owner, info, expandedAt: null });
    }

    return;
  }

  const drawn = alreadyUnder(tree, owner);
  const expander = parents[0];

  parents.forEach((parent, index) => {
    if (drawn.has(parent)) {
      return;
    }

    drawn.add(parent);
    collect(tree.children, parent, {
      kind: "node",
      value: owner,
      info,
      expandedAt: index === 0 || expander === undefined ? null : whereDrawn(expander),
    });
    attach(tree, parent);
  });
}

function alreadyUnder(tree: Tree, owner: object): Set<object> {
  const known = tree.placed.get(owner);

  if (known) {
    return known;
  }

  const created = new Set<object>();

  tree.placed.set(owner, created);

  return created;
}

/**
 * Where a repeat says its value is expanded: the home and the name of the holder that expands it.
 *
 * The name the model holds, never the key the view spells. A key takes its number from the siblings
 * it lands beside, and no level is built yet when a placement is collected, so a repeat pointing at
 * a key would have to wait for a pass that has not run.
 */
function whereDrawn(holder: object): string {
  const info = isStore(holder) ? undefined : nodeInfoOf(holder);

  if (info !== undefined) {
    return makeLabel(info.home, info.name);
  }

  const entry = isStore(holder) ? getEntry(holder) : undefined;

  return entry === undefined ? "" : makeLabel(entry.home, entry.name);
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
 * The children of one owner.
 *
 * A clash is settled twice over: the store's own name and place first, and its home second. The
 * home is for the one clash a file level made impossible, where ownership draws stores from two
 * files into one node and two files each hold a `$history`. Both sides show it, because one bare
 * `$history` beside a `$history` from `vendor/withUndo.ts` does not say where the bare one came
 * from.
 */
function childNodes(pass: Pass, held: readonly Held[]): TreeNode[] {
  const placements = held.map((one) => childPlacement(pass, one));

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
 * A repeat draws nothing under it. Its children sit under the placement that expands it, and
 * drawing them again would say the app holds twice as many stores as it does. A store repeat still
 * carries its value, because that is the useful fact about a store; a node has no value, so a node
 * repeat says only that it is here, and the view words where to open it.
 */
function fill(pass: Pass, node: TreeNode): void {
  if (node.kind === "repeat") {
    return;
  }

  if (node.kind === "store") {
    node.children = childNodes(pass, pass.tree.children.get(node.entry.store) ?? []);

    return;
  }

  if (node.expandedAt === null) {
    node.children = childNodes(pass, pass.tree.children.get(node.value) ?? []);
  }
}

function rootPlacement(pass: Pass, held: Held): Placement {
  if (held.kind === "node") {
    return holderPlacement(pass, held);
  }

  const named: Naming =
    held.at.under === "binding"
      ? { name: held.at.bound.name, qualifier: boundParts(held.at.bound) }
      : { name: held.entry.name, qualifier: ownParts(held.entry) };

  return { node: storeNode(held, named.name, named.qualifier), sortName: sortName(held) };
}

/**
 * What a binding's own name has to show beside it, which is nothing unless a second module the home
 * holds writes that name too. A name the developer wrote came from no creation site, so the place
 * and the number that tell two stores of one site apart say nothing about it.
 */
function boundParts(bound: BoundName): NameParts | null {
  return bound.file === null ? null : { file: bound.file, place: null, number: 1 };
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
 * A class field carries no such name: nothing there holds the store under a key. Those keep the
 * name the creation site gave, and a store no site ever named keeps its registered one.
 */
function childPlacement(pass: Pass, held: Held): Placement {
  if (held.kind === "node") {
    return holderPlacement(pass, held);
  }

  const key = held.at.under === "owner" ? held.at.key : undefined;
  const name = key ?? nameForOwner(held.entry);

  return { node: storeNode(held, name, null), sortName: sortName(held) };
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
      walked: info.walked,
      skipped: info.skipped,
      expandedAt: held.expandedAt,
      children: [],
    },
    sortName: info.name,
  };
}

function storeNode(
  held: Extract<Held, { kind: "store" | "repeat" }>,
  name: string,
  qualifier: NameParts | null,
): StoreNode | RepeatNode {
  const drawn = {
    entry: held.entry,
    name,
    qualifier,
    ordinal: null,
    slot: staleNote(held.entry.store, held.entry),
  };

  return held.kind === "repeat"
    ? { kind: "repeat", ...drawn }
    : { kind: "store", ...drawn, children: [] };
}

/** The name the source wrote, which orders the tree: a qualifier or a number never moves a child. */
function sortName(held: Held): string {
  if (held.kind === "node") {
    return held.info.name;
  }

  /**
   * A member of a collection sorts by its position, a binding by the name it wrote, and a repeat an
   * owner keeps sorts where its own name puts it rather than where the developer's would.
   */
  if (held.at.under === "binding") {
    return held.at.bound.name;
  }

  const key = held.at.under === "owner" ? held.at.key : undefined;

  return key ?? (held.kind === "repeat" ? nameForOwner(held.entry) : held.entry.name);
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

  /**
   * A binding never makes a home somebody else's: a file outside the developer's root places no
   * name at all, and a binding of theirs moves the entry into a file of their own, external and
   * all.
   */
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
