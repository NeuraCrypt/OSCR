// What a page rendered on demand costs, measured on a build (docs/PLATFORM_PLAN.md §6):
//
//   node --experimental-strip-types scripts/measure-pages.mjs [records per paper shard]
//
// For the papers: the Worker's CPU for one page (parse its shard, render the record, fill the
// shell: worker/pages.ts), on the largest shard of dist/records/paper/ and on a shard grown to
// the given number of records (default 240: the full neuro stock's ~60,000 papers past
// STATIC_PAPERS in 256 shards). For the entities: the sizes of their shards, which the browser
// fetches. V8 here is the Workers' engine; the Workers' own CPU counts may differ a little.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { paperView } from "../src/lib/render.ts";
import { ENTITY_TYPES } from "../src/lib/shards.ts";
import { fillShell } from "../worker/pages.ts";

const per = Number(process.argv[2] ?? 240);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const sizes = (dir) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => statSync(`${dir}/${f}`).size).sort((x, y) => x - y);
  } catch {
    return [];
  }
};
const report = (label, s) => {
  if (!s.length) return console.log(`${label}: none`);
  const total = s.reduce((x, y) => x + y, 0);
  console.log(`${label}: ${s.length} files, ${kb(total)} in all; median ${kb(s[s.length >> 1])}, largest ${kb(s.at(-1))}`);
};
for (const t of ENTITY_TYPES) report(`records/${t}`, sizes(`dist/records/${t}`));
report("records/paper", sizes("dist/records/paper"));
report("lookup", sizes("dist/lookup"));

function time(label, text) {
  const shell = readFileSync("dist/paper/404.html", "utf8");
  const keys = Object.keys(JSON.parse(text));
  const runs = 300;
  const start = process.hrtime.bigint();
  for (let i = 0; i < runs; i += 1) {
    const shard = JSON.parse(text);
    const page = fillShell(shell, paperView(shard[keys[i % keys.length]]));
    if (!page) throw new Error("no page");
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / runs;
  console.log(`${label}: ${keys.length} records, ${kb(text.length)}: ${ms.toFixed(2)} ms of CPU a page`);
}
const papers = sizes("dist/records/paper");
if (papers.length) {
  const largest = readdirSync("dist/records/paper").map((f) => `dist/records/paper/${f}`).sort((x, y) => statSync(y).size - statSync(x).size)[0];
  const text = readFileSync(largest, "utf8");
  time(`the largest paper shard (${largest.split("/").pop()})`, text);
  // The same records, again and again, up to `per`: a shard at the full stock.
  const all = readdirSync("dist/records/paper").flatMap((f) => Object.values(JSON.parse(readFileSync(`dist/records/paper/${f}`, "utf8"))));
  const grown = Object.fromEntries(Array.from({ length: per }, (_, i) => [`k${i}`, all[i % all.length]]));
  time(`a shard of ${per} records`, JSON.stringify(grown));
}
