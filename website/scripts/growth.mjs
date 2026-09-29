// The site's number of files does not grow with the catalogue (docs/PLATFORM_PLAN.md §6):
//
//   npm run check:growth
//
// builds the site twice with only OSCR_STATIC_PAPERS=2 papers static: from the fixture
// (tests/fixtures/public-catalog), then from the fixture grown with thousands of synthetic authors,
// institutions, tools, datasets, journals, papers with a page and DOIs read. Each build must pass
// `npm run check`; then every folder must hold the same number of files in both, but the shards
// (/records/<type>/, at most SHARDS[type]; /lookup/, at most 256) and the authors' list (one page a
// letter, 27 at most), which are bounded whatever the catalogue. It leaves dist/ built from the
// grown fixture; the synthetic export is written to a temporary folder, removed afterwards.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_MARGIN, LOOKUP_HEX, SHARDS } from "../src/lib/shards.ts";

const FIXTURE = new URL("../../tests/fixtures/public-catalog/", import.meta.url).pathname;
/** How much the fixture grows: a few times today's real catalogue for each kind. */
const GROW = { authors: 40_000, institutions: 15_000, tools: 1_000, datasets: 8_000, journals: 2_000, papers: 12_000, dois: 150_000 };
const STATIC = "2";

const json = (f) => JSON.parse(readFileSync(f, "utf8"));
const write = (f, v) => writeFileSync(f, JSON.stringify(v));

function grow(dir) {
  cpSync(FIXTURE, dir, { recursive: true });
  const catalog = json(join(dir, "catalog.json"));
  // Papers with a page ("on request"), older than the fixture's, so that its own stay static.
  const papers = Array.from({ length: GROW.papers }, (_, i) => {
    const doi = `10.5555/oscr.growth.${i}`;
    return {
      id: `doi:${doi}`, slug: `doi_10.5555_oscr.growth.${i}`, doi, pmcid: "", fulltext_id: "",
      title: `A synthetic paper ${i}`, journal: "Journal of Synthetic Fixtures", journal_id: "issn:0000-0019",
      published: `20${String(10 + (i % 15)).padStart(2, "0")}-0${1 + (i % 9)}-1${i % 10}`,
      status: "on_request", page: true, code: [], data_links: 0, families: [], alignment: null, card: null,
    };
  });
  catalog.articles.push(...papers);
  write(join(dir, "catalog.json"), catalog);
  const slugs = papers.map((p) => p.slug);
  const some = (i, n) => Array.from({ length: n }, (_, j) => slugs[(i * 7 + j * 131) % slugs.length]);
  const counts = (n) => ({ papers: n, with_code: 0 });
  const e = (name) => join(dir, "entities", `${name}.json`);
  const orcid = (i) => {
    // An ORCID iD with its check digit (ISO 7064 11,2), as the export writes them.
    const base = String(9_000_000_000 + i).padStart(15, "0");
    let total = 0;
    for (const c of base) total = (total + Number(c)) * 2;
    const r = (12 - (total % 11)) % 11;
    const id = `${base}${r === 10 ? "X" : r}`;
    return `${id.slice(0, 4)}-${id.slice(4, 8)}-${id.slice(8, 12)}-${id.slice(12)}`;
  };
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  write(e("authors"), [
    ...json(e("authors")),
    ...Array.from({ length: GROW.authors }, (_, i) => ({
      orcid: orcid(i), name: `Given${i} ${LETTERS[i % 26]}family${i}`, given: `Given${i}`, family: `${LETTERS[i % 26]}family${i}`,
      papers: some(i, 3), affiliations: [], institutions: [`0gr${String(i % GROW.institutions).padStart(6, "0")}`], tools: [], counts: counts(3),
    })),
  ]);
  write(e("institutions"), [
    ...json(e("institutions")),
    ...Array.from({ length: GROW.institutions }, (_, i) => ({
      id: `0gr${String(i).padStart(6, "0")}`, name: `Synthetic Institute ${i}`, country: "NL", type: "education",
      papers: some(i, 4), authors: [orcid(i)], counts: counts(4),
    })),
  ]);
  write(e("tools"), [
    ...json(e("tools")),
    ...Array.from({ length: GROW.tools }, (_, i) => ({
      id: `synthtool${i}`, slug: `synthtool${i}`, name: `SynthTool ${i}`, kind: "library", homepage: "", rrid: "",
      repositories: [], papers: some(i, 5), counts: { ...counts(5), repositories: 0 },
    })),
  ]);
  write(e("datasets"), [
    ...json(e("datasets")),
    ...Array.from({ length: GROW.datasets }, (_, i) => ({
      id: `doi:10.5555/oscr.growth.data.${i}`, slug: `doi-10.5555-oscr.growth.data.${i}`, repository: "DOI",
      url: `https://doi.org/10.5555/oscr.growth.data.${i}`, title: "", license: "", papers: some(i, 2), counts: counts(2),
    })),
  ]);
  write(e("journals"), [
    ...json(e("journals")),
    ...Array.from({ length: GROW.journals }, (_, i) => ({
      id: `issn:9${String(i).padStart(3, "0")}-0000`, slug: `issn-9${String(i).padStart(3, "0")}-0000`, title: `Synthetic Journal ${i}`,
      issn: "", eissn: "", publisher: "", papers: some(i, 6), counts: { ...counts(6), read: 12 },
    })),
  ]);
  // The DOI lookup: the fixture's shards, and many more DOIs read.
  const shards = new Map();
  for (const f of readdirSync(join(dir, "lookup"))) shards.set(f.slice(0, -5), json(join(dir, "lookup", f)));
  const put = (doi, entry) => {
    const name = createHash("sha1").update(doi).digest("hex").slice(0, LOOKUP_HEX);
    if (!shards.has(name)) shards.set(name, {});
    shards.get(name)[doi] = entry;
  };
  for (const p of papers) put(p.doi, ["on_request", "2026-09-21", p.slug]);
  for (let i = 0; i < GROW.dois; i += 1) put(`10.5555/oscr.growth.read.${i}`, ["none", "2026-09-21"]);
  for (const [name, shard] of shards) write(join(dir, "lookup", `${name}.json`), shard);
}

/** Builds from `dir`, checks the build, and counts its files folder by folder. */
function build(dir, label) {
  const env = { ...process.env, CATALOG_DIR: dir, OSCR_STATIC_PAPERS: STATIC };
  console.log(`== ${label}: building`);
  execFileSync("npm", ["run", "build"], { env, stdio: ["ignore", "ignore", "inherit"] });
  const check = execFileSync("npm", ["run", "check"], { env, encoding: "utf8" });
  console.log(check.split("\n").find((l) => l.includes("files in dist/")));
  const folders = new Map();
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(join(d, x.name)) : [join(d, x.name)]));
  const files = walk("dist").map((f) => f.slice("dist/".length));
  for (const f of files) {
    const parts = f.split("/");
    const folder = parts.length === 1 ? "(root)" : parts[0] === "records" ? `records/${parts[1]}/` : `${parts[0]}/`;
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }
  return { total: files.length, folders };
}

const base = build(FIXTURE, "the fixture");
const dir = mkdtempSync(join(tmpdir(), "oscr-growth-"));
let grown;
try {
  grow(dir);
  grown = build(dir, `the fixture grown (${Object.entries(GROW).map(([k, n]) => `${n.toLocaleString("en-GB")} ${k}`).join(", ")})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/** What may differ, and its bound. */
const bounded = (folder) => {
  const r = folder.match(/^records\/([a-z]+)\/$/);
  if (r) return SHARDS[r[1]];
  if (folder === "lookup/") return 16 ** LOOKUP_HEX + 1; // and the lookup's own page
  if (folder === "authors/") return 28; // A to Z, "Other", and the list's own page
  return undefined;
};
const problems = [];
console.log("files by folder: the fixture → grown");
for (const folder of [...new Set([...base.folders.keys(), ...grown.folders.keys()])].sort()) {
  const x = base.folders.get(folder) ?? 0;
  const y = grown.folders.get(folder) ?? 0;
  const bound = bounded(folder);
  console.log(`  ${folder.padEnd(22)} ${String(x).padStart(5)} → ${String(y).padStart(5)}${bound ? `  (at most ${bound})` : ""}`);
  if (bound === undefined ? x !== y : y > bound) problems.push(`${folder}: ${x} → ${y}`);
}
console.log(`total: ${base.total} → ${grown.total} files (the margin: ${FILE_MARGIN})`);
if (grown.total > FILE_MARGIN) problems.push(`${grown.total} files, past the margin`);
if (problems.length) {
  console.error(problems.map((p) => `FAIL ${p}`).join("\n"));
  process.exit(1);
}
console.log("ok: the number of files does not grow with the catalogue.");
