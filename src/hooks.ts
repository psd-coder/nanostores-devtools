import { onNotify, onSet, onStart, onStop } from "nanostores";

import { catchAndWarn } from "./catch-and-warn.ts";
import { noteMount, noteUnmount } from "./lifecycle.ts";
import { listEntries, type StoreEntry, type StoreType } from "./registry.ts";
import { appendFollower, flushOpenRow, openDirectRow } from "./timeline.ts";

const FOLLOWER: ReadonlySet<StoreType> = new Set<StoreType>(["computed", "batched"]);

/** Registration records, connect attaches: only connect knows whether the extension is there. */
export function attachHooks(): void {
  for (const entry of listEntries()) {
    attach(entry);
  }
}

/**
 * Everything outside `FOLLOWER` is a direct write, and that puts `unknown` there. It is the type
 * every `trackStores` call records, and a store that draws no row at all is worse than one whose
 * row is named wrongly: a store that turns out to be a `computed` still shows its change, in a row
 * of its own instead of the row that caused it.
 */
function attach(entry: StoreEntry): void {
  if (entry.unhook.length > 0) {
    return;
  }

  attachLifecycle(entry);

  if (FOLLOWER.has(entry.type)) {
    attachFollower(entry);
  } else {
    attachDirectWrite(entry);
  }
}

/** Every type, and whatever `lifecycleEvents` says, because `everMounted` is not a row. */
function attachLifecycle(entry: StoreEntry): void {
  /** A store mounted before we got here fires no `onStart`, so its mount is read off `lc` once. */
  if (entry.store.lc > 0) {
    entry.everMounted = true;
  }

  entry.unhook.push(
    onStart(entry.store, () => {
      catchAndWarn(entry.label, () => {
        noteMount(entry);
      });
    }),
    onStop(entry.store, () => {
      catchAndWarn(entry.label, () => {
        noteUnmount(entry);
      });
    }),
  );
}

/**
 * `onSet` flushes and `onNotify` opens, and that order is the whole correctness of the timeline.
 * The two hooks sit on opposite sides of the write, so inside `onSet` the store still holds the
 * old value and inside `onNotify` it holds the new one. Flushing from `onNotify` would snapshot
 * the next store's new value into this store's row.
 */
function attachDirectWrite(entry: StoreEntry): void {
  /** Named and passed on: it is our outermost frame, so it is where the stack capture cuts. */
  function onWrite({ changed }: { changed: unknown }): void {
    catchAndWarn(entry.label, () => {
      openDirectRow(entry, changed === undefined ? undefined : String(changed), onWrite);
    });
  }

  entry.unhook.push(onSet(entry.store, flushOpenRow), onNotify(entry.store, onWrite));
}

/** No `onSet`: a computed sets itself mid-cascade, and flushing there would split the row. */
function attachFollower(entry: StoreEntry): void {
  entry.unhook.push(
    onNotify(entry.store, () => {
      catchAndWarn(entry.label, () => {
        appendFollower(entry);
      });
    }),
  );
}
