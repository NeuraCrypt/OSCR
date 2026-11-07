// The signs of machine-written English the site's own text must not carry (2026-11-07, after a
// Wikidata reviewer called the site "vibe-coded", with a lot of "this not that" language): negative
// parallelisms ("X, not Y", "not just", "more than just", "rather than"), a list of overused words,
// avoided copulas ("serves as"), hollow phrases, long and short dashes, and curly quotes. It reads the
// site's SOURCE (src/, worker/), whose strings and text nodes are the site's own words; the built HTML
// also holds the catalogue (paper titles say "robust" or "comprehensive", and are not ours to change).
// A line that must keep one says why on it: `style-ok: <reason>` (a comment, or in the text of a
// test). `node scripts/style-signs.mjs [files...]` prints every sign; the test fails on any.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const VOCABULARY = [
  "additionally", "align with", "aligns with", "boast", "boasts", "crucial", "delve", "delves", "enhance", "enhances",
  "enhanced", "enhancing", "foster", "fosters", "fostering", "garner", "interplay", "intricate", "landscape",
  "meticulous", "meticulously", "pivotal", "realm", "resonate", "resonates", "robust", "seamless", "seamlessly",
  "showcase", "showcases", "tailored", "tapestry", "testament", "underscore", "underscores", "valuable", "vibrant",
  "empower", "empowers", "unlock", "unlocks", "harness", "leverage", "leverages", "ensure", "ensures", "ensuring",
  "comprehensive", "cutting-edge", "highlights the", "highlighting the", "key role", "key feature", "key features",
  "key insight", "navigate the",
  // Wikipedia's "Signs of AI writing" (read 2026-11-07): more words and set phrases.
  "bolstered", "deep dive", "enduring", "emphasizing", "intricacies", "multifaceted", "indelible", "deeply rooted",
  "setting the stage", "evolving landscape", "focal point", "valuable insights", "quietly", "universally",
  "dependable", "echoed", "a testament", "plays a vital role", "plays a crucial role",
];
export const SIGNS = [
  ["negative parallelism", /[a-z)'"]+, not (?:a |an |the |just |only |merely )?[a-z'"(]/i],
  ["negative parallelism", /\bnot (?:just|only|merely)\b|\bmore than just\b|\brather than\b/i],
  ["overused word", new RegExp(`\\b(?:${VOCABULARY.map((w) => w.replace(/[-\s]/g, (c) => (c === " " ? "\\s+" : "-"))).join("|")})\\b`, "i")],
  ["avoided copula", /\b(?:serves? as|stands? as)\b/i],
  ["hollow phrase", /\b(?:it is (?:important|worth) (?:to note|noting)|it is crucial to|in short,|overall,|in summary|in conclusion|at its core|should not be confused with|does not by itself|i hope this helps|feel free to)\b/i],
  ["long or short dash", /[—–]/],
  ["curly quote", /[“”‘’]/],
];
const SKIP_LINE = /^\s*(?:\/\/|\/?\*|<!--|import |export type )/;

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(astro|ts|svelte|mjs)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Every sign in the site's own text: [{ file, line, sign, text }]. */
export function signs(root, only) {
  const found = [];
  const list = only?.length ? only : ["src", "worker"].flatMap((d) => files(join(root, d)));
  for (const f of list) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (SKIP_LINE.test(text) || /style-ok:/.test(text)) return;
      // Only lines that hold words of a sentence: three words in a row.
      if (!/[A-Za-z]{2,} [a-z]{2,} [a-z]{2,}/.test(text)) return;
      for (const [sign, rx] of SIGNS) if (rx.test(text)) found.push({ file: relative(root, f), line: i + 1, sign, text: text.trim() });
    });
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL("..", import.meta.url).pathname;
  const found = signs(root, process.argv.slice(2));
  for (const s of found) console.log(`${s.file}:${s.line}  [${s.sign}]  ${s.text.slice(0, 200)}`);
  console.log(`${found.length} sign(s)`);
  process.exitCode = found.length ? 1 : 0;
}
