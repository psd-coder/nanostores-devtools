import type { Store } from "nanostores";

/**
 * Every store a snapshot drew inside another store's value, noted while that snapshot was written.
 * A store with no placement of its own has no key in the tree, and it is still drawn wherever a
 * value the panel shows holds it, so the tree alone cannot say whether a developer can see it.
 *
 * **Any view's value walk must call `noteDrawn` for every store it draws.** That walk is the very
 * pass that draws the panel, so the two can only disagree if it never ran, and then nothing reached
 * the panel either. A walk that skips the call drops the timeline rows of a store the developer can
 * plainly see, which is the one failure this set exists to prevent.
 *
 * It never forgets within one connection. A store drawn once and later taken out of the value keeps
 * drawing rows, which is the noise this is meant to cut; the other way round would drop a row for
 * something on screen, and a row too many reads better than a value that quietly stops updating.
 */
let drawn = new WeakSet<Store>();

export function noteDrawn(store: Store): void {
  drawn.add(store);
}

export function drawnLately(store: Store): boolean {
  return drawn.has(store);
}

/** A new connection draws its own first snapshot, so what the last one showed says nothing here. */
export function forgetDrawn(): void {
  drawn = new WeakSet();
}
