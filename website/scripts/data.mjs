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

const withCode = catalog.articles.filter((a) => a.code.length > 0).length;
const aligned = catalog.articles.filter((a) => a.alignment?.pairs > 0).length;
console.log(
  `catalog of ${catalog.generated_at}: ${catalog.articles.length} papers, ${withCode} with code, ` +
    `${aligned} with Code ↔ Paper matches (${pairs} pairs)`,
);
