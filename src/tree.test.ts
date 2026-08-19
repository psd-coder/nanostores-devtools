import { atom, computed, type Store } from "nanostores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDevtoolsGlobal } from "./global.ts";
import { beginFrame, endFrame, noteBirth, ownBindings } from "./ownership.ts";
import { registerStore, type StoreType, trackStores } from "./registry.ts";
import { buildTree, type HolderNode, type StoreNode, type TreeNode } from "./tree.ts";

const HOME = "src/stores/cart.ts";
const FROM = { home: HOME, external: false, moduleKey: HOME };

function track(
  store: Store,
  name: string,
  type: StoreType = "atom",
  place: string | null = null,
  fn: string | null = null,
): void {
  registerStore({ store, name, home: HOME, type, place, origin: "plugin", external: false, fn });
}

function homeAt(home: string): TreeNode[] {
  return buildTree().homes.find((group) => group.home === home)?.children ?? [];
}

function storesIn(nodes: readonly TreeNode[]): StoreNode[] {
  return nodes.filter((node): node is StoreNode => node.kind === "store");
}

/** Every string the model holds for one node, so a rendered key cannot hide in any of them. */
function stringsIn(node: TreeNode): string[] {
  if (node.kind === "second") {
    return [node.name];
  }

  const own = node.kind === "holder" ? [node.name, node.type ?? ""] : [node.name];

  return [...own, ...node.children.flatMap(stringsIn)];
}

describe("buildTree", () => {
  beforeEach(() => {
    resetDevtoolsGlobal();
  });

  afterEach(() => {
    resetDevtoolsGlobal();
  });

  it("says of each home whether the developer wrote it, owns it, or somebody else does", () => {
    trackStores("cart", { $items: atom(["milk"]) });
    track(atom(1), "$own");
    registerStore({
      store: atom(2),
      name: "$theirs",
      home: "node_modules/@nanostores/router/index.js",
      type: "atom",
      origin: "plugin",
      external: true,
      fn: null,
    });

    expect(buildTree().homes.map((group) => [group.home, group.kind])).toEqual([
      ["cart", "group"],
      [HOME, "own"],
      ["node_modules/@nanostores/router/index.js", "external"],
    ]);
  });

  it("keeps the name, what qualifies it and its number in fields of their own", () => {
    const $first = atom(1);
    const $second = computed(atom(1), (count) => count + 1);
    const $draft = atom("");

    track($draft, "$draft");
    track($first, "$sum", "atom", "line 20", "makeCart");
    track($second, "$sum", "computed", "line 30", "makeCart");
    beginFrame();
    noteBirth($first);
    noteBirth($second);
    endFrame(FROM, $draft, "$draft");
    ownBindings(FROM, [["$draft", $draft]]);

    const [drawn] = storesIn(homeAt(HOME));
    const held = storesIn(drawn?.children ?? []);

    expect(held.map((node) => node.name)).toEqual(["$sum", "$sum"]);
    expect(held.map((node) => node.qualifier?.place)).toEqual(["line 20", "line 30"]);
    expect(held.map((node) => node.ordinal)).toEqual([null, null]);
  });

  it("holds no string the panel reads: no type note, no parentheses, no number", () => {
    const $held = atom(1);
    const editor = { $held };

    track($held, "$held", "computed", "line 20");
    ownBindings(FROM, [["editor", editor]]);

    const drawn = homeAt(HOME).flatMap(stringsIn);

    expect(drawn).toContain("$held");
    expect(drawn.some((name) => /[[(#]/.test(name))).toBe(false);
  });

  it("says what built a node and how many members the walk left out", () => {
    const $held = atom(1);
    const editor = { $held };

    track($held, "$held");
    ownBindings(FROM, [["editor", editor]]);

    const [node] = homeAt(HOME).filter((one): one is HolderNode => one.kind === "holder");

    expect(node?.name).toBe("editor");
    expect(node?.type).toBeUndefined();
    expect(node?.skipped).toBe(0);
  });

  it("says of each slot whether its value can be trusted", () => {
    const $stale = computed(atom(1), (count) => count + 1);
    const unbind = $stale.listen(() => {});

    unbind();
    track(atom(1), "$live");
    track($stale, "$stale", "computed");
    track(
      computed(atom(1), (count) => count + 1),
      "$never",
      "computed",
    );

    expect(storesIn(homeAt(HOME)).map((node) => [node.name, node.slot.state])).toEqual([
      ["$live", "live"],
      ["$never", "never-computed"],
      ["$stale", "stale"],
    ]);
  });
});
