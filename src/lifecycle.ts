import { isPlaced } from "./placement.ts";
import { nameKey, type RegistryChange, type StoreEntry } from "./registry.ts";
import { activeSession, type Session } from "./session.ts";
import {
  type Change,
  openLifecycleRow,
  type RowOp,
  type RowSubject,
  sendLifecycleRow,
} from "./timeline.ts";

type Membership = { kind: "register" | "unregister"; entry: StoreEntry };

/** What one store did in a turn. A store that left and came back was rebuilt by a hot reload. */
type MoveOp = Membership["kind"] | "hotReload";

/** One module's worth of stores joining, leaving, or both, which is one row. */
type Group = { subject: RowSubject; op: RowOp; changes: Change[] };

/** What one module's stores did in a turn, collected while the turn's changes arrive. */
type HomeMoves = {
  home: string;
  joining: boolean;
  leaving: boolean;
  /**
   * Keyed by the name, so a store that leaves and comes back reads as one line and not two, and
   * holding the entry seen last, which for that pair is the store the hot reload built.
   */
  ops: Map<string, { entry: StoreEntry; op: MoveOp }>;
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

export function noteInitSent(session: Session): void {
  session.lifecycle.initSent = true;
}

/** Rows in flight belong to the session that collected them, so a stopped view drops them. */
export function dropPendingRows(session: Session): void {
  session.lifecycle.pending.length = 0;
}

/**
 * A hot reload clears a module and re-registers its stores in one synchronous run, which would
 * otherwise draw a burst of paired rows on every edit, so these wait for the end of the turn. That
 * is also where the two halves meet and become one hot-reload row.
 */
export function noteRegistryChange(session: Session, change: RegistryChange): void {
  if (change.kind === "update" || drawingSession() !== session) {
    return;
  }

  if (session.lifecycle.pending.length === 0) {
    queueMicrotask(() => {
      flushPending(session);
    });
  }

  session.lifecycle.pending.push({ kind: change.kind, entry: change.entry });
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
  const session = drawingSession();

  if (session && isPlaced(entry)) {
    openLifecycleRow(session, { kind: "store", entry }, op, [{ entry, op }]);
  }
}

function drawingSession(): Session | undefined {
  const session = activeSession();

  return session?.lifecycle.enabled && session.lifecycle.initSent ? session : undefined;
}

/**
 * Placement is read here and not where the change was noted: the binding scan runs at the end of a
 * module body, so a store noted while that body was still running has not been placed yet. This
 * flush is a microtask later, by which time every mechanism has had its turn.
 */
function flushPending(session: Session): void {
  const pending = session.lifecycle.pending.splice(0);

  if (drawingSession() !== session) {
    return;
  }

  for (const group of groupPending(pending.filter(({ entry }) => isPlaced(entry)))) {
    sendLifecycleRow(session, group.subject, group.op, group.changes);
  }
}

/** Keyed on the module, so the two halves of a hot reload meet and draw one row together. */
function groupPending(pending: Membership[]): Group[] {
  const homes = new Map<string, HomeMoves>();

  for (const { kind, entry } of pending) {
    const moves = homeMoves(homes, entry);
    const key = nameKey(entry);
    const seen = moves.ops.get(key)?.op;

    moves.joining ||= kind === "register";
    moves.leaving ||= kind === "unregister";
    moves.ops.set(key, { entry, op: seen === undefined || seen === kind ? kind : "hotReload" });
  }

  return [...homes.values()].map(toGroup);
}

function homeMoves(homes: Map<string, HomeMoves>, entry: StoreEntry): HomeMoves {
  const known = homes.get(entry.home);

  if (known) {
    return known;
  }

  const created: HomeMoves = { home: entry.home, joining: false, leaving: false, ops: new Map() };

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
  const op: RowOp = moves.leaving ? (moves.joining ? "hotReload" : "unregister") : "register";
  const changes = [...moves.ops.values()].map(({ entry, op: moved }) => ({ entry, op: moved }));
  const alone = changes.length === 1 ? changes[0]?.entry : undefined;

  return {
    subject:
      alone === undefined ? { kind: "home", home: moves.home } : { kind: "store", entry: alone },
    op,
    changes,
  };
}
