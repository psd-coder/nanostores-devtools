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
`src/utils/`, while the entry points and the state they share stay in `src/`. It knows nothing about
the extension, and it hands its answers out as records, not as strings that a reader would have to
parse back. A model file never imports a view file, and `src/boundary.test.ts` fails on one that
does.

**View** — the half of the bridge that speaks one devtools client's protocol and nothing else: the
connection, the message shapes, the config, every key string and the jsan replacer. Today there is
one, in `src/redux/*.ts`. It may import the model, and it supplies a session (`src/session.ts`).

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
file's place in the tree for stores the plugin did not find. It also holds a store that the walk
gave an owner, and it is the unit that `untrack` removes.

**Label** — home, a slash, then the store name with its qualifier:
`src/stores/cart.ts/$counter (line 20)` or `cart/$counter`. It is internal, and it is written for a
reader: a message prints it and nothing uses it as a key. Two other things are used as keys. The
first, the **entry id**, is which registration this is, a number handed out once and never reused, and it is
what holds every warning about one store to one warning. The **name key** is which name a record
holds, and taking one that is already held replaces the store behind it, which is why the qualifier
is part of the name.

**Tree** — what the app's stores look like once the bridge has arranged them: homes on top, and
below each home a store under whatever built it, at any depth. The **model** owns it, as the
`TreeModel` that `src/tree/tree.ts` builds, and it holds records rather than strings. The **view**
turns it into the single state object the extension is sent, in `src/redux/render.ts`. The extension
expects one root state; nanostores has none, so the bridge invents this. The home level exists to
keep two stores with the same name apart.

**Type note** — the store's type in square brackets behind its name, `$total [computed]`. It sits
on a key and never on the name or the label, which stay bare. Every store carries one, and an `atom`
and an unknown type both read `store`. It comes straight after the name, in front of anything else
the key carries, and every key pointing at a store takes one, a collection position such as
`[0] [store]` included.

**Timeline entry** — one row in the extension's list of changes. The extension calls these actions.
Nanostores has no actions, so the bridge invents each entry from a store change, and one entry holds
exactly one direct write and the followers it caused. It calls a store by its **binding path**, and
the change inside it keeps the store's label, which says which file it came from. The **model**
owns the row and holds none of its words; the **view** writes them, in `src/redux/row.ts`.

**Direct write** — a change to an `atom`, `map` or `deepMap`. The app caused it, so it opens
a new timeline entry and gives the entry its name.

**Follower** — a change to a `computed` store, caused by one of its sources changing rather
than by the app. It joins the open entry instead of starting one. Only a mounted computed
can be a follower, because an unmounted one never recomputes.

**Throttled** — a store held to one timeline entry a second. The first write draws an entry at once,
a write inside the second after it draws none, and the last of those draws the entry that closes the
second, carrying the current tree. Followers sit inside the entry their write opened, so throttling
one store throttles the cascade behind it. Three things set it and they set the same state: the
`throttle` option, the `// @nanostores-devtools:throttle` comment, which alone can name another rate
in milliseconds, and `autoThrottle`, which catches a store writing more than ten times a second and
holds it for the rest of the session. The tree is never behind; only the steps between entries are
lost. The tree key says the word while it holds: `$frame [store, throttled]`.

**Devtools comment** — one of the four `// @nanostores-devtools:` comments the plugin reads while
it walks your source: `:throttle`, which can name a rate in milliseconds, `:no-throttle`, `:ignore`
and `:max-members`, which names how many members of one **binding** the **binding scan** walks. The
package name is the namespace and the colon is the one separator. Each one stands on its own line
and puts a **mark** on the whole statement below it, so a call that makes several stores marks all
of them. Only the plugin reads them, and one that opens with the namespace and names none of the
four is read as prose and warned about. This is not **Marker**, which is a view word.

**Ignored** — a store the developer kept out of the devtools with `// @nanostores-devtools:ignore`.
The plugin wraps nothing in the statement below that comment, so the store never registers, takes no
key in the tree and draws no timeline entry: the bridge is never told it exists. Ignoring beats
throttling over the same statement, because a store nobody draws has no rate. **Explicit
registration** is the way back in, and it knows nothing about the comment.

**Synthesized name** — the name of a timeline entry, built by the bridge from the store's
**binding path** and the kind of change, for example `config.theme.$x/set`. A store a top-level
binding holds itself has a path of one part, so it reads `$counter/set`. A lifecycle entry that
carries several stores is named after the **binding path** they share where every one of them was
found inside another store's value, `$root.value.$children[0]/register`, and after the module they
belong to in every other case, the shared part that stops before the `.value` step included. Every
entry gets one: v1 has no way for a developer to name a change by hand. The **model** picks which store the entry points at and what happened to it; the **view**
writes the name out, the `/` and the op word included.

**Explicit registration** — the developer hands the bridge a group name and an object of
stores: `trackStores("cart", { $counter })`. The object key is the store name. Group first
and required, which is deliberately not the shape `@nanostores/logger` uses.

**Automatic discovery** — reading the developer's own names out of the source at build time so that
a store registers itself under one of them. It has two halves: a creator call carries its name where
**the gate** lets it, and the **binding scan** appended to the end of the module body registers
whatever the top-level bindings turn out to hold. The finding is one bundler-neutral core in
`src/discovery/`, and an adapter beside it reaches one bundler with it.

**Adapter** — the one file that turns discovery into a plugin for one bundler, and the only file
that is allowed to know that bundler's words. It answers six things: whether this build is a
development one, how the walk is made to run first, the roots a home is measured from, the shape of
a module id, the hot-reload line the injected header carries, and the channel a warning is printed
through. The walk, the rewrite, the skip rules and every name in the tree sit behind those answers
and are shared. Today there are three, `discovery/vite.ts`, `discovery/webpack.ts` and
`discovery/rspack.ts`.

**Creation site** — one place in the source where a store is made, identified by module, name and
line. The line is the one the developer wrote, which is why the
walk runs before anything rewrites the file. It is not the same as a store: one site makes a
new store every time it runs, which is how a factory behaves. The unit for numbering repeats.

**Adoption** — the wrapper the plugin puts around a call whose callee it cannot recognise, so that a
store some factory of the developer's built still reaches the bridge early. It registers nothing on
its own: **the gate** decides. A call the gate passes carries the name the module body holds it
under, with or without a `$` prefix, and the bridge renames whatever comes back if it is already a
registered store, registers it as `unknown` if nothing instrumented made it, and ignores it if it is
not a store at all. A call the gate refuses carries no name, registers nothing and files the kind
alone, for the **binding scan** to read back. It carries a type where the package to kind map behind
the `storeTypes` option knows the package the call was imported from.

**Own fields** — what a value holds itself, and the first reading of every value the bridge draws: a
property that is own, enumerable, named by a string, and holding a plain value. An inherited field,
a getter, a symbol key, a key the developer made non-enumerable and a function are each left out,
because the panel draws state. They arrive in the value's own order, and a value that refuses to be
read gives up all of them instead of half. Where a value has none it is asked for **a published
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
serializers and before every other rule of ours, and `platformSerializers: false` leaves the whole
list out. It is a **model** thing, `platformRules` in `src/values/platform.ts`.

**The global object** — `globalThis`, wherever a row reaches it: `currentTarget` on a `window`
listener, `self`, `frames`, `top` and `parent` in a page that is not framed. It is never walked and
no key of it is even listed, because whatever the app parked on `window` is an own enumerable
property, so it draws its class name alone, `Window {}`. The test is identity, not where the value
was reached, so a window from another realm is read as an ordinary object of its class.

**Callee matching** — the way a store's kind is read off the call itself: the call names something
the file imported from `nanostores`, renamed imports included. It is the only way the real kind is
ever learned, and it fires wherever the call is written, so even a store no name holds leaves its
kind behind. Whether the same call also registers is **the gate**'s answer and nothing else's.
Adoption covers the calls this misses, with a type from the package to kind map.

**The gate** — the one test both wrappers ask before a call carries a name: the call sits directly
in the module body, with no function and no block around it, and something the developer wrote names
its own place. A call that passes registers a store. A call that fails carries no name, registers
nothing, and files its kind alone, for the **binding scan** to read back if a walk ever reaches the
store.

Two mechanisms decide a store's **owner**: the **binding scan** and **`this` in a class field**. A
store neither of them reaches keeps no owner, and it is drawn flat at its own home where something
registered it anyway, such as a wrapper or **explicit registration**.

**Reachability rule** — what decides which stores exist for the bridge: **a store the developer
can reach from a top-level binding of their own is drawn and watched, and a store they cannot reach
is invisible**. Reach means a **binding path**, and nothing else counts. A store kept in a closure
is the one shape no path can ever name, and that is the rule working rather than a gap in it. The
rule works in both directions. A store the app puts where a path reaches it joins the registry from
that turn. A store no path reaches any more leaves it, unless **explicit registration** gave it a
name by hand.

**Binding scan** — one call appended at the end of a module body, listing that module's top-level
`const`, `let` and `var` names, and its class declarations. At load the bridge walks each value one
holds, and a store found under a binding is drawn under that binding. **A store it walks to is
registered there**, under the **binding path** that reached it, so a store no wrapper could name
still draws. It reaches a factory result, a class instance, a class's own static fields, a
collection's members, an alias such as `export const $canUndo = $draft.$canUndo`, where the
initializer is a property read and not a call, and a store inside another store's value.

The scan does not run once. While a panel is connected, a change in a store the scan reached sends
the walk down every binding that reaches that store again, once per binding per turn, and what the
new walk finds decides what joins the registry and what leaves it. A binding whose first walk
reached no store is never walked again, because nothing under it can notify, and nothing at all is
watched before the panel connects: a store built between module load and connect is a known gap.

**Binding path** — the whole chain the **binding scan** walked to reach a store: the top-level
binding, then every key under it, `config.theme.$x`, `$all[0]`, `byId["a1"].$status`. A key that
cannot stand after a dot is bracketed, so every part is something the developer could type in their
own source. A step into what a store holds is one part too, written `.value` and never `.get()`:
`$root.value.$children`. `.value` is what the walk really reads, through the descriptor and never
computed, so an unmounted **computed** returns the same stale value the **marker** states. The path
is what an entry is named after and what heads a timeline row. The tree still draws one key per
level, so the path and the tree key are built from the same links but are not the same string.

**Member** — one key and one value inside a value the **binding scan** walked. It is not a
**binding**: a binding is a name the module's own source writes, while a member is a name the value
carries. A store found inside another store's value is a member of that store, and takes a key
beside `(value)`; a store that is the whole value is not, because `(value)` already draws it. A
`max-members` comment can leave members out of that scan. When it caps a store's own members, the
tree places the store value under `(value)` and adds `…` beside it. A cap inside a store's value
adds no count of its own, and `(value)` still shows that value whole.

**`this` in a class field** — a field initializer runs with `this` bound to the new instance, so
the transform hands it over and the instance is recorded as what holds the store. A static field's
`this` is the constructor instead, which is why a static store belongs to the class. A **private**
field is the one thing this cannot draw: **the gate** names no call inside a class body, so nothing
registers the store, and no walk can list a private field afterwards.

**Converter** — our code that turns a store value into something that survives the trip to the
extension. It is a jsan **replacer**, passed to the extension as `serialize: { replacer, options:
true }`, so it uses the `serialize` option rather than replacing it. It handles only what jsan
handles badly: `Error`, class instances, typed arrays, `BigInt`, DOM nodes, the global object, and
`Map` and `Set`. Everything else it returns untouched for jsan to encode, and it encodes only: there
is no reviver of ours. It is a **view** thing, `src/redux/replacer.ts`.

Two things it changes about what it copies. **A method is not drawn**, because the panel draws state
and a method is behaviour that the source already shows. And **a store takes the type note on its
key** wherever a key of ours reaches it, with its value bare beneath it, the way the tree writes a
slot.

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
source does.

**Placement** — one node in the tree standing for a value, which the view draws as one key. The
**model** decides how many there are, one per **reference**: a store has one entry and as many
placements as the source wrote, the home the developer chose for it and the name each owner knows it
by. An owner's key is the property it really holds the store at. **One owner and one key name one
store**: where a scan finds a second store at the same key on the same owner, the first loses that
link, because one key holds one value and the walk read it whole.

**Repeat** — every placement past the one that expands. The value is expanded under its first
placement, and every other placement shows it and stops, because drawing its children twice would
say the app holds twice as many stores as it does. A store repeat carries its value, which is the point
of a store; a node has no value, so a node repeat carries `(drawn under)`, the label of the
placement that expands it.

A store the developer's own code does not hold is never registered, so it has no placement and no
row either: one made inside a function and kept there is that function's own working state, and the
tree already draws what the function returned. And **somebody else's file places nothing**: every
mechanism runs on the developer's own files, so what the app took out of a library is drawn at the
binding that holds it.

**Written name** — a name the developer can point at in their own source: a binding, a property
key, an array index, a `Map` key. Only the binding is a name the source itself writes; the other
three are names the value carries, and all four are names the developer could type to reach the
value. Every one of them beats a name we derive.

**Type label** — what built a node, `Editor` or `Map`, carried in `__serializedType__` and drawn
by the panel in front of the node. `Object` is left off, because a plain object node says that
much by itself. A store never takes one: that slot already holds its marker.

**Ref name** — `ref#1`, the key for an instance nothing could name: one a class field handed over
while the constructor ran, before any binding held it. It says plainly that the name is ours. Every
unnamed instance shares the base `ref` and they number across the file, not per class. The
**binding scan** renames the node as soon as it walks to it under a name.

**Name qualifier** — what an entry carries beside its name so two entries never share one label: the
place it was made, `line 20`, the file it came from, `a.ts`, and the number of the store among the
ones its site made. Both sides of a clash take one, so neither name depends on which of the two
loaded first. The **model** decides which node takes one and what goes in it; the **view** writes it,
`$counter (a.ts, line 20) #2` for the label and `$counter [store] (a.ts, line 20) #2` for the key.

**Key order** — a **view** rule, and the only place these parts are ever put together: a tree key
reads name, type note, one parenthesis group, number, always in that order. The group holds the
place the store was made, so a key carries one group and never two.

**Lifecycle row** — a timeline entry for something other than a value change: a store joining or
leaving the registry, or mounting and unmounting. All four are on by default, because a tree that
changes without a row would drift into the next write's diff. Every registered store gets them,
because a store the bridge was told about is one the developer's own code holds. The **model**
decides which of the four a turn produced and which stores it covers, and the
**view** writes the result, `src/stores/cart.ts/hotReload` and all.

**The hard rule** — the bridge must not change how the app behaves. Above all, watching
a store must not mount it.

**The read-only rule** — the bridge reads `.value`, attaches lifecycle hooks, and calls no app code
on purpose. Three gaps are accepted and named in the source: a `Proxy` can trap a property read,
`Error.prepareStackTrace` can run while a stack is read, and reading a stack makes V8 read `name`
and `message` off the error. It is stronger than the hard rule and different in kind: that one
promises an outcome, this one promises a mechanism that a reader can check in our own source. It is why
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
