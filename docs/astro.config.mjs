// @ts-check
import { defineConfig } from "astro/config";
import docsTheme from "astro-pigment";

export default defineConfig({
  site: "https://nanostores-devtools.psdcoder.dev",
  integrations: [
    docsTheme({
      project: {
        name: "nanostores-devtools",
        description:
          "Inspect nanostores state in the Redux DevTools extension, with every store named after the code you wrote",
        license: {
          name: "MIT",
          url: "https://github.com/psd-coder/nanostores-devtools/blob/main/LICENSE.md",
        },
        github: { user: "psd-coder", repository: "nanostores-devtools" },
      },
      docs: {
        navLinks: [
          { href: "/", label: "Getting started" },
          { href: "/api", label: "API" },
          { href: "/how-it-works", label: "How it works" },
        ],
      },
      theme: {
        customCss: ["./src/styles/custom.css"],
        hue: 210,
        saturation: 24,
      },
      author: { name: "Pavel Grinchenko", url: "https://x.com/psd_coder" },
      credits: [{ name: "Evil Martians", url: "https://evilmartians.com/" }],
      logo: "./assets/logo.svg",
      meta: {
        icon: "./assets/icon.svg",
        og: {
          image: {
            logo: "./assets/logo-og.svg",
          },
        },
      },
    }),
  ],
});
