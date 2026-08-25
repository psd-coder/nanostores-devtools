import { atom, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDevtoolsGlobal, GLOBAL_KEY, resetDevtoolsGlobal } from "./global.ts";
import { buildSnapshot } from "./redux/render.ts";
import { ownBindings } from "./stores/ownership.ts";
import { registerStore } from "./stores/registry.ts";
import { memberCountOf } from "./tree/placement.ts";

const HOME = "src/model.ts";
const FROM = { home: HOME, external: false, moduleKey: HOME };

function track(store: Store, name: string): void {
  registerStore({ store, name, home: HOME, type: "atom", origin: "plugin", external: false });
}

/** A store holding two more stores than its cap lets the walk draw, so it carries a count. */
function cappedStore(): Store {
  const $draft = Object.assign(atom<unknown>("text"), {
    $one: atom(1),
    $two: atom(2),
    $three: atom(3),
  });

  track($draft, "$draft");
  track($draft.$one, "$one");
  track($draft.$two, "$two");
  track($draft.$three, "$three");

  return $draft;
}

function walk(store: Store): void {
  ownBindings(FROM, [{ name: "$draft", value: store, exported: false, maxMembers: 2 }]);
}

/**
 * What an older copy of the package left behind: everything today's shape holds, minus a field
 * that copy never heard of. A fresh object, because the copy that made it built it from its own
 * list and nothing here can fill a field in behind its back.
 */
function plantOlderGlobal(): void {
  const { members: _members, ...older } = getDevtoolsGlobal();

  resetDevtoolsGlobal();
  Reflect.set(globalThis, GLOBAL_KEY, older);
}

function drawn(): Record<string, unknown> {
  const home = buildSnapshot()[HOME];

  return typeof home?.["$draft [store]"] === "object" && home["$draft [store]"] !== null
    ? { ...home["$draft [store]"] }
    : {};
}

describe("a global an older copy of the package made", () => {
  beforeEach(() => {
    resetDevtoolsGlobal();
  });

  afterEach(() => {
    resetDevtoolsGlobal();
  });

  it("draws a store whose counts the older shape has no place for, as if nothing was cut", () => {
    const $draft = cappedStore();

    walk($draft);
    expect(Object.keys(drawn())).toContain("…");

    plantOlderGlobal();

    expect(memberCountOf($draft)).toEqual({ walked: 0, skipped: 0 });
    /** The store draws as it always did, with only the note about what was cut gone. */
    expect(Object.keys(drawn())).toEqual(["(value)", "$one [store]", "$two [store]"]);
  });

  it("records the counts again once the walk runs through it", () => {
    const $draft = cappedStore();

    walk($draft);
    plantOlderGlobal();
    /** The render reads first, or the walk would fill the field in before the render met one. */
    drawn();
    walk($draft);

    expect(memberCountOf($draft)).toEqual({ walked: 2, skipped: 1 });
    expect(Object.keys(drawn())).toContain("…");
  });
});
