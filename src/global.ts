import type { Store } from "nanostores";

import type { Bridge } from "./connect.ts";
import type { RegistryChange, StoreEntry } from "./registry.ts";

export type ChangeListener = (change: RegistryChange) => void;

export type DevtoolsGlobal = {
  entries: Map<Store, StoreEntry>;
  byLabel: Map<string, Store>;
  changeListeners: Set<ChangeListener>;
  warned: Set<string>;
  bridge?: Bridge | undefined;
};

/**
 * The marker is the shape of what sits behind the key, not the package version, so two
 * copies of the same major share one registry instead of drawing half a tree each.
 */
export const GLOBAL_KEY: unique symbol = Symbol.for("nanostores-devtools/v1");

type GlobalHolder = { [GLOBAL_KEY]?: DevtoolsGlobal };

/** The one cast in the package: `globalThis` cannot be typed with a symbol key any other way. */
function holder(): GlobalHolder {
  return globalThis as GlobalHolder;
}

export function getDevtoolsGlobal(): DevtoolsGlobal {
  const existing = holder()[GLOBAL_KEY];

  if (existing) {
    return existing;
  }

  const created: DevtoolsGlobal = {
    entries: new Map(),
    byLabel: new Map(),
    changeListeners: new Set(),
    warned: new Set(),
  };

  holder()[GLOBAL_KEY] = created;

  return created;
}

export function peekDevtoolsGlobal(): DevtoolsGlobal | undefined {
  return holder()[GLOBAL_KEY];
}

export function resetDevtoolsGlobal(): void {
  delete holder()[GLOBAL_KEY];
}
