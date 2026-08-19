import type { StoreEntry } from "./registry.ts";

/** Everything that fills, reads or empties `entry.unhook` is here, so the array has one owner. */
export function keepHooks(entry: StoreEntry, ...unhooks: (() => void)[]): void {
  entry.unhook.push(...unhooks);
}

export function hasHooks(entry: StoreEntry): boolean {
  return entry.unhook.length > 0;
}

export function detachEntryHooks(entry: StoreEntry): void {
  for (const unhook of entry.unhook) {
    unhook();
  }

  entry.unhook.length = 0;
}
