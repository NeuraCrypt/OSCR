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
// The GitHub side (night phase 01): its fixed pages are in FIXED; every /r/<owner>/<name>/… link is
// served by the one shell /r/index.html (public/_redirects: "/r/* /r/ 200"); OSCR's static layer,
// when the export has one, is at most 64 shards /forge/layer/NN.json, each a JSON object. Phase 02:
// the tracing maps, exactly 64 shards /forge/traced/NN.json.
//
// It prints the number of files: a Worker's static assets stop at 20,000 per version.
import { createHash } from "node:crypto";
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
/** A route ("/browse/", "/lookup/6c6.json") is served by a file of dist/. Every repository page
 *  (/r/<owner>/<name>/…) is served by the shell /r/index.html (public/_redirects). */
const exists = (route) =>
  route.startsWith("/r/")
    ? all.has("/r/index.html")
    : /^\/research\/(?:[1-9]\d{0,9}|new)?(?:\?.*)?$/.test(route)
      ? all.has("/research/index.html")
      : route.endsWith("/") ? all.has(`${route}index.html`) : all.has(route) || all.has(`${route}/index.html`);

// 1. The fixed pages.
const FIXED = ["/", "/about/", "/browse/", "/authors/", "/journals/", "/institutions/", "/tools/", "/datasets/",
  "/lookup/", "/search/", "/404.html", "/account/", "/submit/", "/badge.svg",
  // The GitHub side (night phase 01).
  "/new/", "/new/link/", "/new/import/", "/repositories/", "/forge/authorized/", "/r/", "/hosting/", "/hosting/limits/",
  "/hosting/large-files/", "/hosting/git/", "/hosting/history/", "/hosting/tokens/", "/hosting/import/", "/hosting/leave/",
  // Night phase 05: the research issues' one shell.
  "/research/"];
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

// 3. Every internal link and resource of every page leads to a file, and every link within
// a page ("#code") to an element of that page. A paper's page has its sections, the Contribute
// section and its removal request included (Phase 6), and no inline script: its
// Content-Security-Policy (public/_headers) allows this site's files only.
const pages = files.filter((f) => f.endsWith(".html"));
const SECTIONS = ["overview", "code", "map", "data", "versions", "cite", "similar", "contribute", "removal", "discussion",
  "reproductions", "activity"];
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
  if (/^\/(paper\/[^/]+|account|submit|new|new\/link|new\/import|repositories|forge\/authorized|r|research)\/index\.html$/.test(page) &&
      /<script(?![^>]*\ssrc=)[^>]*>/.test(html)) {
    problems.push(`${page}: an inline script, which its Content-Security-Policy forbids`);
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

console.log(`${files.length} files in dist/ (${pages.length} pages, ${shards.length} lookup shards, ${layer.length} forge layer shards), ` +
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
