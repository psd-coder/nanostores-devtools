# nanostores-devtools

Inspect [nanostores](https://github.com/nanostores/nanostores) state in the
[redux-devtools](https://github.com/reduxjs/redux-devtools) browser extension.

Every store on the page becomes a key in one state tree, and every change draws one named row in
the timeline. The bridge is read-only: it reads `.value`, attaches nanostores lifecycle hooks, and
runs no app code at all.

**This package ships no UI.** You install the redux-devtools extension in your browser yourself.
We never fork it, repackage it, or build our own panel. This package only speaks its protocol.

## Install

```bash
pnpm add -D nanostores-devtools
```

Then install the redux-devtools extension in your browser. With no extension on the page the
package does nothing, logs nothing, and attaches no hook.

## Setup

Two steps.

Add the Vite plugin:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { nanostoresDevtools } from "nanostores-devtools/vite";

export default defineConfig({
  plugins: [nanostoresDevtools()],
});
```

Call `connectDevtools()` in your entry file:

```ts
// src/main.ts
import { connectDevtools } from "nanostores-devtools";

connectDevtools({ name: "my-app" });
```

That is the whole setup. There is no `import.meta.env.DEV` guard and no dynamic import, because
[export conditions](#turning-it-off-in-a-production-build) resolve the package to a no-op module in
a production build. The plugin runs in the dev server only, so a production build also carries no
instrumentation.

`connectDevtools()` never throws and never needs `await`. Called twice it warns once and returns
the same handle, which is what makes a hot reload safe.

Open the Redux panel in your browser devtools and pick your app from the dropdown.

## Two ways a store gets in

### The Vite plugin

The plugin reads your source at dev-server time and makes every store register itself under its
own variable name. It finds a store in two ways:

- **By callee.** A call whose callee names something the file imported from `"nanostores"`,
  renamed imports included. This is the way that gives a store its type. It works at any depth:
  variable declarations, object properties, class fields, array elements, inside factories, loops
  and methods.
- **By adoption.** A call bound to a `$`-prefixed name, whatever the call is. This catches a
  codebase that wraps store creation, such as `const $theme = persistentAtom("theme", "dark")` in
  a file that never imports `"nanostores"`. Adoption carries a name, never a type.

A codebase that does not use the `$` prefix still gets normal discovery. It only loses the factory
and the dependency cases. You can turn adoption off with `adoptFactories: false`.

### `trackStores`

Stores the plugin cannot reach go in by hand. A dependency's stores are the usual case, and so is
a build with no plugin.

```ts
// src/stores/cart.ts
import { atom, computed } from "nanostores";
import { trackStores } from "nanostores-devtools";

export const $items = atom<string[]>([]);
export const $count = computed($items, (items) => items.length);

trackStores("cart", { $items, $count });
```

`untrack("cart")` removes the group again.

## Where a store sits in the tree

The tree is two levels deep: **home**, then **name**.

- **Home** is the file path for a store the plugin found, and the group name for a store you
  listed by hand. File paths are relative to the project root and always use `/`, so macOS and
  Windows read the same.
- **Name** is the variable name or the object key, with `$` kept exactly as you wrote it.

Groups sort first, then files. Both are alphabetical, and stores inside a home are alphabetical
too. A home holding at least one store you listed by hand counts as a group.

### A store listed by hand leaves the file tree

This surprises people, so it is worth saying plainly. **With the plugin on, a store you also pass
to `trackStores` leaves the file tree and appears under its group instead.** Writing a store into
`trackStores` is a deliberate act and the group was chosen by hand, so the hand-written name wins.
The type still comes from the plugin, because an explicit call has no type to give.

**To keep the store where the plugin put it, name the group after the file:**

```ts
// src/stores/cart.ts
trackStores("src/stores/cart.ts", { $items });
```

The tree is keyed by the home string, so this lands on the very node the plugin uses for that
file. Nothing moves, and the store simply gains a hand-written name. **This is the recommended
pattern for a project that uses the plugin and `trackStores` together.**

### The same name twice

The plugin and `trackStores` behave differently here, and the difference is real.

**The plugin** tells two cases apart. One source line running again (a factory, a loop) makes
interchangeable stores, so they are numbered: `$items`, `$items #2`. Two different source lines
wanting one name is a real clash: both entries take a suffix naming the enclosing function and the
line, such as `$counter (makeCart, line 12)`, and we warn once with both places.

**`trackStores` replaces, quietly.** A second registration for `cart/$counter` drops whatever held
that label before, with no warning. A clash here is almost always a hot reload, and we cannot tell
the two apart: both look like "this label again, with a different store object". A warning on
every edit would teach you to ignore our warnings. The label still shows in the tree, so nothing
disappears silently.

Two cases do warn, because neither can be a hot reload:

- The same store under two names in one call (`{ $counter, $total: $counter }`) is one store and
  one entry. The first name wins.
- The same store in two groups moves to the second group.

## Turning it off in a production build

The main entry, `nanostores-devtools`, ships a `production` export condition. Under it the package
resolves to a module that exports the same three names with the same types and does nothing.
Everything else gets the real module.

The two Vite subpaths need no such condition. The plugin runs in the dev server only, and the
runtime is reached only through code the plugin injects, which a production build never sees.

| bundler         | behaviour                                                                    |
| --------------- | ---------------------------------------------------------------------------- |
| Vite            | automatic. `resolve.conditions` carries `development\|production` by default |
| webpack, Rspack | automatic. `conditionNames` follows `mode`                                   |
| esbuild         | needs `--conditions=production`                                              |
| Rollup          | needs `exportConditions: ["production"]` on the node-resolve plugin          |
| plain Node      | gets the real module. Importing it in Node is safe and does nothing          |

**The explicit pattern stays supported** for anyone who wants control instead of automation, and it
is the answer for a bundler in the bottom half of that table:

```ts
if (import.meta.env.DEV) {
  const { connectDevtools } = await import("nanostores-devtools");

  connectDevtools();
}
```

To keep the bridge in a production build, leave `production` out of the condition list your bundler
uses. In Vite that is `resolve: { conditions: ["development"] }`. There is no `development` key in
our exports map, so nothing matches it and the resolver falls back to the real module.

**`trackStores` calls are a separate case and they stay.** They sit in your store files, where
neither the condition nor a guard reaches them. Under the production condition they resolve to the
no-op, so each one costs a single function call.

## Options

### `connectDevtools(options?)`

| option            | default        | what it does                                              |
| ----------------- | -------------- | --------------------------------------------------------- |
| `name`            | `"nanostores"` | the entry in the extension's dropdown                     |
| `serializers`     | `[]`           | your own rules for converting values, checked before ours |
| `trace`           | `true`         | capture a stack at each direct write                      |
| `traceLimit`      | `10`           | how many stack frames to capture                          |
| `maxAge`          | `500`          | how many rows the extension keeps                         |
| `lifecycleEvents` | `true`         | draw rows for register, unregister, mount and unmount     |

`name` is fixed at the first connect and cannot change later, because the panel builds its record
for a connection once. It defaults to a fixed word rather than `document.title`, which changes per
page and per route.

**`maxAge` defaults to 500, not the extension's own 50.** Every row holds a full copy of the state
tree, and 50 rows is far too short for a debugging session. 500 rows with 1000 stores measured at
about 50 MB, and the cost is linear, which is why the option exists.

**`traceLimit` defaults to 10 and should not be lowered without thought.** The stack is captured
inside our own hook, so the first frames belong to us and to nanostores. We cut our own five frames
at capture time. About four nanostores frames are still left, so a limit of 5 leaves you about one
frame of your own code. Measured cost per write: 0.01 microseconds with the option off, 7.1 at 10,
13.0 at 25. `Error.stackTraceLimit` and `Error.captureStackTrace` are V8 features, so this is a
Chrome cost control. Firefox gets a full stack with no limit at all.

**`lifecycleEvents: false` costs correctness, not only a quieter timeline.** Mount state lives in
the tree, and the extension only ever sees the tree when we send a row. Turn the option off and a
mount, an unmount or a late registration changes nothing in the panel until the next write, which
then carries that change in its diff. Turn it off when a route change mounting many stores at once
is too slow, and know what you are paying for it.

A custom serializer is `{ match: (value) => boolean, convert: (value) => unknown }`. Serializers
run in array order, first match wins, ahead of every rule of ours. Whatever `convert` returns is
handed straight on, never back through your serializers, so an endless loop cannot start.

### `nanostoresDevtools(options?)`

First, what a **creation site** is, because the cap below only makes sense once this word does.
**A site is one place in your source where a store is made, not one store.** A site inside a
factory or a loop makes a new store every time it runs, and all of them share one name. The
registry holds strong references on purpose, so nothing leaves it on its own.

| option             | default                        | what it does                                       |
| ------------------ | ------------------------------ | -------------------------------------------------- |
| `fileKey`          | the project-root-relative path | rewrites the path shown as a store's home          |
| `adoptFactories`   | `true`                         | wrap `$`-named calls the plugin does not recognise |
| `maxStoresPerSite` | `50`                           | how many live stores one creation site may hold    |

`maxStoresPerSite` keeps the last 50 live stores of a site. It evicts unmounted stores first,
oldest of those first, and never the store just made. So **a table with 200 rows, one store per
row, all from one factory line, shows 50 of them.** The number 50 is a guess; only the eviction
order is settled. Stores registered through `trackStores` have no site and no cap, because you
wrote each one by hand.

`fileKey` only changes what is displayed. A hot reload still clears a module by its real path, so
two files sharing one display key cannot delete each other's stores.

We do not cut the shared start of your file paths for you, because that shared part changes as
routes load. Cutting it would rename every key in the tree at once, and the extension reads that
as every key deleted and added again. Write a fixed rule instead, such as
`fileKey: (path) => path.replace(/^src\/stores\//, "")`. A fixed rule gives the same key on every
page load.

On **Vite 8** the plugin costs you nothing extra: Vite re-exports the parser it needs. On **Vite 6
and 7** it needs `oxc-parser` as a dev dependency, declared here as an optional peer.

## Subpaths

| subpath                            | runs in        | may depend on                                                         |
| ---------------------------------- | -------------- | --------------------------------------------------------------------- |
| `nanostores-devtools`              | browser        | `nanostores` (peer) only                                              |
| `nanostores-devtools/vite`         | Node, dev only | `magic-string` (dependency), `vite` and `oxc-parser` (optional peers) |
| `nanostores-devtools/vite/runtime` | browser        | nothing                                                               |

**`nanostores-devtools/vite/runtime` is internal.** The plugin injects an import of it into your
modules during development, so it appears in your module graph. Never import it yourself.

## What v1 does not do

Everything here is written down on purpose, so nothing you find later looks like a bug.

### No time travel

The jump, dispatch, skip, reorder and import buttons are turned off in the panel. Time travel was
built and measured first. Five things block it:

- The app writes over the values we restore.
- An unmounted `computed` stays stale, and nothing says so.
- A partial restore is silent. Code splitting makes a missing store normal, so nothing marks the
  point where two moments were mixed.
- Side effects do not go back. An open socket stays open, and a written `localStorage` key stays
  written.
- Half the value types cannot be rebuilt at all: a class instance, a function, a Symbol, a DOM
  node, an object made only of getters.

Pause and export stay on. Both use state the panel already holds.

### An unmounted `computed` shows an old value, or nothing

**The bridge never runs a computed's callback and never works a value out for itself.** An
unmounted `computed` or `batched` shows whatever its `.value` still holds, under one of two
markers:

- `not mounted, never computed` when it holds `undefined` and we never saw it mount.
- `not mounted, may be stale` for everything else.

A store whose type we never learned takes the second marker too, because it could be somebody's
computed store and we cannot prove otherwise.

An unmounted `atom`, `map` or `deepMap` is **not** marked. `set` writes the value with no check on
the listener count, so an unmounted one holds a perfectly correct value and there is no
consequence to state.

One gap: the hooks attach when you connect, not when a store registers, so a computed that
mounted and unmounted before you connected looks never-mounted to us. If it ran and returned
`undefined`, it takes `never computed` and that claim is then wrong.

Mount state itself is read as `lc === 0`. We do not wait out the 1000 ms cleanup window nanostores
keeps after the last listener leaves, because that would mean running our clock against theirs. So
a store that unmounts and remounts inside that window reads as unmounted for a moment, and with
lifecycle rows on it draws an unmount row and a mount row for a teardown that never happened.

**Nothing is ever hidden.** Every registered store is always a key in the tree, mounted or not.

### Values are never shortened

**Nothing is truncated, sampled or capped**, by default or behind an option. One store holding a
very large value is sent in full on every change of any store anywhere on the page, and **there is
no way around that in v1.** A way to leave a store out is the first thing a v2 would add.

Other things values do:

- **The same object appearing twice is written once, and after that as a `$.path` pointer.** The
  extension's own encoder does this to make a value that refers back to itself safe to write. It
  applies to every repeat, not only to a real loop. This is the price of letting a `Date`, a `Map`
  and a `Set` render as themselves in the panel.
- **A getter is never read**, because a getter can run app code. An object whose data lives
  entirely on its prototype, such as a `URL`, shows its `String()` form or nothing.
- **A function arrives with its body stripped.**
- **`-0` arrives as `0`.**
- **A custom serializer has no reviver.** The bridge encodes only, and v1 never reads state back.

An `Error` keeps its name, message, stack, cause and own fields. A class instance keeps its class
name. A typed array, a `BigInt` and a DOM node each keep something readable. A value that throws
while being converted puts `ConversionError` in that one slot and everything else still goes.

### A follower can name the wrong source

A row is one direct write plus the recomputes it caused. Each follower carries a `from` field
naming the store it followed. `from` is the previous change in the row, which is right for a chain
and wrong in three cases:

- **Inside `batch(fn)`**, where every direct write arrives first and every follower arrives at the
  end, so followers attach to the last write of the batch.
- **When one of your own listeners writes another store mid-cascade**, which closes the open row
  early, so a follower still queued behind it lands in the new row.
- **When two computed stores follow the same source**, where the second one names the first
  instead of the source they share.

A wrong `from` is never invented, only attached to the wrong store, and the change itself always
shows.

A **`batched` store always gets its own row.** Its recompute runs in a `setTimeout`, which happens
in a later task, long after the row that caused it closed. So it never joins that row and always
draws its own `$total/computed` row.

A store of unknown type is timed wrongly in the same way. The bridge treats it as a direct write.
So if it really is a computed, its recompute opens a row of its own instead of joining the row that
caused it. It also closes the open row while the cascade is still running.

### What the Vite plugin misses

- **Reassignment.** `let $late = atom("a"); $late = atom("b")` registers the first store only.
- **`import * as ns from "nanostores"`** gets no callee matching, and we warn once for that file.
  A `$`-named store it makes still reaches the tree through adoption, with `type: "unknown"`. A
  type-only import of `atom` behaves the same way.
- **`.vue` and `.svelte` files are untouched.** The plugin reads script files only.
- **A factory-made store bound to a name without `$` is not adopted.**
- **A store created inside an already instrumented store is not registered.** A store made inside
  a computed's callback is a temporary that the callback rebuilds on every run.
- **A store from a dependency shows `type: "unknown"`.** Vite pre-bundles dependencies before any
  plugin runs, so they cannot be instrumented. Adoption still puts them in the tree under your own
  name for them, but the type is lost and the marker stays conservative.
- **A factory defined in module A but called from module B piles up entries under A when B hot
  reloads**, because A did not run again and so did not clear itself. Measured: one unrelated edit
  took `$items` from 2 rows to 4. The per-site cap keeps the count bounded, and it drops the
  unmounted stores first. Adopted stores do not have this problem, because they move to the
  calling module.
- **An edit that leaves a file with nothing to find leaves that file's old entries behind.** The
  plugin runs a quick text test before it parses anything. A file with no store creator imported
  by name and no `$`-named binding left fails that test, so it never gets the header that clears
  its own stores. They stay in the tree until you reload the page.

### Cost

The ordinary case is fast enough. **500 stores at 60 writes a second cost 0.51 ms per write**, and
the panel keeps working. While no panel is open the bridge costs nothing per write at all: it
builds no tree and sends nothing.

Three cases stay slow, and we know about all three:

| case                                               | cost                                                | what you can do today    |
| -------------------------------------------------- | --------------------------------------------------- | ------------------------ |
| one store holding a 2000-row array                 | 102 ms per write, 12 MB, 10 writes a second at most | nothing                  |
| a route change mounting 100 stores, at 5000 stores | 539 ms freeze                                       | `lifecycleEvents: false` |
| 5000 stores at a high write rate                   | 3 ms per write                                      | nothing                  |

The first one is the worst. Half of those 102 ms is the extension writing out 12 MB. That half is
inside the extension, so no work on our side can make it smaller. Automatic discovery also means
you may never have chosen to track that store.

There is no cap on how many stores the tree holds. At 2000 entries we warn once, and the choice
what to do about it stays yours.

## Words this project uses in one fixed way

[glossary.md](./glossary.md) defines the terms above: bridge, registry, home, group, label, tree,
direct write, follower, creation site, adoption, slot, marker and the rest.

## License

MIT
