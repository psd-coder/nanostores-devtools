# Redux DevTools bridge specification

`nanostores-devtools` is a read-only bridge from nanostores to the Redux DevTools browser
extension. It draws registered stores as one state tree and sends a row for each direct write and
its recomputes. It does not change application state.

The [README](../README.md) covers installation and examples. [ARCHITECTURE.md](./ARCHITECTURE.md)
explains the source layout. [REFERENCE.md](./REFERENCE.md) explains tree names, rows, limits and
options in more detail. This document states the current bridge behavior in one place.

## Scope

The package supports nanostores 1.x and the `atom`, `map`, `deepMap`, `computed` and `batched`
store kinds. It supports automatic discovery through Vite 6, 7 and 8, webpack and Rspack.

It does not ship a UI. The user installs the Redux DevTools extension.

It does not support time travel, dispatch, import, reset, commit, rollback, skip or reorder. The
bridge disables those extension features. The extension pause button works and stops tree builds
and rows on this side.

The bridge never calls `store.get()` or runs an application getter. It reads own data properties
through descriptors. A `valueOf()` or `toString()` supplied by a class can run only when the object
has no own data, so a method with side effects can still affect the application during a snapshot.

## Public API

The package has five public entry points.

| subpath                       | source                     | runs in                     |
| ----------------------------- | -------------------------- | --------------------------- |
| `nanostores-devtools`         | `src/index.ts`             | browser                     |
| `nanostores-devtools/runtime` | `src/runtime.ts`           | browser, injected code only |
| `nanostores-devtools/vite`    | `src/discovery/vite.ts`    | Node, development only      |
| `nanostores-devtools/webpack` | `src/discovery/webpack.ts` | Node, development only      |
| `nanostores-devtools/rspack`  | `src/discovery/rspack.ts`  | Node, development only      |

The browser entry exports:

```ts
connectDevtools(options?): DevtoolsHandle
trackStores(group, stores): void
untrack(group): void
```

`connectDevtools()` returns `{ connected, disconnect }`. It returns `connected: false` when the
extension is absent or cannot connect. Calling it again keeps the first connection and returns its
handle.

`trackStores(group, stores)` registers stores that the plugin cannot reach. `untrack(group)` removes
all stores in that group.

The options are:

| option                | default        | behavior                                               |
| --------------------- | -------------- | ------------------------------------------------------ |
| `name`                | `"nanostores"` | extension connection name                              |
| `serializers`         | `[]`           | user value serializers, before shipped rules           |
| `platformSerializers` | `true`         | include shipped platform serializers                   |
| `maxAge`              | `500`          | rows held by the extension                             |
| `trace`               | `true`         | capture a stack for direct writes                      |
| `traceLimit`          | `10`           | captured stack frames                                  |
| `lifecycleEvents`     | `true`         | send register, unregister, mount and unmount rows      |
| `throttle`            | `[]`           | stores held to one row per second                      |
| `autoThrottle`        | `10`           | write-rate threshold; `false` disables it              |
| `maxValueDepth`       | `5`            | depth below a class instance; `Infinity` disables it   |
| `maxValueMembers`     | `100`          | members below a class instance; `Infinity` disables it |

`throttle` accepts `home/name` strings or a predicate over `{ home, name, type }`. The predicate
runs when a store registers, moves or changes its name, never on each write.

## Connection and session

`connectDevtools()` creates one connection to `globalThis.__REDUX_DEVTOOLS_EXTENSION__`. It attaches
store hooks only after a connection succeeds. Existing stores are matched first, and the initial
tree is sent in a microtask so imports in the same turn can register before it is built.

The extension sends `START` when a panel starts watching. The bridge sends a fresh tree on that
transition. `STOP` drops open and queued rows. `PAUSE_RECORDING` stops tree work until recording
resumes.

The model talks to a view through `Session`:

```ts
type Session = {
  active: () => boolean;
  emit: (row: Row) => void;
  emitAll: () => void;
};
```

The Redux view implements `emit()` with `connection.send()` and `emitAll()` with `connection.init()`.
No tree is built and no row is sent while the session is inactive.

## Registration and ownership

A store enters the registry in three ways:

1. A wrapper around a known nanostores creator registers a store where the source names the call.
2. The binding scan walks top-level bindings at the end of a module body and registers every store
   it reaches.
3. `trackStores()` registers stores under a group chosen by the user.

One store has one registry entry. A later discovery can rename or move that entry. Explicit
registration wins over a plugin name. A top-level binding in the developer's own file wins over an
owner path. Every binding and owner still has its own placement in the tree.

One owner and one key name one store, so a store replaced at the key that held it loses that key.
It keeps its entry and draws flat at its own file, if it was registered before it lost the key. A
store the plugin named where it was built, `holder = { $x: atom(0) }`, stays. A store only a member
assignment ever put there, `holder.$x = atom(0)`, never had an entry, so a second assignment to
that key leaves it drawn nowhere.

The binding scan walks plain objects, class instances, arrays, `Map` and `Set`. It reads own,
enumerable data properties only. It reaches a factory result, an alias, a collection member and a
class static field. A class field wrapper records `this` as the owner. A private field is not
listed by the scan, so it is not drawn unless another reference reaches the same store.

There is no creation-frame system. A store held only in a closure is not registered or drawn unless
a returned value exposes it to the binding scan. This keeps the tree to state the application can
reach from its own names.

Files outside the bundler root can register stores through named wrappers, but their binding scan
and class-field ownership create no names, nodes or owner links. Such stores stay flat under an
external home. The application binding that holds a library result gives it an application-owned
placement.

Owner links and nodes are weak. A collected owner disappears, and a store without a live owner is
drawn at its home.

## Automatic discovery

Each bundler adapter gives a shared discovery core its roots, module id shape, runtime module name,
hot-reload statement and warning channel. The core loads the parser on the first eligible source
file and uses the same transform for every adapter.

The plugin skips `node_modules`, virtual modules, non-script files and this package's own files.
Vite uses the plugin during `serve` only. webpack and Rspack refuse a build that is not in
development mode.

The transform injects a `fileScope()` call, clears the previous module scope at module execution,
wraps creator and adoption calls, and appends `own([...])` for top-level bindings. A Vite module
also receives a `prune()` callback for the deleted-file case. webpack and Rspack use their own HMR
dispose hook.

The injected runtime has this shape:

```ts
type FileScope = {
  store: <TStore>(store: TStore, site: CreationSite, owner?: object) => TStore;
  adopt: <TValue>(value: TValue, site: CreationSite) => TValue;
  own: (bindings: readonly Binding[]) => void;
  clear: () => void;
};

fileScope(moduleKey, home, external, maxDepth?): FileScope;
```

`CreationSite` contains `name`, `line`, `type` and an optional throttle mark. `Binding` contains a
name, its value, whether it is exported, and optional `maxMembers` and `isClass` fields.

The gate gives a call a source name only when it sits directly in the module body and a binding,
held object property or held array index names it. Calls inside a function, block, class field or
unowned argument have `name: null`. Their wrappers can still record a known store type for a later
binding scan.

Callee matching recognizes creators imported from `nanostores`, including renamed imports. Adoption
wraps named calls that matching does not recognize when `adoptFactories` is on, which is the default.
It passes non-stores through unchanged. `storeTypes` can add or replace a package export's store
kind for adopted stores.

`maxDepth` limits each binding scan to a whole-number depth of at least one, or `Infinity`. Its
default is ten. `// @nanostores-devtools:max-members N` limits the members scanned at every depth
for one binding. If it caps a store's own members, the tree shows the store value under `(value)`
and a `…` note with the omitted count.

The other source comments are `:throttle`, `:no-throttle` and `:ignore`. They mark the following
statement. `:ignore` leaves all calls in that statement unwrapped. An unreadable comment in this
namespace produces one bundler warning.

## Tree and keys

The tree has homes at its top level: explicit groups first, then the developer's files, then
external files. A store appears under what holds it. A store with more than one placement expands
at one placement and is a value-only repeat at the others. A repeated holder has `(drawn under)`
with the place that expands it.

The view owns these special keys:

| key             | meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `(value)`       | a store value that must sit beside children, a marker or a cap note |
| `…`             | members left out by a cap                                           |
| `(valueOf)`     | a published `valueOf()` result                                      |
| `(toString)`    | a published `toString()` result                                     |
| `(drawn under)` | where a repeated holder expands                                     |

The store key is its name, kind, optional qualifier and optional ordinal. For example:

```text
$counter [store]
$total [computed]
$counter [store] (line 20)
```

The timeline name uses the whole binding path, such as `config.theme.$x/set`. The tree uses one key
per nesting level, so its labels stay short.

## Timeline

One row holds one direct write and any synchronous computed followers. Direct writes use `onSet` to
finish the previous row and `onNotify` to open the next row. A microtask closes the final open row.
The snapshot is built only when the row is sent, so it contains current values.

`atom`, `map`, `deepMap` and `unknown` stores are direct writes. `computed` and `batched` stores are
followers. A batched store recomputes in a later task, so it always gets its own row. An unknown
computed or batched store can be shown as a direct write because the bridge cannot identify it.

Lifecycle rows describe registration, removal, mounting and unmounting. A reload that removes and
adds stores in one module execution becomes one hot-reload row.

A store can be throttled by the `throttle` option, a `:throttle` comment or automatic throttling.
The first row is sent immediately; later writes during the period merge into the row sent at the end
of the period. A `:no-throttle` comment excludes one store from automatic throttling. Lifecycle
rows are never throttled.

## Values

The extension's jsan serializer handles ordinary values. The bridge replacer protects descriptor
reads and marks values that jsan cannot render correctly. User serializers run first. Shipped rules
then cover platform values such as `Headers`, `FormData`, `URLSearchParams`, `ArrayBuffer`,
`SharedArrayBuffer`, `DataView` and boxed primitives.

Plain objects, arrays and collections are sent whole. The only value cap applies below a class
instance. A cycle is handled by jsan. A `Proxy` can still trap descriptor access; the bridge cannot
reliably detect that case.

## Shared state and production builds

All copies of the package share state through `Symbol.for("nanostores-devtools/v1")`. The shared
state includes the registry, module scopes, name claims, owners, owner keys, nodes, store member
counts and the active session. A newer copy fills missing fields when it finds a global object made
by an older copy.

The main entry has a `production` export condition that resolves to `noop.ts`. It exports the same
API and types with empty bodies. Vite does not load the plugin for production builds; webpack and
Rspack refuse their production mode. The package is ESM only and has `sideEffects: false`.

## Verification

The co-located tests cover registration, ownership, discovery, hot reload, timeline rows, rendering,
serialization and packaging. `src/testing/tree-fixture.test.ts` is the end-to-end tree fixture.
Run `pnpm test` for the full suite.
