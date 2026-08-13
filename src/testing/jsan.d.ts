/**
 * The encoder the extension bundles and runs on both ends, pulled in for tests only. It ships no
 * types of its own and has no `@types` package, so this states the two calls we make.
 */
declare module "jsan" {
  export function stringify(
    value: unknown,
    replacer?: ((key: string, value: unknown) => unknown) | null,
    space?: string | number | null,
    options?: Record<string, boolean> | boolean,
  ): string;

  export function parse(text: string, reviver?: (key: string, value: unknown) => unknown): unknown;
}
