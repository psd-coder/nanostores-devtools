import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resetDevtoolsGlobal } from "../src/global.ts";
import { listEntries } from "../src/stores/registry.ts";
import { type Apps, installApps } from "./support/apps.ts";
import { BUNDLERS, type DevRun, runBundle, startViteServer } from "./support/bundlers.ts";

/** Packing, installing and a real build per bundler. */
const SLOW = 120_000;

let apps: Apps;

function names(): string[] {
  return listEntries()
    .map((entry) => entry.name)
    .sort();
}

beforeAll(async () => {
  apps = await installApps();
}, SLOW);

afterAll(async () => {
  await apps.remove();
});

describe.each(BUNDLERS)("a $name dev run", ({ dev }) => {
  let run: DevRun;

  beforeAll(async () => {
    resetDevtoolsGlobal();
    run = await dev(apps);
  }, SLOW);

  afterAll(async () => {
    await run.stop();
    resetDevtoolsGlobal();
  });

  it("registers the app's stores and the stores of a package beside it", () => {
    expect(names()).toEqual(["$count", "$theme", "$user"]);
  });
});

/**
 * The one shape only Vite has: a module served to the browser. The node bundlers answer the same
 * question by construction, since their dev bundle runs and registers all three stores above.
 */
describe("a Vite dev server", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await startViteServer(apps);
  }, SLOW);

  afterAll(async () => {
    await server.close();
  });

  it("serves the browser one runtime, which both store files import", async () => {
    const client = server.environments.client;
    const inside = await client.transformRequest("/src/counter.js");
    const outside = await client.transformRequest(`/@fs${apps.theme}`);
    const imported = /from "([^"]*runtime[^"]*)"/.exec(inside?.code ?? "")?.[1];

    expect(imported).toBeDefined();
    expect(outside?.code).toContain(imported);
    expect(await client.transformRequest(imported ?? "")).not.toBeNull();
  });
});

describe.each(BUNDLERS)("a $name production build", ({ production, productionWarnings }) => {
  let bundle: string;
  let warnings: string[];

  beforeAll(async () => {
    resetDevtoolsGlobal();
    warnings = [];

    const warn = vi.spyOn(console, "warn").mockImplementation((message: string) => {
      warnings.push(message);
    });

    try {
      bundle = await production(apps);
    } finally {
      warn.mockRestore();
    }
  }, SLOW);

  afterAll(() => {
    resetDevtoolsGlobal();
  });

  it("carries the app's own stores and nothing of the plugin's", () => {
    expect(bundle).toContain(`"dark"`);
    expect(bundle).not.toContain("__nsdt");
    expect(bundle).not.toContain("fileScope");
    expect(bundle).not.toContain("nanostores-devtools/runtime");
  });

  it("registers nothing when it runs", () => {
    runBundle(apps, bundle);

    expect(names()).toEqual([]);
  });

  it("says out loud that it did nothing, when the bundler loads it at all", () => {
    expect(warnings.length > 0).toBe(productionWarnings.length > 0);

    for (const word of productionWarnings) {
      expect(warnings.join("\n")).toContain(word);
    }
  });
});
