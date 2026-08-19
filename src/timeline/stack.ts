export type StackBoundary = (...args: never[]) => unknown;

/** The V8 half of `Error`. Firefox has neither, so this is a Chrome cost control, not a guarantee. */
type V8ErrorConstructor = {
  stackTraceLimit?: number | undefined;
  captureStackTrace?: ((target: object, boundary?: StackBoundary) => void) | undefined;
};

/**
 * Captured at the direct write, because the extension's own capture happens inside its `send`,
 * which for us is flush time. `boundary` is our outermost frame and is cut away with everything
 * below it, or the limit would be spent on our own five frames before nanostores' four.
 *
 * The limit belongs to the page, so it is ours only for the length of the capture.
 */
export function captureStack(limit: number, boundary: StackBoundary): string | undefined {
  const v8: V8ErrorConstructor = Error;
  const previous = v8.stackTraceLimit;

  v8.stackTraceLimit = limit;

  try {
    if (!v8.captureStackTrace) {
      return new Error().stack;
    }

    const holder: { stack?: string | undefined } = {};

    v8.captureStackTrace(holder, boundary);

    return holder.stack;
  } finally {
    v8.stackTraceLimit = previous;
  }
}
