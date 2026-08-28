# Fixture apps

A small workspace the bundler tests install the packed package into. `test/support/apps.ts` copies
it to a temporary folder, unpacks `pnpm pack` output into `app/node_modules/nanostores-devtools`,
and links every other dependency out of this repository's own `node_modules`.

- `app` depends on the devtools and holds two stores.
- `packages/theme` holds one store and **does not depend on the devtools**. That is on purpose: a
  bundler resolves the import the plugin injects from the store file, so this package is the one
  that catches a runtime the app can reach and the store file cannot.
