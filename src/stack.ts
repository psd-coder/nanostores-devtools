export type StackBoundary = (...args: never[]) => unknown;

declare global {
  interface ErrorConstructor {
    /** V8 features. Firefox has neither, so this is a Chrome cost control, not a guarantee. */
    stackTraceLimit?: number | undefined;
    captureStackTrace?: ((target: object, boundary?: StackBoundary) => void) | undefined;
  }
}

/**
 * Captured at the direct write, because the extension's own capture happens inside its `send`,
 * which for us is flush time. `boundary` is our outermost frame and is cut away with everything
 * below it, or the limit would be spent on our own five frames before nanostores' four.
 *
 * The limit belongs to the page, so it is ours only for the length of the capture.
 */
export function captureStack(limit: number, boundary: StackBoundary): string | undefined {
  const previous = Error.stackTraceLimit;

  Error.stackTraceLimit = limit;

  try {
    if (!Error.captureStackTrace) {
      return new Error().stack;
    }

    const holder: { stack?: string | undefined } = {};

    Error.captureStackTrace(holder, boundary);

    return holder.stack;
  } finally {
    Error.stackTraceLimit = previous;
  }
}
