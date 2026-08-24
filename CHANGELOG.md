# Changelog

## Unreleased

One rule now decides which stores the panel draws: **a store is tracked where your own code holds
it, never where it only passed through.** A wrapped call registers a store only where it sits
directly in the module body under a name you wrote; everything else is found by the binding scan at
the end of the file, which registers every store it walks to under the whole chain that reached it.

### Added

- A rebound package store (`const $d = $ready`), a store on what a call returned
  (`client.$value`), a destructured pair (`const { $user, $cart } = makeThings()`), a `new`
  expression and an object you built to gather stores all draw now, and so does the file holding
  them.
- The walk goes ten levels into a binding instead of three, and the new `maxDepth` plugin option
  moves that.
- `// @nanostores-devtools:max-members <n>` caps how much of one binding the scan walks, at every
  depth of it, and a member past the number is not registered at all.

### Changed

- **A nested store's timeline row is headed by its whole binding path.** `[0]/set` becomes
  `$all[0]/set`, and `$x/set` becomes `config.theme.$x/set`. The tree still draws one key per
  level. Where two chains of yours reach one store, the row heads with the first and the change
  lists the rest under `also`.
- **A store replaced at the key that held it loses that key and draws flat at its own file.** It is
  still drawn: one owner and one key name one store, so the store that was there before keeps its
  entry and moves out from under the owner. A replacement written in the same file is the one case
  that does vanish, because the new store takes the old one's name.
- Nothing caps how many stores one creation site may hold any more.

### Removed

Each of these drew a row before and draws nothing now.

- A call handed straight to another call, `useStore(userStore(id))`, which drew a row named after
  the callee.
- A bare top-level call, `init()`.
- A default export of a call, `export default make()`.
- A store made inside a function body and kept there, and one in an object a local function
  returned that nothing holds.
- A getter that built a store on every read.
- A class field where no binding holds an instance. A field of a held instance still draws.
- A private class field, `#hidden = atom(0)`, even on a held instance: nothing names the call and no
  walk can list a private field.
- A store made in a top-level loop body: the per-turn rows go, and the stores draw under the array
  that holds them instead.
- A store made in a bare block or an `if` block that nothing outside holds.
- A store a top-level call keeps inside a closure.
- A store only a `WeakMap` or a `WeakSet` holds. No walk can enumerate one.
- Every `... unassigned N` row. The word leaves the panel.
- The `maxStoresPerSite` plugin option.
