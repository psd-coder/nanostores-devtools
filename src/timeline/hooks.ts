import { onNotify, onSet, onStart, onStop } from "nanostores";

import { catchAndWarn } from "../utils/catch-and-warn.ts";
import { noteMount, noteUnmount } from "./lifecycle.ts";
import { DERIVED, listEntries, type StoreEntry } from "../stores/registry.ts";
import { appendFollower, flushOpenRow, openDirectRow } from "./timeline.ts";
import { detachEntryHooks, hasHooks, keepHooks } from "../stores/unhook.ts";

/** Registration records, connect attaches: only connect knows whether the extension is there. */
export function attachHooks(): void {
  for (const entry of listEntries()) {
    attach(entry);
  }
}

/** The other half, so a disconnected page is left as devtools found it. */
export function detachHooks(): void {
  for (const entry of listEntries()) {
    detachEntryHooks(entry);
  }
}

/**
 * Everything outside `DERIVED` is a direct write, and that puts `unknown` there. It is the type
 * every `trackStores` call records, and a store that draws no row at all is worse than one whose
 * row is named wrongly: a store that turns out to be a `computed` still shows its change, in a row
 * of its own instead of the row that caused it.
 */
function attach(entry: StoreEntry): void {
  if (hasHooks(entry)) {
    return;
  }

  attachLifecycle(entry);

  if (DERIVED.has(entry.type)) {
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

  keepHooks(
    entry,
    onStart(entry.store, () => {
      catchAndWarn(entry, () => {
        noteMount(entry);
      });
    }),
    onStop(entry.store, () => {
      catchAndWarn(entry, () => {
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
    catchAndWarn(entry, () => {
      openDirectRow(entry, changed === undefined ? undefined : String(changed), onWrite);
    });
  }

  keepHooks(entry, onSet(entry.store, flushOpenRow), onNotify(entry.store, onWrite));
}

/** No `onSet`: a computed sets itself mid-cascade, and flushing there would split the row. */
function attachFollower(entry: StoreEntry): void {
  keepHooks(
    entry,
    onNotify(entry.store, () => {
      catchAndWarn(entry, () => {
        appendFollower(entry);
      });
    }),
  );
}
