import {
  EXTENSION_SOURCE,
  type ExtensionAction,
  type ExtensionConfig,
  type ExtensionConnection,
  type ExtensionListener,
  type ExtensionMessage,
  type ReduxDevtoolsExtension,
} from "../extension.ts";

export type InitCall = { state: unknown; liftedData: unknown };

export type SendCall = { action: ExtensionAction; state: unknown };

export type FakeExtension = {
  readonly configs: ExtensionConfig[];
  readonly inits: InitCall[];
  readonly sends: SendCall[];
  readonly errors: string[];
  readonly listenerCount: () => number;
  start: () => void;
  stop: (failed?: boolean) => void;
  deliver: (message: ExtensionMessage) => void;
  uninstall: () => void;
};

/**
 * Installed on `globalThis`, which in a browser is `window`, so the same property the real
 * extension writes is the one a Node test run can reach.
 */
export function installFakeExtension(): FakeExtension {
  const configs: ExtensionConfig[] = [];
  const inits: InitCall[] = [];
  const sends: SendCall[] = [];
  const errors: string[] = [];
  const listeners = new Set<ExtensionListener>();
  const replaced = globalThis.__REDUX_DEVTOOLS_EXTENSION__;

  const connection: ExtensionConnection = {
    init(state, liftedData) {
      inits.push({ state, liftedData });
    },
    send(action, state) {
      sends.push({ action, state });
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    unsubscribe() {
      listeners.clear();
    },
    error(payload) {
      errors.push(payload);
    },
  };

  const extension: ReduxDevtoolsExtension = {
    connect(config) {
      configs.push(config);

      return connection;
    },
  };

  globalThis.__REDUX_DEVTOOLS_EXTENSION__ = extension;

  const deliver = (message: ExtensionMessage): void => {
    for (const listener of Array.from(listeners)) {
      listener(message);
    }
  };

  return {
    configs,
    inits,
    sends,
    errors,
    listenerCount: () => listeners.size,
    deliver,
    start: () =>
      deliver({ type: "START", state: undefined, id: undefined, source: EXTENSION_SOURCE }),
    stop: (failed) =>
      deliver({ type: "STOP", state: undefined, id: undefined, source: EXTENSION_SOURCE, failed }),
    uninstall: () => {
      listeners.clear();
      globalThis.__REDUX_DEVTOOLS_EXTENSION__ = replaced;
    },
  };
}
