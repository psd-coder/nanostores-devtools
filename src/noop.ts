import type { Store } from "nanostores";

import type { DevtoolsHandle, DevtoolsOptions } from "./redux/connect.ts";

export type { DevtoolsHandle, DevtoolsOptions } from "./redux/connect.ts";
export type { Serializer } from "./redux/replacer.ts";
export type { ThrottleOption, ThrottleTarget } from "./throttle.ts";

/**
 * What the package resolves to under the `production` export condition: the same three names with
 * the same types, over empty bodies. Every import here is type-only, so nothing but these three
 * functions is left to bundle.
 */
export function connectDevtools(_options?: DevtoolsOptions): DevtoolsHandle {
  return { connected: false, disconnect: () => {} };
}

export function trackStores(_group: string, _stores: Readonly<Record<string, Store>>): void {}

export function untrack(_group: string): void {}
