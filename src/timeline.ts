import { catchAndWarn } from "./catch-and-warn.ts";
import type { Bridge } from "./connect.ts";
import { peekDevtoolsGlobal } from "./global.ts";
import type { StoreEntry } from "./registry.ts";
import { buildSnapshot } from "./snapshot.ts";
import { captureStack, type StackBoundary } from "./stack.ts";

/** A change names what moved, never what it moved to: the extension diffs the trees itself. */
export type Change =
  | { label: string; op: "set" }
  | { label: string; op: "setKey"; path: string }
  | { label: string; op: "computed"; from?: string | undefined }
  | { label: string; op: "mount" | "unmount" | "register" | "unregister" | "hotReload" };

export type Row = {
  type: string;
  changes: Change[];
  timestamp: number;
  stack?: string | undefined;
};

/** The open row and what it costs to build, owned here and parked on the bridge. */
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
  return peekDevtoolsGlobal()?.bridge?.timeline.stack;
}

/** A row in flight belongs to the session that opened it, so a stopped panel drops it. */
export function dropOpenRow(bridge: Bridge): void {
  bridge.timeline.row = undefined;
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
  const bridge = listeningBridge();

  if (!bridge) {
    return;
  }

  const { timeline } = bridge;
  const { type, change } = describeWrite(entry, changed);
  const stack = timeline.trace ? captureStack(timeline.traceLimit, boundary) : undefined;

  openRow(bridge, type, [change], stack);
}

/**
 * A lifecycle row is about the registry or the mount state, not about a write, so it stands on
 * its own: whatever row is open closes first, with the tree as it was before this happened.
 *
 * It opens rather than sends: at `onStart` the store is not mounted yet, so a tree built there
 * would show the state before the mount the row announces.
 */
export function openLifecycleRow(bridge: Bridge, type: string, changes: Change[]): void {
  guardedFlush(bridge);
  openRow(bridge, type, changes);
}

/** The same row, closed at once: a row drawn at the end of a turn has nothing left to wait for. */
export function sendLifecycleRow(bridge: Bridge, type: string, changes: Change[]): void {
  openLifecycleRow(bridge, type, changes);
  guardedFlush(bridge);
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
  const bridge = listeningBridge();

  if (!bridge) {
    return;
  }

  const open = bridge.timeline.row;

  if (open) {
    /** A mount row is a store's own, so the recompute it causes has nothing to name but itself. */
    const previous = open.changes.at(-1)?.label;

    open.changes.push({
      label: entry.label,
      op: "computed",
      from: previous === entry.label ? undefined : previous,
    });

    return;
  }

  /** A follower that finds no open row is a row of its own, named after the store. */
  openRow(bridge, `${entry.name}/computed`, [{ label: entry.label, op: "computed" }]);
}

export function flushOpenRow(): void {
  const bridge = peekDevtoolsGlobal()?.bridge;

  if (bridge) {
    guardedFlush(bridge);
  }
}

/**
 * Keyed on the store the row belongs to, never on the store that happened to trigger the flush.
 * One store holding a value the extension cannot serialize has to warn once, not once per other
 * store that writes after it.
 */
function guardedFlush(bridge: Bridge): void {
  catchAndWarn(subject(bridge.timeline.row), () => {
    flush(bridge);
  });
}

/**
 * `type` sits at both levels on purpose. The extension replaces a whole action that carries no
 * top-level `type` with `{ type: "update" }`, and only the nested shape keeps our `timestamp`,
 * which is what lets a row flushed later keep the time of the write that caused it.
 */
function flush(bridge: Bridge): void {
  const { timeline } = bridge;
  const row = timeline.row;

  if (!row || !bridge.listening) {
    return;
  }

  timeline.row = undefined;
  timeline.stack = row.stack;

  try {
    bridge.connection.send(
      {
        type: row.type,
        action: { type: row.type, changes: row.changes },
        timestamp: row.timestamp,
      },
      buildSnapshot(),
    );
  } finally {
    timeline.stack = undefined;
  }
}

/** One shape for every row, and the flush that closes it is booked in the same breath. */
function openRow(
  bridge: Bridge,
  type: string,
  changes: Change[],
  stack?: string | undefined,
): void {
  bridge.timeline.row = { type, changes, timestamp: Date.now(), stack };

  scheduleFlush(bridge);
}

/** Nothing is built while no panel is listening: the tree is the expensive part of a row. */
export function listeningBridge(): Bridge | undefined {
  const bridge = peekDevtoolsGlobal()?.bridge;

  return bridge?.listening ? bridge : undefined;
}

/** The open row closes lazily: the next direct write closes it, or this microtask does. */
function scheduleFlush(bridge: Bridge): void {
  const { timeline } = bridge;

  if (timeline.flushScheduled) {
    return;
  }

  timeline.flushScheduled = true;

  queueMicrotask(() => {
    timeline.flushScheduled = false;
    guardedFlush(bridge);
  });
}

/** The store a row is about is whatever opened it, which is always its first change. */
function subject(row: Row | undefined): string {
  return row?.changes[0]?.label ?? "";
}

function describeWrite(
  entry: StoreEntry,
  changed: string | undefined,
): { type: string; change: Change } {
  return changed === undefined
    ? { type: `${entry.name}/set`, change: { label: entry.label, op: "set" } }
    : {
        type: `${entry.name}/setKey:${changed}`,
        change: { label: entry.label, op: "setKey", path: changed },
      };
}
