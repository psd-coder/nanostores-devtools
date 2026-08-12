/**
 * Our own types for the Redux DevTools extension, read from the extension source. The npm
 * package `@redux-devtools/extension` types `connect` as returning `init` and `send` only,
 * which loses `subscribe`, `unsubscribe` and `error`.
 */

export type ExtensionSerialize = {
  replacer?: ((key: string, value: unknown) => unknown) | undefined;
  reviver?: ((key: string, value: unknown) => unknown) | undefined;
  options?: boolean | undefined;
};

export type ExtensionFeatures = {
  pause: boolean;
  export: boolean;
  lock: boolean;
  persist: boolean;
  import: boolean;
  jump: boolean;
  skip: boolean;
  reorder: boolean;
  dispatch: boolean;
  test: boolean;
};

export type ExtensionConfig = {
  name?: string | undefined;
  type?: string | undefined;
  instanceId?: number | undefined;
  maxAge?: number | undefined;
  latency?: number | undefined;
  serialize?: boolean | ExtensionSerialize | undefined;
  features?: ExtensionFeatures | undefined;
  trace?: boolean | (() => string | undefined) | undefined;
  traceLimit?: number | undefined;
};

export type ExtensionAction = {
  type: string;
  [field: string]: unknown;
};

/** `START` and `STOP` carry a fixed shape. The last arm groups the ones that vary. */
export type ExtensionMessage =
  | {
      readonly type: "START";
      readonly state: undefined;
      readonly id: undefined;
      readonly source: string;
    }
  | {
      readonly type: "STOP";
      readonly state: undefined;
      readonly id: undefined;
      readonly source: string;
      readonly failed?: boolean | undefined;
    }
  | {
      readonly type: "DISPATCH" | "ACTION" | "EXPORT" | "IMPORT" | "UPDATE" | "OPTIONS";
      readonly payload?: unknown;
      readonly state?: string | undefined;
      readonly id?: string | undefined;
      readonly source: string;
    };

export type ExtensionListener = (message: ExtensionMessage) => void;

export type ExtensionConnection = {
  init: (state: unknown, liftedData?: unknown) => void;
  subscribe: (listener: ExtensionListener) => (() => void) | undefined;
  unsubscribe: () => void;
  send: (action: ExtensionAction, state: unknown) => void;
  error: (payload: string) => void;
};

export type ReduxDevtoolsExtension = {
  connect: (config: ExtensionConfig) => ExtensionConnection;
};

declare global {
  var __REDUX_DEVTOOLS_EXTENSION__: ReduxDevtoolsExtension | undefined;
}

/**
 * The `source` every message from the extension's content script carries. The other direction
 * has its own value, `@devtools-page`, which is what a page stamps on a message it sends out.
 */
export const EXTENSION_SOURCE = "@devtools-extension";
