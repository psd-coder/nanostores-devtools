import { atom } from "nanostores";
import { describe, expect, it } from "vitest";

import { peekDevtoolsGlobal, resetDevtoolsGlobal } from "./global.ts";
import * as real from "./index.ts";
import * as noop from "./noop.ts";

/** True only when each side accepts the other, so a widened no-op signature fails to compile. */
type Mutual<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : false
  : false;

describe("the no-op module", () => {
  it("exports the same names with the same types as the real module", () => {
    const namespaces: Mutual<typeof noop, typeof real> = true;
    const options: Mutual<noop.DevtoolsOptions, real.DevtoolsOptions> = true;
    const handle: Mutual<noop.DevtoolsHandle, real.DevtoolsHandle> = true;
    const serializer: Mutual<noop.Serializer, real.Serializer> = true;

    expect([namespaces, options, handle, serializer]).toEqual([true, true, true, true]);
  });

  it("returns a handle that says it is not connected", () => {
    const handle = noop.connectDevtools({ name: "app" });

    expect(handle.connected).toBe(false);
    expect(() => {
      handle.disconnect();
    }).not.toThrow();
  });

  it("hands out a fresh handle per call, so nothing is shared at module scope", () => {
    expect(noop.connectDevtools()).not.toBe(noop.connectDevtools());
  });

  it("registers nothing", () => {
    resetDevtoolsGlobal();

    noop.trackStores("cart", { $items: atom<string[]>([]) });
    noop.untrack("cart");

    expect(peekDevtoolsGlobal()).toBeUndefined();
  });
});
