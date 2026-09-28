// After `npm run build`: is the site in dist/ whole?
//
//   npm run check                    every page the data asks for exists (a page for each
//                                    paper of decision D2, and none for the others), every
//                                    internal link leads to a file (and every "#" link to an
//                                    element of its page), each paper's page has its
//                                    sections, every lookup shard is there, and no page shows
//                                    an email address
//   npm run check -- --every-route   and every kind of page exists at least once: the CI
//                                    builds from tests/fixtures/public-catalog, which
//                                    exercises them all
//
// It prints the number of files: a Worker's static assets stop at 20,000 per version.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const LIMIT = 20000;
const MARGIN = 15000;
const everyRoute = process.argv.includes("--every-route");
const problems = [];

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
if (!existsSync(DIST)) {
  console.error("No dist/: run `npm run build` first.");
  process.exit(1);
}
const files = walk(DIST).map((f) => f.slice(DIST.length).split("\\").join("/"));
const all = new Set(files);
/** A route ("/browse/", "/lookup/6c6.json") is served by a file of dist/. */
const exists = (route) =>
  route.endsWith("/") ? all.has(`${route}index.html`) : all.has(route) || all.has(`${route}/index.html`);

// 1. The fixed pages.
const FIXED = ["/", "/about/", "/browse/", "/authors/", "/journals/", "/institutions/", "/tools/", "/datasets/",
  "/lookup/", "/search/", "/404.html"];
for (const route of FIXED) if (!exists(route)) problems.push(`missing page ${route}`);

// 2. A page for each paper of decision D2, none for the others; a reader for each paper
// with code; the lookup's shards.
const catalog = JSON.parse(readFileSync("src/data/catalog.json", "utf8"));
for (const a of catalog.articles) {
  const page = a.page === true || a.code.length > 0;
  if (page !== exists(`/paper/${a.slug}/`)) problems.push(`${a.doi}: ${page ? "no page" : "a page it must not have (D2)"}`);
  if (a.code.length > 0 && !exists(`/paper/${a.slug}/code/`)) problems.push(`${a.doi}: no Code ↔ Paper reader`);
}
const shards = existsSync("public/lookup") ? readdirSync("public/lookup").filter((n) => n.endsWith(".json")) : [];
for (const name of shards) if (!exists(`/lookup/${name}`)) problems.push(`missing lookup shard ${name}`);

// 3. Every internal link and resource of every page leads to a file, and every link within
// a page ("#code") to an element of that page. A paper's page has its ten sections.
const pages = files.filter((f) => f.endsWith(".html"));
const SECTIONS = ["overview", "code", "map", "data", "versions", "cite", "similar", "discussion", "reproductions",
  "activity"];
let links = 0;
for (const page of pages) {
  const html = readFileSync(join(DIST, page), "utf8");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  // The Code ↔ Paper reader's "#pair-N" is its script's state, not an element.
  const reader = /^\/paper\/[^/]+\/code\//.test(page);
  for (const [, url] of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    if (url.startsWith("#") && url.length > 1 && !reader) {
      links += 1;
      if (!ids.has(decodeURIComponent(url.slice(1)))) problems.push(`${page}: no element for the link ${url}`);
      continue;
    }
    // /api/* is the Worker's code (sign-in, search), not a file of dist/.
    if (!url.startsWith("/") || url.startsWith("//") || url.startsWith("/api/")) continue;
    links += 1;
    const path = decodeURI(url.split(/[?#]/)[0].replace(/&amp;/g, "&"));
    if (!exists(path)) problems.push(`${page}: broken link ${url}`);
  }
  if (/^\/paper\/[^/]+\/index\.html$/.test(page)) {
    const missing = SECTIONS.filter((id) => !ids.has(id));
    if (missing.length) problems.push(`${page}: no section ${missing.map((id) => `#${id}`).join(", ")}`);
  }
}

// 4. No email address on a page of the site, nor in the lookup. (The Code ↔ Paper reader
// and the script lots show the authors' own code, as they published it.)
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;
for (const f of files) {
  if (!/\.(html|json)$/.test(f) || /^\/paper\/[^/]+\/code\//.test(f) || f.startsWith("/scripts/")) continue;
  const m = readFileSync(join(DIST, f), "utf8").match(EMAIL);
  if (m) problems.push(`${f}: an email address (${m[0]})`);
}

// 5. With --every-route: each kind of page at least once.
const kinds = {
  "/author/<orcid>/": /^\/author\/[^/]+\/index\.html$/,
  "/journal/<id>/": /^\/journal\/[^/]+\/index\.html$/,
  "/institution/<ror>/": /^\/institution\/[^/]+\/index\.html$/,
  "/tool/<id>/": /^\/tool\/[^/]+\/index\.html$/,
  "/dataset/<id>/": /^\/dataset\/[^/]+\/index\.html$/,
  "/browse/<facet>/<value>/": /^\/browse\/[^/]+\/[^/]+\/index\.html$/,
  "/lookup/<shard>.json": /^\/lookup\/[0-9a-f]{3}\.json$/,
};
const counts = Object.fromEntries(Object.entries(kinds).map(([k, re]) => [k, files.filter((f) => re.test(f)).length]));
if (everyRoute) {
  for (const [kind, n] of Object.entries(counts)) if (n === 0) problems.push(`no page ${kind}`);
  for (const s of ["code_verified", "on_request", "data_only"]) {
    if (!catalog.articles.some((a) => a.status === s && exists(`/paper/${a.slug}/`))) problems.push(`no paper page "${s}"`);
  }
}

console.log(`${files.length} files in dist/ (${pages.length} pages, ${shards.length} lookup shards), ` +
  `${links} internal links checked; the limit is ${LIMIT.toLocaleString("en-GB")}.`);
console.log(Object.entries(counts).map(([k, n]) => `  ${k}: ${n}`).join("\n"));
if (files.length > MARGIN) {
  problems.push(`${files.length} files: past the margin of ${MARGIN.toLocaleString("en-GB")} (limit ${LIMIT.toLocaleString("en-GB")})`);
}
if (problems.length) {
  console.error(problems.map((p) => `FAIL ${p}`).join("\n"));
  process.exit(1);
}
console.log("ok: every route, every internal link, no email address.");
