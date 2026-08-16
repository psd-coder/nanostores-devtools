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

The top level of the tree is the **home**. Under it, **a store sits beneath whatever built it, at
any depth**.

- **Home** is the file path for a store the plugin found, and the group name for a store you
  listed by hand. A file inside the Vite root keeps its short path, `app/model.ts`. A file outside
  it, such as a linked package or anything above that root, is measured from the
  [project root](#nanostoresdevtoolsoptions) instead of climbing out with `../`. Paths always use
  `/`, so macOS and Windows read the same. A file under `node_modules` is never instrumented, so it
  never has a home of its own.
- **Name** is the variable name or the object key, with `$` kept exactly as you wrote it.

Homes sort in three bands: groups first, then your own files, then the files that are somebody
else's. A home holding at least one store you listed by hand counts as a group. There is no wrapper
node over the external files: it would cost a click to reach anything inside and say nothing itself.

Inside a home everything sorts too, on **the name your source wrote**, so a type note, a number or
a group never moves a row. Two rows your source names the same then sort on their whole keys. The
order is by character code rather than by locale, so the tree reads the same everywhere and a
capital letter sorts before a small one: `Editor` sits above `byId`.

### The ownership tree

This is the shape our own acceptance fixture draws, trimmed:

```
app/editor.ts
  Editor: { $opened [store]: 0 }                           <- a static field, keyed by the class
  byId: Map { ["scratch"]: Editor {…} }                    <- a Map, walked by key
  drafts: Array { [0]: Editor {…}, [1]: Editor {…} }       <- an array, walked by index
  editorOne: Editor { $count [store]: 0, $value [store]: "" }   <- named by its binding
  hidden: WeakMap { ref#1: Editor {…}, ref#2: Viewer {…} } <- nothing here can be named
app/model.ts
  $busy [computed]: false
  $draft [store]: { (value): "the quick brown fox jumps ", $canRedo [computed],
                    $canUndo [computed], $history [computed], $position [computed],
                    $timeline [store] }
  $entries [computed]: ["", "the ", …]                     <- your own name for a nested store
  counter [store]: { (value): 0, $doubled [computed] }     <- a store with no $ that owns others
app/workspace.ts
  panel: { open [store]: false, width [store]: 320 }       <- what a factory returned
```

#### `(value)`: a store that owns others

A store that owns nothing is drawn as v1 drew it: its name, its value. **A store that owns others
keeps its own value under `(value)`**, so its children can sit beside it. Only a store that owns
something is wrapped, so a value you can read today stays readable.

#### What becomes a node

A **node** holds others and has no value of its own. Four things become one:

| what it is                   | its key                                | its type label         |
| ---------------------------- | -------------------------------------- | ---------------------- |
| a class instance             | the binding that holds it, `editorOne` | the class, `Editor`    |
| an object a factory returned | the binding that holds it, `panel`     | none, when it is plain |
| an array, `Map` or `Set`     | the binding, then one child per member | `Array`, `Map`, …      |
| a class's static fields      | the class name, `Editor`               | none                   |

A member that is itself an object is keyed by a name you could write to reach it: `[0]` for an array
or a `Set`, and `["scratch"]` for a `Map`. A node may sit inside a node, which is how an array's
members nest under the array. **A member that is a store keeps its own name instead**, the one the
registry gave it, because a store is drawn as a store wherever it sits.

The **type label** is not part of the key. It rides in the extension's own `__serializedType__`
wrapper, and the panel prints it in front of the node, so it costs no key and no nesting level. A
plain object carries none, because `Object` says nothing the node does not already say. A store
carries none either: that place already holds its `not mounted` marker, and its own kind is written
on its key instead. That is what tells a plain-object node from a store holding a plain object:

```
panel: { width: 320 }            <- a node
$panel [store]: { width: 320 }   <- a store holding an object
```

An instance nothing could name is keyed `ref#1`. The name is ours, so it says so rather than
borrowing the class name the label already holds. Every unnamed instance shares the base `ref`, and
they number across the file rather than per class.

#### How a store finds its owner

Three mechanisms, and each covers what the others miss.

- **The binding scan.** The plugin appends one call at the end of each module body listing that
  module's top-level `const`, `let` and `var` names, and we walk what each one holds. This is what
  reaches a factory result, a class instance in a binding, `Object.assign($atom, {…})` members, a
  collection's members, and an alias such as `export const $canUndo = $draft.$canUndo`, which is
  the one case nothing else reaches.
- **`this` in a class field.** A field initializer runs with `this` bound to the new instance, so
  the plugin hands it over. Static fields included, and this is the only way a private field
  `#hidden = atom()` is reachable at all.
- **The creation frame.** A frame is opened around a top-level initializer that is a call or a
  `new`, and closed on the value it returned. A plain store creator needs none, and neither does an
  initializer holding an `await`, which a frame must never span. It is the only thing that reaches a
  store a library kept in a closure, such as the `$timeline` inside `pipe(atom(""), withUndo())`.

**All three run on your own files only.** A library binds its working state to its own top-level
names too, and a `$active` that a ref count inside `history.ts` writes is that library's business,
not a thing you can act on. What you got out of that library is bound in a file of yours, and that
binding is what draws it.

**A store none of the three places is drawn nowhere at all.** One made inside a function and kept
there is that function's own working state: what the function returned is what your app holds, and
the tree draws that already. A store made at module level always keeps a place, because it has no
function it could belong to and the file it was written in is its only holding. That last rule is
what keeps a library's own `export const $route = atom("/")` on the tree, under its own file, even
though nothing in your code placed it.

Nothing else changes for a store the tree leaves out. It stays in the registry, we still watch it,
and a write to it still opens a timeline entry, because that write is often what makes a value you
can see change. Only the lifecycle rows go: a row saying a store joined or mounted is there to
explain a tree that changed shape, and this one changes no shape.

The scan and a class field both know a property name, so either may correct a frame, which only
knows that a store was born while some expression ran. Neither corrects the other. A store is never
drawn under itself: an owner already above it in the chain is refused.

#### Two placements

**A store you bound to a top-level name in one of your own files keeps that name, drawn flat. Its
owner keeps a second placement of the same store, under the name the owner knows it by.**

For `export const $entries = $draft.$history`:

```
$entries [computed]: ["a", "b"]                                    <- the name you wrote
$draft [store]: { (value): "b", $history [computed]: ["a", "b"] }  <- as $draft knows it
```

One entry, one identity, two keys. With only the first, `$draft` reads as incomplete. With only the
second, the name you chose is lost: `export const $undoable = $draft2.$canUndo` would be drawn under
`$draft2` as `$canUndo`, and `$undoable` would appear nowhere at all. The value is sent twice,
because the extension's encoder writes a repeat again rather than as a pointer. On the tree we
measured that cost about 11% more bytes.

The flat placement owns the name for every other purpose, timeline rows included, so a store
renamed by your own binding has its rows renamed too: `$undoable/set`, not `$canUndo/set`.

**A store you passed to `trackStores` is drawn the same way**, at the group you named, with the
owner keeping the second placement. The group is a home you chose by hand, so it beats any owner
the walk found.

Two bindings holding one store: the exported one wins, whichever is scanned first. Two of the same
kind pick one arbitrarily. **A binding inside somebody else's file places nothing**, neither a name
nor a node, because that is no name you chose.

#### Numbers under an owner

A nested store drops the number its creation site gave it, because the parent already says which
one this is: `$draft` and `$draft2` read the same way inside, even though the registry knows the
second set as the second store of its site.

Where the number is all that tells two children apart, both sides take one back:
`$timeline [store]` next to `$timeline [store] #2`. Where a node holds stores from two different
files that share a name, both name the file instead:
`$history [computed] (vendor/withUndo.ts)`.

### The kind of store, after the name

**Every store carries its kind in square brackets**: `$total [computed]`, `$cart [map]`,
`$settings [deepMap]`, `$slow [batched]`, `$count [store]`.

**An `atom` and a store of an unknown kind both read `store`.** A kind is read from the creator
call at build time, so a store listed by hand in a project without the plugin, and a store made by
a third-party factory such as `createRouter`, have no kind to print. Nothing at runtime can tell a
`map` from a `deepMap`, or a `computed` from a `batched`, so a guess is all we could add.

The two are one word on purpose. `[atom]` would say we read your creation site and `[store]` that
we did not, which is a fact about how much of your source we reached and not about the store. Both
are writable and both hold whatever was last set, so there is nothing you would do differently.

The brackets are part of the tree key only. Timeline rows keep the bare name (`$total/set`), and
sorting is on the bare name too, so the kind never moves a store in the tree. A store that gains a
kind later, which adoption can do, changes its key, and the panel draws that as one key removed
and one added. Gaining `atom` changes nothing, because `store` was already the word.

### One order for a key

**A tree key always reads the same way**: the name, the kind in square brackets, then at most one
group in parentheses saying where the store was made, then the number saying which store of that
place it is.

```
$count [store]                                        nothing to tell apart
$counter [store] (line 20)                            two source lines in one file
$counter [store] (app.ts, line 20)                    two files under one home
$history [store] (vendor/withUndo.ts, createPanel, line 20)
$history [store] (vendor/withUndo.ts)                 a home clash with no place to give
panel [store] #2                                      a clash nothing else told apart
```

Inside the group the file comes first, because it says where to look before the line says where in
the file. There is never a second group: where a home clash has a place to show as well, the home
takes the group and the place steps aside.

A node's number sits tight against its name, `ref#1`, and a store's stays spaced, `panel [store] #2`,
so the two never read as one thing.

### A store listed by hand leaves the file tree

This surprises people, so it is worth saying plainly. **With the plugin on, a store you also pass
to `trackStores` leaves the file tree and appears under its group instead.** Writing a store into
`trackStores` is a deliberate act and the group was chosen by hand, so the hand-written name wins.
The type still comes from the plugin, because an explicit call has no type to give. A store that
something else owns leaves that owner a second placement, as [two placements](#two-placements)
describes.

**To keep the store where the plugin put it, name the group after the file:**

```ts
// src/stores/cart.ts
trackStores("src/stores/cart.ts", { $items });
```

The tree is keyed by the home string, so this lands on the very node the plugin uses for that
file, and the store gains a hand-written name. A store that nothing owns stays exactly where it
was. One that something owns rises to the top level of that file, and its owner keeps the second
placement. **This is the recommended pattern for a project that uses the plugin and `trackStores`
together.**

### The same name twice

The plugin and `trackStores` behave differently here, and the difference is real.

**The plugin** tells two cases apart. One source line running again (a factory, a loop) makes
interchangeable stores, so they are numbered: `$items [store]`, `$items [store] #2`. Two different
source lines wanting one name is a real clash: both keys name the enclosing function and the line,
such as `$counter [store] (makeCart, line 12)`, and we warn once with both places.

**`trackStores` replaces, quietly.** A second registration for `cart/$counter` drops whatever held
that label before, with no warning. A clash here is almost always a hot reload, and we cannot tell
the two apart: both look like "this label again, with a different store object". A warning on
every edit would teach you to ignore our warnings. The label still shows in the tree, so nothing
disappears silently.

Two cases do warn, because neither can be a hot reload:

- The same store under two names in one call (`{ $counter, $total: $counter }`) is one store and
  one entry. The first name wins.
- The same store in two groups moves to the second group.

## What each row in the timeline means

Every row is named after the store it is about and the kind of change. The name is built by us:
nanostores has no actions, so there is nothing else to name a row after.

| the row                              | what happened                                         |
| ------------------------------------ | ----------------------------------------------------- |
| `$counter/set`                       | an `atom` was written                                 |
| `$user/setKey:name`                  | a `map` key was written                               |
| `$settings/setKey:theme.color`       | a `deepMap` path was written                          |
| `$total/computed`                    | a `computed` recomputed with no write of yours open   |
| `$counter/mount`, `$counter/unmount` | the store gained its first listener, or lost its last |
| `$late/register`                     | stores joined the tree                                |
| `$late/unregister`                   | stores left it                                        |
| `$count/hotReload`                   | a file ran again and its stores were rebuilt          |

A row carries one write plus every recompute that write caused, which is why a `computed` usually
has no row of its own. Mount, unmount, register, unregister and hot reload are the lifecycle rows,
and [`lifecycleEvents`](#connectdevtoolsoptions) turns all five off together.

### When stores join and leave

**A register row never means startup.** Everything registered before the first snapshot is already
inside it, so a register row is always a late arrival:

- a code-split chunk loaded, and a file of yours ran for the first time;
- a factory or a loop made another store, `$items [store] #2`;
- a `$`-named binding adopted a store some other code built;
- `trackStores` ran after `connectDevtools`, which is the usual shape for a dependency's stores.

An unregister row is the opposite: stores left the tree for good. `untrack("cart")` does it, and so
does an edit that deletes the last store in a file. A store dropped by the
[per-site cap](#nanostoresdevtoolsoptions) says nothing, because the store that pushed it out draws
a row anyway.

Renaming changes no rows. A store that gains a name from your binding, a kind from adoption or a
group from `trackStores` keeps its entry, so it neither joins nor leaves.

### A hot reload draws one row, not a pair

A file that both loses stores and gains stores while it runs again was hot reloaded. The two halves
become one row, `src/stores/cart.ts/hotReload`, or `$count/hotReload` when only one store moved.

Inside the row each store carries its own word: `hotReload` for a store that came back, `register`
for one your edit added, `unregister` for one it dropped. So the row tells you what the edit did,
and a pair of registry rows never has to be recognised as your own save.

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

| option            | default        | what it does                                                    |
| ----------------- | -------------- | --------------------------------------------------------------- |
| `name`            | `"nanostores"` | the entry in the extension's dropdown                           |
| `serializers`     | `[]`           | your own rules for converting values, checked before ours       |
| `trace`           | `true`         | capture a stack at each direct write                            |
| `traceLimit`      | `10`           | how many stack frames to capture                                |
| `maxAge`          | `500`          | how many rows the extension keeps                               |
| `lifecycleEvents` | `true`         | draw the [lifecycle rows](#what-each-row-in-the-timeline-means) |

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
run in array order, first match wins, ahead of every rule of ours.

**What `convert` returns may hold its own input.** The encoder walks that result too, and none of
your serializers runs again on a value inside it, so a `convert` returning `{ point: value }` draws
your wrapper with the `Point` inside it drawn by our rules, and the walk ends. Your rule already ran
over the whole tree it built, which is also what it costs: a result that a later serializer's
`match` would match does not reach that serializer either.

**Put the values of a result in plain properties, not behind getters.** We read a result through
property descriptors and never call a getter, so a value behind one is a value we cannot keep out
of your serializers. A getter handing back the input converts it over and over; that one slot then
shows `ConversionError` and the rest of the tree still reaches the panel.

**A `Map` and a `Set` go out as a list the encoder builds, and your rules never see that list.** A
`Map` becomes a list of `[key, value]` pairs and a `Set` a list of its members. Neither the list nor
a pair inside it reaches your serializers, so a rule as wide as `match: Array.isArray` leaves a
collection as it is. The keys, the values and the members inside one are your app's, and every rule
you wrote still runs on them.

### `nanostoresDevtools(options?)`

First, what a **creation site** is, because the cap below only makes sense once this word does.
**A site is one place in your source where a store is made, not one store.** A site inside a
factory or a loop makes a new store every time it runs, and all of them share one name. The
registry holds strong references on purpose, so nothing leaves it on its own.

| option             | default                   | what it does                                       |
| ------------------ | ------------------------- | -------------------------------------------------- |
| `fileKey`          | the home unchanged        | rewrites the path shown as a store's home          |
| `adoptFactories`   | `true`                    | wrap `$`-named calls the plugin does not recognise |
| `maxStoresPerSite` | `50`                      | live stores one creation site may hold, 1 or more  |
| `projectRoot`      | Vite's own workspace root | what a file outside the Vite root is measured from |

`maxStoresPerSite` keeps the last 50 live stores of a site. It evicts unmounted stores first,
oldest of those first, and never the store just made. So **a table with 200 rows, one store per
row, all from one factory line, shows 50 of them.** The number 50 is a guess; only the eviction
order is settled. Stores registered through `trackStores` have no site and no cap, because you
wrote each one by hand.

**It takes a whole number of 1 or more, or `Infinity` for no cap.** Anything else is refused with
a warning naming the option and your value, and the plugin holds 50 per site instead: `0`, a
number below zero, a fraction and `NaN` each say something no count of stores can be made of.

**`fileKey` receives the home as the tree would show it**, so a file inside the Vite root arrives
relative to that root and a file outside it arrives relative to `projectRoot`. It only changes what
is displayed. A hot reload still clears a module by its real path, so two files sharing one display
key cannot delete each other's stores.

**Two files mapped to one home keep both stores.** When each of them holds a `$counter`, both keys
say which file they came from: `$counter [store] (a.ts)` next to `$counter [store] (b.ts)`. Where
the two files carry the same name, the key takes as much of the path as it takes to tell them
apart, `$counter [store] (a/store.ts)`. It comes from the file alone, so a hot reload and the other
load order both give the same two keys, and you are warned once for each name two files write.
Every other key stays exactly as it is: a name only one of the files writes needs nothing added.

We do not cut the shared start of your file paths for you, because that shared part changes as
routes load. Cutting it would rename every key in the tree at once, and the extension reads that
as every key deleted and added again. Write a fixed rule instead, such as
`fileKey: (path) => path.replace(/^src\/stores\//, "")`. A fixed rule gives the same key on every
page load.

**`projectRoot` defaults to Vite's own `searchForWorkspaceRoot`**, which climbs until it meets a
lockfile or a workspace file. That is right for a real app: a linked package then reads as
`packages/…`. Pin it when that default sits so high above your app that every external home gets
long. It changes no path inside the Vite root. A file the project root cannot reach either keeps its
full path, which still opens in an editor.

**Every source file is parsed, and there is no option to stop it.** Parsing costs about 0.02 ms per
file, paid once per file per dev server run, because Vite caches the transform. That buys the file
whose own text says nothing about stores, such as `export const panel = createPanel()` in a file
that imports no nanostores: nothing else says the factory result holds those stores, and a store
nothing places is drawn nowhere, so skipping that file would lose it rather than move it.

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

The marker prints in front of the value. A plain object and an array are drawn as they are;
everything else sits under `(value)`, the same key a store that owns others keeps its own value
under, because the panel loses the marker text otherwise.

```
$cart [computed]:  not mounted, may be stale { total: 12 }
$count [computed]: not mounted, may be stale { (value): 12 }
$empty [computed]: not mounted, never computed {}
```

An unmounted `atom`, `map` or `deepMap` is **not** marked. `set` writes the value with no check on
the listener count, so an unmounted one holds a perfectly correct value and there is no
consequence to state.

**The word on the key does not tell you which rule a row follows.** Two rows can both read
`[store]` and behave differently: an `atom` we know about is drawn bare while unmounted, and a
store of an unknown kind carries `not mounted, may be stale`. The marker is what says which one
you have.

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

- **A value that refers back to itself is written as a `$.path` pointer.** The extension's own
  encoder does this to make a loop safe to write. A plain repeat is not: the same object in two
  places is written out twice, because the option that would collapse it is off in the extension's
  defaults. This is the price of letting a `Date`, a `Map` and a `Set` render as themselves in the
  panel.
- **A getter is never read**, with one exception, because a getter can run app code. An object whose
  data lives entirely on its prototype, such as a `URL`, shows its `String()` form or nothing. The
  exception is the `stack` accessor V8 puts on an error itself: refusing it would drop the stack from
  every error, and a devtools with no stack traces is worth less than the risk. Reading it can run
  `Error.prepareStackTrace` if the app installed one, and it makes V8 read `name` and `message` off
  the error.
- **A method is left out.** An object's own property holding a function does not reach the panel:
  `{ id, $checked, toggle, add }` arrives as `{ id, $checked }`. The panel draws state, and a
  method beside the stores it writes says nothing your source does not. A value that is itself a
  function still arrives, with its body stripped, and so does a function at an array index, because
  there the position is part of the shape.
- **`-0` arrives as `0`.**
- **A custom serializer has no reviver.** The bridge encodes only, and v1 never reads state back.
- **A labelled value inside a `Map` or a `Set` keeps its wrapper**, so you read
  `{ data, __serializedType__ }` there instead of a label in front of the value. The extension's
  own encoder writes those two containers as one string and reads them back without its reviver, so
  nothing inside them is ever unwrapped. It hits every labelled value: an `Error`, a class
  instance, a typed array, a `BigInt`, a DOM node, a store, and a slot that failed to convert.

An `Error` keeps its name, message, stack, cause and own fields. A class instance keeps its class
name. A typed array, a `BigInt` and a DOM node each keep something readable. A value that throws
while being converted puts `ConversionError` in that one slot and everything else still goes.

**A store held inside another store's value is drawn as a store**, wherever it sits: in an array, in
a plain object, in a `Map`, in a `Set`, in a class instance field, or on an error. You never see the
nanostores keys behind it, and `.value` is the whole read, as it is everywhere else, so watching a
store still never mounts it.

**Where the store sits at a name your source wrote, the kind goes in the key** and the value goes in
bare beneath it, exactly as the tree spells a store's own slot:

```
$root [store]
  id: "node-1"
  label: "root"
  $children [store]:      [ … ]
  $checked [computed]:    false
  $indeterminate [computed]: false
```

That covers a property of a plain object, a class instance field and an error's own field. It costs
no wrapper and no `(value)` box, so a plain `false` reads as `false` instead of a node you have to
open.

**An array holding at least one store is keyed too**, `[0]`, `[1]`, the same way the tree spells a
collection member. It goes out as an object rather than a list, labelled `Array` so a collapsed node
still says what it was:

```
$rows [store]   Array
  [0] [store]:  { id: 1, name: "city", value: "Berlin" }
  [1] [store]:  { id: 2, name: "street", value: "Unter den Linden" }
```

**An array of plain data stays a list.** Only an array that holds a store pays for the key, so
`$fields [store]: [ {…}, {…} ]` right beside it is untouched.

This is not a matter of taste. A kind carried in a wrapper is drawn in the panel's **item string**,
and the State tab sets `display: none` on that string while the node is expanded and leaves it out
of a collapsed parent's preview. On a member there is no moment you can read it. A key is always
drawn.

**A `Map` key and a `Set` position keep the wrapper**, as the bullet above says, so you read
`{ data, __serializedType__ }` there with the store's value under `data`. The encoder writes those
two containers itself and no key of ours reaches inside them.

The word is the kind the bridge knows: `map`, `deepMap`, `computed` or `batched`. An `atom`, and a
store whose kind the bridge never learned, both say the plain word `store`. An unmounted store keeps
its note beside the kind, `$total [computed]: not mounted, may be stale { … }`.

One shape is left over. **A store whose value can reach that store again keeps the wrapper**, with
the kind in front of the value and no kind in the key. That loop is what the extension's encoder
finds by the path it built, and it only finds it while the wrapper's own key stands in that path.

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

### A hot reload does not always draw one row

A reload draws [one row](#a-hot-reload-draws-one-row-not-a-pair) only when both halves happen in
the same run of the file. Two cases split them:

- **A file with a top-level `await` above its stores.** The old stores go the moment the file
  starts, the new ones arrive after the `await`, so you get an unregister row and a register row
  again.
- **A file whose stores are only made inside a factory.** The reload drops the old stores and
  registers none, so it draws a lone unregister row. The register row comes later, when the factory
  runs.

Both draw the truth, only in two rows instead of one.

### What the ownership tree cannot reach

Some of these we refuse, and the rest we cannot do. The difference matters: a refusal will not
change, and a gap might.

**Refused, by the read-only rule:**

- **A value behind a getter is never read.** A getter runs your code, and running it would change
  how the app behaves. A store held only behind a getter still reaches the tree; it just sits where
  it was made rather than under the object that holds it. An object whose data lives entirely on its
  prototype is the same case.
- **An array is read index by index through its own descriptors**, so a getter sitting at an index
  never runs and an index only its prototype holds is left out. If that fails, the array
  contributes nothing.
- **A `Map` and a `Set` are iterated through the built-in `forEach`**, never through a method of
  their own, so a subclass that overrides iteration cannot run its code while we scan. If that
  fails, the collection contributes nothing.

**Cannot be reached at all:**

- **A `WeakMap` or `WeakSet` member.** Unenumerable by design. An instance inside one still reaches
  the tree through the creation frame; only its key is lost, which is what `ref#1` says.
- **A `Promise`'s value**, which is reachable only through `then`.
- **A symbol-keyed property, an inherited property, and a non-enumerable own property.** We read own
  enumerable data properties only.
- **A `Map` key that is not a string or a number.** There is no name for it that exists in your
  source, so that member is left out.

**Bounded on purpose:**

- **25 members of one collection** become nodes. **The tree says what it left out**, as one extra
  key `…` labelled `5 more members past the 25 walked; their stores are listed here without a node
of their own`. No store is lost: the ones past the cap sit on the collection itself, keeping the
  numbers the registry gave them, such as `open #30`.
- **Three steps into a binding**, counting a property, an index and a key alike. This cut is silent.

**Undetectable:** a `Proxy` can trap a property read and run your code. We cannot see one, so this
is an accepted risk. It is the same risk the getter rule above is written against, and it matters
more here than in v1, because the ownership tree reads far more properties.

**A plain object node and a store that owns others both carry no label**, so they look alike. In
redux-devtools 3.2.10 a collapsed node previews what is inside it, so the `(value)` key usually
tells the two apart.

**A binding that names a store built in another file never gives that name up.** Once a top-level
binding of yours claims a store, we remember the claim for the life of the page. Delete
`export const $undoable = $draft2.$canUndo` and save: the store was built elsewhere, so the hot
reload does not replace it, and it keeps both the name and the home the deleted binding gave it
until you reload the page in full. A store the same file created is unaffected: the reload builds a
new one, and no binding has claimed that one yet.

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
- **An edit that leaves a file with nothing at all to instrument leaves that file's old entries
  behind.** A file gets the header that clears its own stores when it imports a store creator by
  name, holds a `$`-named call to adopt, or declares a top-level `const`, `let` or `var` under a
  plain name. A file left with none of the three never runs that header, so its old entries stay in
  the tree until you reload the page.

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
direct write, follower, creation site, adoption, slot, node, owner, placement, type label, marker
and the rest.

## License

MIT
