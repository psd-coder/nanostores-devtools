# Reference

What `nanostores-devtools` draws, and why it draws it that way. The
[README](../README.md) covers install, setup and every option's name and default. This document is
the long half: how a store gets its name, where it lands in the tree, what a timeline row means,
what a value shows, and what the package cannot do.

How the code itself is put together is in [ARCHITECTURE.md](./ARCHITECTURE.md). The words this
project uses in one fixed way are in [GLOSSARY.md](../GLOSSARY.md).

## Contents

- [Two ways a store gets in](#two-ways-a-store-gets-in)
  - [The bundler plugin](#the-bundler-plugin)
  - [`trackStores`](#trackstores)
- [Where a store sits in the tree](#where-a-store-sits-in-the-tree)
  - [The ownership tree](#the-ownership-tree)
  - [The kind of store, after the name](#the-kind-of-store-after-the-name)
  - [One order for a key](#one-order-for-a-key)
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

The plugin reads your source while your dev build runs and makes every store register itself under
its own variable name. It is the same plugin under Vite, webpack and Rspack, and it finds a store in
two ways:

- **By callee.** A call whose callee names something the file imported from `"nanostores"`,
  renamed imports included. This is the way that gives a store its type. It works at any depth:
  variable declarations, object properties, class fields, array elements, inside factories, loops
  and methods.
- **By adoption.** A call standing under a name, whatever the call is. This catches a codebase that
  wraps store creation, such as `const theme = persistentAtom("theme", "dark")` in a file that never
  imports `"nanostores"`. Adoption carries a name, and a type only where the call names an export
  the [package map](#what-each-plugin-option-costs) knows. A call written inside another
  one is adopted as well, because what it hands back is yours either way.

**A store written inside a binding's initializer and assigned to no name of its own takes the
binding's name and a number.**

```js
const $pointerEnd = merged([eventAtom(root, "up"), eventAtom(root, "cancel")]);
const $candidate = filtered(computed([$username, $format], pick), long, "");
```

```
$pointerEnd [store]                 <- what merged returned
$pointerEnd unassigned 1 [store]    <- eventAtom(root, "up")
$pointerEnd unassigned 2 [store]    <- eventAtom(root, "cancel")
$candidate [store]                  <- what filtered returned
$candidate unassigned 1 [computed]  <- the computed written inside it
```

The number counts them in source order and is what tells them apart. Without it two stores written
on one line share a name, a file and a line, which is the whole of a store's identity, and the
second silently takes the first one's place in the registry.

An array is the one exception, and only where the array is the value the binding holds:

```js
const $totals = [atom(0), atom(1)]; // $totals[0], $totals[1]
```

There `$totals[0]` is something you can type and get that store back. In `merged([…])` the array is
handed away and `$pointerEnd` is the atom that came out, so an index off it would point at nothing.

**A call that no name reaches at all is drawn under the name of the call that made it**, as long as
the file imported that callee. This is a store made where it is used rather than where it is
declared:

```jsx
return <Name value={useStore(userStore(id))} />;
```

Nothing names `userStore(id)` here: it is bound to nothing, it is no property, and the function
around it ends the reach of every name. It is drawn as `userStore`, in the file the call is written
in, and two such calls on one line are told apart by number the way any two stores of one line are.

Two cases stay out of this. A callee the file declares itself is a helper of your own, and a member
call such as `api.userStore(id)` names no import either. Without that limit every call in every
function body would carry a wrapper.

A codebase that does not use the `$` prefix gets all of this too: the name a call stands under is
what adoption reads, and the prefix is no part of it.

**`adoptFactories` has two settings**, and the wide rule above is the default:

| setting             | what adoption reaches                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| `true`, the default | a call standing under any name, and a call named after the callee that made it |
| `false`             | nothing: only the calls the plugin recognises are wrapped                      |

**A setting we cannot read is refused**, with a warning naming the option, your value and the two
settings above, and the plugin adopts the default way instead. Only a plain JavaScript config can
get one in; TypeScript refuses it where you wrote it.

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
  listed by hand. A file inside your bundler's root, Vite's `root` or webpack's `context`, keeps its
  short path, `app/model.ts`. A file outside it, such as a linked package or anything above that
  root, is measured from the
  [project root](../README.md#nanostoresdevtoolsoptions) instead of climbing out with `../`. Paths always use
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
                    $canUndo [computed], $history [computed], $position [computed] }
  $entries [computed]: ["", "the ", …]                     <- your own name for a nested store
  counter [store]: { (value): 0, $doubled [computed] }     <- a store with no $ that owns others
app/workspace.ts
  panel: { open [store]: false, width [store]: 320 }       <- what a factory returned
```

#### `(value)`: a store's own value, moved down a level

A store that owns nothing and carries no marker is drawn as v1 drew it: its name, its value.
**`(value)` is where that value goes when it cannot stay at the store's own key**, and two different
things send it there.

**The store owns other stores.** Its own value moves under `(value)` so its children can sit beside
it. Only a store that owns something is wrapped, so a value you can read today stays readable.

**The store carries a marker**, and the marker has nowhere else to ride. See
[an unmounted `computed` shows an old value, or nothing](#an-unmounted-computed-shows-an-old-value-or-nothing)
for that half.

Two more keys are spelled with the same parentheses and mean something else: `(valueOf)` and
`(toString)` name **which method answered** on a class instance that published a reading of itself.
See [what a platform object shows](#what-a-platform-object-shows).

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
members nest under the array. **A member that is a store is keyed by its position too**, `[0] [store]`,
and keeps its own flat slot at its home besides. Only a store a frame or a class field placed, where
no property leads to it, falls back to the name its creation site gave.

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
  store one of your own helpers kept in a closure, where no property leads to it.

**A frame places nothing born in somebody else's file.** It catches every store made while your
expression ran, however many files down, and a store still homed in a library is one that library
kept rather than handed over: `$inputs` inside `resourceAtom`, `$timeline` inside `withUndo`. What a
library does hand you is adopted at your call site and takes your file as its home, and whatever the
returned value carries is reached by the scan through a property — `$value` and `$loading` on a
resource stay exactly where they were. The frame keeps its full reach inside your own files, where a
store in a closure is yours whether or not a property leads to it.

**A frame places nothing that already stands at a site of its own.** A store made at module level is
drawn flat at the file it was written in, because it has no function it could belong to. All the
frame knows is that it was born while some expression ran, and that says when, not what holds it:

```js
const $pointerEnd = merged([
  eventAtom(root, "pointerup"),
  eventAtom(root, "pointercancel"),
]);
```

`merged` keeps its sources in a closure, so nothing on the atom it hands back leads to them. Drawing
them inside it would say that atom holds them. They are siblings of it, and the tree draws all three
flat. What is left for the frame is the case it exists for: a store your own code made **inside a
function**, which nothing else would draw at all.

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

A store the tree leaves out stays in the registry and we still watch it, but it draws no timeline
row of its own either: no register, no mount, no write. A row you cannot trace to anything on
screen, with a diff showing nothing, teaches you to stop reading the timeline.

**The test for that is "can you see it", not "is it in the tree".** Those differ. A store with no
place of its own is still drawn wherever a value you can see holds it, and then its own write is the
only thing that pushes the new tree, so it must keep its row. We note every store the converter draws
inside a value while it writes a snapshot, and a store in neither the tree nor that note draws
nothing:

```
$requested/set          <- you clicked Next
$currentResource/set    <- the response arrived
```

rather than the same two with a `$inputs/set` between them, `$inputs` being a store some library
keeps inside a factory and you have no way to look up.

The note is one snapshot behind, so a store put into a drawn value and written in the same tick
loses that first row. The write that put it there is a drawn store's own write, which sends a row
and refreshes the note, so the window is one turn wide.

The scan and a class field both know a property name, so each is a reference you wrote and each one
draws. A frame only knows that a store was born while some expression ran, so it places a store only
where no reference does. A store is never drawn under itself: an edge that would close a loop is
refused, searching every owner and every parent.

#### Every reference draws

**Every reference you wrote draws. A value is expanded under its first placement, and every other
placement shows it and stops.** A reference is a name you wrote for the value: a top-level binding,
or a key on a container you built. Two bindings for one store are two references, and so are two
containers holding one store.

So a store you bound to a top-level name in one of your own files keeps that name, drawn flat, and
its owner keeps a **repeat** of the same store under the name the owner knows it by.

For `export const $entries = $draft.$history`:

```
$entries [computed]: ["a", "b"]                                    <- the name you wrote
$draft [store]: { (value): "b", $history [computed]: ["a", "b"] }  <- as $draft knows it
```

One entry, one identity, as many keys as your source wrote. With only the first, `$draft` reads as
incomplete. With only the second, the name you chose is lost: `export const $undoable =
$draft2.$canUndo` would be drawn under `$draft2` as `$canUndo`, and `$undoable` would appear nowhere
at all. The value is sent once per placement, because the extension's encoder writes a repeat again
rather than as a pointer. On the tree we measured one such repeat at about 11% more bytes.

**A repeat draws nothing under it.** Its children sit under the placement that expands it, or the
tree would say your app holds twice as many stores as it does. A store repeat still carries its
value, which is the point of a store. A node has no value, so a node repeat carries one key,
`(drawn under)`, holding the home and the name where you can open it:

```
left: { pinned: Viewer {…} }
right: { pinned: Viewer { (drawn under): "app/editor.ts/left" } }
```

**A row calls the store whatever the tree calls it.** A home you chose wins, so a store renamed by
your own binding has its rows renamed too: `$undoable/set`, not `$canUndo/set`. A store only its
owner holds takes that owner's key, so the row says `username/set` where the tree says `username`.
The change inside the row still carries `lensed.ts/$lens`, because that says which file the store
came from and a name its owner chose does not.

**The second key is the property the owner really holds the store at**, not the name the store was
born with. The two agree wherever a util calls its own field what it hands it out as, which is most
of the time. Where they part, the key you wrote wins:

```js
export const fields = {
  username: focus($values, "username"),
  password: focus($values, "password"),
};
```

```
fields: { username [store]: "ada", password [store]: "" }
```

The atom `focus` returns is called `$lens` inside its own file, and two of them side by side would
read as `$lens [store]` and `$lens [store] #2`. Neither name is one you could look up. A frame and a
class field hold the store under no property at all, so those still fall back to the name its
creation site gave.

**A store you passed to `trackStores` is drawn the same way**, at the group you named, with every
owner keeping a repeat. The group is a home you chose by hand, so it beats any owner the walk found.

**Two bindings holding one store both draw**, each at the file that binds it. One entry cannot hold
two names, and every timeline row reads that one name, so the entry takes the exported binding
whichever is scanned first, and two of the same kind pick one arbitrarily. Nothing is lost from the
tree either way.

`trackStores` is the exception: a group makes one entry per store, so two names in one group for one
store keep the first and warn.

**A binding inside somebody else's file places nothing**, neither a name nor a node, because that is
no name you chose.

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

**An `atom` and a store of an unknown kind both read `store`.** A kind is read at build time from
the creator call, or from the [package map](#what-each-plugin-option-costs) where a
known package made the store, so a store listed by hand in a project without the plugin, and a
store from a package the map does not name, have no kind to print. Nothing at runtime can tell a
`map` from a `deepMap`, or a `computed` from a `batched`, so a guess is all we could add.

The two are one word on purpose. `[atom]` would say we read your creation site and `[store]` that
we did not, which is a fact about how much of your source we reached and not about the store. Both
are writable and both hold whatever was last set, so there is nothing you would do differently.

**A store that is being held back says so in the same brackets**, `$frame [store, throttled]`, and
loses the word again when its rate drops. See [`throttle`](../README.md#connectdevtoolsoptions).

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
something else owns leaves that owner a repeat, as [every reference draws](#every-reference-draws)
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
and [`lifecycleEvents`](../README.md#connectdevtoolsoptions) turns all five off together.

A [throttled](../README.md#connectdevtoolsoptions) store draws at most one row a second, or one per the rate its
comment names, and the writes it made inside that time fold into the row that closes it, followers
and all. Its value in the tree stays
current; the steps between those rows are what you lose.

### When stores join and leave

**A register row never means startup.** Everything registered before the first snapshot is already
inside it, so a register row is always a late arrival:

- a code-split chunk loaded, and a file of yours ran for the first time;
- a factory or a loop made another store, `$items [store] #2`;
- a binding adopted a store some other code built;
- `trackStores` ran after `connectDevtools`, which is the usual shape for a dependency's stores.

An unregister row is the opposite: stores left the tree for good. `untrack("cart")` does it, and so
does an edit that deletes the last store in a file. A store dropped by the
[per-site cap](../README.md#nanostoresdevtoolsoptions) says nothing, because the store that pushed it out draws
a row anyway.

Renaming changes no rows. A store that gains a name from your binding, a kind from adoption or a
group from `trackStores` keeps its entry, so it neither joins nor leaves.

### A hot reload draws one row, not a pair

A file that both loses stores and gains stores while it runs again was hot reloaded. The two halves
become one row, `src/stores/cart.ts/hotReload`, or `$count/hotReload` when only one store moved.

Inside the row each store carries its own word: `hotReload` for a store that came back, `register`
for one your edit added, `unregister` for one it dropped. So the row tells you what the edit did,
and a pair of registry rows never has to be recognised as your own save.

## What each `connectDevtools` option costs

Every option's name, type and default is in the [README](../README.md#connectdevtoolsoptions). This
section is what the table cannot say: what each one buys, and what it costs when you change it.

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

**`autoThrottle` is on, and it is the one default that drops rows.** A store that writes more than
10 times a second is held to **one row a second** from the write that passes that count. Its first
write in a second draws a row at once, the writes after it inside that second draw none, and the
last of them draws the row that closes the second. We warn once, naming the store and the ways to
say something else.

**A store it picks up stays throttled for the rest of the session.** The rate is a fact about the
store, not about the moment: a frame loop that pauses, or a countdown between two runs, would
otherwise be let go and picked up again over and over, and the timeline would flip between full
rows and thinned ones while you read it. A reload starts every store clean again, and so does a hot
reload that builds the store again, because that is a new store to us.

**The tree is never behind, only the steps between rows are lost.** Every row carries the whole
tree, so the value a throttled store shows is its current one. What you cannot do is click your way
through the writes in between, because they are no rows. A throttled store says so in the panel:
its key reads `$frame [store, throttled]`, and it keeps the word from the write that trips it.

A frame loop writes about 60 times a second, so it costs about 60 full trees a second without this.
That is what fills `maxAge` in eight seconds and pushes every row you came to read out of the panel.

Pass your own threshold, `autoThrottle: 20`, or `false` to keep every row. What comes out is
one row a second, and the plugin's comment below is the only way to hold one store to another rate,
or to keep every row of one store while the rest still gets caught.

**`throttle` says it on purpose, and turns the warning off.** It takes the names as the tree writes
them, `"home/name"`, or a rule over them:

```ts
connectDevtools({ throttle: ["src/model.ts/$remaining"] });
connectDevtools({
  throttle: (store) => store.home.startsWith("src/animation/"),
});
```

A rule is handed `{ home, name, type }` and runs when a store registers, is renamed or moves, never
per write. The name is the one you read in the tree, without the file and line a clash adds to it,
so an edit that moves a line does not break the match.

The plugin reads a comment for the same thing, next to the store, where a rename cannot lose it:

```ts
// @nanostores-devtools:throttle
const $remaining = countdownAtom($delay, { interval: TICK });
```

The comment marks the whole statement below it, so a call that makes several stores marks all of
them. Either channel alone is enough, and a store you marked by hand never warns.

**The comment also takes a rate of its own**, in milliseconds:

```ts
// @nanostores-devtools:throttle 100
const $frame = atom(0);
```

That store draws one row per 100ms, and every other throttled store keeps the default second. Edit
the number and the reload the edit causes carries the new rate. Anything that is not a positive
number of milliseconds, `// @nanostores-devtools:throttle 100ms`, still marks the store, at the
default rate: the mark is what the comment is for, and a rate nobody can read must not cost you one.

**`// @nanostores-devtools:no-throttle` keeps every row of one store**, which is the other half of
the same comment:

```ts
// @nanostores-devtools:no-throttle
const $frame = atom(0);
```

That store writes fast on purpose, so `autoThrottle` never takes it over, however fast it writes,
and it never warns. It reaches the whole statement below it, the way the mark does, and anything
written behind the word leaves the store spared all the same. It says nothing about the other two
channels: a store you named in `throttle`, or marked with `// @nanostores-devtools:throttle`, is
throttled because you asked for it, and a statement carrying both comments follows the mark.

**A follower rides in the row its source opened**, so marking one store quiets the whole chain
behind it and no computed needs a mark of its own. Lifecycle rows are never throttled;
`lifecycleEvents: false` is the lever for those.

**`// @nanostores-devtools:ignore` keeps a store out of the devtools altogether**, which is the
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
that makes several stores keeps all of them out, and anything written behind the word leaves the
statement ignored all the same. **Ignoring beats throttling** over one statement: a store nobody
draws has no rate, so a statement carrying both comments is ignored.

**Only that statement is left alone.** Every other store in the file is instrumented as usual. Two
cases are worth knowing. A comment over an `import` line still lets the import be read, so the
creators it brings in keep naming the stores below it. And a file that imports a creator keeps the
one-line header the plugin injects even when every store in it is ignored, because that header
carries the clear a hot reload needs.

**`trackStores` is the way back in.** The bridge never hears about the comment, so a store you
ignored and then passed to `trackStores("secrets", { $session })` registers by hand and is drawn
under that group. Use it when you want one build to draw a store the source keeps out; delete the
comment when you want it back for good.

**A comment cannot reach a store a dependency makes.** The plugin reads your own source and never a
file under `node_modules`, so a store built inside a dependency has no statement of yours to mark.
Such a store is in the tree only because you named it in `trackStores`, and dropping that name, or
calling `untrack`, is what keeps it out.

**A `@nanostores-devtools` comment the plugin cannot read warns instead of acting.**
`// @nanostores-devtools:ignored` names none of the three, so it is read as prose and the store
below it stays drawn. So does `// @nanostores-devtools-throttle`, with a hyphen where the colon
belongs: the plugin reads the namespace and everything written onto it, so both forms warn rather
than pass as prose. The plugin warns once through your bundler, naming the file, the line, what you
wrote and the three comments it reads: `@nanostores-devtools:ignore`,
`@nanostores-devtools:throttle`, `@nanostores-devtools:no-throttle`. Read that warning as your file
not doing what it looks like it does.

A custom serializer is `{ match: (value) => boolean, convert: (value) => unknown }`. Serializers
run in array order, first match wins, ahead of every rule of ours.

**What `convert` returns may hold its own input.** The encoder walks that result too, and none of
your serializers runs again on a value inside it, so a `convert` returning `{ point: value }` draws
your wrapper with the `Point` inside it drawn by our rules, and the walk ends. Your rule already ran
over the whole tree it built, which is also what it costs: a result that a later serializer's
`match` would match does not reach that serializer either.

**Put the values of a result in plain properties, not behind getters.** Your result is the one thing
the bridge hands to the encoder as it is, and the encoder reads it with plain reads, so **a getter on
your result does run**. The bridge tracks the result's values through property descriptors instead,
which is what keeps them out of your serializers, and a value behind a getter is invisible to that
tracking. Two things follow: your getter's answer reaches the panel without any rule of yours seeing
it, and a getter handing back the input converts it over and over, so that one slot shows
`ConversionError` and the rest of the tree still reaches the panel.

**A `Map` and a `Set` are keyed by the bridge, and no list of ours reaches your rules.** We read
both into an array on the way, and that array never leaves the bridge, so a rule as wide as
`match: Array.isArray` leaves a collection as it is. The keys, the values and the members inside one
are your app's, and every rule you wrote still runs on them.

The one collection the encoder still writes by itself is one **your own `convert` returned**. It
builds a list out of it there, and neither that list nor a `[key, value]` pair inside it reaches
your serializers.

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

Each of the first five draws `<Headers> {}` without the rule, because none of them holds own data or
publishes a reading of itself. A boxed string drew one key per character, so a 10 000-character one
cost 10 000 keys.

Your own rules are checked first, so a rule you wrote for one of these values wins. Ours are checked
before every other rule of the bridge.

**A name that repeats takes a number**: a `FormData` or a `URLSearchParams` holding `tag` twice
draws `tag` and `tag #2`, in the order the entries went in, because one key holds one entry. A field
really named `tag #2` reads the same way, which is what this costs.

Pass `platformSerializers: false` to leave the whole list out. Those values then draw the way every
other class instance does.

**`maxValueDepth` and `maxValueMembers` cap only what a class instance holds.** Everything you
shaped yourself goes out whole, however large: the two counts start where the walk enters a class
instance, and a plain object, an array or a collection above one is never touched. Raise either
number, or pass `Infinity` for no cap. Your own
serializer runs before the caps, because a rule you wrote is the exact tool for shrinking a deep
value, and a store below the caps keeps its whole value. See
[values are shortened only under a class instance](#values-are-shortened-only-under-a-class-instance).

## What each plugin option costs

Every option's name, type and default is in the [README](../README.md#nanostoresdevtoolsoptions).

First, what a **creation site** is, because the cap below only makes sense once this word does.
**A site is one place in your source where a store is made, not one store.** A site inside a
factory or a loop makes a new store every time it runs, and all of them share one name. The
registry holds strong references on purpose, so nothing leaves it on its own.

`maxStoresPerSite` keeps the last 50 live stores of a site. It evicts unmounted stores first,
oldest of those first, and never the store just made. So **a table with 200 rows, one store per
row, all from one factory line, shows 50 of them.** The number 50 is a guess; only the eviction
order is settled. Stores registered through `trackStores` have no site and no cap, because you
wrote each one by hand.

**It takes a whole number of 1 or more, or `Infinity` for no cap.** Anything else is refused with
a warning naming the option and your value, and the plugin holds 50 per site instead: `0`, a
number below zero, a fraction and `NaN` each say something no count of stores can be made of.

**`storeTypes` gives an adopted store its kind, and nothing else.** It maps a package name to that
package's store making exports, and each export to the kind it returns. We ship entries for the
packages on the Smart Stores list in the nanostores README, read off each package's own source, so
`persistentAtom` reads as an atom and `persistentMap` as a map. Your own entries are laid over ours
per package and per export, so correcting one export restates nothing else.

**It does not find stores.** Finding one is adoption's job, so a package with no entry reaches the
tree exactly as before, only without a kind, and turning `adoptFactories` off takes the map with it.
A kind from the map beats the nothing an adoption site carries and loses to the kind the creator
call itself gave the store.

**It reads the export name, not the local one**, so `import { persistentAtom as stored }` still
lands. It reads a named import only: `import * as persistent` and a default import both say nothing
about which export a later call means.

**An entry for an export a package does not have is silent.** Nothing reads an entry until a file
imports that name from that package, so a typo, a renamed export and a package you no longer use
all cost you the kind and nothing more.

**A kind is one of `atom`, `map`, `deepMap`, `computed`, `batched` or `unknown`**, which is what the
tree prints in square brackets. Four packages on that list have no entry, because none of them
exports a function that returns a store: `@nanostores/query` builds its creators inside a
`nanoquery()` call, and `@vp-tw/nanostores-storage`, `@vp-tw/nanostores-data-layer` and
`@vp-tw/nanostores-qs` each keep their stores on a property of something else. Write your own entry
for a package we do not ship, and for one of your own.

**`fileKey` receives the home as the tree would show it**, so a file inside your bundler's root
arrives relative to that root and a file outside it arrives relative to the wider one, `projectRoot`
under Vite and the climb above `context` under webpack and Rspack. It only changes what
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

**`projectRoot` is a Vite option.** Under webpack and Rspack the wider root is always the climb
above `context`. That climb stops at three markers: `pnpm-workspace.yaml`, `lerna.json` and a
`workspaces` field in a `package.json`.

**`projectRoot` defaults to Vite's own `searchForWorkspaceRoot`**, which stops at the same
`pnpm-workspace.yaml`, `lerna.json` and `workspaces` field, plus one more our climb does not read:
a `deno.json` or `deno.jsonc` holding a `workspace` field. So a Deno workspace is the one place the
two stop differently. That is right for a real app: a linked package then reads as
`packages/…`. Pin it when that default sits so high above your app that every external home gets
long. It changes no path inside the Vite root. A file the project root cannot reach either keeps its
full path, which still opens in an editor.

**Every source file is parsed, and there is no option to stop it.** Parsing costs about 0.02 ms per
file, paid once per file per dev build, because a bundler caches the transform of a file it has
already read. That buys the file
whose own text says nothing about stores, such as `export const panel = createPanel()` in a file
that imports no nanostores: nothing else says the factory result holds those stores, and a store
nothing places is drawn nowhere, so skipping that file would lose it rather than move it.

On **Vite 8** the plugin costs you nothing extra: Vite re-exports the parser it needs. **Vite 6 and
7, webpack and Rspack** all need `oxc-parser` as a dev dependency instead, because none of them
ships a parser this plugin can borrow. It is declared here as an optional peer, since a peer is
declared for the package and never for one subpath, so a Vite 8 user is not handed a package they
never load.

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

Pause and export stay on. Both use state the panel already holds. Pause stops both halves: we build
no tree and send nothing while it is on, so the page pays nothing either. Lifting it changes no row
already in the panel; the next write brings the current tree.

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
under.

**That boxing is the extension's limit, not a choice of ours.** A marker rides in the extension's
own `__serializedType__` wrapper, and the extension's reviver hangs it on the object it is about,
under a symbol key. So the marker needs an object it can be hung on, and four kinds of value cannot
give it one:

- **a primitive, and `null`**, which never come back through the reviver at all;
- **a `Date` and a `RegExp`**, which travel as a `{ $jsan: … }` object, so decoding replaces the
  object the marker was written onto and the marker goes with it;
- **anything we already marked**, a `Map` and a `Set` included, because two markers on one object
  leave only the outer one;
- **a value that can reach the store back**, because the extension's encoder writes a repeat of an
  ancestor as a pointer, and a pointer replaces the object the marker was written onto.

A plain object and an array with no way back to the store are what is left, and both go in bare.
Boxing costs one level and never loses a word, so everything else takes the box.

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

### Values are shortened only under a class instance

**A value you designed is never shortened.** A plain object twenty levels deep, an array of two
thousand rows, a `Map` of ten thousand entries: all of them go out whole, however large, and no
option changes that.

**Two counts start where the walk enters a class instance**, and they apply to everything below that
point:

- `maxValueDepth`, `5` by default, is how many levels are drawn below the instance. A value past it
  keeps its class name and shows one line: `(value): "past the 5 levels drawn under a class
instance"`.
- `maxValueMembers`, `100` by default, is how many members are drawn per shape: an instance's own
  fields, and a plain object, an array, a `Set`, a `Map` or a typed array below it. The rest are
  counted under one key, `…`, labelled `1901 more members past the 100 drawn under a class
instance` over an empty object. It is
  the first 100 in source order, and a store past that point loses this node but keeps its own slot
  at its home.

Raise either one, or pass `Infinity` to turn it off:

```js
connectDevtools({ maxValueDepth: 12, maxValueMembers: Infinity });
```

`maxValueDepth` takes a whole number of 0 or more, where `0` draws an instance's own fields and
makes every object among them a placeholder. `maxValueMembers` takes a whole number of 1 or more.
Any other number is refused rather than repaired, with one console warning per option name and the
default in its place.

**A store below the cap keeps its whole value.** One store must not disagree with itself between two
placements: a store drawn deep inside a class instance and the same store drawn at its own home have
to show the same value, and the home slot has no cap above it. It stays bounded, because a class
instance inside that value starts a fresh count.

**Why a class instance is the line.** A plain object is state you wrote and shaped for yourself. A
class instance is where a value the panel was never designed for begins: a framework's node, a
platform interface, a scene graph. Five levels reads a real domain object whole
(`Editor → doc → blocks → Block → id` is four), and 100 members clears the widest record an app
writes for itself, a settings object or a row of a table, whole.

Two limits stay as they were. A repeat is still written once per path, not pointed at, and a
serializer's own result is not width-capped.

Other things values do:

- **A value that refers back to itself is written as a `$.path` pointer.** The extension's own
  encoder does this to make a loop safe to write. A plain repeat is not: the same object in two
  places is written out twice, because the option that would collapse it is off in the extension's
  defaults. This is the price of letting a `Date` and a `RegExp` render as themselves in the panel.
- **A getter is never read**, whoever wrote it, because it can run app code. The one exception is the
  `stack` accessor V8 puts on an error itself: refusing it would drop the stack from every error, and
  a devtools with no stack traces is worth less than the risk. Reading it can run
  `Error.prepareStackTrace` if the app installed one, and it makes V8 read `name` and `message` off
  the error.
- **A method is left out.** An object's own property holding a function does not reach the panel:
  `{ id, $checked, toggle, add }` arrives as `{ id, $checked }`. The panel draws state, and a
  method beside the stores it writes says nothing your source does not. A value that is itself a
  function still arrives, with its body stripped, and so does a function at an array index, because
  there the position is part of the shape.
- **`-0` arrives as `0`.**
- **A custom serializer has no reviver.** The bridge encodes only, and v1 never reads state back.
- **A labelled value inside a `Map` a `convert` of yours returned keeps its wrapper**, so you read
  `{ data, __serializedType__ }` there instead of a label in front of the value. The extension's
  own encoder writes that collection as one string and reads it back without its reviver, so nothing
  inside it is ever unwrapped. It hits every labelled value: an `Error`, a class instance, a typed
  array, a `BigInt`, a DOM node, a store, and a slot that failed to convert. A `Map` or a `Set` your
  app holds is keyed by the bridge instead and has no such problem.

An `Error` keeps its name, message, stack, cause and own fields. A class instance keeps its class
name. A typed array and a `BigInt` each keep something readable. A value that throws
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

**A `Map` and a `Set` are keyed the same way**, and unconditionally, which is where they part from
an array. `["scratch"]` for a `Map` key your source could write, `[0]` for a `Set` position:

```
$columns [store]   Set
  [0]: "name"
  [1]: "size"

$editors [store]   Map
  ["draft"] [store]:  "Berlin"
```

The reason is not the key, it is the label. The panel draws a `Map`, a `Set` and anything else with
an iterator with one node kind, and that node writes **`Iterable`** over the name it worked out. A
collection the encoder renders itself therefore cannot say which of the two it is. Keying it buys
the name back, and costs the `2 entries` count the panel writes for that node kind alone.

The one wrapper left is the `[key]` half of a `Map` entry whose key is not a string or a number.
There is no name in your source for such a key, so the entry keeps the encoder's own shape,
`[entry 0]: { [key]: …, [value]: … }`, and a store sitting in either half is wrapped there.

The word is the kind the bridge knows: `map`, `deepMap`, `computed` or `batched`. An `atom`, and a
store whose kind the bridge never learned, both say the plain word `store`. An unmounted store keeps
its note beside the kind, `$total [computed]: not mounted, may be stale { … }`.

One shape is left over. **A store whose value can reach that store again keeps the wrapper**, with
the kind in front of the value and no kind in the key. That loop is what the extension's encoder
finds by the path it built, and it only finds it while the wrapper's own key stands in that path.

### What an object's own fields show

**Almost every value the bridge draws starts here: its own fields.** One rule, and it reaches a plain
object, a class instance and an `Error`. The one thing it does not reach is a result your own
serializer returned, which goes to the encoder untouched.

**A field counts when it is own, enumerable, named by a string, and holds a plain value.** Each of
those four is doing work:

| the value holds               | what arrives         | why                                                             |
| ----------------------------- | -------------------- | --------------------------------------------------------------- |
| `{ open: true, width: 320 }`  | both                 | ordinary state                                                  |
| a getter you wrote            | nothing for that key | reading it runs your code                                       |
| a method, `toggle() {}`       | nothing for that key | the panel draws state, and your source already spells behaviour |
| a symbol key                  | nothing for that key | there is no name to draw                                        |
| a key you made non-enumerable | nothing for that key | you already marked it internal                                  |

A function is dropped **wherever it sits at a key**, whether or not you would call it a method. It
still arrives in the two places where the function is the state itself: as a store's own value, and
at an array index. Both come with the body stripped.

**Keys arrive in the order the value lists them, and the panel does not sort.** That order is
JavaScript's own: any key that looks like an array index comes first in numeric order, then the rest
in the order they were assigned. So a class draws its fields in assignment order, class fields before
whatever the constructor body added.

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

**A prototype is never walked for fields.** Only what sits on the value itself is read, so a field
your class declared on its prototype does not arrive. The prototype is still read for two things that
are not fields: the class name in front of the value, and the `valueOf` or `toString` a value with no
own fields is asked for. An `Error` is read by name rather than by this rule, and its four names are
looked up along the chain.

**Own fields win over everything else a value could say.** A class that writes a `toString` is asked
for it only when it has no own field at all:

```
class Priced { amount = 500;  toString() { return "$5.00" } }
class Silent  {               toString() { return "$5.00" } }

$a [store]: Priced { amount: 500 }          <- the method is never called
$b [store]: Silent { (toString): "$5.00" }
```

See [what a platform object shows](#what-a-platform-object-shows) for the second half of that rule.

**Where the fields are read from, in one table:**

| value                                    | what it draws                                                       |
| ---------------------------------------- | ------------------------------------------------------------------- |
| a plain object, or one with no prototype | its own fields                                                      |
| a class instance                         | its own fields, then its class name in front                        |
| an `Error`                               | `name`, `message`, `stack` and `cause`, then its own fields on top  |
| a result your `convert` returned         | nothing of this rule: the encoder reads it plainly, getters and all |
| an array                                 | its own **indices**, read one by one, and never its named keys      |
| a `Map`, a `Set`                         | its entries, read through the built-in `forEach`                    |
| a typed array                            | its elements                                                        |
| a DOM node                               | **nothing** — see below                                             |
| the global object                        | **nothing** — see below                                             |

The last two are the only values whose own fields are skipped on purpose, and each has a reason
worth knowing:

- **A DOM node.** A framework parks its own state on an element as an ordinary property, React's
  `__reactFiber$…` above all. Reading those would pull a whole render tree into any row holding an
  element.
- **The global object.** Everything you park on `window`, by assignment or by a top-level `var`, is
  an own enumerable property. Its keys are never even listed.

**An object that refuses to be read gives up all of it, not half.** Listing keys and reading a
descriptor can both be trapped on a `Proxy`, and a trap of yours may throw. Half an object is worse
to read than none, so nothing partial is ever drawn. The keys are listed once before any rule runs,
so in practice such a value fills its one slot with `ConversionError`, and the rest of the tree still
arrives.

**Nesting keeps the same rule at every level**, and a plain object inside a class instance does not
escape the caps by being plain:

```
$editor [store]: Holder {
  at: Point {
    x: 1
    y: 2
  }
  label: "one"
}
```

The one thing that trims this list is the width cap, and only under a class instance. See
[values are shortened only under a class instance](#values-are-shortened-only-under-a-class-instance).

### What a platform object shows

**A class instance is drawn by [the own data it holds](#what-an-objects-own-fields-show).** An event,
a `DOMRect`, a `Blob` and an `AbortSignal` hold none: every field on them is a getter on their
prototype, and a getter is never read, whoever wrote it. So each of them draws its class name over an
empty object:

```
$lastMove [store]: <MouseEvent> {}
$viewport [store]: <DOMRect> {}
```

**A class that wrote down how it reads gets that reading instead.** Where an instance holds no own
data, a `valueOf` and a `toString` **the class itself defines** are called, and each answer takes a
key naming the method that gave it:

```
$link [store]: <URL> {
  (toString): "https://a.dev/x?q=1"
}
$price [store]: <Money> {
  (valueOf): 500
  (toString): "$5.00"
}
```

`Object.prototype`'s own two are refused: its `toString` gives `[object MouseEvent]`, which says
nothing the class name does not, and its `valueOf` hands the object straight back. That one test is
the whole rule, so no list of classes is kept anywhere. It is also why a `URL` and a `Location` keep
their address while an event does not: those two write a `toString` and an event does not.

**This is the one place the bridge runs a line of your code**, and every part of the rule is a bound:

- **only where there is no own data**, so every ordinary object of yours runs nothing at all
- **the method is found through a property descriptor**, so a `toString` sitting behind a getter is
  refused like every other getter
- **called by name**, never through `String(value)`, which would run `Symbol.toPrimitive` and a
  chain of its own
- **only a primitive answer is kept**; an object, `null` and `undefined` are dropped
- **a method that throws costs its own key**, and the other key and the class name still arrive

If you wrote a `toString` with a side effect, this is the paragraph you needed: it runs while a
snapshot is written.

**For every other field, write one rule over the class you hold.** The bridge cannot choose which
fields of an interface matter, and you can:

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
the same shape. [`connectDevtools(options?)`](../README.md#connectdevtoolsoptions) has the full contract.

**One trap.** A platform object **inside** your result meets no serializer either, ours included, so
it draws its class name and nothing else. Spell it out in your own rule:
`{ headers: Object.fromEntries(response.headers) }`, not `{ headers: response.headers }`, which
draws `<Headers> {}`.

Three things read without a rule of yours, so the loss is bounded to objects that keep everything
behind getters:

- **A DOM node** takes the same rule: a `<div>` draws `HTMLDivElement {}`, and an `<a>` draws its
  href under `(toString)`, because `HTMLAnchorElement` writes one. What a node never shows is a
  property the app or a framework parked on it, React's fiber above all, which would otherwise pull
  a whole render tree into the row.
- **The window your page runs in is never walked**, wherever the row reaches it from: `self`,
  `frames`, `currentTarget` on a `window` listener, and `top` or `parent` while the page is not
  framed. It draws its class name alone, `Window {}`, so whatever you parked on `window` costs no
  keys at all. A window from another realm, an iframe's or a `window.open` result,
  is read as an ordinary object of its class, because the test is identity.
- **A few classes take a rule of ours**: a `Headers`, a `FormData`, a `URLSearchParams`, an
  `ArrayBuffer`, a `SharedArrayBuffer`, a `DataView` and a boxed `String`, `Number` or `Boolean`.
  Those run before yours is even asked, and
  [`connectDevtools(options?)`](../README.md#connectdevtoolsoptions) has the list and the option that turns it
  off.

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

- **A value behind a getter is never read**, whoever wrote it. A getter runs code, and running it
  would change how the app behaves. A store held only behind a getter still reaches the tree; it just
  sits where it was made rather than under the object that holds it. See
  [what a platform object shows](#what-a-platform-object-shows) for what an object made only of
  getters draws instead.
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
- **A `Map` key that is not a string or a number, as a place in the tree.** There is no name for it
  that exists in your source, so that member gets no node. The entry itself is still drawn inside
  the value, key and all, as `[entry 0]: { [key]: …, [value]: … }`.

**Bounded on purpose:**

- **25 members of one collection** become nodes. **The tree says what it left out**, as one extra
  key `…` labelled `5 more members past the 25 walked; their stores are listed here without a node
of their own`. No store is lost: the ones past the cap sit on the collection itself, keeping the
  numbers the registry gave them, such as `open [store] #30`.
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

### What the plugin misses

- **Reassignment.** `let $late = atom("a"); $late = atom("b")` registers the first store only.
- **`import * as ns from "nanostores"`** gets no callee matching, and we warn once for that file.
  A store it makes still reaches the tree through adoption, with `type: "unknown"`.
- **A type-only import of `atom` gives no callee matching either**, and this one is silent: a type
  import creates no value, so there is nothing there to have gone wrong. Adoption still reaches
  the store, with `type: "unknown"`.
- **`.vue` and `.svelte` files are untouched.** The plugin reads script files only.
- **A store created inside an already instrumented store is not registered.** A store made inside
  a computed's callback is a temporary that the callback rebuilds on every run.
- **A call an optional chain can skip is left exactly as you wrote it.** In `a?.b().c` the plugin
  wraps nothing: a wrapper around `a?.b()` would take the `undefined` the chain gives when `a` is
  null and hand it on to `.c`, which throws. Your code keeps its meaning, and the store that call
  makes stays out of the tree. The rest of such a chain is wrapped the usual way: the call the chain
  ends on, because the wrapper there stands outside the whole chain, a call written before the first
  `?.`, which runs whatever the chain does, and any call standing in an argument.
- **A store from a dependency the package map does not name shows `type: "unknown"`.** The plugin
  never reads a file under `node_modules`, and under Vite it could not anyway: Vite pre-bundles
  dependencies before any plugin runs. Adoption still puts them in the tree under your own name for
  them, but without an entry in the map the type is lost and the marker stays conservative.
- **A factory defined in module A but called from module B piles up entries under A when B hot
  reloads**, because A did not run again and so did not clear itself. Measured: one unrelated edit
  took `$items` from 2 rows to 4. The per-site cap keeps the count bounded, and it drops the
  unmounted stores first. Adopted stores do not have this problem, because they move to the
  calling module.
- **An edit that leaves a file with nothing at all to instrument leaves that file's old entries
  behind.** A file gets the header that clears its own stores when it imports a store creator by
  name, holds a call to adopt, or declares a top-level `const`, `let` or `var` under a plain name. A
  file left with none of the three never runs that header, so its old entries stay in the tree until
  you reload the page.

### Cost

The ordinary case is fast enough. **500 stores at 60 writes a second cost 0.51 ms per write**, and
the panel keeps working. While no panel is open the bridge costs nothing per write at all: it
builds no tree and sends nothing. **The panel's pause button reads the same way**, so a paused
panel costs the page nothing either, rather than only dropping what we send.

Four cases stay slow, and we know about all four:

| case                                               | cost                                                | what you can do today    |
| -------------------------------------------------- | --------------------------------------------------- | ------------------------ |
| one store holding a 2000-row array                 | 102 ms per write, 12 MB, 10 writes a second at most | nothing                  |
| a route change mounting 100 stores, at 5000 stores | 539 ms freeze                                       | `lifecycleEvents: false` |
| 5000 stores at a high write rate                   | 3 ms per write                                      | `throttle`               |
| one store on a frame loop, 60 writes a second      | 60 full trees a second, `maxAge` full in 8 s        | `autoThrottle`, on       |

The first one is the worst. Half of those 102 ms is the extension writing out 12 MB. That half is
inside the extension, so no work on our side can make it smaller. Automatic discovery also means
you may never have chosen to track that store.

The last one is the wall people actually hit, and it is why `autoThrottle` is on: a rate, not one
oversized value. Coalescing cannot help the first row of this table, and nothing here shortens a
value.

There is no cap on how many stores the tree holds. At 2000 entries we warn once, and the choice
what to do about it stays yours.
