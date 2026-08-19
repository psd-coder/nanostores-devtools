import { peekDevtoolsGlobal } from "./global.ts";
import type { LifecycleState } from "./timeline/lifecycle.ts";
import type { ThrottleSettings } from "./timeline/throttle.ts";
import type { Row, TimelineState } from "./timeline/timeline.ts";

/** What the entry call hands back: whether a view took the page, and the way to let it go. */
export type DevtoolsHandle = {
  readonly connected: boolean;
  disconnect: () => void;
};

/**
 * One view watching the page. The model keeps its state here and hands it finished rows; how a row
 * is spelled, and what it is sent over, belongs to whoever built the session.
 */
export type Session = {
  timeline: TimelineState;
  lifecycle: LifecycleState;
  throttle: ThrottleSettings;
  handle: DevtoolsHandle;
  /** Whether anything is watching. A closed or paused view answers no and nothing is built. */
  active: () => boolean;
  emit: (row: Row) => void;
  /** The whole tree, for the first message and for a reconnect. */
  emitAll: () => void;
};

/**
 * Nothing is built while nothing is watching: the tree is the expensive part of a row. A paused
 * view reads the same way, so pause stops the build on our side and not only the send on theirs.
 */
export function activeSession(): Session | undefined {
  const session = peekDevtoolsGlobal()?.session;

  return session?.active() === true ? session : undefined;
}
