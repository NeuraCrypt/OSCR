// The tracing maps of the repository pages (night phase 02, E4): 64 static shards,
// /forge/traced/00.json … 63.json, a fixed number of files whatever the catalogue's size. A shard
// holds, per repository ("owner/name" in lower case, the shard as the layer's: src/lib/forge.ts
// layerShard), each paper's map at its pinned commit: the pairs' paths, lines, section headings,
// paragraph numbers and symbols (src/lib/traced.ts tracedEntries). No paper text: the paragraphs
// are read in the Code ↔ Paper reader, under its licence rules. The code view reads its shard as
// a file: a signed-out reader asks the Worker nothing.
import type { APIRoute, GetStaticPaths } from "astro";
import { alignmentOf, withPage } from "../../../lib/catalog";
import { LAYER_SHARDS, layerShard } from "../../../lib/forge";
import { type TracedShard, tracedEntries } from "../../../lib/traced";

export const getStaticPaths: GetStaticPaths = () =>
  Array.from({ length: LAYER_SHARDS }, (_, i) => ({ params: { shard: String(i).padStart(2, "0") } }));

let built: Promise<Map<string, TracedShard>> | null = null;

async function shards(): Promise<Map<string, TracedShard>> {
  const papers = withPage.flatMap((a) => {
    const al = alignmentOf(a);
    if (!al || !al.pairs.length) return [];
    return [{ slug: a.slug, title: a.title, doi: a.doi, code: a.code.map((c) => ({ repo: c.repo, commit: c.commit })), card: a.card, method: al.method, pairs: al.pairs }];
  });
  const out = new Map<string, TracedShard>();
  for (const [key, maps] of tracedEntries(papers)) {
    const [owner, name] = key.split("/");
    const shard = await layerShard(owner, name);
    const into = out.get(shard) ?? {};
    into[key] = maps;
    out.set(shard, into);
  }
  return out;
}

export const GET: APIRoute = async ({ params }) => {
  built ??= shards();
  const shard = (await built).get(String(params.shard)) ?? {};
  return new Response(JSON.stringify(shard), { headers: { "Content-Type": "application/json; charset=utf-8" } });
};
