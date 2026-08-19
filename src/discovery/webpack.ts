import { createUnplugin } from "unplugin";

import type { BundlerPlugin, BundlerPluginOptions } from "./bundler.ts";
import { webpackLikeFactory } from "./webpack-like.ts";

export type { BundlerPlugin, BundlerPluginOptions };

/**
 * webpack has no dev-only flag, so this belongs under your development config. Added to a production
 * one it refuses to run and says so, because nothing it injects may reach a shipped bundle.
 */
export function nanostoresDevtools(options: BundlerPluginOptions = {}): BundlerPlugin {
  return createUnplugin(webpackLikeFactory).webpack(options);
}
