// The harvester's public export → the data of the site.
//
// The source is the folder named by CATALOG_DIR (default ../data/public), ALWAYS
// exported in public mode: it holds the text of scripts only when their license
// allows republishing it, and not a single sentence of any paper. A catalog that
// is not public is refused.
//
//   catalog.json      → src/data/catalog.json        (read at build time)
//   alignments/NN.json → src/data/alignments/NN.json (read at build time)
//   scripts/NN.json   → public/scripts/NN.json       (fetched by the reader on demand)
//   entities/*.json   → src/data/entities/*.json     (read at build time: authors, journals,
//                                                     institutions, tools, datasets, categories)
//   lookup/NN.json    → public/lookup/NN.json        (fetched by the DOI lookup page)
//   papers/NN.json    → src/data/papers/NN.json      (read at build time: the sections of
//                                                     each paper's page)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const source = process.env.CATALOG_DIR ?? "../data/public";
const file = `${source}/catalog.json`;
if (!existsSync(file)) {
  console.error(`No catalog in ${source}: run the harvester's public export first, or set CATALOG_DIR.`);
  process.exit(1);
}
const catalog = JSON.parse(readFileSync(file, "utf8"));
if (catalog.public !== true) {
  console.error(`${source} was not exported in public mode: it does not go on the site.`);
  process.exit(1);
}

// No email address is ever displayed (CLAUDE.md). The export already strips them
// (oscr/entities.py); anything that still looks like one is removed here too, from the
// entities and from the authors of each paper.
const EMAIL = /[\w.+-]+\s*[@＠]\s*[\w-]+(?:\.[\w-]+)+/;
const EMAILS = new RegExp(EMAIL.source, "g");
let scrubbed = 0;
const scrub = (v) => {
  if (typeof v === "string") {
    if (!EMAIL.test(v)) return v;
    scrubbed += 1;
    return v.replace(EMAILS, "").replace(/\s{2,}/g, " ").trim();
  }
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
};
for (const a of catalog.articles) if (a.authors) a.authors = scrub(a.authors);

mkdirSync("src/data", { recursive: true });
writeFileSync("src/data/catalog.json", JSON.stringify(catalog));

// The matches between paragraphs and code lines. The site never serves the text of
// a paper: a pair carries a paragraph NUMBER, a section title and a few short
// evidence terms. Only the known fields are kept, and any evidence "term" long
// enough to be a sentence is dropped.
const MAX_TERM = 60;
const PAIR_FIELDS = ["pair", "paragraph", "section", "repo", "path", "start_line", "end_line", "symbol", "score", "evidence"];
rmSync("src/data/alignments", { recursive: true, force: true });
mkdirSync("src/data/alignments", { recursive: true });
let pairs = 0;
let dropped = 0;
if (existsSync(`${source}/alignments`)) {
  for (const name of readdirSync(`${source}/alignments`).filter((n) => /^\d+\.json$/.test(n))) {
    const lot = JSON.parse(readFileSync(`${source}/alignments/${name}`, "utf8"));
    const clean = {};
    for (const [id, a] of Object.entries(lot)) {
      clean[id] = {
        method: String(a.method ?? ""),
        fulltext_id: String(a.fulltext_id ?? ""),
        pairs: (a.pairs ?? []).map((p) => {
          const kept = Object.fromEntries(PAIR_FIELDS.map((k) => [k, p[k]]));
          const terms = Array.isArray(p.evidence) ? p.evidence.map(String) : [];
          kept.evidence = terms.filter((t) => t.length <= MAX_TERM);
          dropped += terms.length - kept.evidence.length;
          kept.section = String(p.section ?? "").slice(0, 200);
          kept.symbol = String(p.symbol ?? "").slice(0, 200);
          return kept;
        }),
      };
      pairs += clean[id].pairs.length;
    }
    writeFileSync(`src/data/alignments/${name}`, JSON.stringify(clean));
  }
}
if (dropped) console.warn(`${dropped} evidence terms longer than ${MAX_TERM} characters were dropped.`);

// The lots of scripts, fetched on demand by the reader (one file per lot).
rmSync("public/scripts", { recursive: true, force: true });
if (existsSync(`${source}/scripts`)) cpSync(`${source}/scripts`, "public/scripts", { recursive: true });
else mkdirSync("public/scripts", { recursive: true });

// The entities, read at build time. An export older than Phase 2 has none: their pages
// are then built empty.
const ENTITIES = {
  authors: [],
  journals: [],
  institutions: [],
  tools: [],
  datasets: [],
  categories: { min_confidence: 0.6, facets: {} },
};
rmSync("src/data/entities", { recursive: true, force: true });
mkdirSync("src/data/entities", { recursive: true });
const entities = {};
for (const [name, empty] of Object.entries(ENTITIES)) {
  const path = `${source}/entities/${name}.json`;
  const data = existsSync(path) ? scrub(JSON.parse(readFileSync(path, "utf8"))) : empty;
  writeFileSync(`src/data/entities/${name}.json`, JSON.stringify(data));
  entities[name] = Array.isArray(data)
    ? data.length
    : Object.values(data.facets ?? {}).reduce((n, values) => n + Object.keys(values).length, 0);
}
if (scrubbed) console.warn(`${scrubbed} strings looked like an email address: the address was removed.`);

// The DOI lookup: one shard per first 2 hex characters of sha1(DOI), 256 at most (the same
// LOOKUP_HEX as src/lib/shards.ts and oscr/entities.py), fetched by the lookup page. Only the
// known fields are kept: DOI → [status, day read], and the page as a third item, if any. A
// shard of another length (an export older than 2026-09-28 wrote 3 characters, 4,096 files)
// is refused: the page would not find it.
rmSync("public/lookup", { recursive: true, force: true });
mkdirSync("public/lookup", { recursive: true });
let shards = 0;
let looked = 0;
let largest = 0;
if (existsSync(`${source}/lookup`)) {
  const names = readdirSync(`${source}/lookup`).filter((n) => n.endsWith(".json"));
  const wrong = names.filter((n) => !/^[0-9a-f]{2}\.json$/.test(n));
  if (wrong.length) {
    console.error(`${source}/lookup holds ${wrong.length} shards not named by 2 hex characters (${wrong[0]}): export again.`);
    process.exit(1);
  }
  for (const name of names) {
    const clean = {};
    for (const [doi, e] of Object.entries(JSON.parse(readFileSync(`${source}/lookup/${name}`, "utf8")))) {
      if (!/^10\.\S+$/.test(doi) || !Array.isArray(e)) continue;
      clean[doi] = [String(e[0] ?? ""), String(e[1] ?? "")];
      if (typeof e[2] === "string" && /^[a-z0-9._-]+$/.test(e[2])) clean[doi].push(e[2]);
    }
    const text = JSON.stringify(clean);
    writeFileSync(`public/lookup/${name}`, text);
    shards += 1;
    looked += Object.keys(clean).length;
    largest = Math.max(largest, Buffer.byteLength(text));
  }
}

// The sections of each paper's page (oscr/paperpage.py), read at build time. On top of the
// export's own rules, three guards: only the known sections and fields; no email address;
// and a paper's texts (its abstract, its availability statements) only under the licenses
// of decision D1 (CC BY, CC0, CC BY-SA, CC BY-NC; never -ND), the same test as
// catalog.statement_is_publishable. A version keeps only the facts VERSION_FIELDS names.
const OPEN_LICENSES = ["cc by", "cc-by", "cc0", "cc by-sa", "cc-by-sa", "cc by-nc", "cc-by-nc"];
const openLicense = (license) => {
  const l = String(license ?? "").toLowerCase().replace(/_/g, "-").trim();
  return !l.split(/[\s/.-]+/).includes("nd") && OPEN_LICENSES.some((o) => l.startsWith(o));
};
const SECTIONS = ["overview", "code", "availability", "data", "map", "versions", "cite", "similar"];
const VERSION_FIELDS = new Set(["type", "language", "journal", "volume", "issue", "pages", "dates", "authors",
  "keywords", "mesh", "funding", "references", "rrids", "integrity"]);
rmSync("src/data/papers", { recursive: true, force: true });
mkdirSync("src/data/papers", { recursive: true });
let detailed = 0;
let withheld = 0;
if (existsSync(`${source}/papers`)) {
  for (const name of readdirSync(`${source}/papers`).filter((n) => /^\d+\.json$/.test(n))) {
    const clean = {};
    for (const [id, entry] of Object.entries(JSON.parse(readFileSync(`${source}/papers/${name}`, "utf8")))) {
      const e = scrub(Object.fromEntries(SECTIONS.map((k) => [k, entry?.[k]])));
      const open = openLicense(e.overview?.license);
      if (e.overview) {
        if (!open && e.overview.abstract) withheld += 1;
        e.overview.open = open;
        if (!open) e.overview.abstract = "";
      }
      if (e.availability) {
        e.availability.open = open;
        e.availability.statements = (e.availability.statements ?? []).map((s) =>
          open ? { kind: String(s.kind ?? ""), title: String(s.title ?? ""), text: String(s.text ?? "") } : { kind: String(s.kind ?? "") },
        );
      }
      e.versions = (e.versions ?? []).map((v) => ({
        ...v,
        changes: (v.changes ?? []).filter((c) => VERSION_FIELDS.has(String(c.field ?? "").split(".")[0])),
      }));
      clean[id] = e;
      detailed += 1;
    }
    writeFileSync(`src/data/papers/${name}`, JSON.stringify(clean));
  }
}
if (withheld) console.warn(`${withheld} abstracts under a license that does not allow them were dropped (D1).`);

const withCode = catalog.articles.filter((a) => a.code.length > 0).length;
const withPage = catalog.articles.filter((a) => a.page === true || a.code.length > 0).length;
const aligned = catalog.articles.filter((a) => a.alignment?.pairs > 0).length;
console.log(
  `catalog of ${catalog.generated_at}: ${catalog.articles.length} papers, ${withCode} with code, ` +
    `${withPage} with a page, ${aligned} with Code ↔ Paper matches (${pairs} pairs)`,
);
console.log(
  `entities: ${Object.entries(entities).map(([k, n]) => `${n} ${k}`).join(", ")}; ` +
    `DOI lookup: ${looked} papers in ${shards} shards (the largest ${Math.ceil(largest / 1024)} KB); ${detailed} full paper pages`,
);
