# nanostores-devtools

<img align="right" width="92" height="92" alt="nanostores-devtools logo" title="nanostores-devtools logo" src="https://raw.githubusercontent.com/psd-coder/nanostores-devtools/main/logo.svg">

Inspect [nanostores](https://github.com/nanostores/nanostores) state in the
[Redux DevTools](https://github.com/reduxjs/redux-devtools) browser extension. Every store your
source gives a name to becomes a key in one state tree, and every write draws a named row in the
timeline, together with the recomputes that write caused. A store from a dependency joins the tree
the moment you name it, in one line.

A bundler plugin reads your source during development and gives each store the name you wrote for
it, so you write no setup per store at all. The bridge is **read-only**: it reads `.value` through
its own property descriptor, and runs none of your app's own code. It never calls `store.get()` and
never reads a getter you wrote. The only code of yours it runs is code you handed it on purpose: a
`serializers` rule, or a `throttle` function.

## Features

- ✅ Every store is named after the binding, object key, array index or `Map` key you wrote. A
  value that holds stores and has no name in your source is keyed `ref#1`, instead of getting a
  name we invented.
- ✅ Read-only. Never calls `store.get()`, never reads a getter you wrote, never mounts a store.
- ✅ One timeline row per change, named after the store: `$counter/set`, `$user/setKey:name`.
- ✅ Each store's kind sits in its key: `[computed]`, `[map]`, `[deepMap]`, `[batched]`.
- ✅ A store is drawn under whatever built it: a class instance, an object a factory returned, an
  array, a `Map`.
- ✅ Vite, webpack and Rspack. One plugin, one subpath each, and none of the three runs outside a
  development build.
- ✅ Builds no tree and sends nothing while no panel is open, and the panel's own pause button
  works the same way.
- ✅ A production build gets nothing but three empty functions, on Vite, webpack and Rspack with no
  work from you. The `production` export condition swaps the real module out, and every
  other bundler reaches the same place with one condition set.
- ✅ Holds a store that writes more than 10 times a second to one row a second, so a frame loop
  cannot push the rows you came to read out of the panel.
- ✅ Keeps a store out when you ask: write `// @nanostores-devtools:ignore` above it and the plugin
  skips it, so it never registers, takes no key in the tree and draws no row.
- ✅ ESM only, `sideEffects: false`, `nanostores` as its one browser peer.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { nanostoresDevtools } from "nanostores-devtools/vite";

export default defineConfig({
  plugins: [nanostoresDevtools()],
});
```

```ts
// src/main.ts
import { connectDevtools } from "nanostores-devtools";

connectDevtools({ name: "my-app" });
```

That is the whole code. Two things besides the package have to be in place first: the Redux
DevTools extension in your browser, and, on anything but Vite 8, `oxc-parser`. See
[Installation](#installation). Then open the Redux tab in your browser devtools and pick `my-app`
from the dropdown.

## Contents

- [Installation](#installation)
- [Core Concepts](#core-concepts)
- [Usage](#usage)
- [What you see in the panel](#what-you-see-in-the-panel)
- [When nothing shows up](#when-nothing-shows-up)
- [Turning it off in a production build](#turning-it-off-in-a-production-build)
- [API](#api)
- [Documentation](#documentation)
- [Design Notes](#design-notes)
- [License](#license)

## Installation

```bash
# npm
npm install -D nanostores-devtools

# pnpm
pnpm add -D nanostores-devtools

# yarn
yarn add -D nanostores-devtools
```

**This package ships no UI.** Install the
[Redux DevTools extension](https://github.com/reduxjs/redux-devtools) in your browser yourself. We
never fork it, repackage it, or build our own panel. With no extension on the page this package does
nothing, logs nothing, and attaches nothing to your stores.

Requires an ESM environment and `nanostores` 1.x. The bundler plugin runs in Node during
development only.

**On webpack, on Rspack and on Vite 6 and 7, add `oxc-parser` too:**

```bash
pnpm add -D oxc-parser
```

That is what reads your source. Vite 8 re-exports a parser the plugin can borrow, so a Vite 8
project needs nothing extra. Everywhere else the first file the plugin touches fails the build with
an error naming `oxc-parser`, so you cannot get this wrong quietly.

## Core Concepts

A nanostores store is a plain object. Nothing about it says where it was written, what it is
called, or what holds it. So the usual ways to watch one are all manual: a `console.log` inside
`$store.listen()`, or [`@nanostores/logger`](https://github.com/nanostores/logger), which prints
changes to the console under names you pass it store by store.

`nanostores-devtools` does the naming for you. A bundler plugin reads your source while your dev
server runs, finds every call that makes a store, and wraps it with the name, the line and the kind
it found there. In the browser those wrapped calls report to a registry, and the package draws one
state tree and one timeline out of what it learns. You get the whole app's state at once, a diff
per change, and a stack trace pointing at the line that wrote it.

It fits when:

- you have more than a handful of stores and want to see them together;
- you want to know **which** line wrote a value, not only that it changed;
- you want state a route or a code-split chunk added to appear on its own;
- you already read Redux DevTools for something else on the page.

## Usage

### Step 1: Add the plugin

There is one plugin and one subpath per bundler. Pick the line for yours; everything after it is
the same. This package is ESM only, so the config file holding it has to be ESM too.

The plugin reads **script files only**: `.js`, `.ts` and the rest of that family. A store written
inside a `.vue` or a `.svelte` file is untouched, and so is anything under `node_modules`. It
rewrites each file it does touch with `magic-string`, which keeps your source maps intact.

**Vite.** The plugin loads on the dev server alone, so one config covers both builds.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { nanostoresDevtools } from "nanostores-devtools/vite";

export default defineConfig({
  plugins: [nanostoresDevtools()],
});
```

**webpack and Rspack.** The same plugin, the same options, a different subpath.

```js
// webpack.config.dev.mjs
import { nanostoresDevtools } from "nanostores-devtools/webpack";

export default {
  mode: "development",
  plugins: [nanostoresDevtools()],
};
```

```js
// rspack.config.dev.mjs
import { nanostoresDevtools } from "nanostores-devtools/rspack";

export default {
  mode: "development",
  plugins: [nanostoresDevtools()],
};
```

Give webpack and Rspack a **development config of its own**. Neither has a dev-only flag, so both
load whatever the config lists, and a shared config would carry this plugin into your release build.
The plugin refuses a build whose `mode` is not `"development"`, transforming nothing and printing one
line to your terminal saying why, so a shared config costs you a warning instead of a leak. It is
still better to keep the plugin out of that config: a dev-only plugin should not be loaded by a
release build at all.

### Step 2: Call `connectDevtools()`

```ts
// src/main.ts
import { connectDevtools } from "nanostores-devtools";

connectDevtools({ name: "my-app" });
```

No `import.meta.env.DEV` guard and no dynamic import: export conditions already resolve the package
to an empty module in a production build. See
[Turning it off in a production build](#turning-it-off-in-a-production-build).

`connectDevtools()` never throws and never needs `await`, and a hot reload calling it again is safe.
It hands back a [`DevtoolsHandle`](#types), so `handle.connected` is how you check whether the
extension was there:

```ts
const handle = connectDevtools({ name: "my-app" });

if (!handle.connected) {
  console.info("No Redux DevTools extension on this page.");
}
```

Call it as early as you like. **The panel does not have to be open first.** The extension sends a
`START` whenever a panel begins watching, and we answer with every store there is, so you never
reload the page to catch up on state. A late panel does lose history: the rows from before it
opened were never sent.

### Step 3: Add the stores the plugin cannot reach

The plugin never reads a file under `node_modules`, and no option changes that, so a dependency's
stores are the usual case here. A build with no plugin is the other. List those stores by hand:

```ts
// src/stores/cart.ts
import { atom, computed } from "nanostores";
import { trackStores } from "nanostores-devtools";

export const $items = atom<string[]>([]);
export const $count = computed($items, (items) => items.length);

trackStores("cart", { $items, $count });
```

The first argument is a group name, and it becomes the top-level key those stores sit under.
`untrack("cart")` removes the group again.

With the plugin on, a store you also pass to `trackStores` **leaves the file tree** and moves under
your group, because a name you wrote by hand beats a name the plugin worked out. To keep it where
the plugin put it, name the group after the file: `trackStores("src/stores/cart.ts", { $items })`.

## What you see in the panel

The top level of the tree is the **home**: the file path for a store the plugin found, and the group
name for a store you listed by hand. Under a home, a store sits beneath whatever built it.

```
app/editor.ts
  Editor: { $opened [store]: 0 }                                <- a static class field
  drafts: Array { [0]: Editor {…}, [1]: Editor {…} }            <- an array, walked by index
  editorOne: Editor { $count [store]: 0, $value [store]: "" }   <- named by its binding
app/model.ts
  $busy [computed]: false
  $entries [computed]: ["", "the ", …]
  counter [store]: { (value): 0, $doubled [computed] }          <- a store that owns others
app/workspace.ts
  panel: { open [store]: false, width [store]: 320 }            <- what a factory returned
```

Two things in that example need an explanation.

**`(value)` holds a store's own value** whenever that value cannot sit at the store's own key. Two
things put it there:

- **The store owns other stores.** Its children then sit beside the value instead of inside it.
- **The store carries a note**, such as `not mounted, may be stale` on a `computed` nobody is
  listening to. This one is the extension's limit, not our choice: Redux DevTools hangs a note on
  the object it draws, so a value that cannot carry one has to be boxed first. That covers a
  primitive, a `null`, and anything the extension's own encoder rewrites on the way, a `Date` and a
  `RegExp` among them. A plain object and an array go in bare, because those can carry the note
  themselves.

**`[store]` covers two cases at once: an `atom`, and a store whose kind we could not read.** The
kind is read from the creator call at build time, so a store you listed by hand, or one a
third-party factory built, has none to print. Nothing at runtime could tell a `map` from a
`deepMap`, so all we could add is a guess.

Every row in the timeline is named after the store it is about and the kind of change. We build
that name ourselves: nanostores has no actions, so there is nothing else to name a row after.

| the row                              | what happened                                         |
| ------------------------------------ | ----------------------------------------------------- |
| `$counter/set`                       | an `atom` was written                                 |
| `$user/setKey:name`                  | a `map` key was written                               |
| `$settings/setKey:theme.color`       | a `deepMap` path was written                          |
| `$total/computed`                    | a `computed` recomputed with no write of yours open   |
| `$counter/mount`, `$counter/unmount` | the store gained its first listener, or lost its last |
| `$late/register`, `$late/unregister` | stores joined the tree, or left it                    |
| `$count/hotReload`                   | a file ran again and its stores were rebuilt          |

A row holds one write plus every recompute that write caused, which is why a `computed` usually has
no row of its own.

[REFERENCE.md](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/REFERENCE.md) has the rest: how a store finds its owner, what the key format
means, how two stores with one name are told apart, what a value shows and what it cannot show.

## When nothing shows up

**Our messages go to two different places.** The bridge writes to the browser console, and every
line begins with `[nanostores-devtools]`. The plugin writes to the terminal running your build:
what it finds in your source goes through the bundler's own warning channel, and the one line that
refuses a build which is not a development build is printed straight to the terminal. Both name the
plugin in their text. Each message is printed once, not once per save.

If the tree is empty, walk down this list:

| what you see                                      | what it means                                                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the dropdown has no entry for your app            | `connectDevtools()` never ran, or ran before the extension put itself on the page. Check `handle.connected`: `false` means we found no extension at that moment |
| your app is there, the tree is empty              | the plugin is not in your bundler config, or the build is not a dev build                                                                                       |
| the build failed naming `oxc-parser`              | install it, per [Installation](#installation)                                                                                                                   |
| the terminal says the plugin did nothing          | the build's `mode` is not `"development"`                                                                                                                       |
| your own stores are there, a dependency's are not | expected. Name them with [`trackStores`](#trackstoresgroup-stores)                                                                                              |
| a key reads `ref#1`                               | nothing in your source names that value, so the tree says so instead of inventing a name                                                                        |

## Turning it off in a production build

The main entry ships a `production` export condition. Under it the package resolves to a module
that exports the same three names with the same types and does nothing. Everything else gets the
real module.

| bundler         | behaviour                                                                    |
| --------------- | ---------------------------------------------------------------------------- |
| Vite            | automatic. `resolve.conditions` carries `development\|production` by default |
| webpack, Rspack | automatic. `conditionNames` follows `mode`                                   |
| esbuild         | needs `--conditions=production`                                              |
| Rollup          | needs `exportConditions: ["production"]` on the node-resolve plugin          |
| plain Node      | gets the real module. Importing it in Node is safe and does nothing          |

The plugin and the runtime need no such condition. The runtime is reached only through code the
plugin injects, and no production build ever sees that code: under Vite the plugin is not loaded
outside the dev server, and under webpack and Rspack it is loaded but refuses to transform anything.

The three bundlers in the top half need nothing from you. For esbuild and Rollup, set the condition
once in your build config and the rest works the same way.

**The explicit pattern stays supported** for anyone who wants control instead of automation. It
also drops the two calls from the bundle, instead of leaving them pointing at empty functions. Use
your own bundler's dev flag: `import.meta.env.DEV` is Vite's, and esbuild, Rollup and Node each
spell it differently.

```ts
if (import.meta.env.DEV) {
  const { connectDevtools } = await import("nanostores-devtools");

  connectDevtools();
}
```

## API

Five entry points. The three plugin subpaths run in Node during development only, and each exports
one function under the same name.

| subpath                       | exports                                     | runs in        |
| ----------------------------- | ------------------------------------------- | -------------- |
| `nanostores-devtools`         | `connectDevtools`, `trackStores`, `untrack` | browser        |
| `nanostores-devtools/vite`    | `nanostoresDevtools`                        | Node, dev only |
| `nanostores-devtools/webpack` | `nanostoresDevtools`                        | Node, dev only |
| `nanostores-devtools/rspack`  | `nanostoresDevtools`                        | Node, dev only |
| `nanostores-devtools/runtime` | internal, injected by the plugin            | browser        |

**`nanostores-devtools/runtime` is internal.** The plugin injects an import of it into your modules
during development, so it appears in your module graph. Never import it yourself.

### `connectDevtools(options?)`

Opens the bridge and returns a [`DevtoolsHandle`](#types). Never throws, never needs `await`.

Called a second time **while connected**, it warns once and hands back the first handle, which is
what makes a hot reload safe. With no extension on the page there is no connection to keep, so each
call quietly returns a fresh handle whose `connected` is `false`.

**Safe to call during server-side rendering.** It reads `globalThis.__REDUX_DEVTOOLS_EXTENSION__`,
finds nothing on the server, and hands back a disconnected handle. There is no `window` access to
guard.

| option                | default        | what it does                                                       |
| --------------------- | -------------- | ------------------------------------------------------------------ |
| `name`                | `"nanostores"` | the entry in the extension's dropdown                              |
| `serializers`         | `[]`           | your own rules for converting values, checked before ours          |
| `platformSerializers` | `true`         | our own rules for `Headers`, `FormData` and other platform classes |
| `trace`               | `true`         | capture a stack at each direct write                               |
| `traceLimit`          | `10`           | how many stack frames to capture                                   |
| `maxAge`              | `500`          | how many rows the extension keeps                                  |
| `lifecycleEvents`     | `true`         | draw the mount, unmount, register, unregister and hot reload rows  |
| `throttle`            | `[]`           | hold these stores to one row a second                              |
| `autoThrottle`        | `10`           | writes a second above which a store is throttled                   |
| `maxValueDepth`       | `5`            | levels drawn below a class instance                                |
| `maxValueMembers`     | `100`          | members drawn per shape below a class instance                     |

Four of these are worth reading about before you change them.
[`maxAge`, `traceLimit` and `lifecycleEvents`](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/REFERENCE.md#what-each-connectdevtools-option-costs)
each buy panel quality with page cost, and `autoThrottle` is the one default that drops rows.

**`autoThrottle` is a threshold in writes a second.** Pass your own, `autoThrottle: 20`, or `false`
to keep every row. The number is the write rate above which a store is caught, not the rate you get
out. What you get out is one row a second, and the `// @nanostores-devtools:throttle 100` comment
below is the only way to hold one store to a different rate. A store it catches stays throttled for
the rest of the session, and we warn once, naming the store.

`throttle` takes the names as the tree writes them, `"home/name"`, or a rule over them:

```ts
connectDevtools({ throttle: ["src/model.ts/$remaining"] });
connectDevtools({
  throttle: (store) => store.home.startsWith("src/animation/"),
});
```

The plugin reads a comment for the same thing, next to the store, where a rename cannot lose it.
`// @nanostores-devtools:throttle` marks the whole statement below it,
`// @nanostores-devtools:throttle 100` sets its own rate in milliseconds, and
`// @nanostores-devtools:no-throttle` keeps every row of a store that writes fast on purpose:

```ts
// @nanostores-devtools:throttle 100
const $frame = atom(0);
```

**The plugin reads a third comment, and it is not about rows.** `// @nanostores-devtools:ignore`
keeps every store the statement below it makes out of the devtools: no key in the tree, no row in
the timeline, nothing in the panel that says the store is there. It marks the whole statement the
way the other two do, it wins over them where both stand over one statement, and it changes nothing
else in the file. A store you keep out this way is called **ignored**:

```ts
// @nanostores-devtools:ignore
const $session = atom(readToken());
```

The colon is the one separator. A `@nanostores-devtools` comment that names none of the three is
read as ordinary prose, and so is one with a hyphen where the colon belongs. The plugin then warns
once, naming the file and the line, so a typo does not quietly leave a store drawn.
[REFERENCE.md](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/REFERENCE.md#what-each-connectdevtools-option-costs)
has the full rules for all three.

`handle.disconnect()` closes the bridge: it stops listening, drops the rows it has not sent,
detaches every nanostores hook, and lets the next `connectDevtools()` open a fresh connection. You
rarely need it. It is there for a page that tears its app down and builds another one.

A **serializer** is how you draw a value the panel cannot read on its own. Every field of a
`MouseEvent` sits behind a getter, and a getter is never read, so without a rule it draws as an
empty object:

```ts
connectDevtools({
  serializers: [
    {
      match: (value) => value instanceof MouseEvent,
      convert: (event) => ({
        type: event.type,
        x: event.clientX,
        y: event.clientY,
      }),
    },
  ],
});
```

Rules run in array order, the first match wins, and all of them run before our own rules.

### `trackStores(group, stores)`

Registers stores the plugin cannot reach, under a top-level key you name.

- `group` - the home those stores sit under. Name it after a file to land on the node the plugin
  already uses for that file.
- `stores` - an object of `name -> store`. The key is the name the tree draws.

A second registration for the same `group/name` replaces the store held there, with no warning. A
clash here is almost always a hot reload, and we cannot tell the two apart.

### `untrack(group)`

Removes a group and every store in it. Draws one unregister row.

### `nanostoresDevtools(options?)`

The bundler plugin. Exported from `/vite`, `/webpack` and `/rspack`, and the same function behind
all three.

| option             | default                   | what it does                                                  |
| ------------------ | ------------------------- | ------------------------------------------------------------- |
| `fileKey`          | the home unchanged        | rewrites the path shown as a store's home                     |
| `adoptFactories`   | `true`                    | wrap named calls we do not recognise: `true` or `false`       |
| `storeTypes`       | the packages we ship      | which kind a package's export makes                           |
| `maxStoresPerSite` | `50`                      | live stores one creation site may hold, 1 or more             |
| `projectRoot`      | Vite's own workspace root | what a file outside the Vite root is measured from, Vite only |

`adoptFactories` is what catches a codebase that wraps store creation. A call whose result is
stored under a name is registered, no matter which function it names, so
`const theme = persistentAtom("theme", "dark")` reaches the tree from a file that never imports
`"nanostores"`. It takes two settings:

- `true`, the default: adopt a call under any name.
- `false`: adopt nothing, so only the calls the plugin recognises are wrapped.

`storeTypes` is what gives that store its kind. We ship a map of the packages from the Smart Stores
list in the nanostores README, so `persistentAtom` reads as an atom and `persistentMap` as a map.
Add your own package, or correct one of ours, and your entry is laid over ours per package and per
export:

```js
nanostoresDevtools({
  storeTypes: {
    "@acme/state": { createDeep: "deepMap" },
  },
});
```

A kind is one of `atom`, `map`, `deepMap`, `computed`, `batched` or `unknown`. An entry naming any
other kind is refused with a warning, and so is a package whose value is not an object. A refusal
costs the kind and nothing else: every other entry still merges, the call still reaches the tree by
adoption, and your build still runs.

`maxStoresPerSite` caps how many live stores one source line may hold, which matters for a factory
inside a loop. It drops unmounted stores first, the oldest of those first, and never the store just
made. `projectRoot` is a Vite option; under webpack and Rspack the wider root is always found by
climbing up from `context`.

[REFERENCE.md](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/REFERENCE.md#what-each-plugin-option-costs)
has what each one costs.

### Types

```ts
type DevtoolsHandle = {
  readonly connected: boolean; // false when no extension was on the page
  disconnect: () => void;
};

type Serializer = {
  match: (value: unknown) => boolean;
  convert: (value: unknown) => unknown;
};

// the shape a `throttle` rule is handed, once per registration and never per write
type ThrottleTarget = {
  home: string;
  name: string; // the name the tree draws, without the file and line a clash adds
  type: "atom" | "map" | "deepMap" | "computed" | "batched" | "unknown";
};

type ThrottleOption = readonly string[] | ((store: ThrottleTarget) => boolean);

// what `/webpack` and `/rspack` take
type BundlerPluginOptions = {
  fileKey?: (path: string) => string;
  adoptFactories?: boolean;
  // package name, then export name, then the kind that export makes
  storeTypes?: Record<string, Record<string, ThrottleTarget["type"]>>;
  maxStoresPerSite?: number;
};

// what `/vite` takes: the same four, plus one
type VitePluginOptions = BundlerPluginOptions & {
  projectRoot?: string;
};

// what `/webpack` and `/rspack` hand back. `/vite` hands back Vite's own `Plugin`
type BundlerPlugin = { apply(compiler: unknown): void };
```

`DevtoolsOptions` is exported too, and holds the eleven keys of the table above.

## Documentation

- [REFERENCE.md](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/REFERENCE.md) -
  what the panel draws and why. The tree, the keys, the timeline, the value rules, and everything
  this package cannot do.
- [ARCHITECTURE.md](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/ARCHITECTURE.md)
  - how the code works, end to end. For anyone changing it.
- [GLOSSARY.md](https://github.com/psd-coder/nanostores-devtools/blob/main/GLOSSARY.md) - the words
  this project uses in one fixed way: bridge, registry, home, group, tree, direct write, follower,
  creation site, adoption, node, owner, placement.

## Design Notes

- **No UI of our own.** Redux DevTools already draws a state tree, a diff and a timeline, and it is
  already installed. This package speaks its protocol and ships nothing else. We never fork it or
  repackage it.
- **Read-only, with no way around it.** Watching an app must not change how it behaves. So `.value`
  is read through its own property descriptor and never through `get()`, which for a `computed` can
  mount sources that were unmounted. A getter you wrote is never read either.
- **A name you wrote beats a name we worked out.** Every key in the tree traces to something in your
  source: a binding, a property, an index, a `Map` key, a class name. Where none exists we write
  `ref#1` and say so, rather than inventing a label you cannot look up.
- **Automatic discovery has a cost, and that cost is throttling.** Finding stores for you means you
  never chose which ones to watch, so a frame loop that writes 60 times a second lands in the panel
  whether you wanted it or not. That is why `autoThrottle` is on by default.

## License

[MIT](./LICENSE.md)
