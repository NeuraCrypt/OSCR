// A STATIC site: every page is built ahead of time, and a Cloudflare Worker serves
// the pages as static assets, for free and with no traffic limit. The text of a paper
// is never part of the build: the Code ↔ Paper reader loads it from Europe PMC in the
// reader's browser. Future actions (search, ORCID sign-in of authors, validation of a
// map) will be the Worker's own code; only they will consume requests.
import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.SITE_URL ?? "https://oscr.yannbellec-b.workers.dev",
  output: "static",
  trailingSlash: "always",
  // science.css as ONE external file, shared by every page and cached, rather
  // than copied into each of them.
  build: { inlineStylesheets: "never" },
});
