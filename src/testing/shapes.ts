/**
 * Shapes more than one suite asserts, written once so a format change lands everywhere at the
 * same time.
 */

/**
 * A node the panel draws with its type in front of it. Written out rather than built with the
 * package's own `mark`, so a broken wrapper fails these tests instead of moving with them.
 */
export function labelled(type: string, children: Record<string, unknown>): unknown {
  return { data: children, __serializedType__: type };
}

/** A node holding one panel's two stores: `open` shut, and the width the caller passes. */
export function panelNode(width: number): Record<string, unknown> {
  return { "open [store]": false, "width [store]": width };
}
