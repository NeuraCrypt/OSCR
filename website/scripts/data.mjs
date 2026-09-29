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
//   forge/layer/NN.json → public/forge/layer/NN.json (fetched by the repository pages, /r/*:
//                                                     OSCR's layer for signed-out readers,
//                                                     oscr/forgelayer.py; absent: none)
//   forge/moderation.json → src/data/moderation.json (night phase 16: the public notices and the
//                                                     hidden repositories; read at build time)
//   social/NN.json, social/explore.json → public/social/… (night phase 08: stars, follows and
//                                                     public profiles as of last night, the Explore
//                                                     page; oscr/social.py; absent: none)
import { createHash } from "node:crypto";
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

// OSCR's layer over the repositories (the GitHub side, night phase 01): at most 64 shards, fetched
// by the repository pages for signed-out readers. An entry is keyed by "owner/name" in lower case
// and sits in the shard the first byte of its key's SHA-256 names, mod 64 (src/lib/forge.ts
// layerShard). On top of the export's own rules: only well-formed keys in their own shard, never a
// repository that is hidden, waiting for deletion or deleted, and no email address.
const LAYER_MODES = new Set(["catalogue", "created", "installed", "public"]);
const LAYER_HIDDEN = new Set(["hidden", "pending_deletion", "deleted"]);
const SEGMENT = /^(?!\.+$)[a-z0-9._-]{1,100}$/;
rmSync("public/forge/layer", { recursive: true, force: true });
let layerShards = 0;
let layered = 0;
let misplaced = 0;
if (existsSync(`${source}/forge/layer`)) {
  mkdirSync("public/forge/layer", { recursive: true });
  for (const name of readdirSync(`${source}/forge/layer`).filter((n) => /^\d{2}\.json$/.test(n) && Number(n.slice(0, 2)) < 64)) {
    const clean = {};
    for (const [key, e] of Object.entries(JSON.parse(readFileSync(`${source}/forge/layer/${name}`, "utf8")))) {
      const [owner, repo, ...rest] = key.split("/");
      const shard = String(createHash("sha256").update(key).digest()[0] % 64).padStart(2, "0");
      if (rest.length || !SEGMENT.test(owner ?? "") || !SEGMENT.test(repo ?? "") || `${shard}.json` !== name) {
        misplaced += 1;
        continue;
      }
      // Night phase 16: a repository moderation hid keeps only that it is hidden, and why (the /r/ page
      // says so and shows nothing of it).
      if (e && typeof e === "object" && e.moderated && typeof e.moderated === "object") {
        clean[key] = { moderated: { words: scrub(String(e.moderated.words ?? "")).slice(0, 200), since: Number(e.moderated.since) || 0 } };
        layered += 1;
        continue;
      }
      if (!e || typeof e !== "object" || !LAYER_MODES.has(e.mode) || LAYER_HIDDEN.has(e.state)) continue;
      clean[key] = scrub(e);
      layered += 1;
    }
    writeFileSync(`public/forge/layer/${name}`, JSON.stringify(clean));
    layerShards += 1;
  }
}
if (misplaced) console.warn(`${misplaced} entries of OSCR's forge layer were not in their shard, or not a repository: dropped.`);

// The registry's research issues for signed-out readers (night phase 05): at most 64 shards,
// forge/research/NN.json, NN = the issue's number mod 64, each an object keyed by the number
// ("12") → {issue, comments}, as of last night (oscr/forgelayer.py). Only well-formed numbers in
// their own shard, and no email address.
rmSync("public/forge/research", { recursive: true, force: true });
let researchShards = 0;
let researched = 0;
if (existsSync(`${source}/forge/research`)) {
  mkdirSync("public/forge/research", { recursive: true });
  for (const name of readdirSync(`${source}/forge/research`).filter((n) => /^\d{2}\.json$/.test(n) && Number(n.slice(0, 2)) < 64)) {
    const clean = {};
    for (const [key, e] of Object.entries(JSON.parse(readFileSync(`${source}/forge/research/${name}`, "utf8")))) {
      if (!/^[1-9]\d{0,9}$/.test(key) || `${String(Number(key) % 64).padStart(2, "0")}.json` !== name) continue;
      if (!e || typeof e !== "object" || !e.issue || typeof e.issue !== "object" || Number(e.issue.id) !== Number(key)) continue;
      clean[key] = scrub({ issue: e.issue, comments: Array.isArray(e.comments) ? e.comments : [] });
      researched += 1;
    }
    writeFileSync(`public/forge/research/${name}`, JSON.stringify(clean));
    researchShards += 1;
  }
}

// The social layer for signed-out readers (night phase 08): at most 64 shards, social/NN.json, NN =
// the first byte of the key's SHA-256 mod 64 (src/lib/social.ts socialShard), each an object keyed by
// "repo:…", "paper:doi:10.…", "topic:…", "person:<handle>" or "owner:<forge>:<login>"; and the Explore
// page's social/explore.json (oscr/social.py). Only well-formed keys in their own shard, and no email
// address.
const SOCIAL_KEY = /^(?:repo:(?:github|memory):\d{1,20}|paper:doi:10\.\S{1,200}|topic:[a-z0-9][a-z0-9-]{0,49}|person:(?:[a-z0-9][a-z0-9-]{0,38}|\d{4}-\d{4}-\d{4}-\d{3}[\dX])|owner:(?:github|memory):[a-z0-9][a-z0-9-]{0,38})$/;
rmSync("public/social", { recursive: true, force: true });
let socialShards = 0;
let socialKeys = 0;
if (existsSync(`${source}/social`)) {
  mkdirSync("public/social", { recursive: true });
  for (const name of readdirSync(`${source}/social`).filter((n) => /^\d{2}\.json$/.test(n) && Number(n.slice(0, 2)) < 64)) {
    const clean = {};
    for (const [key, e] of Object.entries(JSON.parse(readFileSync(`${source}/social/${name}`, "utf8")))) {
      const shard = String(createHash("sha256").update(key).digest()[0] % 64).padStart(2, "0");
      if (!SOCIAL_KEY.test(key) || `${shard}.json` !== name || !e || typeof e !== "object" || Array.isArray(e)) continue;
      clean[key] = scrub(e);
      socialKeys += 1;
    }
    writeFileSync(`public/social/${name}`, JSON.stringify(clean));
    socialShards += 1;
  }
  if (existsSync(`${source}/social/explore.json`)) {
    const explore = JSON.parse(readFileSync(`${source}/social/explore.json`, "utf8"));
    if (explore && typeof explore === "object" && !Array.isArray(explore)) writeFileSync("public/social/explore.json", JSON.stringify(scrub(explore)));
  }
}

// Night phase 16: what moderation hid, as of last night (oscr/moderation.py): the public notices (the
// /notices/ page) and the hidden repositories with their papers (a line on each paper's page). Read at
// build time only: src/data/moderation.json. Absent: none. Never the hidden words, never who reported.
let moderation = { notices: [], repos: {} };
if (existsSync(`${source}/forge/moderation.json`)) {
  const m = JSON.parse(readFileSync(`${source}/forge/moderation.json`, "utf8"));
  const notices = (Array.isArray(m?.notices) ? m.notices : []).slice(0, 2000).filter((n) => n && typeof n === "object").map((n) => ({
    date: /^\d{4}-\d{2}-\d{2}$/.test(n.date) ? n.date : "",
    updated: /^\d{4}-\d{2}-\d{2}$/.test(n.updated) ? n.updated : "",
    what: String(n.what ?? "").slice(0, 60),
    reason: String(n.reason ?? "").slice(0, 120),
    notice: String(n.notice ?? "").slice(0, 1000),
    state: n.state === "restored" ? "restored" : "hidden",
    by: String(n.by ?? "").slice(0, 60),
    counter_notice: n.counter_notice === true,
    appeal: ["", "open", "accepted", "rejected"].includes(n.appeal) ? n.appeal : "",
  }));
  const repos = {};
  for (const [path, r] of Object.entries(m?.repos && typeof m.repos === "object" ? m.repos : {})) {
    if (!/^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/.test(path) || !r || typeof r !== "object") continue;
    repos[path] = {
      words: String(r.words ?? "").slice(0, 200),
      since: Number(r.since) || 0,
      papers: (Array.isArray(r.papers) ? r.papers : []).filter((d) => typeof d === "string" && /^10\.\S{1,200}$/.test(d)).slice(0, 50),
    };
  }
  moderation = scrub({ notices, repos });
}
writeFileSync("src/data/moderation.json", JSON.stringify(moderation));

const withCode = catalog.articles.filter((a) => a.code.length > 0).length;
const withPage = catalog.articles.filter((a) => a.page === true || a.code.length > 0).length;
const aligned = catalog.articles.filter((a) => a.alignment?.pairs > 0).length;
console.log(
  `catalog of ${catalog.generated_at}: ${catalog.articles.length} papers, ${withCode} with code, ` +
    `${withPage} with a page, ${aligned} with Code ↔ Paper matches (${pairs} pairs)`,
);
console.log(
  `entities: ${Object.entries(entities).map(([k, n]) => `${n} ${k}`).join(", ")}; ` +
    `DOI lookup: ${looked} papers in ${shards} shards (the largest ${Math.ceil(largest / 1024)} KB); ${detailed} full paper pages; ` +
    `forge layer: ${layered} repositories in ${layerShards} shards; research issues: ${researched} in ${researchShards} shards; ` +
    `social layer: ${socialKeys} entries in ${socialShards} shards`,
);
