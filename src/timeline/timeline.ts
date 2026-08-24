import { catchAndWarn } from "../utils/catch-and-warn.ts";
import { peekDevtoolsGlobal } from "../global.ts";
import { getEntry, listEntries, type StoreEntry } from "../stores/registry.ts";
import { activeSession, type Session } from "../session.ts";
import { captureStack, type StackBoundary } from "./stack.ts";
import { clearThrottle, suppressWrite, throttlePeriod } from "./throttle.ts";

/** What a row is about: one store, or one home when several of its stores moved together. */
export type RowSubject = { kind: "store"; entry: StoreEntry } | { kind: "home"; home: string };

export type RowOp =
  | "set"
  | "setKey"
  | "computed"
  | "mount"
  | "unmount"
  | "register"
  | "unregister"
  | "hotReload";

/** A change names what moved, never what it moved to: the extension diffs the trees itself. */
export type Change = {
  entry: StoreEntry;
  op: RowOp;
  /** The key inside a `map` or `deepMap` that took the write. `setKey` only. */
  path?: string | undefined;
  /** The change before this one down a chain of recomputes. `computed` only. */
  from?: StoreEntry | undefined;
};

export type Row = {
  subject: RowSubject;
  op: RowOp;
  path?: string | undefined;
  changes: Change[];
  timestamp: number;
  stack?: string | undefined;
  /** Whose second this row is waiting out. A row carrying one is parked instead of sent. */
  parkedOn?: StoreEntry | undefined;
};

/** A row before it is opened, which is where it takes the time of the write that made it. */
type NewRow = Omit<Row, "timestamp">;

/** The open row and what it costs to build, owned here and parked on the session. */
export type TimelineState = {
  trace: boolean;
  traceLimit: number;
  flushScheduled: boolean;
  row?: Row | undefined;
  stack?: string | undefined;
};

export function createTimeline(trace: boolean, traceLimit: number): TimelineState {
  return { trace, traceLimit, flushScheduled: false };
}

/** Read by the `trace` function we hand the extension, which it calls inside its own `send`. */
export function currentStack(): string | undefined {
  return peekDevtoolsGlobal()?.session?.timeline.stack;
}

/** A row in flight belongs to the session that opened it, so a stopped view drops it. */
export function dropOpenRow(session: Session): void {
  session.timeline.row = undefined;
}

/** The same for every row parked on a store, which the timers holding them are dropped with. */
export function dropParkedRows(): void {
  for (const entry of listEntries()) {
    clearThrottle(entry);
  }
}

/**
 * A direct write. The store already holds the new value here, because `onNotify` runs after the
 * value is assigned, so the row this opens is snapshotted correctly whenever it flushes.
 */
export function openDirectRow(
  entry: StoreEntry,
  changed: string | undefined,
  boundary: StackBoundary,
): void {
  const session = activeSession();

  if (!session) {
    return;
  }

  const { timeline } = session;
  const op: RowOp = changed === undefined ? "set" : "setKey";
  const row: NewRow = {
    subject: { kind: "store", entry },
    op,
    path: changed,
    changes: [{ entry, op, path: changed }],
  };

  /** A row about to be parked pays for no stack, which with `trace` on is the expensive half. */
  if (suppressWrite(entry, Date.now())) {
    openRow(session, { ...row, parkedOn: entry });

    return;
  }

  openRow(session, {
    ...row,
    stack: timeline.trace ? captureStack(timeline.traceLimit, boundary) : undefined,
  });
}

/**
 * A lifecycle row is about the registry or the mount state, not about a write, so it stands on
 * its own: whatever row is open closes first, with the tree as it was before this happened.
 *
 * It opens rather than sends: at `onStart` the store is not mounted yet, so a tree built there
 * would show the state before the mount the row announces.
 */
export function openLifecycleRow(
  session: Session,
  subject: RowSubject,
  op: RowOp,
  changes: Change[],
): void {
  guardedFlush(session);
  openRow(session, { subject, op, changes });
}

/** The same row, closed at once: a row drawn at the end of a turn has nothing left to wait for. */
export function sendLifecycleRow(
  session: Session,
  subject: RowSubject,
  op: RowOp,
  changes: Change[],
): void {
  openLifecycleRow(session, subject, op, changes);
  guardedFlush(session);
}

/**
 * A recompute joins the open row instead of opening one, so a write and the whole cascade behind
 * it read as a single row. The cascade runs inside the root notify drain, so a follower reaches
 * the row that caused it.
 *
 * `from` is the change before this one. That is the store this one followed down a chain, and a
 * sibling of it whenever changes arrive in an order the dependencies do not match.
 */
export function appendFollower(entry: StoreEntry): void {
  const session = activeSession();

  if (!session) {
    return;
  }

  const open = session.timeline.row;

  if (open) {
    /** A mount row is a store's own, so the recompute it causes has nothing to name but itself. */
    const previous = open.changes.at(-1)?.entry;

    open.changes.push({ entry, op: "computed", from: previous === entry ? undefined : previous });

    return;
  }

  /**
   * A follower that finds no open row is a row of its own, named after the store, and it runs the
   * counter too: a computed whose source draws nothing can open a row every frame on its own.
   */
  const suppressed = suppressWrite(entry, Date.now());

  openRow(session, {
    subject: { kind: "store", entry },
    op: "computed",
    changes: [{ entry, op: "computed" }],
    parkedOn: suppressed ? entry : undefined,
  });
}

export function flushOpenRow(): void {
  const session = peekDevtoolsGlobal()?.session;

  if (session) {
    guardedFlush(session);
  }
}

/**
 * Keyed on the store the row belongs to, never on the store that happened to trigger the flush.
 * One store holding a value the extension cannot serialize has to warn once, not once per other
 * store that writes after it.
 */
function guardedFlush(session: Session): void {
  catchAndWarn(subject(session.timeline.row), () => {
    flush(session);
  });
}

function flush(session: Session): void {
  const { timeline } = session;
  const row = timeline.row;

  if (!row || !session.active()) {
    return;
  }

  timeline.row = undefined;

  if (row.parkedOn) {
    park(row.parkedOn, row);

    return;
  }

  timeline.stack = row.stack;

  try {
    session.emit(row);
  } finally {
    timeline.stack = undefined;
  }
}

/** One shape for every row, and the flush that closes it is booked in the same breath. */
function openRow(session: Session, row: NewRow): void {
  session.timeline.row = { ...row, timestamp: Date.now() };

  scheduleFlush(session);
}

/**
 * A suppressed row waits out the store's rate on the store it belongs to, and a second row inside
 * that time replaces it. That is the coalescing: no tree is built and nothing is sent until the
 * timer fires.
 */
function park(entry: StoreEntry, row: Row): void {
  const { throttle } = entry;

  /**
   * A store the registry has dropped parks nothing. Every sweep that cancels a timer walks the
   * entries, so a timer armed here would be reachable from none of them, and the row it holds names
   * a store the unregister row has already taken out of the tree.
   */
  if (getEntry(entry.store) === undefined) {
    return;
  }

  throttle.pending = row;

  if (throttle.trailing !== undefined) {
    return;
  }

  const rest = Math.max(throttlePeriod(entry) - (Date.now() - throttle.lastEmit), 0);

  throttle.trailing = setTimeout(() => {
    release(entry);
  }, rest);
}

/**
 * The end of the wait. The row keeps the timestamp of the write that made it, and its tree is built
 * now, so it carries the store's current value with the whole cascade that rode inside it.
 */
function release(entry: StoreEntry): void {
  const { throttle } = entry;
  const row = throttle.pending;

  throttle.pending = undefined;
  throttle.trailing = undefined;

  const session = activeSession();

  if (!session || !row) {
    return;
  }

  /**
   * The stretch this row closes starts now, and that is written before anything is sent: a row of
   * this same store standing open parks for the next one instead of a timer of no length.
   */
  throttle.lastEmit = Date.now();

  /** Whatever is open closes first, with the tree as it was before this row's write. */
  guardedFlush(session);

  row.parkedOn = undefined;
  session.timeline.row = row;

  guardedFlush(session);
}

/** The open row closes lazily: the next direct write closes it, or this microtask does. */
function scheduleFlush(session: Session): void {
  const { timeline } = session;

  if (timeline.flushScheduled) {
    return;
  }

  timeline.flushScheduled = true;

  queueMicrotask(() => {
    timeline.flushScheduled = false;
    guardedFlush(session);
  });
}

/** The store a row is about is whatever opened it, which is always its first change. */
function subject(row: Row | undefined): StoreEntry | undefined {
  return row?.changes[0]?.entry;
}
