// After `npm run build`: is the site in dist/ whole, and within its file budget?
//
//   npm run check                    every page the data asks for exists (a page for each
//                                    paper of decision D2: a file for the STATIC_PAPERS most
//                                    recent, a record rendered on demand for the others, and
//                                    none for the other papers; the Code ↔ Paper reader on the
//                                    page of each static paper with code), every internal link leads to a
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
// the catalogue: at most STATIC_PAPERS files of papers (one each, the reader on its page, "code
// first"), and FIXED_FILES_MAX for the rest.
//
// The GitHub side (night phases 01-16), all dormant behind FORGE_OPEN: its fixed pages are in FIXED;
// every /r/<owner>/<name>/… link is served by the one shell /r/index.html (public/_redirects:
// "/r/* /r/ 200"), likewise /u/… and /research/…; OSCR's static layer, when the export has one, is at
// most 64 shards /forge/layer/NN.json, each a JSON object. Phase 02: the tracing maps, exactly 64
// shards /forge/traced/NN.json. They count in FIXED_FILES_MAX: a fixed number, whatever the catalogue.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allowsHash, headersFor, parseHeaders } from "../src/lib/headers.ts";
import { buildOpenapi, ENDPOINTS, REPO_SHARDS } from "../src/lib/apispec.ts";
import {
  ENTITY_TYPES, FILE_LIMIT, FILE_MARGIN, FIXED_FILES_MAX, keyOf, LIST_PAGES_MAX, LOOKUP_HEX, SHARDS, shardOf, SITEMAP_SHARDS,
  SITEMAP_URLS, STATIC_PAPERS,
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
/** A route ("/browse/", "/lookup/6c.json") is served by a file of dist/. Every repository page
 *  (/r/<owner>/<name>/…) is served by the shell /r/index.html, a person's by /u/index.html, a
 *  research issue's by /research/index.html (public/_redirects). */
const exists = (route) =>
  route.startsWith("/r/")
    ? all.has("/r/index.html")
    : /^\/u\/[^/?#]+\/?(?:\?.*)?$/.test(route)
      ? all.has("/u/index.html")
    : /^\/research\/(?:[1-9]\d{0,9}|new)?(?:\?.*)?$/.test(route)
      ? all.has("/research/index.html")
      : route.endsWith("/") ? all.has(`${route}index.html`) : all.has(route) || all.has(`${route}/index.html`);
const json = (f) => JSON.parse(readFileSync(join(DIST, f), "utf8"));

// 1. The fixed pages, the shells of the pages rendered on demand, and the rewrites that serve
// an entity's shell for its address (public/_redirects).
const FIXED = ["/", "/about/", "/help/", "/policies/", "/privacy/", "/brand/", "/labs/", "/taxonomy/", "/list/", "/sitemap.xml", "/robots.txt", "/browse/", "/authors/", "/journals/", "/institutions/", "/tools/", "/datasets/",
  "/lookup/", "/search/", "/404.html", "/account/", "/submit/", "/removal/", "/data-rights/", "/badge.svg", "/paper/404.html",
  ...ENTITY_TYPES.map((t) => `/${t}/`),
  // The GitHub side (night phase 01), dormant behind FORGE_OPEN.
  "/new/", "/new/link/", "/new/import/", "/repositories/", "/forge/authorized/", "/r/", "/hosting/", "/hosting/limits/",
  "/hosting/large-files/", "/hosting/git/", "/hosting/history/", "/hosting/tokens/", "/hosting/import/", "/hosting/leave/",
  // Night phase 05: the research issues' one shell.
  "/research/",
  // Night phase 08: the social pages, and the people's one shell.
  "/notifications/", "/stars/", "/feed/", "/explore/", "/u/",
  // Night phase 09: organizations, and the account's security page.
  "/organizations/",
  // Night phase 10: the tokens, the webhooks, the API's reference.
  "/settings/tokens/", "/settings/hooks/", "/developers/",
  // Night phase 13: snippets, and the snippet shell.
  "/snippets/",
  // Night phase 14: the command line's device approval.
  "/device/",
  // Night phase 15: the ease-of-use pages.
  "/settings/preferences/", "/accessibility/", "/status/",
  // Night phase 16: the report form, the owner's queue, a person's page of hidden things.
  "/report/", "/moderation/", "/account/moderation/", "/notices/", "/settings/blocked/",
  // Night phase 16: the rules and privacy pages.
  "/terms/", "/acceptable-use/", "/guidelines/", "/limits/", "/copyright/"];

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

// The paper's shell must have what the Worker replaces (worker/pages.ts, fillShell), and the
// module script it keeps (the Contribute section's), never an inline one: the page gets the
// static pages' Content-Security-Policy.
if (all.has("/paper/404.html")) {
  const shell = readFileSync(join(DIST, "paper/404.html"), "utf8");
  for (const [what, re] of [["<main>", /<main[^>]*>[\s\S]*<\/main>/], ["<title>", /<title>[^<]*<\/title>/],
    ["the breadcrumb's #crumb", /<span id="crumb">[^<]*<\/span>/], ["application-name", /<meta name="application-name" content="/],
    ["module script in <main>", /<main[^>]*>[\s\S]*<script type="module" src="\/[^"]+"><\/script>[\s\S]*<\/main>/]]) {
    if (!re.test(shell)) problems.push(`/paper/404.html: no ${what}, which the Worker fills`);
  }
  if (/<script(?![^>]*\ssrc=)[^>]*>/.test(shell)) problems.push("/paper/404.html: an inline script, which its Content-Security-Policy forbids");
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
    // The browser and the Worker read the key from the address (keyOf): it must read back the same.
    if (keyOf(type, encodeURIComponent(key)) !== key) problems.push(`${f}: ${key} cannot be read from its address`);
    if ((await shardOf(key, SHARDS[type])) !== name) problems.push(`${f}: ${key} belongs in another shard`);
    records[type].set(key, record);
  }
}
for (const [type, count] of Object.entries(SHARDS)) {
  const written = files.filter((f) => f.startsWith(`/records/${type}/`)).length;
  if (written > count) problems.push(`/records/${type}/: ${written} shards, more than ${count}`);
}

// 2b. The public read API's static data (src/pages/data/, src/lib/apidata.ts, src/lib/apispec.ts):
// the files the API serves and that power users fetch directly (the no-rate-limit path). A fixed
// number of files, keyed the same way the Worker reads them (worker/v1/). No email address passes
// the global scan (section 5); the OpenAPI document must match the endpoints (no drift).
const DATA_FILES = [
  "/data/stats.json", "/data/openapi.json", "/data/articles.csv", "/data/repositories.csv", "/data/alignments.jsonl",
  ...["authors", "journals", "institutions", "tools", "datasets", "categories"].map((t) => `/data/entities/${t}.json`),
];
for (const f of DATA_FILES) if (!all.has(f)) problems.push(`missing API data file ${f}`);
const apiPapers = new Set();
const apiPaperFiles = files.filter((f) => /^\/data\/papers\/[0-9a-f]{2,4}\.json$/.test(f));
if (apiPaperFiles.length > SHARDS.paper) problems.push(`/data/papers/: ${apiPaperFiles.length} shards, more than ${SHARDS.paper}`);
for (const f of apiPaperFiles) {
  const name = f.match(/\/([0-9a-f]+)\.json$/)[1];
  for (const [slug, rec] of Object.entries(json(f))) {
    if ((await shardOf(slug, SHARDS.paper)) !== name) problems.push(`${f}: ${slug} belongs in another shard`);
    // A paper may be identified by its PMCID with no DOI (its slug is pmcid_...), so doi can be
    // empty; the record is sound when it has its slug and an id.
    if (!rec || rec.slug !== slug || !rec.id) problems.push(`${f}: ${slug} record is malformed`);
    apiPapers.add(slug);
  }
}
const apiRepoFiles = files.filter((f) => /^\/data\/repos\/[0-9a-f]{2,4}\.json$/.test(f));
if (apiRepoFiles.length > REPO_SHARDS) problems.push(`/data/repos/: ${apiRepoFiles.length} shards, more than ${REPO_SHARDS}`);
for (const f of apiRepoFiles) {
  const name = f.match(/\/([0-9a-f]+)\.json$/)[1];
  for (const repo of Object.keys(json(f))) if ((await shardOf(repo, REPO_SHARDS)) !== name) problems.push(`${f}: ${repo} belongs in another shard`);
}
if (all.has("/data/openapi.json")) {
  const docPaths = new Set(Object.keys(json("/data/openapi.json").paths ?? {}));
  const specPaths = new Set(ENDPOINTS.map((e) => e.path || "/"));
  const builtPaths = new Set(Object.keys(buildOpenapi().paths));
  for (const p of specPaths) if (!docPaths.has(p)) problems.push(`/data/openapi.json: missing path ${p} (rebuild: it drifted from the routes)`);
  for (const p of docPaths) if (!specPaths.has(p) || !builtPaths.has(p)) problems.push(`/data/openapi.json: unexpected path ${p}`);
}

// 3. A page for each paper of decision D2, none for the others: a static one for the most recent,
// a record for the others; the reader on the page of each static paper with code whose files were
// read (its former address, /paper/<slug>/code/, is no file: the Worker sends it to the page);
// the lookup's shards.
const catalog = JSON.parse(readFileSync("src/data/catalog.json", "utf8"));
const staticPapers = [];
const withReader = [];
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
  if (exists(`/paper/${a.slug}/code/`)) problems.push(`${a.doi}: a file at /paper/${a.slug}/code/, the reader's former address`);
  // A static page carries what a removal request may name (src/lib/removal.ts), first in its <main>:
  // the page /removal/ and the Worker read it there, and stop reading.
  if (file) {
    const html = readFileSync(join(DIST, `paper/${a.slug}/index.html`), "utf8");
    const m = html.match(/<main[^>]*><script type="application\/json" id="paper-facts">([^<]*)<\/script>/);
    let facts = null;
    try {
      facts = m ? JSON.parse(m[1]) : null;
    } catch {
      // said below
    }
    if (!facts || facts.id !== a.id || !Array.isArray(facts.repos) || facts.repos.length !== a.code.length) {
      problems.push(`${a.doi}: its page does not carry its facts first in <main> (the removal request reads them there)`);
    }
  }
  if (file && a.code.length > 0) {
    const html = readFileSync(join(DIST, `paper/${a.slug}/index.html`), "utf8");
    const read = a.code.some((r) => r.files_read > 0);
    const reader = /<section id="code" class="reader"/.test(html) && html.includes('id="reader-data"');
    if (read && !reader) problems.push(`${a.doi}: its code was read, but its page has no Code ↔ Paper reader`);
    if (read && reader) withReader.push(a);
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
// Every paper with a page has a public API record under /data/papers/ (the DOI endpoint reads it).
for (const a of [...staticPapers, ...onDemand]) {
  if (!apiPapers.has(a.slug)) problems.push(`${a.doi}: no /data/papers/ API record (the /api/v1/paper endpoint needs it)`);
}
const shards = existsSync("public/lookup") ? readdirSync("public/lookup").filter((x) => x.endsWith(".json")) : [];
for (const name of shards) {
  if (!new RegExp(`^[0-9a-f]{${LOOKUP_HEX}}\\.json$`).test(name)) problems.push(`lookup shard ${name}: not ${LOOKUP_HEX} hex characters`);
  if (!exists(`/lookup/${name}`)) problems.push(`missing lookup shard ${name}`);
}

// OSCR's static layer for the repository pages (scripts/data.mjs copies it when the export has one):
// at most 64 shards, 00.json to 63.json, each an object keyed by "owner/name" in lower case.
const layer = existsSync("public/forge/layer") ? readdirSync("public/forge/layer") : [];
if (layer.length > 64) problems.push(`${layer.length} forge layer shards: 64 at most`);
for (const name of layer) {
  const m = /^(\d{2})\.json$/.exec(name);
  if (!m || Number(m[1]) > 63) {
    problems.push(`public/forge/layer/${name}: not a shard (00.json to 63.json)`);
    continue;
  }
  if (!exists(`/forge/layer/${name}`)) problems.push(`missing forge layer shard ${name}`);
  let entries;
  try {
    entries = JSON.parse(readFileSync(`public/forge/layer/${name}`, "utf8"));
  } catch {
    problems.push(`public/forge/layer/${name}: not JSON`);
    continue;
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) problems.push(`public/forge/layer/${name}: not an object`);
  else for (const key of Object.keys(entries)) if (key !== key.toLowerCase() || key.split("/").length !== 2) problems.push(`public/forge/layer/${name}: key ${key}`);
}

// The research issues for signed-out readers (night phase 05; scripts/data.mjs copies them when the
// export has them): at most 64 shards, 00.json to 63.json, each an object keyed by an issue's number,
// in the shard its number mod 64 names.
const research = existsSync("public/forge/research") ? readdirSync("public/forge/research") : [];
if (research.length > 64) problems.push(`${research.length} research shards: 64 at most`);
for (const name of research) {
  const m = /^(\d{2})\.json$/.exec(name);
  if (!m || Number(m[1]) > 63) {
    problems.push(`public/forge/research/${name}: not a shard (00.json to 63.json)`);
    continue;
  }
  let entries;
  try {
    entries = JSON.parse(readFileSync(`public/forge/research/${name}`, "utf8"));
  } catch {
    problems.push(`public/forge/research/${name}: not JSON`);
    continue;
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) problems.push(`public/forge/research/${name}: not an object`);
  else for (const key of Object.keys(entries)) if (!/^[1-9]\d{0,9}$/.test(key) || Number(key) % 64 !== Number(m[1])) problems.push(`public/forge/research/${name}: key ${key}`);
}

// The social layer for signed-out readers (night phase 08; scripts/data.mjs copies it when the export
// has it): at most 64 shards, 00.json to 63.json, each an object whose keys sit in the shard the first
// byte of their SHA-256 names, mod 64; the Explore page's explore.json; no email address anywhere.
const social = existsSync("public/social") ? readdirSync("public/social") : [];
if (social.filter((n) => n !== "explore.json").length > 64) problems.push(`${social.length} social shards: 64 at most`);
for (const name of social) {
  const m = /^(\d{2})\.json$/.exec(name);
  if (name !== "explore.json" && (!m || Number(m[1]) > 63)) {
    problems.push(`public/social/${name}: not a shard (00.json to 63.json) nor explore.json`);
    continue;
  }
  const text = readFileSync(`public/social/${name}`, "utf8");
  if (/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/.test(text)) problems.push(`public/social/${name}: an email address`);
  let entries;
  try {
    entries = JSON.parse(text);
  } catch {
    problems.push(`public/social/${name}: not JSON`);
    continue;
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) problems.push(`public/social/${name}: not an object`);
  else if (m) {
    for (const key of Object.keys(entries)) if (createHash("sha256").update(key).digest()[0] % 64 !== Number(m[1])) problems.push(`public/social/${name}: key ${key} out of its shard`);
  }
}

// The tracing maps of the repository pages (night phase 02, E4): exactly 64 shards built from the
// catalogue, /forge/traced/00.json to 63.json, each an object keyed by "owner/name" in lower case,
// holding maps (paper, commit, pairs) and no paper text.
const traced = existsSync(join(DIST, "forge/traced")) ? readdirSync(join(DIST, "forge/traced")) : [];
if (traced.length !== 64) problems.push(`${traced.length} tracing-map shards: 64 expected`);
for (const name of traced) {
  const m = /^(\d{2})\.json$/.exec(name);
  if (!m || Number(m[1]) > 63) {
    problems.push(`/forge/traced/${name}: not a shard (00.json to 63.json)`);
    continue;
  }
  let entries;
  try {
    entries = JSON.parse(readFileSync(join(DIST, "forge/traced", name), "utf8"));
  } catch {
    problems.push(`/forge/traced/${name}: not JSON`);
    continue;
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    problems.push(`/forge/traced/${name}: not an object`);
    continue;
  }
  for (const [key, maps] of Object.entries(entries)) {
    if (key !== key.toLowerCase() || key.split("/").length !== 2) problems.push(`/forge/traced/${name}: key ${key}`);
    for (const map of Array.isArray(maps) ? maps : [null]) {
      if (!map || !/^[0-9a-f]{40}$/.test(map.commit ?? "") || !Array.isArray(map.pairs)) problems.push(`/forge/traced/${name}: a map of ${key} without its commit or pairs`);
      else for (const p of map.pairs) if (Object.keys(p).some((k) => !["pair", "path", "start", "end", "section", "paragraph", "symbol"].includes(k))) problems.push(`/forge/traced/${name}: a pair of ${key} carries more than its link`);
    }
  }
}

/** A path of the site, with no query nor fragment, leads to a file (or a shell of the GitHub side),
 *  to an entity's record behind the rewrite of its shell, or to a paper rendered on demand. */
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
/** The paths the static pages link to: every paper with a page must be one of them (the list by
 *  date, /list/, links to all of them since the home page shows only the latest). */
const linked = new Set();
const follow = (from, url) => {
  // /api/* is the Worker's code (sign-in, search), not a file of dist/.
  if (!url.startsWith("/") || url.startsWith("//") || url.startsWith("/api/")) return;
  links += 1;
  const path = decodeURI(url.split(/[?#]/)[0].replace(/&amp;/g, "&"));
  if (from.endsWith(".html")) linked.add(path);
  if (!leads(path)) problems.push(`${from}: broken link ${url}`);
};
for (const page of pages) {
  const html = readFileSync(join(DIST, page), "utf8");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  // The Code ↔ Paper reader's "#pair-N" is its script's state, not an element.
  for (const [, url] of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    if (/^#pair-\d+$/.test(url)) continue;
    if (url.startsWith("#") && url.length > 1) {
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
  // (The reader's data, a <script type="application/json">, is not run: it is allowed.)
  if (/^\/(paper\/[^/]+|account|submit|removal|new|new\/link|new\/import|repositories|forge\/authorized|r|research|settings\/tokens|settings\/hooks|developers|report|moderation|account\/moderation|settings\/blocked|data-rights)\/index\.html$/.test(page) &&
      /<script(?![^>]*\s(?:src=|type="application\/json"))[^>]*>/.test(html)) {
    problems.push(`${page}: an inline script, which its Content-Security-Policy forbids`);
  }
}
// Every page's inline scripts and styles are allowed by the Content-Security-Policy public/_headers
// gives it (the Worker gives its pages the same: the shell of a paper rendered on demand gets a
// paper's): by their SHA-256, never by 'unsafe-inline'. A style attribute is refused outright.
if (all.has("/_headers")) {
  const headerRules = parseHeaders(readFileSync(join(DIST, "_headers"), "utf8"));
  for (const page of pages) {
    const path = page === "/paper/404.html" ? "/paper/shell/" : page.replace(/index\.html$/, "");
    const policies = (headersFor(headerRules, path).get("content-security-policy") ?? "").split(",").filter((x) => x.trim());
    const html = readFileSync(join(DIST, page), "utf8");
    const inline = [
      ...[...html.matchAll(/<script(?![^>]*\ssrc=)(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => ["script-src", m[1]]),
      ...[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => ["style-src", m[1]]),
    ];
    for (const [directive, body] of inline) {
      const hash = createHash("sha256").update(body).digest("base64");
      if (!policies.every((p) => allowsHash(p, directive, hash))) {
        problems.push(`${page}: an inline ${directive === "script-src" ? "script" : "style"} its Content-Security-Policy refuses; allow it in public/_headers with '${`sha256-${hash}`}'`);
      }
    }
    if (policies.length && /<[a-z][^>]*\sstyle="/i.test(html)) problems.push(`${page}: a style attribute, which science.css's rule and the policy refuse`);
  }
}

// Every paper with a page is reachable by a link of a static page, and the list holds a bounded
// number of pages.
for (const a of [...staticPapers, ...onDemand]) {
  if (!linked.has(`/paper/${a.slug}/`)) problems.push(`${a.doi}: no static page links to its page (the list by date should)`);
}
const listPages = files.filter((f) => /^\/list\/(\d+\/)?index\.html$/.test(f)).length;
if (listPages > LIST_PAGES_MAX) problems.push(`/list/: ${n(listPages)} pages, more than ${n(LIST_PAGES_MAX)}`);
// The sitemap: its index names its shards, SITEMAP_SHARDS at most, each of SITEMAP_URLS addresses at
// most, every address leads to a page, and every paper with a page is there.
if (all.has("/sitemap.xml")) {
  const shardsListed = [...readFileSync(join(DIST, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  const shardFiles = files.filter((f) => f.startsWith("/sitemaps/"));
  if (shardsListed.length > SITEMAP_SHARDS || shardFiles.length > SITEMAP_SHARDS) problems.push(`the sitemap has more than ${SITEMAP_SHARDS} shards`);
  const listed = new Set();
  for (const shard of shardsListed) {
    if (!all.has(shard)) {
      problems.push(`/sitemap.xml names ${shard}, which does not exist`);
      continue;
    }
    const locs = [...readFileSync(join(DIST, shard), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1].replace(/&amp;/g, "&")).pathname);
    if (locs.length > SITEMAP_URLS) problems.push(`${shard}: ${n(locs.length)} addresses, more than ${n(SITEMAP_URLS)}`);
    for (const path of locs) {
      listed.add(path);
      if (!leads(decodeURI(path))) problems.push(`${shard}: ${path} leads nowhere`);
    }
  }
  for (const a of [...staticPapers, ...onDemand]) if (!listed.has(`/paper/${a.slug}/`)) problems.push(`${a.doi}: not in the sitemap`);
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
for (const slug of rows.keys()) follow(`a row of ${slug}`, `/paper/${slug}/`);

// 5. No email address on a page of the site, in the lookup or in the records. (The lines of code
// of the Code ↔ Paper reader and the script lots show the authors' own code, as they published it,
// their addresses masked by the export: catalog.mask_emails.)
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;
for (const f of files) {
  if (!/\.(html|json)$/.test(f) || f.startsWith("/scripts/")) continue;
  const text = readFileSync(join(DIST, f), "utf8").replace(/<ol class="lines[^"]*" id="lines"[^>]*>[\s\S]*?<\/ol>/, "");
  const m = text.match(EMAIL);
  if (m) problems.push(`${f}: an email address (${m[0]})`);
}

// 6. With --every-route: each kind of page at least once.
const kinds = {
  "/paper/<slug>/ (static)": staticPapers.length,
  "/paper/<slug>/ with the reader": withReader.length,
  "/paper/<slug>/ (on demand)": onDemand.length,
  ...Object.fromEntries(ENTITY_TYPES.map((t) => [`/${t}/<key>/`, records[t].size])),
  "/browse/<facet>/<value>/": files.filter((f) => /^\/browse\/[^/]+\/[^/]+\/index\.html$/.test(f)).length,
  "/list/ and its pages": listPages,
  "/lookup/<shard>.json": shards.length,
};
if (everyRoute) {
  for (const [kind, count] of Object.entries(kinds)) if (count === 0 && !kind.includes("on demand")) problems.push(`no page ${kind}`);
  for (const s of ["code_verified", "on_request", "data_only"]) {
    if (!catalog.articles.some((a) => a.status === s && exists(`/paper/${a.slug}/`))) problems.push(`no paper page "${s}"`);
  }
}

// 6b. No em dash (U+2014) in OSCR's OWN text. The em dash reads as AI-generated text and hurts
// the project's scientific credibility, so it is banned from every text the registry itself writes
// (CLAUDE.md, the website's style): a comma, a colon or parentheses instead. The same ban is
// enforced on the Mac's Python by tests/test_no_em_dash.py.
//
// It scans the SOURCE the registry authors (src/**: .astro, .ts, .svelte), NOT the built HTML: a
// paper's own title, abstract or availability statement is the authors' words, faithfully kept, so
// an author who wrote an em dash keeps it (src/data/** holds that harvested content, excluded here).
// Runs on every `npm run check`, not only with --every-route.
const EM_DASH = "—";
const scanForDash = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (p === "src/data") continue; // harvested author content, kept verbatim
      scanForDash(p);
    } else if (/\.(astro|ts|svelte)$/.test(e.name)) {
      const text = readFileSync(p, "utf8");
      if (!text.includes(EM_DASH)) continue;
      const hits = text.split("\n").map((l, i) => (l.includes(EM_DASH) ? i + 1 : 0)).filter(Boolean);
      problems.push(`em dash (U+2014) in ${p}, line ${hits.join(", ")}: banned from the registry's own text (use a comma, colon or parentheses)`);
    }
  }
};
scanForDash("src");

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
console.log(`Papers: ${n(staticPapers.length)} static (at most ${n(STATIC_PAPERS)}, ${n(paperFiles)} files, the readers on their pages), ` +
  `${n(onDemand.length)} rendered on demand; every other file: ${n(others)} (at most ${n(FIXED_FILES_MAX)}).`);
console.log("Pages by kind:");
console.log(Object.entries(kinds).map(([k, c]) => `  ${String(n(c)).padStart(7)}  ${k}`).join("\n"));
// A launch warning, never a failure: the privacy page and the terms name the operator (OPERATOR_NAME and
// OPERATOR_ADDRESS, src/config.ts, or at build time); while they are empty, the pages say that they are
// published before the public launch.
if (all.has("/privacy/index.html") && readFileSync(join(DIST, "privacy/index.html"), "utf8").includes('id="operator-missing"')) {
  console.warn("LAUNCH WARNING: the operator's name and postal address are empty (OPERATOR_NAME, OPERATOR_ADDRESS in " +
    "src/config.ts, or at build time): /privacy/ and /policies/terms/ say they are published before the launch.");
}
if (others > FIXED_FILES_MAX) problems.push(`${n(others)} files besides the papers' pages: past ${n(FIXED_FILES_MAX)}`);
if (files.length > FILE_MARGIN) problems.push(`${n(files.length)} files: past the margin of ${n(FILE_MARGIN)} (limit ${n(FILE_LIMIT)})`);
if (problems.length) {
  console.error(problems.map((p) => `FAIL ${p}`).join("\n"));
  process.exit(1);
}
console.log("ok: every route, every internal link, every record, no email address; within the file budget.");
