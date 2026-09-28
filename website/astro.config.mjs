// A STATIC site: every page is built ahead of time, and a Cloudflare Worker serves
// the pages as static assets, for free and with no traffic limit. The text of a paper
// is never part of the build: the Code ↔ Paper reader loads it from Europe PMC in the
// reader's browser. Future actions (ORCID sign-in of authors, validation of a map) will be
// the Worker's own code; only they consume requests, as the search does (/api/search,
// worker/). The search page is a Svelte island: static HTML, then the form in the browser.
import { existsSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";

// The shell of the papers rendered on demand (src/pages/paper/404.astro) must be
// dist/paper/404.html: the Worker reads it there, and the assets would serve it as the nearest
// 404 page of /paper/ if the Worker were not asked (wrangler.toml).
const paperShell = {
  name: "oscr-paper-shell",
  hooks: {
    "astro:build:done": ({ dir }) => {
      const root = fileURLToPath(dir);
      if (!existsSync(`${root}paper/404/index.html`)) return;
      renameSync(`${root}paper/404/index.html`, `${root}paper/404.html`);
      rmSync(`${root}paper/404`, { recursive: true });
    },
  },
};

export default defineConfig({
  site: process.env.SITE_URL ?? "https://oscr.yannbellec-b.workers.dev",
  output: "static",
  trailingSlash: "always",
  integrations: [svelte(), paperShell],
  // science.css as ONE external file, shared by every page and cached, rather
  // than copied into each of them.
  build: { inlineStylesheets: "never" },
  // Every page script as a file of the site, never inline: the pages that ask the Worker for
  // a signed-in reader (the account, a paper's page, /submit/) forbid inline scripts in their
  // Content-Security-Policy (public/_headers).
  vite: { build: { assetsInlineLimit: 0 } },
});
