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

/** Both options, read once at connect: which stores are marked, and the rate that marks one. */
export type ThrottleSettings = {
  marks: (target: ThrottleTarget) => boolean;
  /** Writes a second above which the bridge throttles a store itself, or nothing with it off. */
  threshold: number | undefined;
};

/** One store's write rate and the row it is holding back, written only while a panel listens. */
export type ThrottleState = {
  /** The option matched or the plugin read a comment: either one alone marks the store. */
  marked: boolean;
  /** The comment the plugin read, kept apart so a rename re-running the option cannot drop it. */
  commented: boolean;
  writes: number;
  windowStart: number;
  /** Whether the window that just ended went over the threshold. */
  hot: boolean;
  /** When the store last drew a row, which is where the leading edge is measured from. */
  lastEmit: number;
  /** The suppressed row waiting for the second to end, and the timer that sends it. */
  pending?: Row | undefined;
  trailing?: ReturnType<typeof setTimeout> | undefined;
  warned: boolean;
};

/** One row a second out, and the window the counter reads, are the same second. */
export const THROTTLE_WINDOW = 1000;

/** Above anything a person clicking causes and well below a frame loop. */
const DEFAULT_THRESHOLD = 10;

export function createThrottleSettings(
  throttle: ThrottleOption | undefined,
  autoThrottle: boolean | number | undefined,
): ThrottleSettings {
  return { marks: marker(throttle), threshold: thresholdOf(autoThrottle) };
}

export function createThrottleState(commented: boolean): ThrottleState {
  return {
    marked: false,
    commented,
    writes: 0,
    windowStart: 0,
    hot: false,
    lastEmit: 0,
    warned: false,
  };
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
 * A write that draws its row clears whatever was waiting, because the row going out now carries a
 * newer tree than the parked one and the store is at the leading edge again.
 */
export function suppressWrite(entry: StoreEntry, now: number): boolean {
  const { throttle } = entry;

  if (count(entry, now) && now - throttle.lastEmit < THROTTLE_WINDOW) {
    return true;
  }

  clearThrottle(entry);
  throttle.lastEmit = now;

  return false;
}

/** Whether the tree says so, which comes and goes with the throttling itself. */
export function isThrottled(entry: StoreEntry): boolean {
  return throttled(entry.throttle, settings()?.threshold, Date.now());
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
 * nothing until it writes again.
 *
 * A window two seconds old means a whole window went by with no write at all, so the count from
 * before it says nothing about the rate now and the store is released.
 */
function count(entry: StoreEntry, now: number): boolean {
  const { throttle } = entry;
  const { threshold } = settings() ?? {};
  const age = now - throttle.windowStart;

  if (age >= THROTTLE_WINDOW) {
    throttle.hot =
      age < THROTTLE_WINDOW * 2 && threshold !== undefined && throttle.writes > threshold;
    throttle.writes = 1;
    throttle.windowStart = now;
  } else {
    throttle.writes += 1;
  }

  const answer = throttled(throttle, threshold, now);

  if (answer && !throttle.marked && !throttle.warned) {
    warnAutoThrottle(entry);
  }

  return answer;
}

/**
 * The trip is inside the window and the release is at its edge: the write that passes the threshold
 * is the first one held back, rather than a whole second of full rows going out first.
 */
function throttled(state: ThrottleState, threshold: number | undefined, now: number): boolean {
  if (state.marked) {
    return true;
  }

  if (threshold === undefined || now - state.windowStart >= THROTTLE_WINDOW * 2) {
    return false;
  }

  return state.hot || state.writes > threshold;
}

/** Once per store: the rate coming back is not news, and a store around the threshold would flood. */
function warnAutoThrottle(entry: StoreEntry): void {
  const target = `${entry.home}/${entry.name}`;

  entry.throttle.warned = true;

  warnOnce(
    "auto-throttle",
    entry.label,
    `${target} wrote ${entry.throttle.writes} times in a second, so the bridge throttles it to ` +
      `one row a second. To keep every row, pass autoThrottle: false. To say this on purpose and ` +
      `stop this warning, pass throttle: ["${target}"].`,
  );
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
      entry.label,
      `The throttle option threw for "${entry.home}/${entry.name}", so that store is not ` +
        `throttled. ${describeError(error)}`,
    );

    return false;
  }
}

function settings(): ThrottleSettings | undefined {
  return peekDevtoolsGlobal()?.bridge?.throttle;
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
