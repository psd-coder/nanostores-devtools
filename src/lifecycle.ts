import type { Bridge } from "./redux/connect.ts";
import { isPlaced, rowName } from "./placement.ts";
import type { RegistryChange, StoreEntry } from "./registry.ts";
import { type Change, listeningBridge, openLifecycleRow, sendLifecycleRow } from "./timeline.ts";

type Membership = { kind: "register" | "unregister"; entry: StoreEntry };

/** What one store did in a turn. A store that left and came back was rebuilt by a hot reload. */
type MoveOp = Membership["kind"] | "hotReload";

/** One module's worth of stores joining, leaving, or both, which is one row. */
type Group = { type: string; changes: Change[] };

/** What one module's stores did in a turn, collected while the turn's changes arrive. */
type HomeMoves = {
  home: string;
  /** The first store's name, which names the row for as long as it is the only store in it. */
  name: string;
  joining: boolean;
  leaving: boolean;
  /** Keyed by label, so a store that leaves and comes back reads as one line, not two. */
  ops: Map<string, MoveOp>;
};

export type LifecycleState = {
  enabled: boolean;
  /**
   * Rows start only once the deferred `init` has gone out. It runs at the end of the connect turn
   * and already holds every store registered in it, so a register row there would say nothing.
   */
  initSent: boolean;
  /** Also the flag: an empty list means the flush at the end of the turn is not booked yet. */
  pending: Membership[];
};

export function createLifecycle(enabled: boolean): LifecycleState {
  return { enabled, initSent: false, pending: [] };
}

export function noteInitSent(bridge: Bridge): void {
  bridge.lifecycle.initSent = true;
}

/** Rows in flight belong to the session that collected them, so a stopped panel drops them. */
export function dropPendingRows(bridge: Bridge): void {
  bridge.lifecycle.pending.length = 0;
}

/**
 * A hot reload clears a module and re-registers its stores in one synchronous run, which would
 * otherwise draw a burst of paired rows on every edit, so these wait for the end of the turn. That
 * is also where the two halves meet and become one hot-reload row.
 */
export function noteRegistryChange(bridge: Bridge, change: RegistryChange): void {
  if (change.kind === "update" || drawingBridge() !== bridge) {
    return;
  }

  if (bridge.lifecycle.pending.length === 0) {
    queueMicrotask(() => {
      flushPending(bridge);
    });
  }

  bridge.lifecycle.pending.push({ kind: change.kind, entry: change.entry });
}

/** `everMounted` outlives the mount, and the tree reads it, so it is set whatever rows say. */
export function noteMount(entry: StoreEntry): void {
  entry.everMounted = true;

  drawRow(entry, "mount");
}

export function noteUnmount(entry: StoreEntry): void {
  drawRow(entry, "unmount");
}

/**
 * One row each, because a mount and an unmount are real app events and happen far apart.
 *
 * A store the tree draws nowhere gets none. A lifecycle row is there to explain a tree that changed
 * shape, and a store with no place in it changes no shape, so the row would be a line the developer
 * cannot follow to anything. Read at the moment the row would go out, which is late enough for every
 * store made at runtime and one beat early for a store that mounts inside its own module body.
 */
function drawRow(entry: StoreEntry, op: "mount" | "unmount"): void {
  const bridge = drawingBridge();

  if (bridge && isPlaced(entry)) {
    openLifecycleRow(bridge, `${rowName(entry)}/${op}`, [{ label: entry.label, op }]);
  }
}

function drawingBridge(): Bridge | undefined {
  const bridge = listeningBridge();

  return bridge?.lifecycle.enabled && bridge.lifecycle.initSent ? bridge : undefined;
}

/**
 * Placement is read here and not where the change was noted: the binding scan runs at the end of a
 * module body, so a store noted while that body was still running has not been placed yet. This
 * flush is a microtask later, by which time every mechanism has had its turn.
 */
function flushPending(bridge: Bridge): void {
  const pending = bridge.lifecycle.pending.splice(0);

  if (drawingBridge() !== bridge) {
    return;
  }

  for (const group of groupPending(pending.filter(({ entry }) => isPlaced(entry)))) {
    sendLifecycleRow(bridge, group.type, group.changes);
  }
}

/** Keyed on the module, so the two halves of a hot reload meet and draw one row together. */
function groupPending(pending: Membership[]): Group[] {
  const homes = new Map<string, HomeMoves>();

  for (const { kind, entry } of pending) {
    const moves = homeMoves(homes, entry);
    const seen = moves.ops.get(entry.label);

    moves.joining ||= kind === "register";
    moves.leaving ||= kind === "unregister";
    moves.ops.set(entry.label, seen === undefined || seen === kind ? kind : "hotReload");
  }

  return [...homes.values()].map(toGroup);
}

function homeMoves(homes: Map<string, HomeMoves>, entry: StoreEntry): HomeMoves {
  const known = homes.get(entry.home);

  if (known) {
    return known;
  }

  const created: HomeMoves = {
    home: entry.home,
    name: rowName(entry),
    joining: false,
    leaving: false,
    ops: new Map(),
  };

  homes.set(entry.home, created);

  return created;
}

/**
 * A module that both loses and gains stores in one turn was hot reloaded, so one row says that,
 * instead of a pair of registry rows the developer has to recognise as their own edit. Stores the
 * reload only dropped, or only added, still carry their own word inside that row.
 *
 * A store on its own keeps its own name, and the second one from a module renames the row after it.
 */
function toGroup(moves: HomeMoves): Group {
  const rowOp = moves.leaving ? (moves.joining ? "hotReload" : "unregister") : "register";
  const subject = moves.ops.size === 1 ? moves.name : moves.home;

  return {
    type: `${subject}/${rowOp}`,
    changes: [...moves.ops].map(([label, op]) => ({ label, op })),
  };
}
