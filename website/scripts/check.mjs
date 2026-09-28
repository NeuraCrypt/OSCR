// After `npm run build`: is the site in dist/ whole, and within its file budget?
//
//   npm run check                    every page the data asks for exists (a page for each
//                                    paper of decision D2: a file for the STATIC_PAPERS most
//                                    recent, a record rendered on demand for the others, and
//                                    none for the other papers), every internal link leads to a
//                                    file, to an entity's record behind its shell, or to a paper's
//                                    record (and every "#" link to an element of its page), each
//                                    paper's page has its sections, the shards are where their
//                                    keys say, and no page shows an email address
//   npm run check -- --every-route   and every kind of page exists at least once: the CI
//                                    builds from tests/fixtures/public-catalog, which
//                                    exercises them all
//
// It prints the number of files, folder by folder: a Worker's static assets stop at 20,000 per
// version, and the budget (src/lib/shards.ts) keeps the site under 15,000 whatever the size of
// the catalogue: at most 2 × STATIC_PAPERS files of papers, and FIXED_FILES_MAX for the rest.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENTITY_TYPES, FILE_LIMIT, FILE_MARGIN, FIXED_FILES_MAX, LOOKUP_HEX, SHARDS, shardOf, STATIC_PAPERS,
} from "../src/lib/shards.ts";

const DIST = "dist";
const everyRoute = process.argv.includes("--every-route");
const problems = [];
const n = (x) => x.toLocaleString("en-GB");

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
/** A route ("/browse/", "/lookup/6c.json") is served by a file of dist/. */
const exists = (route) =>
  route.endsWith("/") ? all.has(`${route}index.html`) : all.has(route) || all.has(`${route}/index.html`);
const json = (f) => JSON.parse(readFileSync(join(DIST, f), "utf8"));

// 1. The fixed pages, the shells of the pages rendered on demand, and the rewrites that serve
// an entity's shell for its address (public/_redirects).
const FIXED = ["/", "/about/", "/browse/", "/authors/", "/journals/", "/institutions/", "/tools/", "/datasets/",
  "/lookup/", "/search/", "/404.html", "/account/", "/submit/", "/badge.svg", "/paper/404.html",
  ...ENTITY_TYPES.map((t) => `/${t}/`)];
for (const route of FIXED) if (!exists(route)) problems.push(`missing page ${route}`);

const rewrites = new Map();
if (!all.has("/_redirects")) problems.push("no _redirects: the entities' addresses lead nowhere");
else {
  for (const raw of readFileSync(join(DIST, "_redirects"), "utf8").split("\n")) {
    const [from, to, code] = raw.replace(/#.*/, "").trim().split(/\s+/);
    if (from && to && code === "200") rewrites.set(from, to);
  }
}
for (const t of ENTITY_TYPES) {
  if (rewrites.get(`/${t}/:key/`) !== `/${t}/`) problems.push(`_redirects: no rewrite of /${t}/:key/ to its shell /${t}/`);
  // A rewrite applies even where a file would answer: nothing but the shell may live there.
  const under = files.filter((f) => f.startsWith(`/${t}/`) && f !== `/${t}/index.html`);
  if (under.length) problems.push(`/${t}/ holds ${under[0]}, which its rewrite would hide`);
}

// The paper's shell must have what the Worker replaces (worker/pages.ts, fillShell).
if (all.has("/paper/404.html")) {
  const shell = readFileSync(join(DIST, "paper/404.html"), "utf8");
  for (const [what, re] of [["<main>", /<main>[\s\S]*<\/main>/], ["<title>", /<title>[^<]*<\/title>/],
    ["the breadcrumb's #crumb", /<span id="crumb">[^<]*<\/span>/], ["application-name", /<meta name="application-name" content="/]]) {
    if (!re.test(shell)) problems.push(`/paper/404.html: no ${what}, which the Worker fills`);
  }
}

// 2. The records of the pages rendered on demand: each in the shard its key names.
const records = Object.fromEntries([...ENTITY_TYPES, "paper"].map((t) => [t, new Map()]));
const rows = new Map();
for (const f of files.filter((x) => x.startsWith("/records/"))) {
  const m = f.match(/^\/records\/([a-z]+)\/([0-9a-f]{2,4})\.json$/);
  if (!m || !(m[1] in records)) {
    problems.push(`${f}: not a shard of a known type`);
    continue;
  }
  const [, type, name] = m;
  const content = json(f);
  const entries = type === "paper" ? content : content.entities ?? {};
  if (type !== "paper") for (const [slug, r] of Object.entries(content.rows ?? {})) rows.set(slug, r);
  for (const [key, record] of Object.entries(entries)) {
    if ((await shardOf(key, SHARDS[type])) !== name) problems.push(`${f}: ${key} belongs in another shard`);
    records[type].set(key, record);
  }
}
for (const [type, count] of Object.entries(SHARDS)) {
  const written = files.filter((f) => f.startsWith(`/records/${type}/`)).length;
  if (written > count) problems.push(`/records/${type}/: ${written} shards, more than ${count}`);
}

// 3. A page for each paper of decision D2, none for the others: a static one for the most recent,
// a record for the others; a reader for each static paper with code; the lookup's shards.
const catalog = JSON.parse(readFileSync("src/data/catalog.json", "utf8"));
const staticPapers = [];
const onDemand = [];
for (const a of catalog.articles) {
  const page = a.page === true || a.code.length > 0;
  const file = exists(`/paper/${a.slug}/`);
  const record = records.paper.has(a.slug);
  if (!page) {
    if (file || record) problems.push(`${a.doi}: a page it must not have (D2)`);
    continue;
  }
  if (file === record) problems.push(`${a.doi}: ${file ? "both a static page and a record" : "no page"}`);
  (file ? staticPapers : onDemand).push(a);
  if (a.code.length > 0 && file !== exists(`/paper/${a.slug}/code/`)) {
    problems.push(`${a.doi}: ${file ? "no Code ↔ Paper reader" : "a reader without its static page"}`);
  }
}
if (staticPapers.length > STATIC_PAPERS) problems.push(`${n(staticPapers.length)} static paper pages, more than ${n(STATIC_PAPERS)}`);
// The order of staticSelection (src/lib/shards.ts): the most recent first, then by page name.
const key = (a) => `${a.published}\u0000${[...a.slug].map((c) => String.fromCharCode(0xffff - c.charCodeAt(0))).join("")}\uffff`;
const oldestStatic = staticPapers.reduce((m, a) => (m === null || key(a) < key(m) ? a : m), null);
const newestOnDemand = onDemand.reduce((m, a) => (m === null || key(a) > key(m) ? a : m), null);
if (oldestStatic && newestOnDemand && key(newestOnDemand) > key(oldestStatic)) {
  problems.push(`${newestOnDemand.doi} is rendered on demand, but ${oldestStatic.doi}, older, is static`);
}
const shards = existsSync("public/lookup") ? readdirSync("public/lookup").filter((x) => x.endsWith(".json")) : [];
for (const name of shards) {
  if (!new RegExp(`^[0-9a-f]{${LOOKUP_HEX}}\\.json$`).test(name)) problems.push(`lookup shard ${name}: not ${LOOKUP_HEX} hex characters`);
  if (!exists(`/lookup/${name}`)) problems.push(`missing lookup shard ${name}`);
}

/** A path of the site, with no query nor fragment, leads to a file, to an entity's record behind
 *  the rewrite of its shell, or to a paper rendered on demand. */
function leads(path) {
  if (exists(path)) return true;
  const m = path.match(/^\/([a-z]+)\/([^/]+)\/$/);
  if (m && rewrites.has(`/${m[1]}/:key/`) && records[m[1]]) {
    const k = decodeURIComponent(m[2]);
    return records[m[1]].has(m[1] === "author" ? k.toUpperCase() : k.toLowerCase());
  }
  const p = path.match(/^\/paper\/([^/]+)\/$/);
  return p !== null && records.paper.has(p[1]);
}

// 4. Every internal link and resource of every page leads somewhere, and every link within a
// page ("#code") to an element of that page. A paper's page has its sections, the Contribute
// section and its removal request included (Phase 6), and no inline script: its
// Content-Security-Policy (public/_headers) allows this site's files only.
const pages = files.filter((f) => f.endsWith(".html"));
const SECTIONS = ["overview", "code", "map", "data", "versions", "cite", "similar", "contribute", "removal", "discussion",
  "reproductions", "activity"];
let links = 0;
const follow = (from, url) => {
  // /api/* is the Worker's code (sign-in, search), not a file of dist/.
  if (!url.startsWith("/") || url.startsWith("//") || url.startsWith("/api/")) return;
  links += 1;
  const path = decodeURI(url.split(/[?#]/)[0].replace(/&amp;/g, "&"));
  if (!leads(path)) problems.push(`${from}: broken link ${url}`);
};
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
    follow(page, url);
  }
  if (/^\/paper\/[^/]+\/index\.html$/.test(page)) {
    const missing = SECTIONS.filter((id) => !ids.has(id));
    if (missing.length) problems.push(`${page}: no section ${missing.map((id) => `#${id}`).join(", ")}`);
  }
  if (/^\/(paper\/[^/]+|account|submit)\/index\.html$/.test(page) && /<script(?![^>]*\ssrc=)[^>]*>/.test(html)) {
    problems.push(`${page}: an inline script, which its Content-Security-Policy forbids`);
  }
}
// The links the records hold, which the browser or the Worker will render.
const hrefs = (value, out = []) => {
  if (Array.isArray(value)) for (const v of value) hrefs(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if ((k === "href" || k === "search") && typeof v === "string" && v) out.push(v);
      else hrefs(v, out);
    }
  }
  return out;
};
for (const [type, map] of Object.entries(records)) {
  for (const [k, record] of map) {
    for (const url of hrefs(record)) follow(`/records/${type}/ ${k}`, url);
    for (const slug of record.papers ?? []) if (!rows.has(slug)) problems.push(`/records/${type}/ ${k}: no row for ${slug}`);
  }
}
for (const [slug, r] of rows) {
  follow(`a row of ${slug}`, `/paper/${slug}/`);
  if (r.reader) follow(`a row of ${slug}`, `/paper/${slug}/code/`);
}

// 5. No email address on a page of the site, in the lookup or in the records. (The Code ↔ Paper
// reader and the script lots show the authors' own code, as they published it.)
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;
for (const f of files) {
  if (!/\.(html|json)$/.test(f) || /^\/paper\/[^/]+\/code\//.test(f) || f.startsWith("/scripts/")) continue;
  const m = readFileSync(join(DIST, f), "utf8").match(EMAIL);
  if (m) problems.push(`${f}: an email address (${m[0]})`);
}

// 6. With --every-route: each kind of page at least once.
const kinds = {
  "/paper/<slug>/ (static)": staticPapers.length,
  "/paper/<slug>/code/": files.filter((f) => /^\/paper\/[^/]+\/code\/index\.html$/.test(f)).length,
  "/paper/<slug>/ (on demand)": onDemand.length,
  ...Object.fromEntries(ENTITY_TYPES.map((t) => [`/${t}/<key>/`, records[t].size])),
  "/browse/<facet>/<value>/": files.filter((f) => /^\/browse\/[^/]+\/[^/]+\/index\.html$/.test(f)).length,
  "/lookup/<shard>.json": shards.length,
};
if (everyRoute) {
  for (const [kind, count] of Object.entries(kinds)) if (count === 0 && !kind.includes("on demand")) problems.push(`no page ${kind}`);
  for (const s of ["code_verified", "on_request", "data_only"]) {
    if (!catalog.articles.some((a) => a.status === s && exists(`/paper/${a.slug}/`))) problems.push(`no paper page "${s}"`);
  }
}

// 7. The budget, folder by folder.
const folders = new Map();
for (const f of files) {
  const parts = f.split("/").filter(Boolean);
  const folder = parts.length === 1 ? "(root)" : parts[0] === "records" ? `records/${parts[1]}/` : `${parts[0]}/`;
  folders.set(folder, (folders.get(folder) ?? 0) + 1);
}
const paperFiles = files.filter((f) => /^\/paper\/[^/]+\//.test(f) && f !== "/paper/404.html").length;
const others = files.length - paperFiles;
console.log(`${n(files.length)} files in dist/ (${n(pages.length)} pages), ${n(links)} internal links checked; ` +
  `the limit is ${n(FILE_LIMIT)}, the margin ${n(FILE_MARGIN)}.`);
console.log("Files by folder:");
for (const [folder, count] of [...folders].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))) {
  console.log(`  ${String(n(count)).padStart(7)}  ${folder}`);
}
console.log(`Papers: ${n(staticPapers.length)} static (at most ${n(STATIC_PAPERS)}, ${n(paperFiles)} files with their readers), ` +
  `${n(onDemand.length)} rendered on demand; every other file: ${n(others)} (at most ${n(FIXED_FILES_MAX)}).`);
console.log("Pages by kind:");
console.log(Object.entries(kinds).map(([k, c]) => `  ${String(n(c)).padStart(7)}  ${k}`).join("\n"));
if (others > FIXED_FILES_MAX) problems.push(`${n(others)} files besides the papers' pages: past ${n(FIXED_FILES_MAX)}`);
if (files.length > FILE_MARGIN) problems.push(`${n(files.length)} files: past the margin of ${n(FILE_MARGIN)} (limit ${n(FILE_LIMIT)})`);
if (problems.length) {
  console.error(problems.map((p) => `FAIL ${p}`).join("\n"));
  process.exit(1);
}
console.log("ok: every route, every internal link, every record, no email address; within the file budget.");
