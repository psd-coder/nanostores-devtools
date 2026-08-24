# Reference

What `nanostores-devtools` draws, and why it draws it that way. The [README](../README.md) covers
install, setup, and every option's name and default. This document is the long half: how a store
gets its name, where it lands in the tree, what a timeline row means, what a value shows, and what
the package cannot do.

How the code itself is put together is in [ARCHITECTURE.md](./ARCHITECTURE.md). The words this
project uses in one fixed way are in [GLOSSARY.md](../GLOSSARY.md).

## Contents

- [Two ways a store gets in](#two-ways-a-store-gets-in)
  - [The bundler plugin](#the-bundler-plugin)
  - [`trackStores`](#trackstores)
- [Where a store sits in the tree](#where-a-store-sits-in-the-tree)
  - [The ownership tree](#the-ownership-tree)
  - [The kind of store, in square brackets](#the-kind-of-store-in-square-brackets)
  - [How a tree key is built](#how-a-tree-key-is-built)
  - [A store listed by hand leaves the file tree](#a-store-listed-by-hand-leaves-the-file-tree)
  - [The same name twice](#the-same-name-twice)
- [What each row in the timeline means](#what-each-row-in-the-timeline-means)
  - [When stores join and leave](#when-stores-join-and-leave)
  - [A hot reload draws one row, not a pair](#a-hot-reload-draws-one-row-not-a-pair)
- [What each `connectDevtools` option costs](#what-each-connectdevtools-option-costs)
- [What each plugin option costs](#what-each-plugin-option-costs)
- [What v1 does not do](#what-v1-does-not-do)
  - [No time travel](#no-time-travel)
  - [An unmounted `computed` shows an old value, or nothing](#an-unmounted-computed-shows-an-old-value-or-nothing)
  - [Values are shortened only under a class instance](#values-are-shortened-only-under-a-class-instance)
  - [What an object's own fields show](#what-an-objects-own-fields-show)
  - [What a platform object shows](#what-a-platform-object-shows)
  - [A follower can name the wrong source](#a-follower-can-name-the-wrong-source)
  - [A hot reload does not always draw one row](#a-hot-reload-does-not-always-draw-one-row)
  - [What the ownership tree cannot reach](#what-the-ownership-tree-cannot-reach)
  - [What the plugin misses](#what-the-plugin-misses)
  - [Cost](#cost)

## Two ways a store gets in

### The bundler plugin

The plugin reads your source while your dev build runs, and makes every store register itself under
its own variable name. It is the same plugin under Vite, webpack and Rspack, and it finds a store
in two ways:

- **By callee.** The plugin sees a call whose function came from an import of `"nanostores"`,
  including renamed imports. This is the way that gives a store its kind. It sees the call wherever
  it is written, a factory, a loop or a class field included, and the store is drawn where your own
  code holds it.
- **By adoption.** The plugin also adopts a call your module body holds under a name, no matter
  which function made the call. This catches a codebase that wraps store creation, such as
  `const theme = persistentAtom("theme", "dark")` in a file that never imports `"nanostores"`.
  Adoption gives the store a name, and a kind only when the call names an export that the
  [package map](#what-each-plugin-option-costs) knows. A call whose function your file imported is
  wrapped even where no name holds it, and that wrapper only records the kind, so the panel can
  still read it if the store lands somewhere you do hold.

**A store is named where your own code holds it, and nowhere else.** A call handed straight to
another call is nobody's, and so is one written inside a function, a loop body or a block:

```js
const $pointerEnd = merged([eventAtom(root, "up"), eventAtom(root, "cancel")]);
```

`$pointerEnd` is the store `merged` returned, and it is drawn. The two `eventAtom` calls are handed
away, so nothing in your source can point at either one and neither is drawn. What they leave behind
is their kind, which the panel reads back if one of them ends up somewhere you do hold.

An array a binding holds is different, because an index on it is something you can type:

```js
const $totals = [atom(0), atom(1)]; // $totals[0], $totals[1]
```

The same for a property of an object a binding holds: `const config = { $x: atom(0) }` names `$x`,
while `foo({ $x: atom(0) })` hands the whole object away and names nothing.

A codebase that does not use the `$` prefix gets all of this too. Adoption reads the name that a
call stands under, and the prefix is no part of that name.

**`adoptFactories` has two settings**, and the wide rule above is the default:

| setting             | what adoption reaches                                     |
| ------------------- | --------------------------------------------------------- |
| `true`, the default | a call the module body holds under a name                 |
| `false`             | nothing: only the calls the plugin recognises are wrapped |

**A setting we cannot read is refused.** We warn, naming the option, your value and the two settings
above, and the plugin adopts the default way instead. Only a plain JavaScript config can pass a
wrong value in; TypeScript refuses it where you wrote it.

### `trackStores`

Stores the plugin cannot reach go in by hand. The usual case is a dependency's stores, and so is a
build with no plugin.

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

The top level of the tree is the **home**. Under it, **a store sits below whatever built it, at any
depth**.

- **Home** is the file path for a store the plugin found, and the group name for a store you listed
  by hand. A file inside your bundler's root, Vite's `root` or webpack's `context`, keeps its short
  path, `app/model.ts`. A file outside that root, such as a linked package or anything above it, is
  measured from the [project root](../README.md#nanostoresdevtoolsoptions) instead of climbing out
  with `../`. Paths always use `/`, so macOS and Windows read the same. A file under `node_modules`
  is never instrumented, so it never has a home of its own.
- **Name** is the variable name or the object key, with `$` kept exactly as you wrote it.

Homes are sorted in three groups: groups you named first, then your own files, then files that
belong to somebody else. A home that holds at least one store you listed by hand counts as a group.
There is no wrapper node over the external files: it would cost a click to reach anything inside
and would say nothing itself.

Inside a home everything is sorted too, on **the name your source wrote**, so a kind label, a
number or a group never moves a row. Two rows that your source names the same are then sorted on
their whole keys. We sort by character code rather than by locale, so the tree reads the same
everywhere, and a capital letter comes before a small one: `Editor` sits above `byId`.

### The ownership tree

This is the shape our own acceptance fixture draws, shortened:

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
                    $canUndo [computed], $history [computed], $position [computed] }
  $entries [computed]: ["", "the ", …]                     <- your own name for a nested store
  counter [store]: { (value): 0, $doubled [computed] }     <- a store with no $ that owns others
app/workspace.ts
  panel: { open [store]: false, width [store]: 320 }       <- what a factory returned
```

#### `(value)`: where a store's own value goes

A store that owns nothing and carries no marker is drawn as v1 drew it: its name, then its value.
**`(value)` is where that value goes when it cannot stay at the store's own key**, and two
different things send it there.

**The store owns other stores.** Its own value moves under `(value)` so that its children can sit
next to it. Only a store that owns something is wrapped, so a value you can read today stays
readable.

**The store carries a marker**, and the marker has nowhere else to ride. See
[an unmounted `computed` shows an old value, or nothing](#an-unmounted-computed-shows-an-old-value-or-nothing)
for that half.

Two more keys are written with the same parentheses and mean something else: `(valueOf)` and
`(toString)` name **which method answered** on a class instance that said how it reads itself. See
[what a platform object shows](#what-a-platform-object-shows).

#### What becomes a node

A **node** holds other things and has no value of its own. Four things become one:

| what it is                   | its key                                | its type label         |
| ---------------------------- | -------------------------------------- | ---------------------- |
| a class instance             | the binding that holds it, `editorOne` | the class, `Editor`    |
| an object a factory returned | the binding that holds it, `panel`     | none, when it is plain |
| an array, `Map` or `Set`     | the binding, then one child per member | `Array`, `Map`, …      |
| a class's static fields      | the class name, `Editor`               | none                   |

A member that is itself an object is keyed by a name you could write to reach it: `[0]` for an
array or a `Set`, and `["scratch"]` for a `Map`. A node may sit inside a node, which is how the
members of an array nest under the array. **A member that is a store is keyed by its position too**,
`[0] [store]`, and it keeps its own flat slot at its home as well. Only a store that a frame or a
class field placed, where no property leads to it, falls back to the name its creation site gave.

The **type label** is not part of the key. It travels in the extension's own `__serializedType__`
wrapper, and the panel prints it in front of the node, so it costs no key and no nesting level. A
plain object carries no label, because `Object` says nothing that the node does not already say. A
store carries none either: that place already holds its `not mounted` marker, and its own kind is
written on its key instead. That is what tells a plain-object node from a store holding a plain
object:

```
panel: { width: 320 }            <- a node
$panel [store]: { width: 320 }   <- a store holding an object
```

An instance that nothing could name is keyed `ref#1`. The name is ours, so it says so rather than
borrowing the class name that the label already holds. Every unnamed instance shares the base
`ref`, and they are numbered across the file rather than per class.

#### How a store finds its owner

There are three mechanisms, and each one covers what the others miss.

- **The binding scan.** The plugin adds one call at the end of each module body that lists the
  module's top-level `const`, `let` and `var` names, and we walk what each name holds. This is what
  reaches a factory result, a class instance in a binding, members added by
  `Object.assign($atom, {…})`, the members of a collection, and an alias such as
  `export const $canUndo = $draft.$canUndo`, which nothing else reaches.
- **`this` in a class field.** A field initializer runs with `this` bound to the new instance, so
  the plugin hands it over. Static fields are included, and this is the only way a private field
  such as `#hidden = atom()` is reachable at all.
- **The creation frame.** We open a frame around a top-level initializer that is a call or a `new`,
  and we close it on the value it returned. A plain store creator needs no frame, and neither does
  an initializer that holds an `await`, which a frame must never span. The frame is the only thing
  that reaches a store one of your own helpers kept in a closure, where no property leads to it.

**A frame places nothing that was born in somebody else's file.** It catches every store made while
your expression ran, however many files down. A store that is still homed in a library is one that
the library kept rather than handed over: `$inputs` inside `resourceAtom`, `$timeline` inside
`withUndo`. What a library does hand you is adopted at your call site and takes your file as its
home, and the scan reaches whatever the returned value carries through a property. So `$value` and
`$loading` on a resource stay exactly where they were. The frame keeps its full reach inside your
own files, where a store in a closure is yours whether or not a property leads to it.

**A frame places nothing that already stands at a site of its own.** A store made at module level
is drawn flat at the file it was written in, because there is no function it could belong to. All
the frame knows is that the store was born while some expression ran, and that says when, not what
holds it:

```js
const $pointerEnd = merged([eventAtom(root, "pointerup"), eventAtom(root, "pointercancel")]);
```

`merged` keeps its sources in a closure, so nothing on the atom it hands back leads to them.
Drawing them inside it would say that this atom holds them. They are its siblings, and the tree
draws all three flat. What is left for the frame is the case it exists for: a store your own code
made **inside a function**, which nothing else would draw at all.

**All three run on your own files only.** A library binds its working state to its own top-level
names too, and a `$active` that a reference count inside `history.ts` writes is that library's
business, not something you can act on. What you got out of that library is bound in a file of
yours, and that binding is what draws it.

**A store that none of the three places is drawn nowhere at all.** One made inside a function and
kept there is that function's own working state: what the function returned is what your app holds,
and the tree draws that already. A store made at module level always keeps a place, because there
is no function it could belong to, and the file it was written in is the only thing holding it.
That last rule is what keeps a library's own `export const $route = atom("/")` on the tree, under
its own file, even though nothing in your code placed it.

A store that the tree leaves out stays in the registry and we still watch it, but it draws no
timeline row of its own either: no register, no mount, no write. A row you cannot trace to anything
on screen, with a diff showing nothing, teaches you to stop reading the timeline.

**The test is "can you see it", not "is it in the tree".** Those two differ. A store with no place
of its own is still drawn wherever a value you can see holds it, and then its own write is the only
thing that pushes the new tree, so it must keep its row. While we write a snapshot, we note every
store the converter draws inside a value, and a store in neither the tree nor that note draws
nothing:

```
$requested/set          <- you clicked Next
$currentResource/set    <- the response arrived
```

instead of the same two rows with a `$inputs/set` between them, where `$inputs` is a store that
some library keeps inside a factory and you have no way to look up.

The note is one snapshot behind, so a store that is put into a drawn value and written in the same
tick loses that first row. The write that put it there is a drawn store's own write, which sends a
row and refreshes the note, so the window is one turn wide.

The scan and a class field both know a property name, so each of them is a reference you wrote and
each one draws. A frame only knows that a store was born while some expression ran, so it places a
store only where no reference does. A store is never drawn under itself: we refuse an edge that
would close a loop, and we search every owner and every parent for one.

#### Every reference you wrote is drawn

**Every reference you wrote is drawn. A value is expanded under its first placement, and every
other placement shows it and stops.** A reference is a name you wrote for the value: a top-level
binding, or a key on a container you built. Two bindings for one store are two references, and so
are two containers that hold one store.

So a store you bound to a top-level name in one of your own files keeps that name, drawn flat, and
its owner keeps a **repeat** of the same store under the name the owner knows it by.

For `export const $entries = $draft.$history`:

```
$entries [computed]: ["a", "b"]                                    <- the name you wrote
$draft [store]: { (value): "b", $history [computed]: ["a", "b"] }  <- as $draft knows it
```

One entry, one identity, as many keys as your source wrote. With only the first, `$draft` reads as
incomplete. With only the second, the name you chose is lost: `export const $undoable =
$draft2.$canUndo` would be drawn under `$draft2` as `$canUndo`, and `$undoable` would appear
nowhere at all. The value is sent once per placement, because the extension's encoder writes a
repeat out again instead of as a pointer. On our own tree we measured one such repeat at about 11%
more bytes.

**A repeat draws nothing under it.** Its children sit under the placement that expands it, or the
tree would say that your app holds twice as many stores as it does. A store repeat still carries
its value, which is the point of a store. A node has no value, so a node repeat carries one key,
`(drawn under)`, holding the home and the name where you can open it:

```
left: { pinned: Viewer {…} }
right: { pinned: Viewer { (drawn under): "app/editor.ts/left" } }
```

**A row calls the store whatever the tree calls it.** A home you chose wins, so a store renamed by
your own binding has its rows renamed too: `$undoable/set`, not `$canUndo/set`. A store that only
its owner holds takes that owner's key, so the row says `username/set` where the tree says
`username`. The change inside the row still carries `lensed.ts/$lens`, because that says which file
the store came from, and a name its owner chose does not.

**The second key is the property that the owner really holds the store at**, not the name the store
was born with. The two agree wherever a util calls its own field what it hands it out as, which is
most of the time. Where they differ, the key you wrote wins:

```js
export const fields = {
  username: focus($values, "username"),
  password: focus($values, "password"),
};
```

```
fields: { username [store]: "ada", password [store]: "" }
```

The atom that `focus` returns is called `$lens` inside its own file, and two of them side by side
would read as `$lens [store]` and `$lens [store] #2`. Neither name is one you could look up. A
frame and a class field hold the store under no property at all, so those still fall back to the
name its creation site gave.

**A store you passed to `trackStores` is drawn the same way**, at the group you named, with every
owner keeping a repeat. The group is a home you chose by hand, so it beats any owner the walk
found.

**Two bindings that hold one store both draw**, each at the file that binds it. One entry cannot
hold two names, and every timeline row reads that one name, so the entry takes the exported binding
whichever is scanned first, and two bindings of the same kind pick one at random. Nothing is lost
from the tree either way.

`trackStores` is the exception: a group makes one entry per store, so two names in one group for
one store keep the first and warn.

**A binding inside somebody else's file places nothing**, neither a name nor a node, because that
is no name you chose.

#### Numbers under an owner

A nested store drops the number its creation site gave it, because the parent already says which
one this is: `$draft` and `$draft2` read the same way inside, even though the registry knows the
second set as the second store of its site.

Where the number is the only thing that tells two children apart, both sides take one back:
`$timeline [store]` next to `$timeline [store] #2`. Where a node holds stores from two different
files that share a name, both name the file instead:
`$history [computed] (vendor/withUndo.ts)`.

### The kind of store, in square brackets

**Every store carries its kind in square brackets**: `$total [computed]`, `$cart [map]`,
`$settings [deepMap]`, `$slow [batched]`, `$count [store]`.

**An `atom` and a store of an unknown kind both read `store`.** We read the kind at build time from
the creator call, or from the [package map](#what-each-plugin-option-costs) when a known package
made the store. So a store listed by hand in a project without the plugin, and a store from a
package the map does not name, have no kind to print. Nothing at runtime can tell a `map` from a
`deepMap`, or a `computed` from a `batched`, so all we could add is a guess.

The two are one word on purpose. `[atom]` would say that we read your creation site, and `[store]`
that we did not. That is a fact about how much of your source we reached, not about the store. Both
are writable and both hold whatever was last set, so there is nothing you would do differently.

**A store that is being held back says so in the same brackets**, `$frame [store, throttled]`, and
loses the word again when its rate drops. See [`throttle`](../README.md#connectdevtoolsoptions).

The brackets are part of the tree key only. Timeline rows keep the bare name (`$total/set`), and we
sort on the bare name too, so the kind never moves a store in the tree. A store that gains a kind
later, which adoption can do, changes its key, and the panel draws that as one key removed and one
added. Gaining `atom` changes nothing, because `store` was already the word.

### How a tree key is built

**A tree key always reads in the same order**: the name, the kind in square brackets, then at most
one group in parentheses saying where the store was made, then the number saying which store of
that place it is.

```
$count [store]                                        nothing to tell apart
$counter [store] (line 20)                            two source lines in one file
$counter [store] (app.ts, line 20)                    two files under one home
$history [store] (vendor/withUndo.ts, createPanel, line 20)
$history [store] (vendor/withUndo.ts)                 a home clash with no place to give
panel [store] #2                                      a clash that nothing else told apart
```

Inside the group the file comes first, because it says where to look before the line says where in
the file. There is never a second group: when a home clash also has a place to show, the home takes
the group and the place steps out.

A node's number sits tight against its name, `ref#1`, and a store's number stays spaced,
`panel [store] #2`, so the two never read as one thing.

### A store listed by hand leaves the file tree

This surprises people, so it is worth saying plainly. **With the plugin on, a store that you also
pass to `trackStores` leaves the file tree and appears under its group instead.** Writing a store
into `trackStores` is a deliberate act and you chose the group by hand, so the hand-written name
wins. The kind still comes from the plugin, because an explicit call has no kind to give. A store
that something else owns leaves that owner a repeat, as
[every reference you wrote is drawn](#every-reference-you-wrote-is-drawn) describes.

**To keep the store where the plugin put it, name the group after the file:**

```ts
// src/stores/cart.ts
trackStores("src/stores/cart.ts", { $items });
```

The tree is keyed by the home string, so this lands on the very node the plugin uses for that file,
and the store gains a hand-written name. A store that nothing owns stays exactly where it was. One
that something owns rises to the top level of that file, and its owner keeps the second placement.
**This is the recommended pattern for a project that uses the plugin and `trackStores` together.**

### The same name twice

The plugin and `trackStores` behave differently here, and the difference is real.

**The plugin** tells two cases apart. One source line that runs again (a factory, a loop) makes
stores you can exchange for each other, so they are numbered: `$items [store]`,
`$items [store] #2`. Two different source lines that want one name is a real clash: both keys name
the enclosing function and the line, such as `$counter [store] (makeCart, line 12)`, and we warn
once with both places.

**`trackStores` replaces, quietly.** A second registration for `cart/$counter` drops whatever held
that label before, with no warning. A clash here is almost always a hot reload, and we cannot tell
the two apart: both look like "this label again, with a different store object". A warning on every
edit would teach you to ignore our warnings. The label still shows in the tree, so nothing
disappears silently.

Two cases do warn, because neither can be a hot reload:

- The same store under two names in one call (`{ $counter, $total: $counter }`) is one store and
  one entry. The first name wins.
- The same store in two groups moves to the second group.

## What each row in the timeline means

Every row is named after the store it is about and the kind of change. We build that name
ourselves: nanostores has no actions, so there is nothing else to name a row after.

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

A row holds one write plus every recompute that write caused, which is why a `computed` store
usually has no row of its own. Mount, unmount, register, unregister and hot reload are the
lifecycle rows, and [`lifecycleEvents`](../README.md#connectdevtoolsoptions) turns all five off
together.

A [throttled](../README.md#connectdevtoolsoptions) store draws at most one row a second, or one row
per the rate its comment names. The writes it made inside that time are folded into the row that
closes it, followers and all. Its value in the tree stays current; what you lose are the steps
between those rows.

### When stores join and leave

**A register row never means startup.** Everything registered before the first snapshot is already
inside it, so a register row is always a late arrival:

- a code-split chunk loaded, and a file of yours ran for the first time;
- a factory or a loop made another store, `$items [store] #2`;
- a binding adopted a store that some other code built;
- `trackStores` ran after `connectDevtools`, which is the usual shape for a dependency's stores.

An unregister row is the opposite: stores left the tree for good. `untrack("cart")` does it, and so
does an edit that deletes the last store in a file.

Renaming changes no rows. A store that gains a name from your binding, a kind from adoption or a
group from `trackStores` keeps its entry, so it neither joins nor leaves.

### A hot reload draws one row, not a pair

A file that both loses stores and gains stores while it runs again was hot reloaded. The two halves
become one row, `src/stores/cart.ts/hotReload`, or `$count/hotReload` when only one store moved.

Inside the row each store carries its own word: `hotReload` for a store that came back, `register`
for one your edit added, `unregister` for one it dropped. So the row tells you what the edit did,
and you never have to recognise a pair of registry rows as your own save.

## What each `connectDevtools` option costs

Every option's name, type and default is in the [README](../README.md#connectdevtoolsoptions). This
section says what the table cannot: what each option buys you, and what it costs when you change
it.

`name` is fixed at the first connect and cannot change later, because the panel builds its record
for a connection once. It defaults to a fixed word rather than `document.title`, which changes per
page and per route.

**`maxAge` defaults to 500, not to the extension's own 50.** Every row holds a full copy of the
state tree, and 50 rows is far too short for a debugging session. 500 rows with 1000 stores
measured at about 50 MB, and the cost grows in a straight line, which is why the option exists.

**`traceLimit` defaults to 10 and should not be lowered without thought.** We capture the stack
inside our own hook, so the first frames belong to us and to nanostores. We cut our own five frames
at capture time. About four nanostores frames are still left, so a limit of 5 leaves you about one
frame of your own code. Measured cost per write: 0.01 microseconds with the option off, 7.1 at 10,
13.0 at 25. `Error.stackTraceLimit` and `Error.captureStackTrace` are V8 features, so this controls
the cost in Chrome. Firefox gives a full stack with no limit at all.

**`lifecycleEvents: false` costs correctness, not only a quieter timeline.** Mount state lives in
the tree, and the extension only ever sees the tree when we send a row. Turn the option off, and a
mount, an unmount or a late registration changes nothing in the panel until the next write, which
then carries that change in its diff. Turn it off when a route change that mounts many stores at
once is too slow, and know what you pay for it.

**`autoThrottle` is on, and it is the one default that drops rows.** A store that writes more than
10 times a second is held to **one row a second**, starting from the write that passes that count.
Its first write in a second draws a row at once, the writes after it inside that second draw none,
and the last of them draws the row that closes the second. We warn once, naming the store and the
ways to ask for something else.

**A store it picks up stays throttled for the rest of the session.** The rate is a fact about the
store, not about the moment. A frame loop that pauses, or a countdown between two runs, would
otherwise be released and picked up again over and over, and the timeline would switch between full
rows and thinned ones while you read it. A reload starts every store clean again, and so does a hot
reload that builds the store again, because that is a new store to us.

**The tree is never behind. Only the steps between rows are lost.** Every row carries the whole
tree, so the value a throttled store shows is its current one. What you cannot do is click through
the writes in between, because they are not rows. A throttled store says so in the panel: its key
reads `$frame [store, throttled]`, and it keeps the word from the write that started it.

A frame loop writes about 60 times a second, so without this it costs about 60 full trees a second.
That is what fills `maxAge` in eight seconds and pushes every row you came to read out of the
panel.

Pass your own threshold, `autoThrottle: 20`, or `false` to keep every row. What you get is one row
a second, and the plugin's comment below is the only way to hold one store to another rate, or to
keep every row of one store while the rest is still caught.

**`throttle` marks a store as throttled on purpose, and turns the warning off.** It takes the names as the tree writes
them, `"home/name"`, or a rule over them:

```ts
connectDevtools({ throttle: ["src/model.ts/$remaining"] });
connectDevtools({
  throttle: (store) => store.home.startsWith("src/animation/"),
});
```

A rule receives `{ home, name, type }` and runs when a store registers, is renamed or moves, never
per write. The name is the one you read in the tree, without the file and line that a clash adds to
it, so an edit that moves a line does not break the match.

The plugin reads a comment for the same thing, next to the store, where a rename cannot lose it:

```ts
// @nanostores-devtools:throttle
const $remaining = countdownAtom($delay, { interval: TICK });
```

The comment marks the whole statement below it, so a call that makes several stores marks all of
them. Either way alone is enough, and a store you marked by hand never warns.

**The comment also takes a rate of its own**, in milliseconds:

```ts
// @nanostores-devtools:throttle 100
const $frame = atom(0);
```

That store draws one row per 100ms, and every other throttled store keeps the default second. Edit
the number, and the reload that your edit causes carries the new rate. Anything that is not a
positive number of milliseconds, such as `// @nanostores-devtools:throttle 100ms`, still marks the
store, at the default rate. The mark is what the comment is for, and a rate nobody can read must
not cost you that mark.

**`// @nanostores-devtools:no-throttle` keeps every row of one store**, which is the other half of
the same comment:

```ts
// @nanostores-devtools:no-throttle
const $frame = atom(0);
```

That store writes fast on purpose, so `autoThrottle` never takes it over, however fast it writes,
and it never warns. It covers the whole statement below it, the way the mark does, and anything
written after the word still leaves the store spared. It says nothing about the other two ways: a
store you named in `throttle`, or marked with `// @nanostores-devtools:throttle`, is throttled
because you asked for it, and a statement that carries both comments follows the mark.

**A follower rides in the row its source opened**, so marking one store quiets the whole chain
behind it, and no computed store needs a mark of its own. Lifecycle rows are never throttled;
`lifecycleEvents: false` is the lever for those.

**`// @nanostores-devtools:ignore` keeps a store out of the devtools completely**, which is the
third comment the plugin reads:

```ts
// @nanostores-devtools:ignore
const $session = atom(readToken());
```

That store never registers. It takes no key in the tree, draws no row in the timeline, and nothing
in the panel says it exists: the file reads as though the plugin never saw that statement. The
comment stops at the build, so there is nothing about it at runtime and no option that turns it
back on.

**It marks the whole statement below it**, the same reach the throttle comments have, so a call
that makes several stores keeps all of them out, and anything written after the word still leaves
the statement ignored. **Ignoring beats throttling** over one statement: a store that nobody draws
has no rate, so a statement that carries both comments is ignored.

**Only that statement is left alone.** Every other store in the file is instrumented as usual. Two
cases are worth knowing. A comment over an `import` line still lets the import be read, so the
creators it brings in keep naming the stores below it. And a file that imports a creator keeps the
one-line header that the plugin injects even when every store in it is ignored, because that header
carries the clear that a hot reload needs.

**`trackStores` is the way back in.** The bridge never hears about the comment, so a store you
ignored and then passed to `trackStores("secrets", { $session })` registers by hand and is drawn
under that group. Use it when you want one build to draw a store that the source keeps out. Delete
the comment when you want the store back for good.

**A comment cannot reach a store that a dependency makes.** The plugin reads your own source and
never a file under `node_modules`, so a store built inside a dependency has no statement of yours
to mark. Such a store is in the tree only because you named it in `trackStores`, and dropping that
name, or calling `untrack`, is what keeps it out.

**`// @nanostores-devtools:max-members 25` caps how much of one binding the scan walks**, which is
the fourth comment the plugin reads:

```ts
// @nanostores-devtools:max-members 25
export const rows = await loadEveryRow();
```

The scan then takes the first 25 members of that binding and stops. It marks the whole statement
below it, the way the other three do, so every name a destructured statement binds takes the same
number.

**The number reaches every depth of that binding**, not the top level alone, so a member of a member
is capped too. Without that, a comment saying 25 would still leave 25 containers walked whole, and
the developer who wrote it would see almost nothing change.

**A member past the number is not registered at all.** It draws nowhere, nothing subscribes to it,
and no timeline row is ever checked for it, which is the cost the comment exists to remove. The
panel says what it left out under one key, `…`, and names the comment while it does:

```
4975 more members left out by `@nanostores-devtools:max-members 25`
```

A store that a creator call already registered under its own name keeps that row, drawn flat at its
file rather than under the binding.

**It takes a whole number of 1 or more**, the same shape `maxDepth` takes. Missing, zero, negative,
a fraction or not a number at all: in each case the comment caps nothing, the binding is walked
whole, and your bundler prints the file and the line, so a typo never quietly hides half your
stores. **Ignoring beats it** over one statement, the way it beats
throttling: `ignore` is the escape, and this comment is the middle setting between drawing all of a
binding and drawing none of it.

**No option sets this for the whole project.** `maxDepth` bounds how deep every binding is walked,
and this comment bounds how wide one of them is.

**A `@nanostores-devtools` comment the plugin cannot read warns instead of acting.**
`// @nanostores-devtools:ignored` names none of the four, so we read it as prose and the store
below it stays drawn. The same goes for `// @nanostores-devtools-throttle`, with a hyphen where the
colon belongs: the plugin reads the namespace and everything written on it, so both forms warn
rather than pass as prose. The plugin warns once through your bundler, naming the file, the line,
what you wrote and the four comments it reads: `@nanostores-devtools:ignore`,
`@nanostores-devtools:throttle`, `@nanostores-devtools:no-throttle` and
`@nanostores-devtools:max-members`. Read that warning as your file not doing what it looks like it
does.

A custom serializer is `{ match: (value) => boolean, convert: (value) => unknown }`. Serializers
run in array order, the first match wins, and all of them run before every rule of ours.

**What `convert` returns may hold its own input.** The encoder walks that result too, and none of
your serializers runs again on a value inside it. So a `convert` that returns `{ point: value }`
draws your wrapper with the `Point` inside it drawn by our rules, and the walk ends there. Your
rule already ran over the whole tree it built, which is also what it costs: a result that a later
serializer's `match` would match does not reach that serializer either.

**Put the values of a result in plain properties, not behind getters.** Your result is the one
thing the bridge hands to the encoder as it is, and the encoder reads it with plain reads, so **a
getter on your result does run**. The bridge tracks the result's values through property
descriptors instead, which is what keeps them out of your serializers, and a value behind a getter
is invisible to that tracking. Two things follow: your getter's answer reaches the panel without
any rule of yours seeing it, and a getter that hands back the input converts it over and over, so
that one slot shows `ConversionError` while the rest of the tree still reaches the panel.

**A `Map` and a `Set` are keyed by the bridge, and no list of ours reaches your rules.** We read
both into an array on the way, and that array never leaves the bridge, so a rule as wide as
`match: Array.isArray` leaves a collection as it is. The keys, the values and the members inside
one are your app's, and every rule you wrote still runs on them.

The one collection that the encoder still writes by itself is one **your own `convert` returned**.
The encoder builds a list out of it there, and neither that list nor a `[key, value]` pair inside
it reaches your serializers.

**We ship rules of our own, and they run after yours.** Nine platform classes say nothing useful
without one, so the bridge draws them itself:

| class                                   | what it draws                 |
| --------------------------------------- | ----------------------------- |
| `Headers`                               | one key per header name       |
| `FormData`                              | one key per entry             |
| `URLSearchParams`                       | one key per entry             |
| `ArrayBuffer`, `SharedArrayBuffer`      | `byteLength`                  |
| `DataView`                              | `byteLength` and `byteOffset` |
| a boxed `String`, `Number` or `Boolean` | the primitive under `(value)` |

Each of the first five draws `<Headers> {}` without the rule, because none of them holds own data
or says how it reads itself. A boxed string drew one key per character, so a 10 000-character one
cost 10 000 keys.

We check your own rules first, so a rule you wrote for one of these values wins. Ours are checked
before every other rule of the bridge.

**A name that repeats takes a number**: a `FormData` or a `URLSearchParams` that holds `tag` twice
draws `tag` and `tag #2`, in the order the entries went in, because one key holds one entry. A
field really named `tag #2` reads the same way, which is what this costs.

Pass `platformSerializers: false` to leave the whole list out. Those values then draw the way every
other class instance does.

**`maxValueDepth` and `maxValueMembers` cap only what a class instance holds.** Everything you
shaped yourself goes out whole, however large: the two counts start where the walk enters a class
instance, and a plain object, an array or a collection above one is never touched. Raise either
number, or pass `Infinity` for no cap. Your own serializer runs before the caps, because a rule
you wrote is the exact tool for shrinking a deep value, and a store below the caps keeps its
whole value. See
[values are shortened only under a class instance](#values-are-shortened-only-under-a-class-instance).

## What each plugin option costs

Every option's name, type and default is in the [README](../README.md#nanostoresdevtoolsoptions).

First, what a **creation site** is. **A site is one place in your source where a store is made, not
one store.** A site inside a factory makes a new store every time it runs, and all of those stores
share one name. The registry holds strong references on purpose, so nothing leaves it on its own,
and nothing caps how many stores one site may hold.

**`maxDepth` bounds the binding scan.** The scan runs at the end of every module body, starts at
each top-level binding the module makes, and walks into what that binding holds, counting a
property, an index and a `Map` key alike. Ten steps by default, which is deeper than state is
usually nested. A store past that number is not drawn under the binding, and not registered by the
scan at all.

**It takes a whole number of 1 or more, or `Infinity` to walk a binding as deep as it goes.**
Anything else is refused with a warning that names the option and your value, and the walk keeps its
own depth. This is not `maxValueDepth`: that one caps how much of one value a row carries, while
this one decides which stores exist at all.

**`storeTypes` gives an adopted store its kind, and nothing else.** It maps a package name to that
package's store-making exports, and each export to the kind it returns. We ship entries for the
packages on the Smart Stores list in the nanostores README, read from each package's own source, so
`persistentAtom` reads as an atom and `persistentMap` as a map. Your own entries are laid over ours
per package and per export, so correcting one export changes nothing else.

**It does not find stores.** Finding one is adoption's job, so a package with no entry reaches the
tree exactly as before, only without a kind, and turning `adoptFactories` off takes the map with
it. A kind from the map wins over the empty kind that an adoption site carries, and loses to the kind
that the creator call itself gave the store.

**It reads the export name, not the local one**, so `import { persistentAtom as stored }` still
works. It reads a named import only: `import * as persistent` and a default import both say nothing
about which export a later call means.

**An entry for an export that a package does not have is silent.** Nothing reads an entry until a
file imports that name from that package, so a typo, a renamed export and a package you no longer
use all cost you the kind and nothing more.

**A kind is one of `atom`, `map`, `deepMap`, `computed`, `batched` or `unknown`**, which is what
the tree prints in square brackets. Four packages on that list have no entry, because none of them
exports a function that returns a store: `@nanostores/query` builds its creators inside a
`nanoquery()` call, and `@vp-tw/nanostores-storage`, `@vp-tw/nanostores-data-layer` and
`@vp-tw/nanostores-qs` each keep their stores on a property of something else. Write your own entry
for a package we do not ship, and for one of your own.

**An entry we cannot read is refused, never repaired.** A kind outside those six is dropped with
one warning that names the package, the export and the value you wrote, so a capital `"Atom"` never
reaches the panel key. A package whose value is not an object is dropped the same way, so
`{ pkg: null }` costs a warning rather than the build, and `{ pkg: "ab" }` is not read as two
exports named `0` and `1`. We read only your own entries this way; ours are checked when this
package is built.

**A refusal costs one entry.** The rest of that package's exports, and every other package, still
merge, so one typo never costs you the entries you got right. What it costs is the kind: the call
still reaches the tree by adoption, exactly as a call from a package we do not name does. The
warnings reach you once per build, through the same channel that `maxDepth` and `adoptFactories`
already use.

**`fileKey` receives the home as the tree would show it**, so a file inside your bundler's root
arrives relative to that root, and a file outside it arrives relative to the wider root:
`projectRoot` under Vite, and the climb above `context` under webpack and Rspack. It only changes
what is displayed. A hot reload still clears a module by its real path, so two files that share one
display key cannot delete each other's stores.

**Two files mapped to one home keep both sets of stores.** When each of them holds a `$counter`,
both keys say which file they came from: `$counter [store] (a.ts)` next to
`$counter [store] (b.ts)`. Where the two files have the same name, the key takes as much of the path as it needs to
tell them apart, `$counter [store] (a/store.ts)`. It comes from the file alone, so a hot reload and
a different load order both give the same two keys, and you are warned once for each name that two
files write. Every other key stays exactly as it is: a name that only one of the files writes needs
nothing added.

We do not cut the shared start off your file paths for you, because that shared part changes as
routes load. Cutting it would rename every key in the tree at once, and the extension reads that as
every key deleted and added again. Write a fixed rule instead, such as
`fileKey: (path) => path.replace(/^src\/stores\//, "")`. A fixed rule gives the same key on every
page load.

**`projectRoot` is a Vite option.** Under webpack and Rspack the wider root is always the climb
above `context`. That climb stops at three markers: `pnpm-workspace.yaml`, `lerna.json` and a
`workspaces` field in a `package.json`.

**`projectRoot` defaults to Vite's own `searchForWorkspaceRoot`**, which stops at the same
`pnpm-workspace.yaml`, `lerna.json` and `workspaces` field, plus one more that our climb does not
read: a `deno.json` or `deno.jsonc` with a `workspace` field. So a Deno workspace is the one place
where the two stop differently. The default is right for a real app: a linked package then reads as
`packages/…`. Set it yourself when that default sits so high above your app that every external
home gets long. It changes no path inside the Vite root. A file that the project root cannot reach
keeps its full path, which still opens in an editor.

**Every source file is parsed, and there is no option to stop it.** Parsing costs about 0.02 ms per
file, paid once per file per dev build, because a bundler caches the transform of a file it has
already read. That price buys you the file whose own text says nothing about stores, such as
`export const panel = createPanel()` in a file that imports no nanostores. Nothing else says that
the factory result holds those stores, and a store that nothing places is drawn nowhere, so
skipping that file would lose it rather than move it.

On **Vite 8** the plugin costs you nothing extra: Vite re-exports the parser it needs. **Vite 6 and
7, webpack and Rspack** all need `oxc-parser` as a dev dependency instead, because none of them
ships a parser this plugin can borrow. We declare it as an optional peer, since a peer is declared
for the package and never for one subpath, so a Vite 8 user is not handed a package they never
load.

## What v1 does not do

Everything here is written down on purpose, so that nothing you find later looks like a bug.

### No time travel

The jump, dispatch, skip, reorder and import buttons are turned off in the panel. We built time
travel first and measured it. Five things block it:

- The app writes over the values we restore.
- An unmounted `computed` stays stale, and nothing says so.
- A partial restore is silent. Code splitting makes a missing store normal, so nothing marks the
  point where two moments were mixed.
- Side effects do not go back. An open socket stays open, and a written `localStorage` key stays
  written.
- Half the value types cannot be rebuilt at all: a class instance, a function, a Symbol, a DOM
  node, an object made only of getters.

Pause and export stay on. Both use state that the panel already holds. Pause stops both halves: we
build no tree and send nothing while it is on, so the page pays nothing either. Lifting it changes
no row already in the panel, and the next write brings the current tree.

### An unmounted `computed` shows an old value, or nothing

**The bridge never runs the callback of a computed store, and never works out a value itself.** An
unmounted `computed` or `batched` shows whatever its `.value` still holds, under one of two
markers:

- `not mounted, never computed` when it holds `undefined` and we never saw it mount.
- `not mounted, may be stale` for everything else.

A store whose kind we never learned takes the second marker too, because it could be a computed
store and we cannot prove that it is not.

The marker is printed in front of the value. A plain object and an array are drawn as they are.
Everything else sits under `(value)`, the same key that a store which owns others keeps its own
value under.

**That box is the extension's limit, not our choice.** A marker travels in the extension's own
`__serializedType__` wrapper, and the extension's reviver hangs it on the object it is about, under
a symbol key. So the marker needs an object to hang on, and four kinds of value cannot give it one:

- **a primitive, and `null`**, which never come back through the reviver at all;
- **a `Date` and a `RegExp`**, which travel as a `{ $jsan: … }` object, so decoding replaces the
  object the marker was written on, and the marker goes with it;
- **anything we already marked**, a `Map` and a `Set` included, because two markers on one object
  leave only the outer one;
- **a value that can reach the store again**, because the extension's encoder writes a repeat of an
  ancestor as a pointer, and a pointer replaces the object the marker was written on.

What is left is a plain object and an array with no way back to the store, and both go in bare. The
box costs one level and loses no word, so everything else takes the box.

```
$cart [computed]:  not mounted, may be stale { total: 12 }
$count [computed]: not mounted, may be stale { (value): 12 }
$empty [computed]: not mounted, never computed {}
```

An unmounted `atom`, `map` or `deepMap` is **not** marked. `set` writes the value without looking
at the listener count, so an unmounted one holds a correct value and nothing is wrong with it.

**The word on the key does not tell you which rule a row follows.** Two rows can both read
`[store]` and behave differently: an `atom` we know about is drawn bare while it is unmounted,
while a store of an unknown kind carries `not mounted, may be stale`. The marker is what tells you
which one you have.

One gap: the hooks attach when you connect, not when a store registers, so a computed store that
mounted and unmounted before you connected looks never-mounted to us. If it ran and returned
`undefined`, it takes `never computed`, and that claim is then wrong.

We read mount state as `lc === 0`. We do not wait out the 1000 ms cleanup window that nanostores
keeps after the last listener leaves, because that would mean running our clock against theirs. So
a store that unmounts and mounts again inside that window reads as unmounted for a moment, and with
lifecycle rows on it draws an unmount row and a mount row for a teardown that never happened.

**Nothing is ever hidden.** Every registered store is always a key in the tree, mounted or not.

### Values are shortened only under a class instance

**A value you designed is never shortened.** A plain object twenty levels deep, an array of two
thousand rows, a `Map` of ten thousand entries: all of them go out whole, however large, and no
option changes that.

**Two caps start where the walk enters a class instance**, and they apply to everything below
that point:

- `maxValueDepth`, `5` by default, is how many levels are drawn below the instance. A value deeper
  than that keeps its class name and shows one line: `(value): "past the 5 levels drawn under a class
instance"`.
- `maxValueMembers`, `100` by default, is how many members are drawn per shape: an instance's own
  fields, and a plain object, an array, a `Set`, a `Map` or a typed array below it. The rest are
  counted under one key, `…`, labelled `1901 more members past the 100 drawn under a class
instance` over an empty object. We keep
  the first 100 in source order, and a store past that point loses this node but keeps its own slot
  at its home.

Raise either one, or pass `Infinity` to turn it off:

```js
connectDevtools({ maxValueDepth: 12, maxValueMembers: Infinity });
```

`maxValueDepth` takes a whole number of 0 or more. With `0` we draw an instance's own fields and
turn every object among them into a placeholder. `maxValueMembers` takes a whole number of 1 or
more. We refuse any other number instead of repairing it, with one console warning per option name,
and we use the default in its place.

**A store below the cap keeps its whole value.** One store must not show two different values in
two places: a store drawn deep inside a class instance and the same store drawn at its own home
have to agree, and the home slot has no cap above it. This still stays bounded, because a class
instance inside that value starts a fresh count.

**Why a class instance is the line.** A plain object is state you wrote and shaped yourself. A
class instance is where a value the panel was never designed for begins: a framework's node, a
platform interface, a scene graph. Five levels show a real domain object whole
(`Editor → doc → blocks → Block → id` is four levels), and 100 members cover the widest record an
app writes for itself, such as a settings object or a row of a table.

Two limits stay as they were. A repeat is still written once per path instead of pointed at, and
a serializer's own result is not width-capped.

Other things values do:

- **A value that refers back to itself is written as a `$.path` pointer.** The extension's own
  encoder does this to make a loop safe to write. A plain repeat is not written that way: the same
  object in two places is written out twice, because the option that would collapse it is off in
  the extension's defaults. That is the price of letting a `Date` and a `RegExp` render as
  themselves in the panel.
- **A getter is never read**, no matter who wrote it, because it can run app code. There is one
  exception: the `stack` accessor that V8 puts on an error itself. Refusing it would drop the stack
  from every error, and devtools with no stack traces are worth less than the risk. Reading it can
  run `Error.prepareStackTrace` if the app installed one, and it makes V8 read `name` and `message`
  off the error.
- **A method is left out.** An own property that holds a function does not reach the panel:
  `{ id, $checked, toggle, add }` arrives as `{ id, $checked }`. The panel draws state, and a
  method next to the stores it writes says nothing that your source does not. A value that is
  itself a function still arrives, with its body stripped, and so does a function at an array
  index, because there the position is part of the shape.
- **`-0` arrives as `0`.**
- **A custom serializer has no reviver.** The bridge only encodes, and v1 never reads state back.
- **A labelled value inside a `Map` that your `convert` returned keeps its wrapper**, so you read
  `{ data, __serializedType__ }` there instead of a label in front of the value. The extension's
  own encoder writes that collection as one string and reads it back without its reviver, so
  nothing inside it is ever unwrapped. This hits every labelled value: an `Error`, a class
  instance, a typed array, a `BigInt`, a DOM node, a store, and a slot that failed to convert. A
  `Map` or a `Set` that your app holds is keyed by the bridge instead and has no such problem.

An `Error` keeps its name, message, stack, cause and own fields. A class instance keeps its class
name. A typed array and a `BigInt` each keep something readable. A value that throws while it is
being converted puts `ConversionError` in that one slot, and everything else still goes.

**A store held inside another store's value is drawn as a store**, wherever it sits: in an array,
in a plain object, in a `Map`, in a `Set`, in a class instance field, or on an error. You never see
the nanostores keys behind it. We read `.value` and nothing else, as everywhere else, so looking at
a store still never mounts it.

**Where the store sits at a name your source wrote, the kind goes in the key** and the value goes
in plain below it, exactly as the tree writes a store's own slot:

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

**An array that holds at least one store is keyed too**, `[0]`, `[1]`, the same way the tree writes
a collection member. It goes out as an object instead of a list, labelled `Array` so a collapsed
node still says what it was:

```
$rows [store]   Array
  [0] [store]:  { id: 1, name: "city", value: "Berlin" }
  [1] [store]:  { id: 2, name: "street", value: "Unter den Linden" }
```

**An array of plain data stays a list.** Only an array that holds a store pays for the keys, so
`$fields [store]: [ {…}, {…} ]` right beside it is untouched.

This is not a matter of taste. A kind carried in a wrapper is drawn in the panel's **item string**,
and the State tab sets `display: none` on that string while the node is expanded, and leaves it out
of a collapsed parent's preview. On a member there is no moment when you could read it. A key is
always drawn.

**A `Map` and a `Set` are keyed the same way**, and always, which is where they differ from an
array. `["scratch"]` for a `Map` key your source could write, `[0]` for a position in a `Set`:

```
$columns [store]   Set
  [0]: "name"
  [1]: "size"

$editors [store]   Map
  ["draft"] [store]:  "Berlin"
```

The reason is not the key, it is the label. The panel draws a `Map`, a `Set` and anything else with
an iterator as one node kind, and that node writes **`Iterable`** over the name it worked out. So a
collection that the encoder renders itself cannot say which of the two it is. Keying it wins the
name back, and it costs the `2 entries` count that the panel writes for that node kind only.

One wrapper is left: the `[key]` half of a `Map` entry whose key is not a string or a number. There
is no name in your source for such a key, so the entry keeps the encoder's own shape,
`[entry 0]: { [key]: …, [value]: … }`, and a store sitting in either half is wrapped there.

The word in the key is the kind the bridge knows: `map`, `deepMap`, `computed` or `batched`. An
`atom`, and a store whose kind the bridge never learned, both say the plain word `store`. An
unmounted store keeps its note next to the kind,
`$total [computed]: not mounted, may be stale { … }`.

One shape is left over. **A store whose value can reach that store again keeps the wrapper**, with
the kind in front of the value and no kind in the key. The extension's encoder finds that loop by
the path it built, and it only finds it while the wrapper's own key stands in that path.
the kind in front of the value and no kind in the key. That loop is what the extension's encoder
finds by the path it built, and it only finds it while the wrapper's own key stands in that path.

### What an object's own fields show

**Almost every value the bridge draws starts here: with its own fields.** It is one rule, and it
covers a plain object, a class instance and an `Error`. The only thing it does not cover is a
result your own serializer returned, which goes to the encoder untouched.

**A field counts when it is own, enumerable, named by a string, and holds a plain value.** Each of
those four words does some work:

| the value holds               | what arrives         | why                                                            |
| ----------------------------- | -------------------- | -------------------------------------------------------------- |
| `{ open: true, width: 320 }`  | both                 | ordinary state                                                 |
| a getter you wrote            | nothing for that key | reading it would run your code                                 |
| a method, `toggle() {}`       | nothing for that key | the panel draws state, and your source already shows behaviour |
| a symbol key                  | nothing for that key | there is no name to draw                                       |
| a key you made non-enumerable | nothing for that key | you already marked it as internal                              |

A function is dropped **wherever it sits at a key**, whether or not you would call it a method. It
still arrives in the two places where the function is the state itself: as a store's own value, and
at an array index. In both places the body is stripped.

**Keys arrive in the order the value lists them, and the panel does not sort.** That order is
JavaScript's own: any key that looks like an array index comes first, in numeric order, then the
rest in the order they were assigned. So a class draws its fields in assignment order, class fields
before whatever the constructor body added.

```
class Cart {
  id = "c1";
  constructor(total) { this.total = total }
}

$cart [store]: Cart {
  id: "c1"
  total: 12
}
```

(The panel has a "Sort Alphabetically" setting, off by default. Turning it on throws this order
away.)

**A prototype is never walked for fields.** We read only what sits on the value itself, so a field
your class declared on its prototype does not arrive. We still read the prototype for two things
that are not fields: the class name drawn in front of the value, and the `valueOf` or `toString`
that we ask for when a value has no own fields. An `Error` is read by name instead, and its four
names are looked up along the prototype chain.

**Own fields win over everything else a value could say.** We ask a class that writes a `toString`
for it only when the instance has no own field at all:

```
class Priced { amount = 500;  toString() { return "$5.00" } }
class Silent  {               toString() { return "$5.00" } }

$a [store]: Priced { amount: 500 }          <- the method is never called
$b [store]: Silent { (toString): "$5.00" }
```

See [what a platform object shows](#what-a-platform-object-shows) for the second half of that rule.

**Where the fields are read from, in one table:**

| value                                    | what it draws                                                      |
| ---------------------------------------- | ------------------------------------------------------------------ |
| a plain object, or one with no prototype | its own fields                                                     |
| a class instance                         | its own fields, plus its class name in front                       |
| an `Error`                               | `name`, `message`, `stack` and `cause`, plus its own fields on top |
| a result your `convert` returned         | none of this rule: the encoder reads it plainly, getters and all   |
| an array                                 | its own **indices**, read one by one, and never its named keys     |
| a `Map`, a `Set`                         | its entries, read through the built-in `forEach`                   |
| a typed array                            | its elements                                                       |
| a DOM node                               | **nothing** (see below)                                            |
| the global object                        | **nothing** (see below)                                            |

The last two are the only values whose own fields we skip on purpose, and each has a reason worth
knowing:

- **A DOM node.** A framework puts its own state on an element as an ordinary property, React's
  `__reactFiber$…` above all. Reading those would pull a whole render tree into any row that holds
  an element.
- **The global object.** Everything you put on `window`, by assignment or by a top-level `var`, is
  an own enumerable property. We never even list its keys.

**An object that refuses to be read gives up everything, not half.** Listing keys and reading a
descriptor can both be caught by a `Proxy`, and a trap of yours may throw. Half an object is worse
to read than none, so we never draw a partial one. The keys are listed once before any rule runs,
so in practice such a value fills its one slot with `ConversionError`, and the rest of the tree
still arrives.

**Nesting follows the same rule at every level**, and a plain object inside a class instance does
not escape the caps by being plain:

```
$editor [store]: Holder {
  at: Point {
    x: 1
    y: 2
  }
  label: "one"
}
```

The only thing that cuts this list short is the width cap, and only under a class instance. See
[values are shortened only under a class instance](#values-are-shortened-only-under-a-class-instance).

### What a platform object shows

**A class instance is drawn from [the own data it holds](#what-an-objects-own-fields-show).** An
event, a `DOMRect`, a `Blob` and an `AbortSignal` hold none. Every field on them is a getter on
their prototype, and a getter is never read, no matter who wrote it. So each of them draws its
class name over an empty object:

```
$lastMove [store]: <MouseEvent> {}
$viewport [store]: <DOMRect> {}
```

**A class that says how it reads itself gets that reading instead.** Where an instance holds no own
data, we call the `valueOf` and the `toString` that **the class itself defines**, and each answer
takes a key that names the method which gave it:

```
$link [store]: <URL> {
  (toString): "https://a.dev/x?q=1"
}
$price [store]: <Money> {
  (valueOf): 500
  (toString): "$5.00"
}
```

The two methods on `Object.prototype` are refused. Its `toString` gives `[object MouseEvent]`,
which says nothing that the class name does not, and its `valueOf` hands the object straight back.
That one test is the whole rule, so we keep no list of classes anywhere. It is also why a `URL` and
a `Location` keep their address while an event does not: those two write a `toString`, and an event
does not.

**This is the one place where the bridge runs code from your app**, and every part of the rule
limits it:

- **only where there is no own data**, so an ordinary object of yours runs nothing at all
- **the method is found through a property descriptor**, so a `toString` behind a getter is refused
  like every other getter
- **it is called by name**, never through `String(value)`, which would run `Symbol.toPrimitive` and
  a chain of its own
- **only a primitive answer is kept**; an object, `null` and `undefined` are dropped
- **a method that throws costs only its own key**; the other key and the class name still arrive

If you wrote a `toString` with a side effect, this is the paragraph you needed: it runs while a
snapshot is written.

**For every other field, write one rule for the class you hold.** The bridge cannot know which
fields of a platform interface matter to you, and you can:

```js
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

Every platform class works the same way, so a `DOMRect`, a `Blob` and a `File` each take a rule of
the same shape. [`connectDevtools(options?)`](../README.md#connectdevtoolsoptions) has the full
contract.

**One trap.** A platform object **inside** your result meets no serializer, ours included, so it
draws its class name and nothing else. Write it out in your own rule:
`{ headers: Object.fromEntries(response.headers) }`, not `{ headers: response.headers }`, which
draws `<Headers> {}`.

Three things are readable without a rule of yours, so the loss is limited to objects that keep
everything behind getters:

- **A DOM node** follows the same rule: a `<div>` draws `HTMLDivElement {}`, and an `<a>` draws its
  href under `(toString)`, because `HTMLAnchorElement` writes one. What a node never shows is a
  property that the app or a framework put on it, React's fiber above all, which would otherwise
  pull a whole render tree into the row.
- **The window your page runs in is never walked**, wherever the row reaches it from: `self`,
  `frames`, `currentTarget` on a `window` listener, and `top` or `parent` while the page is not in
  a frame. It draws its class name alone, `Window {}`, so whatever you put on `window` costs no
  keys at all. A window from another realm, from an iframe or from a `window.open` result, is read
  as an ordinary object of its class, because the test compares identity.
- **A few classes take a rule of ours**: a `Headers`, a `FormData`, a `URLSearchParams`, an
  `ArrayBuffer`, a `SharedArrayBuffer`, a `DataView` and a boxed `String`, `Number` or `Boolean`.
  Those run after your own rules and before every other rule of the bridge, and
  [`connectDevtools(options?)`](../README.md#connectdevtoolsoptions) has the list and the option
  that turns it off.

### A follower can name the wrong source

A row holds one direct write plus the recomputes that write caused. Each follower carries a `from`
field that names the store it followed. `from` is simply the previous change in the row. That is
right for a chain, and wrong in three cases:

- **Inside `batch(fn)`**, where every direct write arrives first and every follower arrives at the
  end, so followers attach to the last write of the batch.
- **When one of your own listeners writes another store in the middle of a cascade.** That write
  closes the open row early, so a follower still waiting behind it lands in the new row.
- **When two computed stores follow the same source.** The second one names the first instead of
  the source they share.

A wrong `from` is never invented. It only points at the wrong store, and the change itself is
always shown.

A **`batched` store always gets its own row.** Its recompute runs in a `setTimeout`, so it happens
in a later task, long after the row that caused it closed. It can never join that row, so it always
draws its own `$total/computed` row.

A store of an unknown kind is timed wrongly in the same way. The bridge treats it as a direct
write. So if it really is a computed store, its recompute opens a row of its own instead of joining
the row that caused it. It also closes the open row while the cascade is still running.

### A hot reload does not always draw one row

A reload draws [one row](#a-hot-reload-draws-one-row-not-a-pair) only when both halves happen in
the same run of the file. Two cases split them:

- **A file with a top-level `await` above its stores.** The old stores go the moment the file
  starts, and the new ones arrive after the `await`, so you get an unregister row and a register
  row again.
- **A file whose stores are all made inside a factory.** The reload drops the old stores and
  registers none, so it draws a single unregister row. The register row comes later, when the
  factory runs.

Both cases tell the truth, only in two rows instead of one.

### What the ownership tree cannot reach

Some of these we refuse to do, and the rest we cannot do. The difference matters: a refusal will
not change, and a gap might.

**Refused, because the bridge only reads:**

- **A value behind a getter is never read**, no matter who wrote it. A getter runs code, and
  running it would change how the app behaves. A store that only a getter leads to still reaches
  the tree. It just sits where it was made, not under the object that holds it. See
  [what a platform object shows](#what-a-platform-object-shows) for what an object built only of
  getters draws instead.
- **An array is read index by index through its own descriptors**, so a getter at an index never
  runs, and an index that only the prototype holds is left out. If that read fails, the array adds
  nothing.
- **A `Map` and a `Set` are read through the built-in `forEach`**, never through a method of their
  own, so a subclass that replaces iteration cannot run its code while we scan. If that read fails,
  the collection adds nothing.

**Cannot be reached at all:**

- **A member of a `WeakMap` or a `WeakSet`.** You cannot list them, by design. An instance inside
  one still reaches the tree through the creation frame. Only its key is lost, and `ref#1` is how
  the tree says that.
- **The value inside a `Promise`**, which you can only get through `then`.
- **A property under a symbol key, an inherited property and a non-enumerable own property.** We
  read own enumerable data properties only.
- **A `Map` key that is not a string or a number, as a place in the tree.** There is no name for it
  in your source, so that member gets no node. The entry itself is still drawn inside the value,
  key and all, as `[entry 0]: { [key]: …, [value]: … }`.

**Bounded on purpose:**

- **Ten steps into a binding**, where a property, an index and a key each count as one step. This
  cut is silent, and `maxDepth` moves it.

Nothing bounds how many members of one collection become nodes. A binding holding 5000 stores draws
5000 rows.

**Impossible to detect:** a `Proxy` can catch a property read and run your code. We cannot see one,
so this is a risk we accept. It is the same risk the getter rule above is written against, and it
matters more here than in v1, because the ownership tree reads many more properties.

**A plain object node and a store that owns other stores both carry no label**, so they look alike.
In redux-devtools 3.2.10 a collapsed node previews what is inside it, so the `(value)` key usually
tells the two apart.

**A binding that names a store built in another file never gives that name up.** Once a top-level
binding of yours claims a store, we keep the claim for the life of the page. Delete
`export const $undoable = $draft2.$canUndo` and save: the store was built elsewhere, so the hot
reload does not replace it, and it keeps both the name and the home that the deleted binding gave
it until you reload the page in full. A store that the same file created is not affected: the
reload builds a new one, and no binding has claimed that one yet.

### What the plugin misses

- **Reassignment.** `let $late = atom("a"); $late = atom("b")` registers the first store only.
- **`import * as ns from "nanostores"`** hides which export a call means, so the plugin cannot
  match the callee, and we warn once for that file. A store made this way still reaches the tree
  through adoption, with `type: "unknown"`.
- **A type-only import of `atom` also stops callee matching**, and this case is silent. A type
  import creates no value, so nothing went wrong here. Adoption still reaches the store, with
  `type: "unknown"`.
- **`.vue` and `.svelte` files are untouched.** The plugin reads script files only.
- **A store created inside a store the plugin already wrapped is not registered.** A store made
  inside a computed's callback is a temporary one that the callback builds again on every run.
- **A call that an optional chain can skip is left exactly as you wrote it.** In `a?.b().c` the
  plugin wraps nothing. A wrapper around `a?.b()` would take the `undefined` that the chain gives
  when `a` is null and pass it on to `.c`, which throws. Your code keeps its meaning, and the store
  that call makes stays out of the tree. The rest of such a chain is wrapped as usual: the call the
  chain ends on, because the wrapper there stands outside the whole chain; a call written before
  the first `?.`, which runs whatever the chain does; and any call written as an argument.
- **A store from a dependency that the package map does not name shows `type: "unknown"`.** The
  plugin never reads a file under `node_modules`, and under Vite it could not anyway, because Vite
  pre-bundles dependencies before any plugin runs. Adoption still puts these stores in the tree
  under your own name for them, but with no entry in the map the kind is lost and the marker stays
  careful.
- **A factory declared in module A but called from module B collects entries under A when B hot
  reloads**, because A did not run again and so did not clear itself. Measured: one unrelated edit
  took `$items` from 2 rows to 4. Adopted stores do not have this problem, because they move to the
  module that calls the factory.
- **An edit that leaves a file with nothing to instrument leaves that file's old entries behind.**
  A file gets the header that clears its own stores when it imports a store creator by name, holds
  a call to adopt, or declares a top-level `const`, `let` or `var` under a plain name. A file with
  none of the three never runs that header, so its old entries stay in the tree until you reload
  the page.

### Cost

Normal use is fast enough. **500 stores at 60 writes a second cost 0.51 ms per write**, and the
panel stays usable. While no panel is open, the bridge costs nothing per write: it builds no tree
and sends nothing. **The pause button in the panel works the same way**, so a paused panel costs
the page nothing either. It does not only drop what we send, it stops the work as well.

Four cases are slow, and we know about all four:

| case                                               | cost                                                | what you can do today    |
| -------------------------------------------------- | --------------------------------------------------- | ------------------------ |
| one store holding a 2000-row array                 | 102 ms per write, 12 MB, 10 writes a second at most | nothing                  |
| a route change mounting 100 stores, at 5000 stores | 539 ms freeze                                       | `lifecycleEvents: false` |
| 5000 stores at a high write rate                   | 3 ms per write                                      | `throttle`               |
| one store on a frame loop, 60 writes a second      | 60 full trees a second, `maxAge` full in 8 s        | `autoThrottle`, on       |

The first case is the worst. Half of those 102 ms is the extension writing out 12 MB. That half
runs inside the extension, so no work on our side can make it smaller. Automatic discovery also
means you may never have chosen to track that store.

The last case is the one people really hit, and it is why `autoThrottle` is on. The problem there
is the write rate, not one huge value. Grouping writes together cannot help the first row of the
table, and nothing here makes a value shorter.

There is no cap on how many stores the tree holds. At 2000 entries we warn once, and you decide
what to do about it.
