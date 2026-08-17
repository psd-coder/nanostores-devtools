import type { Store } from "nanostores";

import {
  builtinFields,
  chainDescriptor,
  chainValue,
  copyData,
  type Fields,
  ownFields,
  ownIndexes,
} from "./descriptor.ts";
import { noteDrawn } from "./drawn.ts";
import { DEFAULT_VALUE_LIMITS, type ValueLimits } from "./limits.ts";
import { box, isBuilt, isMarked, keepBuilt, mark, type Marked, MORE_KEY } from "./marker.ts";
import { getEntry, isStore, noted, storeWord } from "./registry.ts";
import { dataForMark, reachesStore, staleNote, storeValue } from "./slot.ts";
import { isThrottled } from "./throttle.ts";
import { describeError, warnOnce } from "./warn.ts";

/**
 * Checked in array order, ahead of every rule of ours, and the first match wins. What a `convert`
 * returns goes to jsan, and no serializer runs again on a value inside that result, so a result may
 * hold its own input.
 */
export type Serializer = {
  match: (value: unknown) => boolean;
  convert: (value: unknown) => unknown;
};

type NodeAttribute = { name: string; value: string };

/** What a DOM node gives us for its opening tag. `attributes` is missing on a text node. */
type TaggedNode = { nodeName: string; attributes?: ArrayLike<NodeAttribute> | undefined };

/** The one wrapper each source object gets, for as long as the replacer lives. */
type Wrappers = WeakMap<object, Marked>;

/**
 * The one object each source value is handed to jsan as, for as long as the replacer lives, except
 * `expanded`, which one tree fills and the next starts without. Each shape keeps its own map,
 * because a source that is an array is one every time we meet it.
 */
type Kept = {
  wrappers: Wrappers;
  fields: WeakMap<object, Fields>;
  indexes: WeakMap<object, unknown[]>;
  /**
   * Every object a built-in getter handed back, whose own getters are not read again. One expansion
   * is what a developer asked for; a second is how one row reaches the whole platform behind a
   * value. Its own data still goes out: `CustomEvent.detail` is an expansion and holds the app's
   * own object.
   *
   * This one belongs to a tree rather than to the connection, so a value a getter handed back in
   * one tree is read in full in the next, where the app may hold it directly.
   */
  expanded: WeakSet<object>;
  /**
   * The level each value the walk is about to reach sits at below the nearest class instance, or
   * `FREE` where no count is running. Filled at the parent's call, because jsan hands the replacer
   * `(key, value)` and nothing else: no holder object and no path.
   *
   * One tree's, like `expanded`: a count held past its tree would keep an app object alive for the
   * session and let a slot this walk never came back for decide what the next tree draws.
   */
  depths: Map<object, number>;
  /**
   * How many members each source drew in this tree. The decision is taken once and reused, because
   * `copyFields` and `copyIndexes` refill one copy per source: with a cycle jsan can be part-way
   * through its own loop over that copy when the second sighting arrives, and a sighting that
   * refilled it with a different number of keys would make jsan finish the parent's loop over a
   * changed object and drop members.
   */
  widths: Map<object, number>;
  limits: ValueLimits;
};

/**
 * Below every real level, so a value the count never reached and a value the count let through can
 * never be confused, and so `min` keeps it winning wherever a value is reachable both ways.
 */
const FREE = -1;

/** How many slots of a serializer's result hold this value, so how often jsan is yet to hand it back. */
type ResultSlots = Map<unknown, number>;

/** Which kind of collection jsan is about to write, which says what the list it walks next holds. */
type Collection = "map" | "set";

/** What a width cap let through, and how many members it left behind. */
type Shortened<TDrawn> = { drawn: TDrawn; skipped: number };

/**
 * How many times one object may go through a `convert` while one tree is written. A result that
 * reaches its own input through something the walk cannot follow, an own getter above all, converts
 * that input again one level deeper every time and never stops. Nothing a real tree does comes near
 * this many, and jsan's own recursion outlives this depth, so the count stops such a walk while
 * there is still stack left to fill the slot with a `ConversionError`.
 */
const CONVERT_LIMIT = 1000;

/**
 * jsan calls this for every key of the tree and then walks whatever we hand back, so returning a
 * value untouched leaves it to jsan and returning a wrapper preempts jsan's own type handling.
 */
export function createReplacer(
  serializers: Serializer[],
  limits: ValueLimits = DEFAULT_VALUE_LIMITS,
): (key: string, value: unknown) => unknown {
  /**
   * jsan spots a value it has already walked by holding what the replacer handed back and matching
   * a second sighting by identity, so a fresh object on every call means a value that refers to
   * itself never comes round and the walk runs until the stack ends. One object per source value
   * is what lets jsan see the repeat, and they live as long as the replacer, which is one
   * connection.
   */
  const kept: Kept = {
    wrappers: new WeakMap(),
    fields: new WeakMap(),
    indexes: new WeakMap(),
    expanded: new WeakSet(),
    depths: new Map(),
    widths: new Map(),
    limits,
  };
  const slots: ResultSlots = new Map();
  const converted: Map<object, number> = new Map();

  /**
   * A collection handed to jsan whose list has not come back yet. jsan writes a `Map` and a `Set`
   * by walking a list it builds out of them, and that list is jsan's own, so no serializer of the
   * developer's should be asked about it. The list cannot be held by identity: jsan builds it after
   * we return. What can be held is the order: jsan starts that walk before it reads anything else,
   * so the list is the very next call, and that call takes the entry off again.
   */
  const opened: Collection[] = [];

  /**
   * The `[key, value]` pairs of a list jsan built, which are jsan's too, one level further down.
   * Each pair is built for one write and dies with it, so the set holds them weakly and empties
   * itself rather than being cleared after a tree the way a count is.
   */
  const jsanPairs: WeakSet<object> = new WeakSet();
  let forgetQueued = false;

  /**
   * Both counts and the expansions belong to one tree, and jsan writes a tree in one synchronous
   * run, so a microtask is the first moment after that tree. A count kept past it would hold an app
   * object alive for the session and would let a slot this walk never came back for change what the
   * next tree draws.
   */
  const forgetAfterTree = (): void => {
    if (forgetQueued) {
      return;
    }

    forgetQueued = true;

    queueMicrotask(() => {
      slots.clear();
      converted.clear();
      opened.length = 0;
      kept.expanded = new WeakSet();
      kept.depths.clear();
      kept.widths.clear();
      forgetQueued = false;
    });
  };

  /**
   * Hands the value on and, where that value is a collection, notes the list jsan walks next. A
   * serializer's own result is the one collection jsan still writes itself: every one the app holds
   * is keyed below before jsan can see it.
   */
  const openList = (handed: unknown): unknown => {
    if (handed instanceof Map || handed instanceof Set) {
      opened.push(handed instanceof Map ? "map" : "set");
    }

    return handed;
  };

  /**
   * The one way back to jsan, and the only place that says where the walk goes next. Whatever we
   * hand over, the values jsan reads out of it are registered one level down, so every value's own
   * level is known before its own call arrives.
   *
   * A wrapper is left alone here: the panel's reviver drops it, so its `data` takes the wrapper's
   * own level rather than the one below, and only the branch that built the wrapper knows whether
   * it started a fresh count. Each of those registers its own `data` through `markAt`.
   */
  const handOver = (handed: unknown, depth: number): unknown => {
    if (!isMarked(handed)) {
      registerAt(kept.depths, childValues(handed), below(depth));
    }

    return handed;
  };

  return (key, value) => {
    /**
     * On every call, because an expansion is left behind by the value walk rather than by a
     * serializer, and it costs one microtask for the whole tree either way.
     */
    forgetAfterTree();

    const walked = opened.pop();
    const depth = isWalkable(value) ? (kept.depths.get(value) ?? FREE) : FREE;

    try {
      /**
       * The list itself. Its members are the pairs of a `Map`, which are jsan's as well, or the
       * members of a `Set`, which are the app's and go through the serializers like any value.
       */
      if (walked !== undefined && Array.isArray(value)) {
        if (walked === "map") {
          holdPairs(jsanPairs, value);
        }

        return handOver(convertValue(value, kept, depth, true), depth);
      }

      /**
       * One pair, and the walk stops here: the key and the value inside it are the app's, and a
       * serializer of the developer's is meant to see them.
       */
      if (isWalkable(value) && jsanPairs.has(value)) {
        return handOver(convertValue(value, kept, depth, true), depth);
      }

      const left = slots.get(value) ?? 0;

      /**
       * A value jsan reached inside a result the serializers already built. Their rule already ran
       * over that whole tree, so running the serializers again on the way down is what loops.
       */
      if (left > 0) {
        takeSlot(slots, value, left);

        return handOver(fillSlots(slots, convertValue(value, kept, depth)), depth);
      }

      for (const serializer of serializers) {
        if (serializer.match(value)) {
          countConvert(converted, value);

          /** jsan walks this result too, and holding its slots keeps that walk out of this loop. */
          return handOver(openList(fillSlots(slots, serializer.convert(value))), depth);
        }
      }

      return handOver(convertValue(value, kept, depth), depth);
    } catch (error) {
      const message = describeError(error);

      /**
       * jsan passes the key and nothing else: no holder object and no path, so the store the
       * value belongs to is not reachable from here and the key is the whole dedup subject.
       */
      warnOnce(
        "conversion-failed",
        key,
        `A value at "${key}" could not be converted for the panel, so that one slot shows ` +
          `ConversionError. ${message}`,
      );

      /** A plain mark: whatever threw may be a primitive, and a weak key has to be an object. */
      return mark("ConversionError", box(message));
    }
  };
}

/**
 * The pairs of a list jsan built out of a `Map`, held for the one call each of them gets. Two
 * levels and no further: a pair is jsan's, while the key and the value it holds are the app's, so a
 * walk down from here would take the whole collection out of the developer's reach.
 */
function holdPairs(jsanPairs: WeakSet<object>, list: readonly unknown[]): void {
  for (const pair of list) {
    if (isWalkable(pair)) {
      jsanPairs.add(pair);
    }
  }
}

/**
 * Where jsan finds these values next.
 *
 * **The lowest level wins**, not the first write. Children are registered at their parent's call,
 * which in depth-first order always comes before the child's own call, so a value can be registered
 * deep before it is registered shallow: with `R = { a: A, p: P }`, `A = { b: { c: { d: X } } }` and
 * `P = { x: X }`, the walk registers `X` four levels down before `P` registers it two. The extension
 * turns jsan's `refs` off, so a plain repeat is walked a second time in full rather than pointed at,
 * and a wrong answer on that second sighting is drawn in the panel.
 *
 * `min` errs only toward drawing more, and the bound still holds: a value is expanded only when its
 * shortest counted path is inside the cap.
 */
function registerAt(depths: Map<object, number>, values: readonly unknown[], depth: number): void {
  for (const child of values) {
    if (!isWalkable(child)) {
      continue;
    }

    const known = depths.get(child);

    depths.set(child, known === undefined ? depth : Math.min(known, depth));
  }
}

/** One level down, and a value no count reached stays free however deep the walk goes. */
function below(depth: number): number {
  return depth === FREE ? FREE : depth + 1;
}

/**
 * The level a class instance itself sits at. A count that is already running keeps its level, so an
 * instance inside another instance goes on counting; one that is not starts at zero, which puts the
 * instance's own fields at level one.
 */
function startAt(depth: number): number {
  return depth === FREE ? 0 : depth;
}

/** One slot fewer, and the value goes once its last slot has been walked. */
function takeSlot(slots: ResultSlots, value: unknown, left: number): void {
  if (left > 1) {
    slots.set(value, left - 1);
  } else {
    slots.delete(value);
  }
}

/**
 * The values jsan walks next inside a result, one level at a time: each of them comes back to the
 * replacer, and that call holds the level below it. A getter is passed over rather than called, so
 * a result that keeps its input behind one is what `CONVERT_LIMIT` is for.
 */
function fillSlots(slots: ResultSlots, result: unknown): unknown {
  for (const child of childValues(result)) {
    slots.set(child, (slots.get(child) ?? 0) + 1);
  }

  return result;
}

/**
 * What jsan hands the replacer one level down. A `Map` and a `Set` go through a walk of their own,
 * over a list jsan builds out of them, so their keys and their values are held here while that list
 * and its pairs are not: those two levels are jsan's and are held by `opened` and `jsanPairs`, which
 * hold them for one call rather than counting them down like a slot.
 */
function childValues(value: unknown): unknown[] {
  if (!isWalkable(value)) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (value instanceof Map) {
    return [...value.keys(), ...value.values()];
  }

  if (value instanceof Set) {
    return [...value];
  }

  return Object.values(ownFields(value));
}

/**
 * Throws rather than returns, so a walk that cannot end costs the one slot a `ConversionError`
 * through the same `catch` every other failure goes through. Only an object is counted: a primitive
 * the app holds in a thousand slots is a tree a serializer may well meet, and it converts fine.
 */
function countConvert(converted: Map<object, number>, value: unknown): void {
  if (!isWalkable(value)) {
    return;
  }

  const seen = (converted.get(value) ?? 0) + 1;

  converted.set(value, seen);

  if (seen > CONVERT_LIMIT) {
    throw new Error(
      `A serializer converted the same value ${CONVERT_LIMIT} times while one tree was written, ` +
        `so its result reaches its own input through something the walk cannot follow, such as a ` +
        `getter.`,
    );
  }
}

/** What jsan walks into. A function is not one: with `options` on it goes out as a `$jsan` string. */
function isWalkable(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * The wrapper this value already has, holding what the value holds now, or a new one. Handing the
 * same object back twice is what tells jsan a value has come round again, and refreshing it is what
 * keeps a second walk from showing the first walk's values.
 */
function markOnce(wrappers: Wrappers, source: object, type: string, data: object): Marked {
  const known = wrappers.get(source);

  if (!known) {
    const fresh = mark(type, data);

    wrappers.set(source, fresh);

    return fresh;
  }

  known.data = data;
  known.__serializedType__ = type;

  return known;
}

/**
 * A wrapper, and the level its `data` sits at. The panel's reviver drops the wrapper, so `data`
 * takes the wrapper's own level and the members it holds take the one below on their own call.
 */
function markAt(kept: Kept, source: object, type: string, data: object, depth: number): Marked {
  registerAt(kept.depths, [data], depth);

  return markOnce(kept.wrappers, source, type, data);
}

/**
 * How many members this source may draw, decided once per tree so one source keeps one shape while
 * jsan walks it. Only where a count is running: a plain object, an array and a collection of the
 * app's are sent whole, however large, until the walk is inside a class instance.
 */
function allowance(kept: Kept, source: object, counting: boolean): number {
  const known = kept.widths.get(source);

  if (known !== undefined) {
    return known;
  }

  const allow = counting ? kept.limits.maxValueMembers : Number.POSITIVE_INFINITY;

  kept.widths.set(source, allow);

  return allow;
}

/** The first `allow` members in source order, and a note saying how many are past them. */
function shortened(raw: Fields, names: readonly string[], allow: number): Fields {
  if (names.length <= allow) {
    return raw;
  }

  const drawn: Fields = {};

  for (let index = 0; index < allow && index < names.length; index += 1) {
    const name = names[index];

    if (name !== undefined) {
      drawn[name] = raw[name];
    }
  }

  return withMore(drawn, names.length - allow, allow);
}

/**
 * What a capped shape left out, under the same key the tree writes for the same idea. A store past
 * the cap loses this node and keeps its own slot at its home, which is what the tree already does at
 * its own member cap: keeping stores and capping only the rest would force a full read of a
 * ten-million-member array to find them.
 */
function withMore(fields: Fields, skipped: number, drawn: number): Fields {
  if (skipped > 0) {
    fields[MORE_KEY] = mark(
      `${skipped} more members past the ${drawn} drawn under a class instance`,
      {},
    );
  }

  return fields;
}

/** A value the count reached past its last level, drawn by its class and the reason and nothing else. */
function pastDepth(kept: Kept, value: object): Marked {
  return markAt(
    kept,
    value,
    constructorName(value, "Object"),
    box(`past the ${kept.limits.maxValueDepth} levels drawn under a class instance`),
    FREE,
  );
}

/**
 * Throws on a value that will not let its keys be listed, before any rule below hands it to jsan.
 * Two reads sit behind it. jsan lists the keys of whatever it walks, and it does that outside the
 * `try` around this call, so a `Proxy` trap that throws there would take the whole write down. And
 * the copy a plain object and an array go out as answers a refusal with nothing at all, so without
 * this call a value that refused would draw as one that held nothing. Asking here costs one listing
 * and leaves the refusal where every other bad value lands: this one slot, drawn as a
 * `ConversionError`.
 */
function refuseUnlistable(value: object): void {
  Object.keys(value);
}

/**
 * The copy this plain object already has, refilled with what it holds now, or a new one. jsan reads
 * every member of what we hand back with a plain read, so handing back the app's own object is what
 * runs an own getter of theirs, and a copy taken from the descriptors is the only read we control.
 *
 * Identity is how jsan spots a value that has come round again, so a fresh copy on every sighting
 * would let a value holding itself recurse until the stack ends. One copy per source is what lets
 * jsan see the repeat, and refilling it is what keeps a second tree from showing the first tree's
 * members. The keys go back in the order the value lists them, because the panel draws them in the
 * order they arrive.
 */
function copyFields(kept: Kept, source: object, allow: number): Fields {
  const raw = ownFields(source);
  const names = Object.keys(raw);
  const drawn = shortened(raw, names, allow);
  const fields = isBuilt(source) ? drawn : slotted(kept, drawn);
  const known = kept.fields.get(source);

  if (known === undefined) {
    kept.fields.set(source, fields);

    return fields;
  }

  for (const key of Object.keys(known)) {
    delete known[key];
  }

  return Object.assign(known, fields);
}

/**
 * An array holding at least one store, spelled the way the tree spells a collection: one key per
 * position, `[0]`, so the store at it can carry its type, `[0] [store]`. It costs the array shape,
 * which is why only an array holding a store takes it: a list of plain data stays a list.
 *
 * The panel is the whole reason. A type carried in a wrapper is drawn in the item string, and the
 * State tab hides that string while the node is expanded and drops it from a collapsed parent's
 * preview, so on an array member there is no moment it can be read. A key is always drawn.
 *
 * The `Array` mark says what it was while the node is collapsed, and its own `data` key is what
 * keeps jsan finding a loop through here, the same reason a store that holds itself keeps a wrapper.
 */
function positioned(members: readonly unknown[]): Fields {
  const fields: Fields = {};

  for (let index = 0; index < members.length; index += 1) {
    fields[`[${index}]`] = members[index];
  }

  return keepBuilt(fields);
}

/**
 * Both collections are read through the built-in `forEach` called against the value rather than
 * through a method of the value's own, so a subclass that overrode iteration cannot run its code
 * while a tree is written.
 */
function setMembers(value: Set<unknown>, upTo: number): Shortened<unknown[]> {
  const drawn: unknown[] = [];
  let skipped = 0;

  Set.prototype.forEach.call(value, (member: unknown) => {
    if (drawn.length < upTo) {
      drawn.push(member);
    } else {
      skipped += 1;
    }
  });

  return { drawn, skipped };
}

/**
 * One key per entry, spelled the way the tree spells a `Map` key, `["scratch"]`. A key that is
 * neither a string nor a number has no name in the source to spell, so its entry keeps jsan's own
 * shape, `[entry 0]: { "[key]": …, "[value]": … }`: the key is as much state as the value is, and
 * the tree may leave such a member out of a placement but a value may not lose it.
 */
function mapEntries(value: Map<unknown, unknown>, upTo: number): Shortened<Fields> {
  const drawn: Fields = {};
  let index = 0;
  let skipped = 0;

  Map.prototype.forEach.call(value, (member: unknown, key: unknown) => {
    if (index >= upTo) {
      skipped += 1;
      index += 1;

      return;
    }

    if (typeof key === "string" || typeof key === "number") {
      drawn[`[${JSON.stringify(key)}]`] = member;
    } else {
      drawn[`[entry ${index}]`] = keepBuilt({ "[key]": key, "[value]": member });
    }

    index += 1;
  });

  return { drawn, skipped };
}

/** The same rule for an array of no stores, whose members jsan reads by index. A hole stays put. */
function copyIndexes(kept: Kept, source: readonly unknown[], indexes: unknown[]): unknown[] {
  const known = kept.indexes.get(source);

  if (known === undefined) {
    kept.indexes.set(source, indexes);

    return indexes;
  }

  known.length = 0;
  Object.assign(known, indexes);

  /** `Object.assign` copies no hole, so the length says where the members it did copy end. */
  known.length = indexes.length;

  return known;
}

/**
 * Named apart from a `Serializer.convert`, which is the user's rule and runs before this.
 *
 * `encoders` says the array in hand is one jsan built to write a `Map` or a `Set`, so its positions
 * are jsan's own and keying them would break the shape it is halfway through writing.
 */
function convertValue(value: unknown, kept: Kept, depth: number, encoders = false): unknown {
  if (typeof value === "bigint") {
    /**
     * jsan throws outright on a BigInt, so it has to be taken before jsan sees it. A plain mark: a
     * weak key has to be an object, and this value is not one.
     */
    return mark("BigInt", box(String(value)));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  /**
   * The global object, drawn by its class and nothing else. Whatever an app parks on `window` is an
   * own enumerable property, so one row holding a DOM event would otherwise carry the app's whole
   * top-level state, and `event.view` is only one of the routes to it.
   *
   * Identity is the whole test for the window we run in, and `instanceof` adds a window carrying
   * that same `Window` at some other name. A window built in another realm carries that realm's
   * `Window` instead, so it takes the class-instance rule like any other value.
   *
   * Above `refuseUnlistable`, because listing a window's keys is the very cost being avoided.
   * Neither test reads a property of the value.
   */
  if (value === globalThis || (typeof Window !== "undefined" && value instanceof Window)) {
    return markAt(kept, value, constructorName(value, "Object"), box("globalThis"), depth);
  }

  refuseUnlistable(value);

  /**
   * Ahead of every other rule of ours rather than wherever the branches happen to fall. A store is
   * a plain object literal, so the plain-object branch would hand jsan the nanostores keys and the
   * panel would draw `get, init, lc, listen, …` where a value belongs.
   *
   * Ahead of the depth cap too: a store is never replaced by a placeholder, so its slot keeps its
   * key and its type word wherever the walk found it.
   */
  if (isStore(value)) {
    return markStore(kept, value);
  }

  if (depth > kept.limits.maxValueDepth) {
    return pastDepth(kept, value);
  }

  /**
   * Whether a width cap applies to the app's own shapes here. A list jsan built out of a
   * serializer's collection is not the app's to cap, and neither is a shape we built ourselves,
   * which arrives already capped and would otherwise be shortened a second time. The class instance
   * below counts whatever its own level is, because it is what starts a count.
   */
  const counting = !encoders && !isBuilt(value) && depth !== FREE;

  if (value instanceof Error) {
    return markAt(kept, value, constructorName(value, "Error"), errorFields(kept, value), depth);
  }

  if (isTypedArray(value)) {
    return markAt(
      kept,
      value,
      constructorName(value, "Object"),
      typedData(kept, value, allowance(kept, value, counting)),
      depth,
    );
  }

  if (isDomNode(value)) {
    return markAt(kept, value, constructorName(value, "Object"), box(openingTag(value)), depth);
  }

  if (Array.isArray(value)) {
    const allow = allowance(kept, value, counting);
    const size = chainValue(value, "length");

    /**
     * jsan walks an array by `i < length` and drops every other key, so a capped array cannot carry
     * the note as an extra index. It switches to the keyed shape an array holding a store already
     * takes, where every member has a name of its own and the note is one more of them.
     */
    if (typeof size === "number" && size > allow) {
      const drawn = slotted(kept, positioned(ownIndexes(value, allow)));

      return markAt(kept, value, "Array", withMore(drawn, size - allow, allow), depth);
    }

    /** Read once, through the descriptors, so no accessor of the app's runs while we choose. */
    const members = ownIndexes(value);

    return !encoders && members.some(isStore)
      ? markAt(kept, value, "Array", slotted(kept, positioned(members)), depth)
      : copyIndexes(kept, value, members);
  }

  /** Before the class instance rule, or jsan never gets to render these two natively. */
  if (value instanceof Date || value instanceof RegExp) {
    return value;
  }

  /**
   * A `Map` and a `Set` are keyed rather than left to jsan, and unconditionally, which is where they
   * part from an array. The panel draws one node kind for a `Map`, a `Set` and anything else with an
   * iterator, and that node hard-codes its own name over the one it worked out, so every collection
   * jsan renders natively reads `Iterable` and a developer cannot tell a `Map` from a `Set`. An array
   * has no such problem and keeps its shape unless a store inside it needs a key.
   *
   * The cost is jsan's `3 entries` count, which the panel writes for a node of that kind alone.
   */
  if (value instanceof Set) {
    const allow = allowance(kept, value, counting);
    const members = setMembers(value, allow);
    const drawn = slotted(kept, positioned(members.drawn));

    return markAt(kept, value, "Set", withMore(drawn, members.skipped, allow), depth);
  }

  if (value instanceof Map) {
    const allow = allowance(kept, value, counting);
    const entries = mapEntries(value, allow);
    const drawn = slotted(kept, entries.drawn);

    return markAt(kept, value, "Map", withMore(drawn, entries.skipped, allow), depth);
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  if (prototype === Object.prototype || prototype === null) {
    return copyFields(kept, value, allowance(kept, value, counting));
  }

  /**
   * The one place besides a built-in getter expansion, which happens below this, where a count
   * starts. A plain object of the app's registers its children free, so app state above any class
   * instance is untouched, while a plain object *inside* one goes on counting and cannot escape the
   * cap by being plain.
   */
  const name = constructorName(value, "Object");
  const own = heldFields(kept, value);
  const names = Object.keys(own);
  const allow = allowance(kept, value, true);
  const fields = slotted(kept, shortened(own, names, allow));
  const data = Object.keys(fields).length > 0 ? fields : box(String(value));

  return markAt(kept, value, name, data, startAt(depth));
}

/**
 * What a typed array shows. `ownIndexes` cannot serve here: a typed array keeps `length` behind a
 * prototype getter and that reader takes data properties only. `ArrayBuffer.isView` answered yes on
 * an object with the internal slot, which a `Proxy` never has, so reading it runs no app code.
 *
 * `Array.from` on a ten-million-element `Float64Array` in a class field is the payload this cap
 * exists for, so a capped one is read index by index and never through it.
 */
function typedData(kept: Kept, value: ArrayLike<number | bigint>, allow: number): object {
  /** Read as `unknown`: a view whose prototype the app cut away has no `length` left at all. */
  const size: unknown = value.length;

  if (typeof size !== "number" || size <= allow) {
    return keepBuilt(Array.from(value));
  }

  const drawn: unknown[] = [];

  for (let index = 0; index < allow; index += 1) {
    drawn.push(value[index]);
  }

  return withMore(slotted(kept, positioned(drawn)), size - allow, allow);
}

/**
 * The keys of an object whose members are stores, spelled the way the tree spells a slot: the type
 * goes in the key, `$checked [computed]`, and what the store holds goes in beneath it. One store
 * then reads the same wherever it is drawn, and a plain `false` costs neither a wrapper nor the
 * `(value)` box a wrapper needs to carry a label. The wrapper is left for the one thing only a
 * wrapper can say, a value that cannot be trusted, and the key still carries the type beside it.
 *
 * Every position we spell ourselves takes the key too: an array index, a `Set` position and a `Map`
 * key we could name. The one place left for a wrapper is the `[key]` half of a `Map` entry whose key
 * has no name in the source, which is jsan's own shape rather than one of ours.
 *
 * jsan never meets a store this replaced, so a serializer of the developer's does not either. That
 * is what the tree already does with a store's own slot, where the value goes in and the store does
 * not, so the two paths agree rather than one of them being an exception.
 *
 * The result is noted as ours, because jsan walks the wrapper it becomes the `data` of and hands it
 * back here. Without the note that call would read it as a plain object of the app's: it would be
 * counted against the width cap a second time and shortened again, and slotted a second time.
 */
function slotted(kept: Kept, fields: Fields): Fields {
  const named: Fields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (isStore(value)) {
      const [slotKey, slot] = storeSlot(kept, key, value);

      named[slotKey] = slot;

      continue;
    }

    named[key] = value;
  }

  return keepBuilt(named);
}

/**
 * One store member, as a key and what sits under it.
 *
 * A value that can reach its own store back keeps the whole wrapper, key included. jsan finds a loop
 * by comparing the path it is on with the path it first met the value at, and it only counts the two
 * as a loop when one path is spelled inside the other. The wrapper's own `data` key is what puts a
 * `.` in that path: without it a key of ours, which is never a plain word, hides the ancestor and
 * jsan walks the loop until the stack ends.
 */
function storeSlot(kept: Kept, key: string, store: Store): [string, unknown] {
  const entry = getEntry(store);
  const note = staleNote(store, entry);
  const named = noted(key, entry?.type ?? "unknown", entry !== undefined && isThrottled(entry));

  noteDrawn(store);

  if (note !== undefined) {
    return [named, markAt(kept, store, note.label, note.data, FREE)];
  }

  const value = storeValue(store);

  if (reachesStore(value, store)) {
    return [key, markStore(kept, store)];
  }

  registerAt(kept.depths, [value], FREE);

  return [named, value];
}

/**
 * A store at a key that is not ours to rename: the `[key]` half of an unnamed `Map` entry, or one
 * handed straight to the replacer. `value` is the whole read, the same read the tree does: `get()`
 * mounts an unmounted store. A store that is not mounted says so instead of naming its type, because that
 * note says more and a mark cannot sit inside another mark.
 *
 * The value goes out free, whatever level the walk found the store at. One store must not disagree
 * with itself between two placements: a store drawn deep inside a class instance and the same store
 * drawn at its own home have to show the same value, and the home slot has no cap above it. It stays
 * bounded, because a class instance inside that value starts a fresh count.
 */
function markStore(kept: Kept, store: Store): Marked {
  const entry = getEntry(store);
  const note = staleNote(store, entry);

  noteDrawn(store);

  return note === undefined
    ? markAt(kept, store, storeWord(entry?.type), dataForMark(store, storeValue(store)), FREE)
    : markAt(kept, store, note.label, note.data, FREE);
}

/**
 * `message`, `stack` and `cause` are own but not enumerable, so each one is read by name, and each
 * one through a descriptor so a getter the app put on it never runs. `name` sits on the instance
 * only when a constructor assigned it and two prototypes up for a subclass, hence the chain walk;
 * `message` and `cause` are own on every engine we know, and the same walk costs nothing and covers
 * an app that moved them. A field whose descriptor is refused is left out rather than shown empty.
 */
function errorFields(kept: Kept, error: Error): Fields {
  const fields: Fields = {};

  copyData(fields, "name", chainDescriptor(error, "name"));
  copyData(fields, "message", chainDescriptor(error, "message"));

  /** Both keys being here means both held data, and that is what makes the stack safe to read. */
  const headerIsSafe = "name" in fields && "message" in fields;

  copyData(fields, "stack", stackDescriptor(error, headerIsSafe));

  /** `in` walks the prototype chain without running a getter, so the presence test is safe. */
  if ("cause" in error) {
    copyData(fields, "cause", chainDescriptor(error, "cause"));
  }

  return slotted(kept, Object.assign(fields, ownFields(error)));
}

/**
 * V8 installs `stack` as an own accessor on the instance, so refusing every accessor would drop the
 * stack from every error we draw. The position tells the two apart: an own accessor is the engine's
 * and is read, while a `get stack()` the app wrote lands on a prototype and is refused.
 *
 * That getter builds the first stack line as `name: message` and reads both off the error, so a
 * getter on either one would run through it. `headerIsSafe` says both were read as data, and
 * without it the stack goes out with them. Even then the read can run app code through
 * `Error.prepareStackTrace`, a V8 hook that formats the stack, and that is the one hole we take: it
 * is rare in a browser, and a devtools with no stack traces is worth less than the risk.
 */
function stackDescriptor(error: Error, headerIsSafe: boolean): PropertyDescriptor | undefined {
  const own = Object.getOwnPropertyDescriptor(error, "stack");

  if (!own) {
    return chainDescriptor(error, "stack");
  }

  if ("value" in own) {
    return own;
  }

  return own.get && headerIsSafe ? { value: own.get.call(error) } : undefined;
}

/**
 * What built the value, read through the descriptor so a getter the app put on `constructor` or on
 * the function's own `name` never runs. The value's own `constructor` comes first, which keeps
 * `this.constructor = Foo` written by hand working, and the prototype's is where a class puts it, so
 * reading own properties alone would lose every label.
 */
function constructorName(value: object, fallback: string): string {
  const prototype: object | null = Object.getPrototypeOf(value);
  const built: unknown =
    ownValue(value, "constructor") ??
    (prototype === null ? undefined : ownValue(prototype, "constructor"));
  const name: unknown = typeof built === "function" ? ownValue(built, "name") : undefined;

  return typeof name === "string" && name.length > 0 ? name : fallback;
}

/**
 * What a class instance shows: its own data, and where it has none, what the getters of a built-in
 * prototype hold. An object that keeps everything behind platform accessors used to read
 * `[object PointerEvent]` and say nothing else, because own data is all the walk ever looked at.
 *
 * Own data first, so an object that has any is untouched. A getter runs only where nothing was
 * written on the object itself, which is the shape this is for and keeps the reading cheap for every
 * other value the panel draws.
 */
function heldFields(kept: Kept, value: object): Fields {
  const own = ownFields(value);

  if (Object.keys(own).length > 0 || kept.expanded.has(value)) {
    return own;
  }

  const held = builtinFields(value);

  for (const member of Object.values(held)) {
    if (typeof member === "object" && member !== null) {
      kept.expanded.add(member);
    }
  }

  return held;
}

/** What an own data property holds. A getter is passed over rather than called. */
function ownValue(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/** Every view except a `DataView` is a typed array, and every typed array is array-like. */
function isTypedArray(value: object): value is ArrayLike<number | bigint> {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/** `instanceof` reads no property off the value, so no getter of the app's can run here. */
function isDomNode(value: object): value is TaggedNode {
  return typeof Node !== "undefined" && value instanceof Node;
}

/** The opening tag only: children can be a whole page, and `outerHTML` carries all of them. */
function openingTag(node: TaggedNode): string {
  const attributes = node.attributes ? Array.from(node.attributes) : [];
  const rendered = attributes.map((attribute) => ` ${attribute.name}="${attribute.value}"`);

  return `<${node.nodeName.toLowerCase()}${rendered.join("")}>`;
}
