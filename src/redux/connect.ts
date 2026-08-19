import { forgetDrawn } from "../drawn.ts";
import {
  EXTENSION_SOURCE,
  type ExtensionConfig,
  type ExtensionConnection,
  type ExtensionMessage,
} from "./extension.ts";
import { getDevtoolsGlobal, peekDevtoolsGlobal } from "../global.ts";
import { attachHooks, detachHooks } from "../hooks.ts";
import { resolveValueLimits } from "../limits.ts";
import {
  createLifecycle,
  dropPendingRows,
  type LifecycleState,
  noteInitSent,
  noteRegistryChange,
} from "../lifecycle.ts";
import { shippedSerializers } from "../platform.ts";
import { listEntries, onRegistryChange } from "../registry.ts";
import { createReplacer, type Serializer } from "./replacer.ts";
import { buildSnapshot } from "../snapshot.ts";
import {
  createTimeline,
  currentStack,
  dropOpenRow,
  dropParkedRows,
  type TimelineState,
} from "../timeline.ts";
import {
  createThrottleSettings,
  resolveMark,
  type ThrottleOption,
  type ThrottleSettings,
} from "../throttle.ts";
import { describeError, warnOnce } from "../warn.ts";

export type DevtoolsOptions = {
  name?: string | undefined;
  serializers?: Serializer[] | undefined;
  /** The rules the bridge ships for platform classes such as `Headers`. `false` leaves them out. */
  platformSerializers?: boolean | undefined;
  maxAge?: number | undefined;
  trace?: boolean | undefined;
  traceLimit?: number | undefined;
  lifecycleEvents?: boolean | undefined;
  /** The stores held to one row a second by hand: a list of `home/name`, or a rule over them. */
  throttle?: ThrottleOption | undefined;
  /** Writes a second above which the bridge throttles a store itself. `false` turns it off. */
  autoThrottle?: boolean | number | undefined;
  /** Levels drawn below a class instance. `Infinity` turns the cap off. */
  maxValueDepth?: number | undefined;
  /** Members drawn per shape below a class instance. `Infinity` turns the cap off. */
  maxValueMembers?: number | undefined;
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
  /** The panel's own pause button, which stops the tree build here and not only the send there. */
  paused: boolean;
  throttle: ThrottleSettings;
  timeline: TimelineState;
  lifecycle: LifecycleState;
  detach: () => void;
  unwatch: () => void;
};

const DEFAULT_NAME = "nanostores";
const DEFAULT_MAX_AGE = 500;
const DEFAULT_TRACE = true;
const DEFAULT_TRACE_LIMIT = 10;
const DEFAULT_LIFECYCLE_EVENTS = true;

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

  /** Registration happens at import time, so every store already here is matched now instead. */
  for (const entry of listEntries()) {
    resolveMark(entry);
  }

  bridge.unwatch = onRegistryChange((change) => {
    /** A store on its way out took its hooks with it, so only the other changes need a pass. */
    if (change.kind !== "unregister") {
      attachHooks();
    }

    noteRegistryChange(bridge, change);
  });
  attachHooks();

  /**
   * The end of the turn, not now: registration happens at import time, so an early `connect`
   * would otherwise send a nearly empty tree followed by a burst of joins.
   */
  queueMicrotask(() => {
    if (peekDevtoolsGlobal()?.bridge === bridge) {
      noteInitSent(bridge);
      sendInit(bridge);
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

  /** This connection draws its own first tree, so what a previous one drew counts for nothing. */
  forgetDrawn();

  const timeline = createTimeline(
    options?.trace ?? DEFAULT_TRACE,
    options?.traceLimit ?? DEFAULT_TRACE_LIMIT,
  );

  try {
    const connection = extension.connect(buildConfig(options, timeline.trace));
    const bridge: Bridge = {
      connection,
      listening: false,
      paused: false,
      throttle: createThrottleSettings(options?.throttle, options?.autoThrottle),
      timeline,
      lifecycle: createLifecycle(options?.lifecycleEvents ?? DEFAULT_LIFECYCLE_EVENTS),
      detach: () => {
        connection.unsubscribe();
      },
      unwatch: () => {},
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

function buildConfig(options: DevtoolsOptions | undefined, trace: boolean): ExtensionConfig {
  const config: ExtensionConfig = {
    name: options?.name ?? DEFAULT_NAME,
    type: "nanostores",
    maxAge: options?.maxAge ?? DEFAULT_MAX_AGE,
    /**
     * Both halves: `options: true` lets jsan render a `Date`, a `Map` and a `Set` natively, and
     * the replacer marks the ones jsan handles badly, such as an `Error` or a `BigInt`.
     */
    serialize: {
      replacer: createReplacer(serializersFor(options), resolveValueLimits(options ?? {})),
      options: true,
    },
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

  /**
   * A function, and only when the option is on. The extension's own `trace: true` captures inside
   * its `send`, which for us is flush time, so it would point at our flush instead of the write.
   */
  if (trace) {
    config.trace = currentStack;
  }

  return config;
}

/** The developer's rules first and ours after them, so a rule of theirs over a platform class wins. */
function serializersFor(options: DevtoolsOptions | undefined): Serializer[] {
  const own = options?.serializers ?? [];
  const withOurs = options?.platformSerializers ?? true;

  return withOurs ? [...own, ...shippedSerializers] : own;
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
      sendInit(bridge);
    }

    return;
  }

  if (message.type === "STOP") {
    bridge.listening = false;
    dropRows(bridge);

    return;
  }

  /**
   * The extension's own root listener flips its `isPaused` on this message and answers it with a
   * `LIFTED` of its own before ours runs, so we read it and reply nothing.
   *
   * Only this message touches the flag. `START` and `STOP` must leave it alone: the flag we shadow
   * flips on nothing else, and it holds while a panel closes and opens again.
   */
  if (message.type === "DISPATCH" && message.payload?.type === "PAUSE_RECORDING") {
    bridge.paused = message.payload.status === true;

    if (bridge.paused) {
      dropRows(bridge);
    }
  }
}

/** Every row in flight belongs to the session that opened it, and a paused panel is not it. */
function dropRows(bridge: Bridge): void {
  dropOpenRow(bridge);
  dropPendingRows(bridge);
  dropParkedRows();
}

/**
 * jsan runs inside the extension's own `init`, so a value it cannot write throws at our call
 * site. One store nobody can serialize must not take the page down with it.
 */
function sendInit(bridge: Bridge): void {
  try {
    bridge.connection.init(buildSnapshot());
  } catch (error) {
    warnOnce("init-failed", "", `The tree could not be sent to the panel. ${describeError(error)}`);
  }
}

function disconnect(bridge: Bridge): void {
  const devtools = peekDevtoolsGlobal();

  if (!devtools || devtools.bridge !== bridge) {
    return;
  }

  bridge.listening = false;
  dropRows(bridge);
  bridge.unwatch();
  bridge.detach();
  detachHooks();
  delete devtools.bridge;
}
