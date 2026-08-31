# Changelog

## 0.2.0

### Added

- Follow a store into what it holds. A store sitting inside another store's value is now drawn under that store, and the walk runs again whenever a tracked store writes, so an app that builds stores at run time draws them and one that drops them stops drawing them.
- Name a found-store row by the path you can look at. When every store behind a lifecycle row was found inside another store's value, the row takes the longest binding path they share, such as `$root.value.$children[0]/register`, instead of the file the factory lives in. A row that mixes found stores with module-level ones keeps the module name.

### Changed

- Hand back what a binding reaches from the walk, so following a binding over time can compare one list with the last one.

### Documentation

- Write down the reachability rule.
- Say what the second naming pass protects.

## 0.1.1

### Fixed

- Resolve the injected runtime import from the plugin, not from the store file. A store in a workspace package that does not itself depend on `nanostores-devtools` could not reach `nanostores-devtools/runtime`, and the import failed first in SSR and then in the browser.

### Documentation

- Show the panel in the README.

## 0.1.0

First release. `nanostores-devtools` is a read-only bridge from nanostores to the Redux DevTools
browser extension. It ships no UI of its own.

- A bundler plugin for Vite, webpack and Rspack reads your source during development and gives each
  store the name you wrote for it. One rule decides which stores it finds: a store is tracked where
  your own code holds it, never where it only passed through.
- `connectDevtools()` opens the connection. `trackStores()` and `untrack()` add and drop the stores
  the plugin cannot reach.
- Every store the panel draws is keyed by the binding, object key, array index or `Map` key from
  your source, under whatever holds it, with its kind in the key: `[computed]`, `[map]`,
  `[deepMap]`, `[batched]`.
- Every direct write draws one timeline row, headed by the whole path from your binding down, and
  the recomputes that write caused go under it.
- Reads are made through the value's own property descriptor. The bridge never calls `store.get()`,
  never reads a getter you wrote and never mounts a store.
- A store writing more than ten times a second is held to one row a second, so a frame loop cannot
  push the rows you came to read out of the panel. The `throttle` option names your own targets.
- Four comments steer the plugin per store: `// @nanostores-devtools:ignore`, `:throttle`,
  `:no-throttle` and `:max-members <n>`.
- Nothing is built and nothing is sent while no panel is open, and the panel's pause button stops
  the same work.
- A production build gets three empty functions through the `production` export condition, on all
  three bundlers with no work from you.
- ESM only, `sideEffects: false`, with `nanostores` 1.x as the one browser peer. On webpack, on
  Rspack and on Vite 6 and 7 the plugin also needs `oxc-parser` installed.
