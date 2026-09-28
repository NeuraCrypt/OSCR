// A STATIC site: every page is built ahead of time, and a Cloudflare Worker serves
// the pages as static assets, for free and with no traffic limit. The text of a paper
// is never part of the build: the Code ↔ Paper reader loads it from Europe PMC in the
// reader's browser. Future actions (ORCID sign-in of authors, validation of a map) will be
// the Worker's own code; only they consume requests, as the search does (/api/search,
// worker/). The search page is a Svelte island: static HTML, then the form in the browser.
import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";

export default defineConfig({
  site: process.env.SITE_URL ?? "https://oscr.yannbellec-b.workers.dev",
  output: "static",
  trailingSlash: "always",
  integrations: [svelte()],
  // science.css as ONE external file, shared by every page and cached, rather
  // than copied into each of them.
  build: { inlineStylesheets: "never" },
});
