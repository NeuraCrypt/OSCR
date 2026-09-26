// A STATIC site: every page is built ahead of time, and Cloudflare Pages serves
// static files for free, with no traffic limit. The text of a paper is never part
// of the build: the Code ↔ Paper reader loads it from Europe PMC in the reader's
// browser. Future actions (ORCID sign-in of authors, validation of a map) will
// come as Pages Functions in functions/; only they will consume requests.
import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.SITE_URL ?? "https://oscr-2lj.pages.dev",
  output: "static",
  trailingSlash: "always",
  // science.css as ONE external file, shared by every page and cached, rather
  // than copied into each of them.
  build: { inlineStylesheets: "never" },
});
