# Glossary

Words this project uses in one fixed way. Shared vocabulary for anyone reading the source, a
ticket or a pull request.

An entry says what a word means and where the code keeps it. The rules behind a word live in
[docs/REFERENCE.md](docs/REFERENCE.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and a word
for a thing nobody built has no entry at all.

**Bridge** — our code. It sits between the app's nanostores stores and the
redux-devtools extension and translates one into the other. It is not a devtools UI and
it is not a fork of the extension.

**Extension** — the redux-devtools browser extension, installed by the user. We only
speak its protocol.

**Model** — the half of the bridge that holds facts about the app's stores: which ones exist, what
owns what, what each is called, what the tree of them looks like, what changed and when, and what a
value really holds. It is every file under `src/` outside `src/redux/` and `src/testing/`, grouped
by the question it answers: `src/stores/`, `src/tree/`, `src/timeline/`, `src/values/` and
`src/utils/`, with the entry points and the state they share left at `src/`. It knows nothing about
the extension, and hands its answers out as records rather than as strings a reader would have to
parse back. A model file never imports a view file, and `src/boundary.test.ts` fails on one that
does.

**View** — the half of the bridge that speaks one devtools client's protocol and nothing else: the
connection, the message shapes, the config, every key string and the jsan replacer. Today there is
one, in `src/redux/*.ts`. It is free to import the model, it supplies a session
(`src/session.ts`), and its value walk owes `noteDrawn` for every store it draws.

**Registry** — the thing inside the bridge that knows which stores exist and what each
one is called. Both ways in (the explicit map and automatic discovery) write to the same
registry.

**Entry** — one store's record in the registry. The registry maps the store object to its
entry, so the object is what makes an entry unique, never its name.

**Home** — the top level of the tree, holding everything one file or one group put there. A
file path for a store the plugin found, a group name for one registered by hand. A file
inside the bundler's root keeps its short path, `app/model.ts`. A file outside it is measured from
the project root, `vendor/withUndo.ts`, instead of climbing out of that root with `../`.

**Group** — the name a developer must give when registering stores by hand. It takes a
file's place in the tree for stores the plugin did not find, it holds a store the walk gave an
owner as well, and it is also the unit that `untrack` removes.

**Label** — home, a slash, then the store name with its qualifier:
`src/stores/cart.ts/$counter (line 20)` or `cart/$counter`. Internal, and a string for a reader: a
message prints it and nothing keys on it. Two other things do the keying. The **entry id** is which
registration this is, a number handed out once and never reused, and every warning about one store
is held to one by it. The **name key** is which name a record holds, and taking one that is already
held replaces the store behind it, which is why the qualifier is part of the name.

**Tree** — what the app's stores look like once the bridge has arranged them: homes on top, and
below each home a store under whatever built it, at any depth. The **model** owns it, as the
`TreeModel` that `src/tree/tree.ts` builds, and it holds records rather than strings. The **view**
turns it into the single state object the extension is sent, in `src/redux/render.ts`. The extension
expects one root state; nanostores has none, so the bridge invents this. The home level exists to
keep two stores with the same name apart.

**Type note** — the store's type in square brackets behind its name, `$total [computed]`. It rides
on a key and never on the name or the label, which stay bare. Every store carries one, and an `atom`
and an unknown type both read `store`. It sits straight behind the name, in front of anything else
the key carries, and every key pointing at a store takes one, a collection position such as
`[0] [store]` included.

**Timeline entry** — one row in the extension's list of changes. The extension calls these actions.
Nanostores has no actions, so the bridge invents each entry from a store change, and one entry holds
exactly one direct write and the followers it caused. It calls a store whatever the tree calls it,
and the change inside it keeps the store's label, which says which file it came from. The **model**
owns the row and holds no word of it; the **view** spells it, in `src/redux/row.ts`.

**Direct write** — a change to an `atom`, `map` or `deepMap`. The app caused it, so it opens
a new timeline entry and gives the entry its name.

**Follower** — a change to a `computed` store, caused by one of its sources changing rather
than by the app. It joins the open entry instead of starting one. Only a mounted computed
can be a follower, because an unmounted one never recomputes.

**Throttled** — a store held to one timeline entry a second. The first write draws an entry at once,
a write inside the second after it draws none, and the last of those draws the entry that closes the
second, carrying the current tree. Followers ride inside the entry their write opened, so throttling
one store throttles the cascade behind it. Three things set it and they set the same state: the
`throttle` option, the `// @nanostores-devtools:throttle` comment, which alone can name another rate
in milliseconds, and `autoThrottle`, which catches a store writing more than ten times a second and
holds it for the rest of the session. The tree is never behind; only the steps between entries are
lost. The tree key says the word while it holds: `$frame [store, throttled]`.

**Devtools comment** — one of the three `// @nanostores-devtools:` comments the plugin reads while
it walks your source: `:throttle`, which can name a rate in milliseconds, `:no-throttle` and
`:ignore`. The package name is the namespace and the colon is the one separator. Each one stands on
its own line and puts a **mark** on the whole statement below it, so a call that makes several
stores marks all of them. Only the plugin reads them, nothing about a comment reaches the runtime,
and one that opens with the namespace and names none of the three is read as prose and warned about.
This is not **Marker**, which is a view word.

**Ignored** — a store the developer kept out of the devtools with `// @nanostores-devtools:ignore`.
The plugin wraps nothing in the statement below that comment, so the store never registers, takes no
key in the tree and draws no timeline entry: the bridge is never told it exists. Ignoring beats
throttling over the same statement, because a store nobody draws has no rate. **Explicit
registration** is the way back in, and it knows nothing about the comment.

**Synthesized name** — the name of a timeline entry, built by the bridge from the store
name and the kind of change, for example `$counter/set`. Every entry gets one: v1 has no
way for a developer to name a change by hand. The **model** picks which store the entry points at
and what happened to it; the **view** writes the name out, the `/` and the op word included.

**Explicit registration** — the developer hands the bridge a group name and an object of
stores: `trackStores("cart", { $counter })`. The object key is the store name. Group first
and required, which is deliberately not the shape `@nanostores/logger` uses.

**Automatic discovery** — finding store creation in the source at build time and making each
store register itself, carrying its variable name. The finding is one bundler-neutral core in
`src/discovery/`, and an adapter beside it reaches one bundler with it.

**Adapter** — the one file that turns discovery into a plugin for one bundler, and the only file
that is allowed to know that bundler's words. It answers six things: whether this build is a
development one, how the walk is made to run first, the roots a home is measured from, the shape of
a module id, the hot-reload line the injected header carries, and the channel a warning is printed
through. The walk, the rewrite, the skip rules and every name in the tree sit behind those answers
and are shared. Today there are three, `discovery/vite.ts`, `discovery/webpack.ts` and
`discovery/rspack.ts`.

**Creation site** — one place in the source where a store is made, identified by module,
name, enclosing function and line. The line is the one the developer wrote, which is why the
walk runs before anything rewrites the file. It is not the same as a store: one site makes a
new store every time it runs, which is how a factory or a loop behaves. The unit for numbering
repeats and for the per-site bound.

**Adoption** — the second way the plugin gets a store, for calls whose callee it cannot
recognise. A call standing under any name is wrapped, `$` prefix or not, and a call no name reaches
is wrapped under the callee that made it. At runtime the bridge renames whatever comes back if it is
already a registered store, registers it as `unknown` if nothing instrumented made it, and ignores
it if it is not a store at all. It always carries a name, and it carries a type as well where the
package to kind map behind the `storeTypes` option knows the package the call was imported from.

**Unassigned store** — one written inside a binding's initializer and assigned to no name of its
own, `eventAtom(root, "up")` inside `merged([…])`. It takes the binding's name and a number counting
them in source order, `$pointerEnd unassigned 1`. The number is what tells two of them apart,
because two written on one line share every other part of a store's identity. An array names its
members by index instead, but only where the array is the value the binding holds.

**Own fields** — what a value holds itself, and the first reading of every value the bridge draws: a
property that is own, enumerable, named by a string, and holding a plain value. An inherited field,
a getter, a symbol key, a key the developer made non-enumerable and a function are each left out,
because the panel draws state. They arrive in the value's own order, and a value that refuses to be
read gives up all of them rather than half. Where a value has none it is asked for **a published
reading** instead, and a DOM node and **the global object** are skipped on purpose. It is a
**model** thing, `ownFields` in `src/values/descriptor.ts`.

**Platform object** — one whose fields all sit behind getters on its prototype and which holds no
own data: an event, a `URL`, a `DOMRect`, a `Blob`. The bridge reads no getter, whoever wrote it, so
such an object draws its class name over an empty object, plus **a published reading** where its
class wrote one. Anything else it holds needs a serializer of the developer's over the class they
hold. A few classes take a **shipped serializer** instead. It is a **model** kind: what such an
object holds is a fact about the value, and drawing it is the view's half.

**A published reading** — the answer of a `valueOf` or a `toString` a class defines itself, called
on a value that holds no own data and drawn under `(valueOf)` and `(toString)`, `(valueOf)` first.
One rule for every such value: a class instance, a DOM node and the global object all take it, so a
`URL` and an `<a>` keep their address while a `Blob` and a `<div>` draw their class name alone.
`Object.prototype`'s own two are refused by identity, which is what separates the two groups. This
is the one place the bridge runs a line of the app's code. It is a **model** thing, `printedFields`
in `src/values/printed.ts`.

**Shipped serializer** — a rule the bridge carries for a platform class with one obvious reading and
no field to choose: `Headers`, `FormData`, `URLSearchParams`, `ArrayBuffer`, `SharedArrayBuffer`,
`DataView`, and a boxed `String`, `Number` or `Boolean`. Checked after the developer's own
serializers and ahead of every other rule of ours, and `platformSerializers: false` leaves the whole
list out. It is a **model** thing, `platformRules` in `src/values/platform.ts`.

**The global object** — `globalThis`, wherever a row reaches it: `currentTarget` on a `window`
listener, `self`, `frames`, `top` and `parent` in a page that is not framed. It is never walked and
no key of it is even listed, because whatever the app parked on `window` is an own enumerable
property, so it draws its class name alone, `Window {}`. Identity is what bounds it, not where it
was reached, so a window from another realm is read as an ordinary object of its class.

**Callee matching** — the first way, and the one that reads a type off the call itself: the call
names something the file imported from `nanostores`, renamed imports included. Adoption only handles
what this misses, and it has a type of its own from the package to kind map.

Three mechanisms decide where a store is drawn. Adoption and callee matching decide whether a
store reaches the tree at all; these three decide its **owner** once it is in. A store none of them
places is drawn nowhere.

**Binding scan** — one call appended at the end of a module body, listing that module's top-level
`const`, `let` and `var` names. At load the bridge walks each value one holds, and a store found
under a binding is drawn under that binding. It reaches a factory result, a class instance and a
collection's members, and it is the only mechanism that reaches an alias such as
`export const $canUndo = $draft.$canUndo`, where the initializer is a property read and not a call.

**Creation frame** — a frame opened around a top-level initializer that is a call or a `new`, and
closed on the value it returned. Every store born while a frame was open records it, which is the
only way to reach a store kept in a closure, where no property walk can find it. A plain store
creator needs none: the wrap around it already names the one store it makes. A frame is not opened
across an `await`, or it would catch every store made anywhere until it closed.

A frame places nothing born in somebody else's file, nothing that already stands at a site of its
own, and nothing a **reference** the developer wrote holds as well. What is left is a store made
inside a function, which is the case the frame exists for.

**`this` in a class field** — a field initializer runs with `this` bound to the new instance, so
the transform hands it over. A static field's `this` is the constructor instead, which is why a
static store belongs to the class. It is also the only way to reach a private field.

**Converter** — our code that turns a store value into something that survives the trip to the
extension. It is a jsan **replacer**, passed to the extension as `serialize: { replacer, options:
true }`, so it rides on the `serialize` option rather than replacing it. It handles only what jsan
handles badly: `Error`, class instances, typed arrays, `BigInt`, DOM nodes, the global object, and
`Map` and `Set`. Everything else it returns untouched for jsan to encode, and it encodes only: there
is no reviver of ours. It is a **view** thing, `src/redux/replacer.ts`.

Two things it changes about what it copies. **A method is not drawn**, because the panel draws state
and a method is behaviour the source already spells. And **a store takes the type note on its key**
wherever a key of ours reaches it, with its value bare beneath it, the way the tree spells a slot.

**Value cap** — one of the two counts that bound a value the developer never designed for the panel,
`maxValueDepth` and `maxValueMembers`. Both start where the walk enters a class instance and hold
for everything below that point; above one, nothing is capped. A depth past the cap draws the class
name and one `(value)` line saying so, and a width past it draws the first members in source order
and one `…` key counting the rest. A **store** is exempt, so one store never disagrees with itself
between two placements.

**Wrapper** — the extension's own `{ data, __serializedType__ }` shape, not a shape of ours. `data`
holds what survived and `__serializedType__` names it, and the panel's reviver unwraps it and prints
the type as a label in front of the bare value, so it adds no nesting. It only works while
`serialize` is truthy and `data` is an object, which is why every marked slot wraps its value in an
object first. It is a **view** thing, `src/redux/marker.ts`.

**Mounted / unmounted** — nanostores terms, used unchanged. A store is mounted while it
has at least one listener. Unmount has two steps: `onStop` fires the moment the last
listener leaves, and the `onMount` cleanup runs 1000 ms later. A new listener inside that
window cancels the cleanup, and the mount code does not run again. **The bridge reads
`lc === 0` and does not wait out that window**, so a store inside it counts as unmounted.

**Slot** — one store's place in the tree, the value under its name. Store-only: a slot holds a
value, and a **node** holds slots and other nodes. The **model** owns the word: a slot is live,
stale, or a computed that never ran, and it carries the raw value. A mounted store's slot holds its
value bare; a marked one wraps. A store that owns others keeps its slot under `(value)`, so its
children can sit beside it.

**Marker** — what a key pointing at a store carries when the store's value cannot be trusted, which
is not the same as "not mounted". Only a `computed`, a `batched` or an unknown-type store is marked,
as `{ data: <the value>, __serializedType__: "not mounted, may be stale" }`; one holding `undefined`
that never mounted reads `not mounted, never computed` instead. A plain object and an array sit in
`data` bare, every other value is **boxed** under **`(value)`** first, and the marker states the
consequence rather than the mount state, so where there is no consequence there is no marker. It is
a **view** thing, in `src/redux/boxing.ts`: the model says which state a slot is in, the words are
the view's.

**Node** — a thing in the tree that holds others and has no value of its own: a class instance,
a factory result, a collection, a class's statics, or a function we held stores under. It pairs
with **slot**, a store's own place holding its value. It is not a **group**: that word keeps its
v1 meaning, the name a developer passes to `trackStores()` and the unit `untrack` removes.

**Owner** — what a store is drawn under. Either another store or a node. A store may have several,
one per container that really holds it, and a node may have several parents the same way.

**Reference** — a name the developer wrote for a value: a top-level binding, or a key on a
container they built. **Every reference draws.** Two bindings for one store are two references, and
so are two containers holding one store, so dropping any of them says the app holds less than the
source does. A **creation frame** is not a reference: it knows only that a store was born while an
expression ran, which is a claim about when, so it places a store only where no reference does.

**Placement** — one node in the tree standing for a value, which the view draws as one key. The
**model** decides how many there are, one per **reference**: a store has one entry and as many
placements as the source wrote, the home the developer chose for it and the name each owner knows it
by. An owner's key is the property it really holds the store at, and only where nothing holds it
under a property, as under a creation frame, does it fall back to the name the creation site gave.

**Repeat** — every placement past the one that expands. The value is expanded under its first
placement and every other placement shows it and stops, because drawing its children twice would say
the app holds twice as many stores as it does. A store repeat carries its value, which is the point
of a store; a node has no value, so a node repeat carries `(drawn under)`, the label of the
placement that expands it.

A store may also have no placement at all. One made inside a function and placed by nothing is that
function's own working state, and the tree already draws what the function returned. A store made at
module level always keeps one. And **somebody else's file places nothing**: every mechanism runs on
the developer's own files, so what the app took out of a library is drawn at the binding that holds
it.

**Drawn** — whether a developer can see a store at all, which is what decides its timeline rows. Two
things make it true and **placement** is only one: a key of its own in the tree, or a value the
panel shows holding it, which the **converter** draws with no placement involved. A store neither
reaches is one no row can point at, so its rows are dropped rather than sent with a diff showing
nothing. The second half is one snapshot behind, because the converter fills it while it writes.

**Written name** — a name that exists in the developer's source: a binding, a property key, an
array index, a `Map` key. It beats any name we derive.

**Type label** — what built a node, `Editor` or `Map`, carried in `__serializedType__` and drawn
by the panel in front of the node. `Object` is left off, because a plain object node says that
much by itself. A store never takes one: that slot already holds its marker.

**Ref name** — `ref#1`, the key for an instance nothing could name, such as one held in a
`WeakMap`. It says plainly that the name is ours. Every unnamed instance shares the base `ref`
and they number across the file, not per class.

**Name qualifier** — what an entry carries beside its name so two entries never share one label: the
place it was made, `line 20`, the file it came from, `a.ts`, and the number of the store among the
ones its site made. Both sides of a clash take one, so neither name turns on which of the two loaded
first. The **model** decides which node takes one and what goes in it; the **view** spells it,
`$counter (a.ts, line 20) #2` for the label and `$counter [store] (a.ts, line 20) #2` for the key.

**Key order** — a **view** rule, and the only place these parts are ever put together: a tree key
reads name, type note, one parenthesis group, number, always in that order. The group holds the
place the store was made, until a home clash needs telling apart: the home takes the group then and
the place steps aside, so a key carries one group and never two.

**Lifecycle row** — a timeline entry for something other than a value change: a store joining or
leaving the registry, or mounting and unmounting. All four are on by default, because a tree that
changes without a row would drift into the next write's diff. A store with no placement gets none of
them. The **model** decides which of the four a turn produced and which stores it covers, and the
**view** spells the result, `src/stores/cart.ts/hotReload` and all.

**The hard rule** — the bridge must not change how the app behaves. Above all, watching
a store must not mount it.

**The read-only rule** — the bridge reads `.value`, attaches lifecycle hooks, and calls no app code
on purpose. Three holes are accepted and named in the source: a `Proxy` can trap a property read,
`Error.prepareStackTrace` can run while a stack is read, and reading a stack makes V8 read `name`
and `message` off the error. It is stronger than the hard rule and different in kind: that one
promises an outcome, this one promises a mechanism a reader can check in our own source. It is why
the bridge never works out a `computed` value for itself.

**Handle** — what `connectDevtools` returns. It carries `connected`, which says the extension
was found and the connection is open, and `disconnect()`, which closes the connection and
detaches every hook while leaving the registry alone. One page has one handle: a second
`connectDevtools` call warns and returns the first one.

**Listening** — the bridge's own flag for whether a panel is watching. It starts false, turns
true on the extension's `START` message and false on `STOP`. While it is false the bridge builds
no snapshot and sends nothing. Every transition into listening re-sends the whole tree, which is
why a panel opened late still shows current state. It is not the same as `connected`: the
extension can be there with no panel open.

**Paused** — the bridge's flag for the panel's own pause button, which the extension sets with a
`PAUSE_RECORDING` message and nothing else. It reads exactly as not listening does: no snapshot is
built and nothing is sent, and the rows in flight are dropped. `START` and `STOP` leave it alone,
so it holds while a panel closes and opens again. Lifting it sends nothing by itself; the next
entry carries the current tree.
