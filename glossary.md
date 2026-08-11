# Glossary

Words this project uses in one fixed way. Shared vocabulary for anyone reading the source, a
ticket or a pull request.

**Bridge** — our code. It sits between the app's nanostores stores and the
redux-devtools extension and translates one into the other. It is not a devtools UI and
it is not a fork of the extension.

**Extension** — the redux-devtools browser extension, installed by the user. We only
speak its protocol.

**Registry** — the thing inside the bridge that knows which stores exist and what each
one is called. Both ways in (the explicit map and the Vite plugin) write to the same
registry.

**Entry** — one store's record in the registry. The registry maps the store object to its
entry, so the object is what makes an entry unique, never its name.

**Home** — the level above a store in the tree. A file path for a store the Vite plugin
found, a group name for one registered by hand.

**Group** — the name a developer must give when registering stores by hand. It takes a
file's place in the tree for stores the plugin did not find, and it is also the unit that
`untrack` removes.

**Label** — home, a slash, then the store name: `src/stores/cart.ts/$counter` or
`cart/$counter`. Internal. It decides where a store is drawn, not whether two stores are the
same. Registering a label that is already taken replaces the store behind it.

**Tree** — the single state object the bridge sends to the extension. Two levels: file,
then store name. The extension expects one root state; nanostores has none, so the bridge
invents this. The file level exists to keep two stores with the same name apart.

**Timeline entry** — one row in the extension's list of changes. The extension calls
these actions. Nanostores has no actions, so the bridge invents each entry from a store
change. One entry holds exactly one direct write and the followers it caused.

**Direct write** — a change to an `atom`, `map` or `deepMap`. The app caused it, so it opens
a new timeline entry and gives the entry its name.

**Follower** — a change to a `computed` store, caused by one of its sources changing rather
than by the app. It joins the open entry instead of starting one. Only a mounted computed
can be a follower, because an unmounted one never recomputes.

**Synthesized name** — the name of a timeline entry, built by the bridge from the store
name and the kind of change, for example `$counter/set`. Every entry gets one: v1 has no
way for a developer to name a change by hand.

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
recognise. A `$`-named binding is wrapped, and at runtime the bridge renames whatever comes
back if it is already a registered store, registers it as `unknown` if nothing instrumented
made it, and ignores it if it is not a store at all. It carries a name, never a type.

**Callee matching** — the first way, and the one that gives a type: the call names something
the file imported from `nanostores`, renamed imports included. Adoption only handles what
this misses.

**Converter** — our code that turns a store value into something that survives the trip to
the extension. It is a jsan **replacer**, passed to the extension as
`serialize: { replacer, options: true }`, so it rides on the `serialize` option rather than
replacing it. It handles only what jsan handles badly: `Error` (jsan keeps the message alone),
class instances (jsan loses the name), typed arrays, `BigInt` (jsan throws), DOM nodes and
getter-only objects. Everything else it returns untouched for jsan to encode. It takes
user-supplied serializers, never shortens a value, and encodes only: there is no reviver of
ours.

**Wrapper** — the extension's own `{ data, __serializedType__ }` shape, not a shape of ours.
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

**Slot** — one store's place in the tree, the value under its name. A mounted store's slot
holds its value bare; a marked one wraps.

**Marker** — what a slot carries when its store's value cannot be trusted, which is not the same
as "not mounted". An unmounted `atom`, `map` or `deepMap` holds a correct value and is left bare.
Only a `computed`, a `batched` or an unknown-type store is marked, as
`{ data: { $$value: … }, __serializedType__: "not mounted, may be stale" }`. A `computed` or a
`batched` that holds `undefined` and never mounted takes `not mounted, never computed` instead,
which carries `{}` with no `$$value` key at all. The store's value always sits under **`$$value`**,
whatever its type; that is the one invented key name in the design, and the `$$` prefix marks it as
ours. The marker states the consequence, not the mount state, so where there is no consequence
there is no marker. Nothing is ever hidden, so a marker is how an untrustworthy store appears,
never a replacement for a missing key.

**Lifecycle row** — a timeline entry for something other than a value change: a store
joining or leaving the registry, or mounting and unmounting. All four are on by default,
because a tree that changes without a row would drift into the next write's diff.

**The hard rule** — the bridge must not change how the app behaves. Above all, watching
a store must not mount it.

**The read-only rule** — the bridge reads `.value`, attaches lifecycle hooks, and runs no
app code at all. Stronger than the hard rule and different in kind: the hard rule promises
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

**Time travel** — the developer clicks an old timeline entry and the app really returns
to that state. Not in v1. This effort only answers whether it is possible.
