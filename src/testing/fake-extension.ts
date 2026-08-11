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

export type SendCall = { action: ExtensionAction; state: unknown; trace: string | undefined };

export type FakeExtension = {
  readonly configs: ExtensionConfig[];
  readonly inits: InitCall[];
  readonly sends: SendCall[];
  readonly errors: string[];
  readonly listenerCount: () => number;
  /** The extension's `stringify` runs inside its own `send`, so it throws at our call site. */
  setSendFailure: (message: string | undefined) => void;
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
  let sendFailure: string | undefined;

  const connection: ExtensionConnection = {
    init(state, liftedData) {
      inits.push({ state, liftedData });
    },
    /** The real extension reads the stack inside `send`, so the fake has to read it there too. */
    send(action, state) {
      if (sendFailure !== undefined) {
        throw new Error(sendFailure);
      }

      const trace = configs.at(-1)?.trace;

      sends.push({ action, state, trace: typeof trace === "function" ? trace() : undefined });
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
    setSendFailure: (message) => {
      sendFailure = message;
    },
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
