/**
 * The documented setup with no guard around it. `packaging.test.ts` builds this file with Vite and
 * reads the bundle to see which module the export conditions picked.
 */
import { connectDevtools, trackStores, untrack } from "nanostores-devtools";

const handle = connectDevtools({ name: "fixture" });

trackStores("fixture", {});
untrack("fixture");

globalThis.fixtureConnected = handle.connected;
