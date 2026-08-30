import type { Store } from "nanostores";

import {
  type DevtoolsGlobal,
  type Followed,
  getDevtoolsGlobal,
  peekDevtoolsGlobal,
} from "../global.ts";
import { getEntry, unregisterStore } from "./registry.ts";
import type { ReachedStore } from "./ownership.ts";

/**
 * One binding to follow: what a walk of it reached just now, and how to walk it again. The walk is
 * handed in rather than reached for, so watching a store costs the panel none of the walk itself:
 * only the module the plugin instrumented has bindings, and only it needs the code that reads them.
 */
export type FollowedBinding = {
  reached: readonly ReachedStore[];
  walk: () => readonly ReachedStore[];
};

/**
 * The bindings a change has marked, waiting for the end of the turn. One walk per binding per turn,
 * however many of the stores under it wrote: a toggle at the root of a hundred-node tree is one
 * change to the developer and it costs one walk.
 */
let marked: Set<Followed> | undefined;

/**
 * The bindings this module run holds, so a change under one of them can send the walk down again.
 * Whatever the run before it left behind goes first: its bindings are gone with its module body.
 */
export function followBindings(moduleKey: string, bindings: readonly FollowedBinding[]): void {
  releaseFollowed(moduleKey);

  const following: Followed[] = [];

  for (const { reached, walk } of bindings) {
    /** A binding that reaches no store cannot be marked, because nothing under it can notify. */
    if (reached.length === 0) {
      continue;
    }

    const followed: Followed = {
      moduleKey,
      walk,
      reached: reached.map(({ store }) => new WeakRef(store)),
    };

    following.push(followed);

    for (const { store } of reached) {
      link(store, followed);
    }
  }

  if (following.length > 0) {
    getDevtoolsGlobal().follow.set(moduleKey, following);
  }
}

/**
 * A store the registry knows has written, so whatever it holds now may be a store nobody has seen
 * or may be one store fewer. Every binding that reaches it is walked again at the end of the turn,
 * and no other binding is: a change says nothing about the rest of the app.
 */
export function markReached(store: Store): void {
  const following = peekDevtoolsGlobal()?.reaching.get(store);

  if (following === undefined || following.length === 0) {
    return;
  }

  if (marked === undefined) {
    marked = new Set();
    queueMicrotask(walkMarked);
  }

  for (const followed of following) {
    marked.add(followed);
  }
}

/**
 * The module's own bindings, dropped, because its body is about to run again and write them afresh.
 */
export function releaseFollowed(moduleKey: string): void {
  const devtools = peekDevtoolsGlobal();
  const following = devtools?.follow.get(moduleKey);

  if (devtools === undefined || following === undefined) {
    return;
  }

  for (const followed of following) {
    for (const store of stillHeld(followed.reached)) {
      unlink(devtools, store, followed);
    }
  }

  devtools.follow.delete(moduleKey);
}

/**
 * Every marked binding walked, and then one pass over what left. One pass and not one per binding,
 * because a store that moved from under one binding to under another is reachable the whole time,
 * and a per-binding pass would draw it leaving and joining inside one turn.
 */
function walkMarked(): void {
  const walking = [...(marked ?? [])];
  const devtools = peekDevtoolsGlobal();

  marked = undefined;

  if (devtools === undefined) {
    return;
  }

  const dropped = new Map<Store, Set<string>>();

  for (const followed of walking) {
    if (isFollowed(devtools, followed)) {
      rewalk(devtools, followed, dropped);
    }
  }

  for (const [store, modules] of dropped) {
    dropUnreachable(devtools, store, modules);
  }
}

/**
 * Whether the binding is still one the module holds. A hot reload drops the record its old run
 * wrote, while a store that run reached may live on and go on notifying.
 */
function isFollowed(devtools: DevtoolsGlobal, followed: Followed): boolean {
  return devtools.follow.get(followed.moduleKey)?.includes(followed) === true;
}

/**
 * One binding walked again, and what that changed. A store the walk reaches for the first time is
 * registered by the walk itself, with its name, its owner and its hooks; a store it no longer
 * reaches is handed on, because another binding may still hold it.
 */
function rewalk(
  devtools: DevtoolsGlobal,
  followed: Followed,
  dropped: Map<Store, Set<string>>,
): void {
  const before = stillHeld(followed.reached);
  const after = new Set(followed.walk().map(({ store }) => store));

  for (const store of before) {
    if (!after.has(store)) {
      unlink(devtools, store, followed);
      /** Every module that let go of it, because each one holds its own list of what it owns. */
      dropped.set(store, (dropped.get(store) ?? new Set()).add(followed.moduleKey));
    }
  }

  for (const store of after) {
    if (!before.has(store)) {
      link(store, followed);
    }
  }

  followed.reached = [...after].map((store) => new WeakRef(store));
}

/**
 * A store no binding reaches any more, taken out of the registry, so a growing app does not fill it
 * with stores nobody can name. The rows it already drew stay: the timeline is a record of what
 * happened, and at that time the store really did hold that value.
 *
 * A store a group holds is kept whatever the walk says. The developer wrote that group by hand for
 * this store, and a path they can no longer type says nothing about a name they did.
 */
function dropUnreachable(
  devtools: DevtoolsGlobal,
  store: Store,
  modules: ReadonlySet<string>,
): void {
  const entry = getEntry(store);

  if ((devtools.reaching.get(store) ?? []).length > 0 || entry?.origin !== "plugin") {
    return;
  }

  /** Held here until a reload otherwise, and a store nothing reaches is nothing to sweep. */
  for (const moduleKey of modules) {
    devtools.scopes.get(moduleKey)?.owned.delete(store);
  }

  unregisterStore(store);
}

function link(store: Store, followed: Followed): void {
  const { reaching } = getDevtoolsGlobal();
  const following = reaching.get(store);

  if (following === undefined) {
    reaching.set(store, [followed]);

    return;
  }

  if (!following.includes(followed)) {
    following.push(followed);
  }
}

function unlink(devtools: DevtoolsGlobal, store: Store, followed: Followed): void {
  const following = devtools.reaching.get(store);

  if (following !== undefined) {
    devtools.reaching.set(
      store,
      following.filter((one) => one !== followed),
    );
  }
}

/** The stores of the last walk the app still holds, which is what this walk is compared with. */
function stillHeld(reached: readonly WeakRef<Store>[]): Set<Store> {
  const held = new Set<Store>();

  for (const ref of reached) {
    const store = ref.deref();

    if (store !== undefined) {
      held.add(store);
    }
  }

  return held;
}
