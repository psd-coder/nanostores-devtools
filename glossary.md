# Glossary

Words this project uses in one fixed way. Shared vocabulary for anyone reading the source, a
ticket or a pull request.

**Bridge** — our code. It sits between the app's nanostores stores and the
redux-devtools extension and translates one into the other. It is not a devtools UI and
it is not a fork of the extension.

**Extension** — the redux-devtools browser extension, installed by the user. We only
speak its protocol.

**Model** — the half of the bridge that holds facts about the app's stores: which ones exist, what
owns what, what each is called, what the tree of them looks like, and what a value really holds. It
lives in `src/*.ts`, knows nothing about the extension, and hands its answers out as records rather
than as strings a reader would have to parse back. A model file never imports a view file, and
`src/boundary.test.ts` fails on one that does.

**View** — the half of the bridge that speaks one devtools client's protocol and nothing else: the
connection, the message shapes, the config, every key string and the jsan replacer. Today there is
one, in `src/redux/*.ts`. It is free to import the model, it supplies a session
(`src/session.ts`), and its value walk owes `noteDrawn` for every store it draws.

**Registry** — the thing inside the bridge that knows which stores exist and what each
one is called. Both ways in (the explicit map and the Vite plugin) write to the same
registry.

**Entry** — one store's record in the registry. The registry maps the store object to its
entry, so the object is what makes an entry unique, never its name.

**Home** — the top level of the tree, holding everything one file or one group put there. A
file path for a store the Vite plugin found, a group name for one registered by hand. A file
inside the Vite root keeps its short path, `app/model.ts`. A file outside it is measured from
the project root, `vendor/withUndo.ts`, instead of climbing out of the Vite root with `../`.

**Group** — the name a developer must give when registering stores by hand. It takes a
file's place in the tree for stores the plugin did not find, it holds a store the walk gave an
owner as well, and it is also the unit that `untrack` removes.

**Label** — home, a slash, then the store name with its qualifier:
`src/stores/cart.ts/$counter (line 20)` or `cart/$counter`. Internal, and a string for a reader: a
message prints it and nothing keys on it. Two other things do the keying. The **entry id** is which
registration this is, a number handed out once and never reused, and every warning about one store
is held to one by it, so renaming a store cannot ask for a second warning. The **name key** is which
name a record holds: home, name, file, place and number joined with a separator no part can contain,
and no spelling in it at all. It decides which home holds a store, not how deep inside that home the
store is drawn and not whether two stores are the same object. Taking a name key that is already
held replaces the store behind it, which is why the qualifier is part of the name: without it two
clashing stores would hold one key and the registry would keep one.

**Tree** — what the app's stores look like once the bridge has arranged them: homes on top, and
below each home a store under whatever built it, at any depth. The **model** owns it, as the
`TreeModel` that `src/tree.ts` builds, and it holds records rather than strings. The **view** turns
it into the single state object the extension is sent, in `src/redux/render.ts`. The extension
expects one root state; nanostores has none, so the bridge invents this. The home level exists to
keep two stores with the same name apart.

**Type note** — the store's type in square brackets behind its name, `$total [computed]`. It rides
on a key and never on the name or the label, which stay bare. Every store carries one, and an `atom`
and an unknown type both read `store`. It sits straight behind the name, in front of anything else
the key carries. Every key pointing at a store takes one: a tree key, a key inside a value where the
name is one the app wrote, and a collection position, `[0] [store]` and `["scratch"] [store]`,
spelled the way the tree spells a collection member. The one place that keeps the type in a
**wrapper** is the `[key]` half of a `Map` entry whose key is neither a string nor a number, which is
the encoder's own shape rather than one of ours.

**Timeline entry** — one row in the extension's list of changes. The extension calls
these actions. Nanostores has no actions, so the bridge invents each entry from a store
change. One entry holds exactly one direct write and the followers it caused.

A row calls a store whatever the tree calls it: the name the developer chose where they chose one,
and otherwise the key its owner holds it under. The change inside the row keeps the store's label,
which says which file it came from.

The **model** owns the row and holds no word of it: what the row is about, what happened, and one
record per store that moved. The **view** spells it, in `src/redux/row.ts`, which is where the name,
the changed key and the payload the panel prints are written.

**Direct write** — a change to an `atom`, `map` or `deepMap`. The app caused it, so it opens
a new timeline entry and gives the entry its name.

**Follower** — a change to a `computed` store, caused by one of its sources changing rather
than by the app. It joins the open entry instead of starting one. Only a mounted computed
can be a follower, because an unmounted one never recomputes.

**Throttled** — a store held to one timeline entry a second. The first write draws an entry at
once, a write inside the second after it draws none, and the last of those draws the entry that
closes the second, carrying the current tree. Followers ride inside the entry their write opened,
so throttling one store throttles the cascade behind it. Three things set it and they set the same
state: the `throttle` option, the `// @devtools-throttle` comment, and `autoThrottle`, which is on
and catches a store writing more than ten times a second. The comment alone can name another rate
for its store, `// @devtools-throttle 100`, in milliseconds; everything else holds to the second.
A store `autoThrottle` caught stays throttled for the rest of the session, so the timeline does
not flip between full entries and thinned ones as the rate moves. The `// @devtools-no-throttle`
comment takes one store out of that catch and out of the warning with it; it says nothing about
the other two, which are the developer asking for the throttle. The tree is never behind; only
the steps between entries are lost. The tree key says the word while it holds:
`$frame [store, throttled]`.

**Synthesized name** — the name of a timeline entry, built by the bridge from the store
name and the kind of change, for example `$counter/set`. Every entry gets one: v1 has no
way for a developer to name a change by hand. The **model** picks which store the entry points at
and what happened to it; the **view** writes the name out, the `/` and the op word included.

**Explicit registration** — the developer hands the bridge a group name and an object of
stores: `trackStores("cart", { $counter })`. The object key is the store name. Group first
and required, which is deliberately not the shape `@nanostores/logger` uses.

**Automatic discovery** — the Vite plugin finds store creation in the source at build
time and makes each store register itself, carrying its variable name.

**Creation site** — one place in the source where a store is made, identified by module,
name, enclosing function and line. It is not the same as a store: one site makes a new
store every time it runs, which is how a factory or a loop behaves. The unit for numbering
repeats and for the per-site bound.

**Adoption** — the second way the plugin gets a store, for calls whose callee it cannot
recognise. A call standing under a `$`-named binding is wrapped, and at runtime the bridge renames
whatever comes back if it is already a registered store, registers it as `unknown` if nothing
instrumented made it, and ignores it if it is not a store at all. It carries a name, never a type.

**Unassigned store** — one written inside a binding's initializer and assigned to no name of its own,
`eventAtom(root, "up")` inside `merged([…])`. It takes the binding's name and a number counting
them in source order, `$pointerEnd unassigned 1`. The number is what tells two of them apart: a store's
identity is its home, name, file, line and per-site count, and two written on one line share all
five, so without it the second takes the first one's place. An array names its members by index
instead, but only where the array is the value the binding holds, because only then is `$totals[0]`
a name that reaches the store.

**Own fields** — what a value holds itself, and the first reading of every value the bridge draws: a
property that is own, enumerable, named by a string, and holds a plain value. An inherited field, a
getter, a symbol key and a key the developer made non-enumerable are each refused, and a function at
a key is left out because the panel draws state. They arrive in the value's own order, nothing sorts
them, and a value that refuses to be read gives up all of them rather than half. Where a value has
none, it is asked for **a published reading** instead. A DOM node and **the global object** are the
two values whose own fields are skipped on purpose. It is a **model** thing, `ownFields` in
`src/descriptor.ts`: every view asks the same question and gets the same answer.

**Platform object** — one whose fields all sit behind getters on its prototype and which holds no
own data: an event, a `URL`, a `DOMRect`, a `Blob`. The bridge reads no getter, whoever wrote it, so
such an object draws its class name over an empty object, plus **a published reading** where its
class wrote one. Anything else it holds needs a serializer of the developer's over the class they
hold. A few classes take a **shipped serializer** instead. It is a **model** kind: what such an
object holds is a fact about the value, and drawing it is the view's half.

**A published reading** — the answer of a `valueOf` or a `toString` a class defines itself, called
on a value that holds no own data and drawn under `(valueOf)` and `(toString)`, `(valueOf)` first.
One rule for every such value: a class instance, a DOM node and the global object all take it, so a
`URL`, a `Location` and an `<a>` keep their address while an event, a `Blob`, a `<div>` and a
`window` draw their class name alone. `Object.prototype`'s own two are refused by identity, which is
what separates the two groups. This is the one place the bridge runs a line of the app's code: the
method is found through a descriptor, called by name, kept only where the answer is a primitive, and
a throw costs that one key. It is a **model** thing, `printedFields` in `src/printed.ts`, and it
names no key: the two spellings above are the view's, in `src/redux/keys.ts`.

**Shipped serializer** — a rule the bridge carries for a platform class with one obvious reading and
no field to choose: `Headers`, `FormData`, `URLSearchParams`, `ArrayBuffer`, `SharedArrayBuffer`,
`DataView`, and a boxed `String`, `Number` or `Boolean`. Checked after the developer's own
serializers and ahead of every other rule of ours, and `platformSerializers: false` leaves the whole
list out. The rule is a **model** thing, `platformRules` in `src/platform.ts`, and it answers what
the class holds; `src/redux/platform-rules.ts` is what turns each answer into a serializer.

**The global object** — `globalThis`, wherever a row reaches it: `currentTarget` on a `window`
listener, `self`, `frames`, `top` and `parent` in a page that is not framed. It is never walked, and
no key of it is even listed, because whatever the app parked on `window` is an own enumerable
property. It draws its class name alone, `Window {}`. A rule apart from the class-instance
branch: identity is what bounds it, not where it was reached, so a window from another realm, an
iframe's or a `window.open` result, is read as an ordinary object of its class.

**Callee matching** — the first way, and the one that gives a type: the call names something
the file imported from `nanostores`, renamed imports included. Adoption only handles what
this misses.

Three mechanisms decide where a store is drawn. Adoption and callee matching decide whether a
store reaches the tree at all; these three decide its **owner** once it is in. A store none of them
places is drawn nowhere.

**Binding scan** — one call appended at the end of a module body, listing that module's
top-level `const`, `let` and `var` names. At load the bridge walks each value one holds. A store
found under a binding is drawn under that binding. It reaches `Object.assign($atom, {…})`
members, a factory result, a class instance held in a binding and a collection's members, and it
is the only mechanism that reaches an alias such as `export const $canUndo = $draft.$canUndo`,
where the initializer is a property read and not a call.

**Creation frame** — a frame opened around a top-level initializer that is a call or a `new`,
and closed on the value it returned. A plain store creator needs none: the wrap around it already
names the one store it makes. Every store born while a frame was open records it, which is the
only way to reach a store kept in a closure, where no property walk can find it. A frame is not
opened across an `await`: it must close in the same tick or it would catch every store made
anywhere until it did.

A frame places nothing born in somebody else's file. It catches every store made while the
expression ran, however many files down, and one still homed in a library is one that library kept:
what it handed over is adopted at the call site and takes the developer's home, and what the
returned value carries the binding scan reaches through a property. Inside the developer's own files
the frame keeps its full reach.

It also places nothing that already stands at a site of its own. A store made at module level is
drawn flat at the file it was written in, so nesting it under whatever the expression around it
returned would claim a holding that does not exist. What is left is a store made inside a function,
which is the case the frame exists for.

**`this` in a class field** — a field initializer runs with `this` bound to the new instance, so
the transform hands it over. A static field's `this` is the constructor instead, which is why a
static store belongs to the class. It is also the only way to reach a private field.

**Converter** — our code that turns a store value into something that survives the trip to
the extension. It is a jsan **replacer**, passed to the extension as
`serialize: { replacer, options: true }`, so it rides on the `serialize` option rather than
replacing it. It handles only what jsan handles badly: `Error` (jsan keeps the message alone),
class instances (jsan loses the name), typed arrays, `BigInt` (jsan throws), DOM nodes,
the global object, and `Map` and `Set` (the panel calls both of them `Iterable`). Everything else
it returns untouched for jsan to encode. It takes user-supplied serializers and encodes only: there
is no reviver of ours. It is a **view** thing, `src/redux/replacer.ts`: jsan's contract and the
panel's spelling, over readings the model answers with.

It changes two things about what it copies. **A method is not drawn**: an object's own property
holding a function is left out, because the panel draws state and a method is behaviour the source
already spells. A value that is itself a function is untouched, and so is a function sitting at an
array index, where the position is part of the shape.

And **a store takes the type note on its key** wherever a key of ours reaches it, with its value bare
beneath it, the way the tree spells a slot. That is a name the app wrote, and a collection position.
The panel is the reason and it is not a matter of taste: a type in a **wrapper** is drawn in the item
string, which the panel hides while the node is expanded and leaves out of a collapsed parent's
preview, so on a member there is no moment it can be read.

Which collection is keyed differs by kind, and by what the panel does to each. An array holding at
least one store goes out as an object keyed `[0]`, `[1]`, marked `Array`, while an array of plain
data stays an array, because an array reads correctly either way. A `Map` and a `Set` are keyed
always, `["scratch"]` and `[0]`, because the panel draws both of them, and every other iterable,
with one node kind that writes `Iterable` over the name it worked out.

The wrapper is left for what only a wrapper can say, the marker, and for two shapes no key of ours
reaches: the `[key]` half of a `Map` entry we could not name, and a store whose value can reach that
store again, where the wrapper's own key is what keeps the encoder finding the loop.

**Two counts bound a value the developer never designed for the panel**, `maxValueDepth` and
`maxValueMembers`. They start in exactly one place, where the walk enters a class instance, and they
hold for everything below that point, including a plain object, which cannot escape a count by being
plain. Above one, nothing is capped:
a plain object, an array and a collection of the app's go out whole, however large. A depth past the
cap draws the class name and one `(value)` line saying so; a width past it draws the first members
in source order and one `…` key counting the rest, which is the key the **tree** already writes for
the same idea. A capped array switches to the keyed `Array` shape, because the encoder walks an
array by its length and would drop a note put at any other key. A **store** is exempt: it is never
replaced by a placeholder and its value starts free again, so one store never disagrees with itself
between two placements. A serializer runs before both counts, and the result it hands back is bound
by them one level down.

**Wrapper** — the extension's own `{ data, __serializedType__ }` shape, not a shape of ours.
It is a **view** thing, so the code that builds and recognises it lives in `src/redux/marker.ts`,
and a reading the model answers with goes into one only where the view puts it there.
`data` holds what survived and `__serializedType__` names it. The panel's reviver unwraps it and
prints the type as a label in front of the bare value, so it adds no nesting. It only works
while `serialize` is truthy, and only when `typeof data === "object"`, which is why every marked
slot wraps its value in an object first. The label is plain text, because the panel renders it as
a label rather than as data.

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

**Marker** — what a key pointing at a store carries when the store's value cannot be trusted, which is not the same
as "not mounted". It is a **view** thing: the model says which state a slot is in, and the words
below, the boxing and the wrapper are the view's, in `src/redux/boxing.ts`. An unmounted `atom`,
`map` or `deepMap` holds a correct value and is left bare.
Only a `computed`, a `batched` or an unknown-type store is marked, as
`{ data: <the value>, __serializedType__: "not mounted, may be stale" }`. A `computed` or a
`batched` that holds `undefined` and never mounted takes `not mounted, never computed` instead,
which carries `{}` with no value key at all. A plain object and an array sit in `data` bare; every
other value is **boxed** under **`(value)`** first, or the panel drops the label. That is the one
invented key name in the design, the same key a store that owns others keeps its own value under,
and parentheses cannot spell a name a developer could have written. One plain value is boxed too:
one the store itself can be reached from. The mark then sits inside the object it carries, jsan
writes that object as a pointer back to the ancestor it is inside, and the label was written onto
the object the pointer replaces. The marker states the
consequence, not the mount state, so where there is no consequence there is no marker. Nothing is ever hidden, so a marker is how an untrustworthy store appears,
never a replacement for a missing key.

**Node** — a thing in the tree that holds others and has no value of its own: a class instance,
a factory result, a collection, a class's statics, or a function we held stores under. It pairs
with **slot**, a store's own place holding its value. It is not a **group**: that word keeps its
v1 meaning, the name a developer passes to `trackStores()` and the unit `untrack` removes.

**Owner** — what a store is drawn under. Either another store or a node.

**Placement** — one node in the tree standing for a store, which the view draws as one key. The
**model** decides how many there are. A store has one entry and may have two placements: the home
the developer chose for it, drawn flat, and the name its owner knows it by, drawn under the owner.
That second key is the property the owner really holds it at, and only where nothing holds it under
a property, as under a creation frame, does it fall back to the name the store's creation site
gave. They choose a home two ways, a top-level binding of their own and an
explicit registration, and either one beats the owner the ownership walk recorded.

A store may also have none. One made inside a function and placed by nothing is that function's own
working state: what the function returned is what the app holds, and the tree draws that already, so
the store itself is left out. A store made at module level always keeps a placement, because it has
no function it could belong to and the file it was written in is its only holding. A store left out
of the tree stays in the registry and keeps its hooks, and it draws no **timeline row** of its own
either, whatever the row would have said.

Every mechanism that places a store runs on the developer's own files only. **Somebody else's file
places nothing**: no name, no node, and no store under one. A library holds its working state at its
own top-level names as much as in a closure, and neither is a thing the app can act on. What the app
took out of that library is bound in a file of the developer's own, and that binding draws it. The
module-level rule above still holds there, so a store a library exports on purpose keeps its
placement at its own file.

**Drawn** — whether a developer can see a store at all, which is what decides its timeline rows.
Two things make it true and **placement** is only one: a key of its own in the tree, or a value the
panel shows holding it, which the **converter** draws with no placement involved. A store neither
reaches is one no row can point at, so its rows are dropped rather than sent with a diff showing
nothing. The second half is a note the converter fills while it writes a snapshot, so it is one
snapshot behind: a store put into a drawn value and written in the same tick loses that one row.

**Written name** — a name that exists in the developer's source: a binding, a property key, an
array index, a `Map` key. It beats any name we derive.

**Type label** — what built a node, `Editor` or `Map`, carried in `__serializedType__` and drawn
by the panel in front of the node. `Object` is left off, because a plain object node says that
much by itself. A store never takes one: that slot already holds its marker.

**Ref name** — `ref#1`, the key for an instance nothing could name, such as one held in a
`WeakMap`. It says plainly that the name is ours. Every unnamed instance shares the base `ref`
and they number across the file, not per class.

**Name qualifier** — what an entry carries beside its name so two entries never share one label.
The **model** decides which node takes one and what goes in it; the **view** spells it. The parts:
the place it was made, `line 20`, for two creation sites in one file, the file it came from,
`a.ts`, for two files one home holds, and the number of the store among the ones its site made.
Both sides of a clash take it, so neither name turns on which of the two loaded first. The entry
keeps the parts, and one function spells them: `$counter (a.ts, line 20) #2` for the label,
`$counter [store] (a.ts, line 20) #2` for the tree key.

**Key order** — a **view** rule, and the only place these parts are ever put together: a tree key
reads name, type note, one parenthesis group, number, always in that order. The group holds the
place the store was made, until a home clash needs telling apart: the home takes the group then and
the place steps aside, so a key carries one group and never two.

**Lifecycle row** — a timeline entry for something other than a value change: a store
joining or leaving the registry, or mounting and unmounting. All four are on by default,
because a tree that changes without a row would drift into the next write's diff. A store with no
placement gets none of the four: the row is there to explain a tree that changed shape, and a store
the tree does not draw changes no shape. The **model** decides which of the four a turn produced and
which stores it covers, and the **view** spells the result, `src/stores/cart.ts/hotReload` and all.

**The hard rule** — the bridge must not change how the app behaves. Above all, watching
a store must not mount it.

**The read-only rule** — the bridge reads `.value`, attaches lifecycle hooks, and calls no
app code on purpose. Three holes are accepted and named in the source: a `Proxy` can trap a
property read, `Error.prepareStackTrace` can run while a stack is read, and reading a stack
makes V8 read `name` and `message` off the error. Stronger than the hard rule and different
in kind: the hard rule promises
an outcome and has to be argued case by case, while this promises a mechanism and can be
checked by reading our own source. It is why the bridge never works out a `computed` value
for itself.

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

**Time travel** — the developer clicks an old timeline entry and the app really returns
to that state. Not in v1. This effort only answers whether it is possible.
