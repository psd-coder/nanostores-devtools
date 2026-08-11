import type { Bridge } from "./connect.ts";
import type { RegistryChange, StoreEntry } from "./registry.ts";
import { type Change, listeningBridge, openLifecycleRow, sendLifecycleRow } from "./timeline.ts";

type Membership = { kind: "register" | "unregister"; entry: StoreEntry };

/** One module's worth of stores joining, or one module's worth of them leaving. */
type Group = { type: string; changes: Change[] };

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
 * otherwise draw a burst of paired rows on every edit, so these wait for the end of the turn.
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

/** One row each, because a mount and an unmount are real app events and happen far apart. */
function drawRow(entry: StoreEntry, op: "mount" | "unmount"): void {
  const bridge = drawingBridge();

  if (bridge) {
    openLifecycleRow(bridge, `${entry.name}/${op}`, [{ label: entry.label, op }]);
  }
}

function drawingBridge(): Bridge | undefined {
  const bridge = listeningBridge();

  return bridge?.lifecycle.enabled && bridge.lifecycle.initSent ? bridge : undefined;
}

function flushPending(bridge: Bridge): void {
  const pending = bridge.lifecycle.pending.splice(0);

  if (drawingBridge() !== bridge) {
    return;
  }

  for (const group of groupPending(pending)) {
    sendLifecycleRow(bridge, group.type, group.changes);
  }
}

/**
 * Keyed on the module as well as the kind, so a reload draws its leaves before its joins. A store
 * on its own keeps its own name, and the second one from a module renames the row after it.
 */
function groupPending(pending: Membership[]): Group[] {
  const groups = new Map<string, Group>();

  for (const { kind, entry } of pending) {
    const key = `${kind} ${entry.home}`;
    const change: Change = { label: entry.label, op: kind };
    const known = groups.get(key);

    if (known) {
      known.changes.push(change);
      known.type = `${entry.home}/${kind}`;
    } else {
      groups.set(key, { type: `${entry.name}/${kind}`, changes: [change] });
    }
  }

  return [...groups.values()];
}
