import { warnOnce } from "./warn.ts";

/**
 * How far down and how wide a value may be drawn once the walk is inside something the developer
 * never designed for the panel. Both counts start at a class instance, so app state above one is
 * never touched by either.
 */
export type ValueLimits = {
  maxValueDepth: number;
  maxValueMembers: number;
};

/**
 * A real domain object reads inside five levels: `Editor → doc → blocks → Block → id` is four. A
 * platform graph is wide at level one rather than deep, so five cuts the graph and keeps the object.
 */
const DEFAULT_MAX_VALUE_DEPTH = 5;

/**
 * Wide enough for the widest shape the panel is meant to draw whole, which is a platform interface:
 * `Event` plus `MouseEvent` plus `PointerEvent` is about 70 enumerable getters and `Navigator` about
 * 60. It is deliberately well above the placement tree's own member cap, where one member costs a
 * whole node the developer has to read and a much smaller number is right.
 */
const DEFAULT_MAX_VALUE_MEMBERS = 100;

export const DEFAULT_VALUE_LIMITS: ValueLimits = {
  maxValueDepth: DEFAULT_MAX_VALUE_DEPTH,
  maxValueMembers: DEFAULT_MAX_VALUE_MEMBERS,
};

/** What one option is called, what it counts, what it falls back to and the smallest it may be. */
type Cap = { name: string; unit: string; fallback: number; least: number };

const DEPTH_CAP: Cap = {
  name: "maxValueDepth",
  unit: "levels",
  fallback: DEFAULT_MAX_VALUE_DEPTH,
  least: 0,
};

const MEMBERS_CAP: Cap = {
  name: "maxValueMembers",
  unit: "members",
  fallback: DEFAULT_MAX_VALUE_MEMBERS,
  least: 1,
};

/**
 * `Infinity` is an answer: it says no cap. Every other number a walk cannot be held to is refused
 * rather than quietly repaired, because a silent 5 for a typed `-2` is not what was asked for and
 * says nothing. `0` levels is a real answer and means an instance's own fields are drawn with every
 * object among them a placeholder, while `0` members would draw nothing at all.
 */
export function resolveValueLimits(options: {
  maxValueDepth?: number | undefined;
  maxValueMembers?: number | undefined;
}): ValueLimits {
  return {
    maxValueDepth: resolveCap(DEPTH_CAP, options.maxValueDepth),
    maxValueMembers: resolveCap(MEMBERS_CAP, options.maxValueMembers),
  };
}

function resolveCap({ name, unit, fallback, least }: Cap, value: number | undefined): number {
  if (value === undefined) {
    return fallback;
  }

  if (value === Number.POSITIVE_INFINITY || (Number.isSafeInteger(value) && value >= least)) {
    return value;
  }

  /** One warning per option name: a second bad option is a second bug and has to be readable. */
  warnOnce(
    "bad-limit",
    name,
    `${name} is ${value} in connectDevtools(), which is no number of ${unit}, so the bridge ` +
      `draws ${fallback} ${unit} below a class instance instead. Pass a whole number of ` +
      `${least} or more, or Infinity for no cap.`,
  );

  return fallback;
}
