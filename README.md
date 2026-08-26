# nanostores-devtools

<img align="right" width="92" height="92" alt="nanostores-devtools logo" title="nanostores-devtools logo" src="https://raw.githubusercontent.com/psd-coder/nanostores-devtools/main/logo.svg">

Inspect [nanostores](https://github.com/nanostores/nanostores) state in the
[Redux DevTools](https://github.com/reduxjs/redux-devtools) browser extension. A bundler plugin
reads your source during development and gives each store the name you wrote for it, so every store
becomes a key in one state tree and every write draws a named row in the timeline. You write no
setup per store. The bridge, which is the half of this package that runs in your browser, is
**read-only**: it never calls `store.get()` and never reads a getter you wrote.

## Features

- Every store is named after the binding, object key, array index or `Map` key you wrote.
- Read-only. Never calls `store.get()`, never reads a getter you wrote, never mounts a store.
- One timeline row per change: `$counter/set`, `$user/setKey:name`, `config.theme.$x/set`.
- Each store's kind sits in its key: `[computed]`, `[map]`, `[deepMap]`, `[batched]`.
- A store is drawn under whatever holds it: a class, a factory result, an array, a `Map`.
- Vite, webpack and Rspack. Dev builds only, and a production build gets three empty functions.
- Costs the page nothing while no panel is open, and the panel's pause button works the same way.

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
[Redux DevTools extension](https://github.com/reduxjs/redux-devtools) in your browser yourself. With
no extension on the page this package does nothing, logs nothing, and attaches nothing to your
stores.

Requires an ESM environment and `nanostores` 1.x. The package is ESM only and sets
`sideEffects: false`. The bundler plugin runs in Node 20.19+ or 22.12+, during development only.

**Only Vite, webpack and Rspack have a plugin.** On any other bundler nothing is discovered for
you, and you name your stores yourself with [`trackStores`](#trackstoresgroup-stores). The bridge
itself works the same way there.

**On webpack, on Rspack and on Vite 6 and 7, add `oxc-parser` too:**

```bash
pnpm add -D oxc-parser
```

That is what reads your source. Vite 8 re-exports a parser the plugin can borrow, so a Vite 8
project needs nothing extra. Everywhere else the first file the plugin touches fails the build with
an error naming `oxc-parser`.

## Core Concepts

A nanostores store is a plain object. Nothing about it says where it was written, what it is
called, or what holds it. So the usual ways to watch one are all manual: a `console.log` inside
`$store.listen()`, or [`@nanostores/logger`](https://github.com/nanostores/logger), which prints
changes to the console under names you pass it store by store.

`nanostores-devtools` does the naming for you. A bundler plugin reads your source while your dev
server runs and wraps every call that makes a store, so the bridge knows what each store is called
and what holds it. You get the whole app's state at once, a diff per change, and a stack
trace pointing at the line that wrote it.

One rule decides what appears: **a store is tracked where your own code holds it, never where it
only passed through.** Held means bound to a name you wrote, sitting inside a value bound to a name
you wrote, or handed back out of a call whose result is held.
[The bundler plugin](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/REFERENCE.md#the-bundler-plugin)
has the four cases that follow from it, and they are the ones that surprise people.

It fits when:

- you have more than a handful of stores and want to see them together;
- you want to know **which** line wrote a value, not only that it changed;
- you want state a route or a code-split chunk added to appear on its own;
- you already read Redux DevTools for something else on the page.

## Usage

### Step 1: Add the plugin

One plugin, one subpath per bundler, the same options behind all three. This package is ESM only,
so the config file holding it has to be ESM too.

**Vite.** Add `nanostoresDevtools()` from `nanostores-devtools/vite`, as in the block at the top of
this page. The plugin loads on the dev server alone, so one config covers both builds.

**webpack and Rspack.** The same plugin, from their own subpath:

```js
// webpack.config.dev.mjs
import { nanostoresDevtools } from "nanostores-devtools/webpack";

export default {
  mode: "development",
  plugins: [nanostoresDevtools()],
};
```

Rspack is the same file with `nanostores-devtools/rspack`. Give both a **development config of its
own**. Neither has a dev-only flag, so a shared config would carry this plugin into your release
build. The plugin refuses a build whose `mode` is not `"development"`, transforming nothing and
printing one line saying why, so a shared config costs you a warning instead of a leak.

### Step 2: Call `connectDevtools()`

```ts
// src/main.ts
import { connectDevtools } from "nanostores-devtools";

connectDevtools({ name: "my-app" });
```

No `import.meta.env.DEV` guard and no dynamic import: on Vite, webpack and Rspack export conditions
already resolve the package to an empty module in a production build. On esbuild and Rollup that
takes one line of build config, see
[Turning it off in a production build](#turning-it-off-in-a-production-build).

**The panel does not have to be open first.** We answer a panel that begins watching with every
store there is, so you never reload the page to catch up on state. A late panel does lose history:
the rows from before it opened were never sent. The extension itself is the one thing that has to be
there when you call: it puts itself on the page before your code runs, and `handle.connected` says
whether we found it.

### Step 3: Add the stores the plugin cannot reach

The plugin never reads a file under `node_modules`, and no option changes that, so a dependency's
stores are the usual case here. List those stores by hand:

```ts
// src/stores/cart.ts
import { atom, computed } from "nanostores";
import { trackStores } from "nanostores-devtools";

export const $items = atom<string[]>([]);
export const $count = computed($items, (items) => items.length);

trackStores("cart", { $items, $count });
```

The first argument is a group name, and it becomes the top-level key those stores sit under.
`untrack("cart")` removes the group again. A store you pass to `trackStores` with the plugin on
[leaves the file tree](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/REFERENCE.md#a-store-listed-by-hand-leaves-the-file-tree)
and moves under your group.

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

`[store]` marks an `atom`, or a store whose kind we could not read. `(value)` holds a store's own
value when that value cannot sit at the store's own key, which happens when the store owns other
stores or carries a note.

Every row in the timeline is named after the store it is about and the kind of change. We build
that name ourselves: nanostores has no actions to name a row after.

| the row                              | what happened                                         |
| ------------------------------------ | ----------------------------------------------------- |
| `$counter/set`                       | an `atom` was written                                 |
| `$user/setKey:name`                  | a `map` key was written                               |
| `$settings/setKey:theme.color`       | a `deepMap` path was written                          |
| `$total/computed`                    | a `computed` recomputed with no write of yours open   |
| `$counter/mount`, `$counter/unmount` | the store gained its first listener, or lost its last |
| `$late/register`, `$late/unregister` | stores joined the tree, or left it                    |
| `$count/hotReload`                   | a file ran again and its stores were rebuilt          |
| `config.theme.$x/set`                | a nested store was written, headed by its whole path  |

[REFERENCE.md](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/REFERENCE.md) has the
rest: how a store finds its owner, how two stores with one name are told apart, and what a value
shows and cannot show.

## When nothing shows up

Our messages go to two places. The bridge writes to the browser console, every line beginning with
`[nanostores-devtools]`, and the plugin writes to the terminal running your build. Each message is
printed once, not once per save.

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

The main entry ships a `production` export condition, and under it the package resolves to a module
that exports the same three names with the same types and does nothing. Vite, webpack and Rspack
pick that condition up on their own. esbuild needs `--conditions=production` and Rollup needs
`exportConditions: ["production"]`, both set once in your build config.
[Turning it off in a production build](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/REFERENCE.md#turning-it-off-in-a-production-build)
has the full table, and the explicit `import.meta.env.DEV` pattern for anyone who wants control
instead of automation.

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

Opens the bridge and returns a [`DevtoolsHandle`](#types). Never throws, never needs `await`, and
safe to call during server-side rendering. Called a second time while connected, it warns once and
hands back the first handle, which is what makes a hot reload safe.

```ts
const handle = connectDevtools({ name: "my-app" });

if (!handle.connected) {
  console.info("No Redux DevTools extension on this page.");
}
```

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

`autoThrottle` is the one default that drops rows: a store above 10 writes a second is held to one
row a second for the rest of the session, and we warn once, naming the store. Pass your own
threshold, or `false` to keep every row. `throttle` takes names as the tree writes them,
`"src/model.ts/$remaining"`, or a function over them.

A **serializer** draws a value the panel cannot read on its own, such as a `MouseEvent`, whose every
field sits behind a getter. A rule is `{ match, convert }`, and the first match in the array wins.

The plugin reads four comments next to a store, where a rename cannot lose them:
`// @nanostores-devtools:ignore` keeps every store the statement below it makes out of the devtools,
`// @nanostores-devtools:throttle` and `// @nanostores-devtools:no-throttle` set its row rate, and
`// @nanostores-devtools:max-members 25` caps how much of one binding the scan walks.

`handle.disconnect()` closes the bridge and lets the next `connectDevtools()` open a fresh one. It
is there for a page that tears its app down and builds another one.

[What each `connectDevtools` option costs](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/REFERENCE.md#what-each-connectdevtools-option-costs)
has the full rules for the options, the serializers and the four comments.

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
all three. It reads script files only: `.js`, `.ts` and the rest of that family, and nothing under
`node_modules`.

| option           | default                   | what it does                                                  |
| ---------------- | ------------------------- | ------------------------------------------------------------- |
| `fileKey`        | the home unchanged        | rewrites the path shown as a store's home                     |
| `adoptFactories` | `true`                    | wrap named calls we do not recognise: `true` or `false`       |
| `storeTypes`     | the packages we ship      | which kind a package's export makes                           |
| `maxDepth`       | `10`                      | steps into a top-level binding the scan walks, 1 or more      |
| `projectRoot`    | Vite's own workspace root | what a file outside the Vite root is measured from, Vite only |

`adoptFactories` catches a codebase that wraps store creation: a call whose result is stored under
a name is registered whatever function it names, so
`const theme = persistentAtom("theme", "dark")` reaches the tree from a file that never imports
`"nanostores"`. `storeTypes` gives that store its kind, and we ship a map of the packages from the
Smart Stores list in the nanostores README. `maxDepth` counts a property, an index and a `Map` key
alike. `projectRoot` is a Vite option; webpack and Rspack always climb up from `context` instead.

[What each plugin option costs](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/REFERENCE.md#what-each-plugin-option-costs)
has what each one buys and what it costs.

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
  readonly home: string;
  readonly name: string; // the name the tree draws, without the file and line a clash adds
  readonly type: "atom" | "map" | "deepMap" | "computed" | "batched" | "unknown";
};

type ThrottleOption = readonly string[] | ((store: ThrottleTarget) => boolean);

// what `/webpack` and `/rspack` take. `/vite` takes the same four plus `projectRoot?: string`
type BundlerPluginOptions = {
  fileKey?: (path: string) => string;
  adoptFactories?: boolean;
  // package name, then export name, then the kind that export makes
  storeTypes?: Readonly<Record<string, Readonly<Record<string, ThrottleTarget["type"]>>>>;
  maxDepth?: number;
};
```

`DevtoolsOptions` is exported too, and holds the eleven keys of the table above.

## Documentation

- [REFERENCE.md](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/REFERENCE.md) -
  what the panel draws and why, and everything this package cannot do.
- [SPEC.md](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/SPEC.md) - what the
  bridge does today, stated in one place.
- [ARCHITECTURE.md](https://github.com/psd-coder/nanostores-devtools/blob/main/docs/ARCHITECTURE.md)
  - how the code works, end to end. For anyone changing it.
- [GLOSSARY.md](https://github.com/psd-coder/nanostores-devtools/blob/main/GLOSSARY.md) - the words
  this project uses in one fixed way.

## Design Notes

- **No UI of our own.** Redux DevTools already draws a state tree, a diff and a timeline, and it is
  already installed. This package speaks its protocol and ships nothing else.
- **Read-only, with no way around it.** Watching an app must not change how it behaves. So `.value`
  is read through its own property descriptor and never through `get()`, which for a `computed` can
  mount sources that were unmounted.
- **A name you wrote beats a name we worked out.** Where your source names nothing we write `ref#1`
  and say so, rather than inventing a label you cannot look up.
- **Automatic discovery has a cost, and that cost is throttling.** Finding stores for you means you
  never chose which ones to watch, so a frame loop lands in the panel whether you wanted it or not.
  That is why `autoThrottle` is on by default.

## License

[MIT](./LICENSE.md)
