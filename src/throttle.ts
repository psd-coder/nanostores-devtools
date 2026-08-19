import { peekDevtoolsGlobal } from "./global.ts";
import type { StoreEntry, StoreType } from "./registry.ts";
import type { Row } from "./timeline.ts";
import { describeError, warnOnce } from "./warn.ts";

/** What the `throttle` option is handed: the two parts a name in the tree is made of, and the type. */
export type ThrottleTarget = {
  readonly home: string;
  readonly name: string;
  readonly type: StoreType;
};

export type ThrottleOption = readonly string[] | ((store: ThrottleTarget) => boolean);

/**
 * What the plugin read over a creation site: nothing, a bare mark, the rate the mark named, or
 * `false`, which is `// @devtools-no-throttle` taking the store out of the automatic catch.
 */
export type ThrottleComment = boolean | number | undefined;

/** Both options, read once at connect: which stores are marked, and the rate that marks one. */
export type ThrottleSettings = {
  marks: (target: ThrottleTarget) => boolean;
  /** Writes a second at which the bridge takes a store over itself, or nothing with it off. */
  threshold: number | undefined;
};

/** One store's write rate and the row it is holding back, written only while a panel listens. */
export type ThrottleState = {
  /** The option matched or the plugin read a comment: either one alone marks the store. */
  marked: boolean;
  /** The comment the plugin read, kept apart so a rename re-running the option cannot drop it. */
  commented: boolean;
  /** The other comment: this store is the developer's to throttle, so the write rate never does. */
  exempt: boolean;
  /** The rate the comment named, in milliseconds, or nothing for the default one row a second. */
  period: number | undefined;
  writes: number;
  windowStart: number;
  /** The rate caught this store once, and a store that burst once is expected to burst again. */
  tripped: boolean;
  /** When the store last drew a row, which is where the leading edge is measured from. */
  lastEmit: number;
  /** The suppressed row waiting for the second to end, and the timer that sends it. */
  pending?: Row | undefined;
  trailing?: ReturnType<typeof setTimeout> | undefined;
};

/** The second the write counter reads, which is the window the auto rate is measured over. */
export const THROTTLE_WINDOW = 1000;

/** One row a second, which every throttled store holds to unless a comment names its own rate. */
const DEFAULT_PERIOD = 1000;

/** Above anything a person clicking causes and well below a frame loop. */
const DEFAULT_THRESHOLD = 10;

export function createThrottleSettings(
  throttle: ThrottleOption | undefined,
  autoThrottle: boolean | number | undefined,
): ThrottleSettings {
  return { marks: marker(throttle), threshold: thresholdOf(autoThrottle) };
}

export function createThrottleState(comment: ThrottleComment): ThrottleState {
  return {
    marked: false,
    commented: hasComment(comment),
    exempt: comment === false,
    period: periodOf(comment),
    writes: 0,
    windowStart: 0,
    tripped: false,
    lastEmit: 0,
  };
}

/**
 * The plugin's registration is the whole truth about the comment, so the mark and the rate it named
 * are taken from it together: an edit that took the comment away takes the rate with it.
 */
export function applyComment(state: ThrottleState, comment: ThrottleComment): void {
  state.commented = hasComment(comment);
  state.exempt = comment === false;
  state.period = periodOf(comment);
}

/** How long this store holds a row back: the rate its comment named, or one row a second. */
export function throttlePeriod(entry: StoreEntry): number {
  return entry.throttle.period ?? DEFAULT_PERIOD;
}

/**
 * Both channels set one flag. Read at every registration, rename and move rather than per write, so
 * a predicate of the developer's own runs once for a store instead of once an animation frame.
 */
export function resolveMark(entry: StoreEntry): void {
  entry.throttle.marked = entry.throttle.commented || matched(entry);
}

/**
 * The counter and the decision, run on each write while a panel listens. It answers whether this
 * write draws no row of its own: the store is throttled and already drew one inside this second.
 *
 * The rate trips inside the window, on the write that passes the threshold, and it never trips
 * back: a store that burst once holds the throttle until it leaves the registry.
 *
 * A write that draws its row clears whatever was waiting, because the row going out now carries a
 * newer tree than the parked one and the store is at the leading edge again.
 */
export function suppressWrite(entry: StoreEntry, now: number): boolean {
  const { throttle } = entry;
  const { threshold } = settings() ?? {};

  count(throttle, now);

  if (threshold !== undefined && throttle.writes > threshold) {
    throttle.tripped = true;
  }

  const holds = throttled(throttle);

  if (holds && !throttle.marked) {
    warnAutoThrottle(entry);
  }

  if (holds && now - throttle.lastEmit < throttlePeriod(entry)) {
    return true;
  }

  clearThrottle(entry);
  throttle.lastEmit = now;

  return false;
}

/** Whether the tree says so. A mark can be taken away by a rename; the rate never is. */
export function isThrottled(entry: StoreEntry): boolean {
  return throttled(entry.throttle);
}

/** A parked row belongs to the session that made it, and a timer holding an entry is a leak. */
export function clearThrottle(entry: StoreEntry): void {
  const { throttle } = entry;

  if (throttle.trailing !== undefined) {
    clearTimeout(throttle.trailing);
  }

  throttle.pending = undefined;
  throttle.trailing = undefined;
}

/**
 * The rolling one second window, counted lazily: no timer, and a store that stops writing costs
 * nothing until it writes again. The count only has to carry a store to the write that trips it,
 * because the trip holds from there on, so a window that ends resets to this write and no more.
 */
function count(state: ThrottleState, now: number): void {
  if (now - state.windowStart < THROTTLE_WINDOW) {
    state.writes += 1;

    return;
  }

  state.writes = 1;
  state.windowStart = now;
}

function hasComment(comment: ThrottleComment): boolean {
  return comment !== undefined && comment !== false;
}

/** A rate is a positive count of milliseconds. Anything else the comment carries only marks. */
function periodOf(comment: ThrottleComment): number | undefined {
  return typeof comment === "number" && Number.isFinite(comment) && comment > 0
    ? comment
    : undefined;
}

/**
 * The exemption is read here rather than kept out of the counter, because a store can trip before
 * the comment above it reaches us: an edit that adds the comment registers a store that already
 * writes fast, and only the read side lets that store go again.
 */
function throttled(state: ThrottleState): boolean {
  return state.marked || (state.tripped && !state.exempt);
}

/** Once per store: the key is the registration, so a rename cannot ask for a second warning. */
function warnAutoThrottle(entry: StoreEntry): void {
  const target = `${entry.home}/${entry.name}`;

  warnOnce(
    "auto-throttle",
    String(entry.id),
    `${target} wrote ${entry.throttle.writes} times in a second, so the bridge throttles it to ` +
      `one row a second and keeps it there for the rest of the session. To keep every row of this ` +
      `store, ${keepRows(entry)}. To say this on purpose and stop this warning, pass ` +
      `throttle: ["${target}"].`,
  );
}

/** The comment is only worth naming for a store the plugin found, since nothing else reads one. */
function keepRows(entry: StoreEntry): string {
  return entry.origin === "plugin"
    ? "write // @devtools-no-throttle above it, or pass autoThrottle: false for every store"
    : "pass autoThrottle: false";
}

function matched(entry: StoreEntry): boolean {
  const marks = settings()?.marks;

  if (marks === undefined) {
    return false;
  }

  try {
    return marks({ home: entry.home, name: entry.name, type: entry.type });
  } catch (error) {
    warnOnce(
      "throttle-option-failed",
      String(entry.id),
      `The throttle option threw for "${entry.home}/${entry.name}", so that store is not ` +
        `throttled. ${describeError(error)}`,
    );

    return false;
  }
}

function settings(): ThrottleSettings | undefined {
  return peekDevtoolsGlobal()?.session?.throttle;
}

function marker(throttle: ThrottleOption | undefined): (target: ThrottleTarget) => boolean {
  if (throttle === undefined) {
    return () => false;
  }

  if (typeof throttle === "function") {
    return throttle;
  }

  /** A name, never the qualified label: the label carries a line number and an edit moves it. */
  const names = new Set(throttle);

  return (target) => names.has(`${target.home}/${target.name}`);
}

function thresholdOf(autoThrottle: boolean | number | undefined): number | undefined {
  if (autoThrottle === false) {
    return undefined;
  }

  return typeof autoThrottle === "number" ? autoThrottle : DEFAULT_THRESHOLD;
}
