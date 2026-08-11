import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/**/!(*.test).ts", "!src/testing/**"],
  outDir: "dist",
  format: ["esm"],
  clean: true,
  dts: true,
  treeshake: true,
  unbundle: true,
});
