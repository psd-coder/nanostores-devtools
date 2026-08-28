import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const FIXTURES = `${REPO}/test/fixtures`;

/**
 * A workspace holding the two shapes a bundler has to get right: an app that depends on this
 * package, and a package of stores beside it that does not.
 */
export type Apps = {
  /** The workspace root. */
  root: string;
  /** The app, which is the root every bundler is given. */
  app: string;
  /** The store file in the package that does not depend on this one. */
  theme: string;
  remove: () => Promise<void>;
};

/**
 * The apps install the packed package, so the exports map, the published file list and the built
 * files are all under test. Everything else is linked out of the repository's own `node_modules`,
 * which keeps the install offline and holds the bundlers to the versions this checkout tests, the
 * Vite major CI picks included.
 */
async function packPackage(into: string): Promise<string> {
  const tarball = `${into}/package.tgz`;

  await run("pnpm", ["build"], { cwd: REPO });
  await run("pnpm", ["pack", "--out", tarball, "--config.ignore-scripts=true"], { cwd: REPO });

  return tarball;
}

/** Every dependency but this package's own, so the app resolves the packed copy and nothing else. */
async function linkRepoModules(into: string): Promise<void> {
  for (const entry of await readdir(`${REPO}/node_modules`)) {
    if (entry !== "nanostores-devtools") {
      await symlink(`${REPO}/node_modules/${entry}`, `${into}/${entry}`);
    }
  }
}

export async function installApps(): Promise<Apps> {
  /** The real path, because macOS hands out a symlink and Vite refuses to serve a file behind one. */
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nanostores-devtools-apps-")));
  const app = `${root}/app`;
  const modules = `${app}/node_modules`;
  const theme = `${root}/packages/theme`;
  const tarball = await packPackage(root);

  await cp(FIXTURES, root, { recursive: true });
  await mkdir(`${modules}/nanostores-devtools`, { recursive: true });
  await mkdir(`${modules}/@fixture`, { recursive: true });
  await mkdir(`${theme}/node_modules`, { recursive: true });

  await run("tar", [
    "-xzf",
    tarball,
    "-C",
    `${modules}/nanostores-devtools`,
    "--strip-components=1",
  ]);
  await linkRepoModules(modules);
  await symlink(theme, `${modules}/@fixture/theme`);
  await symlink(`${REPO}/node_modules/nanostores`, `${theme}/node_modules/nanostores`);

  return {
    root,
    app,
    theme: `${theme}/src/theme.js`,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
