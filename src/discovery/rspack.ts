import { createUnplugin } from "unplugin";

import type { BundlerPlugin, BundlerPluginOptions } from "./bundler.ts";
import { webpackLikeFactory } from "./webpack-like.ts";

export type { BundlerPlugin, BundlerPluginOptions };

/**
 * Rspack reads webpack's own words for everything this adapter touches, so it takes the same one.
 * Like webpack it has no dev-only flag: add it under your development config.
 */
export function nanostoresDevtools(options: BundlerPluginOptions = {}): BundlerPlugin {
  return createUnplugin(webpackLikeFactory).rspack(options);
}
