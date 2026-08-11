import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionMessage } from "../extension.ts";
import { type FakeExtension, installFakeExtension } from "./fake-extension.ts";

let fake: FakeExtension | undefined;

function install(): FakeExtension {
  fake = installFakeExtension();

  return fake;
}

afterEach(() => {
  fake?.uninstall();
  fake = undefined;
});

describe("installFakeExtension", () => {
  it("puts a connect on the global the bridge reads", () => {
    expect(globalThis.__REDUX_DEVTOOLS_EXTENSION__).toBeUndefined();

    install();

    expect(typeof globalThis.__REDUX_DEVTOOLS_EXTENSION__?.connect).toBe("function");
  });

  it("returns the five methods and records the connect config", () => {
    const extension = install();
    const connection = globalThis.__REDUX_DEVTOOLS_EXTENSION__!.connect({ name: "nanostores" });

    expect(Object.keys(connection).sort()).toEqual([
      "error",
      "init",
      "send",
      "subscribe",
      "unsubscribe",
    ]);
    expect(extension.configs).toEqual([{ name: "nanostores" }]);
  });

  it("records init and send calls", () => {
    const extension = install();
    const connection = globalThis.__REDUX_DEVTOOLS_EXTENSION__!.connect({});

    connection.init({ cart: { $count: 0 } });
    connection.send({ type: "$count/set" }, { cart: { $count: 1 } });
    connection.error("broke");

    expect(extension.inits).toEqual([{ state: { cart: { $count: 0 } }, liftedData: undefined }]);
    expect(extension.sends).toEqual([
      { action: { type: "$count/set" }, state: { cart: { $count: 1 } } },
    ]);
    expect(extension.errors).toEqual(["broke"]);
  });

  it("delivers START and STOP to a subscribed listener", () => {
    const extension = install();
    const connection = globalThis.__REDUX_DEVTOOLS_EXTENSION__!.connect({});
    const seen: ExtensionMessage[] = [];

    connection.subscribe((message) => seen.push(message));

    extension.start();
    extension.stop();
    extension.stop(true);

    expect(seen).toEqual([
      { type: "START", state: undefined, id: undefined, source: "@devtools-page" },
      { type: "STOP", state: undefined, id: undefined, source: "@devtools-page" },
      { type: "STOP", state: undefined, id: undefined, source: "@devtools-page", failed: true },
    ]);
  });

  it("stops delivering after the returned unsubscribe runs", () => {
    const extension = install();
    const connection = globalThis.__REDUX_DEVTOOLS_EXTENSION__!.connect({});
    const listener = vi.fn();

    connection.subscribe(listener)?.();
    extension.start();

    expect(listener).not.toHaveBeenCalled();
    expect(extension.listenerCount()).toBe(0);
  });

  it("stops delivering after unsubscribe", () => {
    const extension = install();
    const connection = globalThis.__REDUX_DEVTOOLS_EXTENSION__!.connect({});
    const listener = vi.fn();

    connection.subscribe(listener);
    connection.unsubscribe();
    extension.start();

    expect(listener).not.toHaveBeenCalled();
  });

  it("puts the global back as it was", () => {
    install().uninstall();
    fake = undefined;

    expect(globalThis.__REDUX_DEVTOOLS_EXTENSION__).toBeUndefined();
  });
});
