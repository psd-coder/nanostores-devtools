import {
  EXTENSION_SOURCE,
  type ExtensionConfig,
  type ExtensionConnection,
  type ExtensionMessage,
} from "./extension.ts";
import { getDevtoolsGlobal, peekDevtoolsGlobal } from "./global.ts";
import { detachHooks } from "./registry.ts";
import { buildSnapshot } from "./snapshot.ts";
import { warnOnce } from "./warn.ts";

export type DevtoolsOptions = {
  name?: string | undefined;
  maxAge?: number | undefined;
};

export type DevtoolsHandle = {
  readonly connected: boolean;
  disconnect: () => void;
};

/** One connection per page, kept beside the registry so two copies of the package share it. */
export type Bridge = {
  connection: ExtensionConnection;
  handle: DevtoolsHandle;
  listening: boolean;
  detach: () => void;
};

const DEFAULT_NAME = "nanostores";
const DEFAULT_MAX_AGE = 500;

/**
 * With no extension nothing is logged: the package is meant to be safe in a production
 * bundle, and `connected` is what a puzzled developer reads instead of a console message.
 */
export function connectDevtools(options?: DevtoolsOptions): DevtoolsHandle {
  const devtools = getDevtoolsGlobal();

  if (devtools.bridge) {
    warnOnce(
      "second-connect",
      "",
      "connectDevtools() was called twice. The first connection is kept.",
    );

    return devtools.bridge.handle;
  }

  const bridge = openBridge(options);

  if (!bridge) {
    return { connected: false, disconnect: () => {} };
  }

  devtools.bridge = bridge;

  /**
   * The end of the turn, not now: registration happens at import time, so an early `connect`
   * would otherwise send a nearly empty tree followed by a burst of joins.
   */
  queueMicrotask(() => {
    if (peekDevtoolsGlobal()?.bridge === bridge) {
      bridge.connection.init(buildSnapshot());
    }
  });

  return bridge.handle;
}

/** The extension global belongs to someone else, so a broken one reads as a missing one. */
function openBridge(options?: DevtoolsOptions): Bridge | undefined {
  const extension = globalThis.__REDUX_DEVTOOLS_EXTENSION__;

  if (typeof extension?.connect !== "function") {
    return undefined;
  }

  try {
    const connection = extension.connect(buildConfig(options));
    const bridge: Bridge = {
      connection,
      listening: false,
      detach: () => {
        connection.unsubscribe();
      },
      handle: {
        connected: true,
        disconnect: () => {
          disconnect(bridge);
        },
      },
    };
    const remove = connection.subscribe((message) => {
      receive(bridge, message);
    });

    if (remove) {
      bridge.detach = remove;
    }

    return bridge;
  } catch {
    return undefined;
  }
}

function buildConfig(options?: DevtoolsOptions): ExtensionConfig {
  return {
    name: options?.name ?? DEFAULT_NAME,
    type: "nanostores",
    maxAge: options?.maxAge ?? DEFAULT_MAX_AGE,
    serialize: { options: true },
    /**
     * In full, because the extension turns every feature on when the object is missing, which
     * gives a read-only bridge a jump, dispatch and import button that all do nothing.
     */
    features: {
      pause: true,
      export: true,
      lock: false,
      persist: false,
      import: false,
      jump: false,
      skip: false,
      reorder: false,
      dispatch: false,
      test: false,
    },
  };
}

/**
 * Re-init on the way into listening, not on every `START`: a second panel opening must not
 * wipe the first panel's history, while a reopened panel must not read a stale tree.
 */
function receive(bridge: Bridge, message: ExtensionMessage): void {
  if (message.source !== EXTENSION_SOURCE) {
    return;
  }

  if (message.type === "START") {
    if (!bridge.listening) {
      bridge.listening = true;
      bridge.connection.init(buildSnapshot());
    }

    return;
  }

  if (message.type === "STOP") {
    bridge.listening = false;
  }
}

function disconnect(bridge: Bridge): void {
  const devtools = peekDevtoolsGlobal();

  if (!devtools || devtools.bridge !== bridge) {
    return;
  }

  bridge.listening = false;
  bridge.detach();
  detachHooks();
  delete devtools.bridge;
}
