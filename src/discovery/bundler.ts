import type { DiscoveryOptions } from "./core.ts";

/**
 * webpack and Rspack take the same options a Vite user reads, without `projectRoot`: neither hands
 * over a root of its own beside `context`, so the wider one is always the climb.
 */
export type BundlerPluginOptions = DiscoveryOptions;

/**
 * What both bundlers take a plugin as: an object holding `apply`, which they call with their own
 * compiler. Written out here rather than imported so the published types name no bundler this
 * package does not depend on, and `apply` is a method so a compiler of either kind still fits.
 *
 * It sits apart from the adapter so the types an adapter publishes reach no further than this file,
 * and unplugin's own types, which do name both bundlers, stay inside the package.
 */
export type BundlerPlugin = { apply(compiler: unknown): void };
