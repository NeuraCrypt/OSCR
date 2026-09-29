// The catalogue's papers of each author, by ORCID iD (night phase 08, E5): 64 static shards,
// /social/authors/00.json … 63.json (the shard: the first byte of the iD's SHA-256, mod 64; src/lib/
// social.ts socialShard), a fixed number of files whatever the catalogue's size. A profile's
// contribution calendar shows the person's publications from them, and a followed author's papers
// reach the feed: 0 Worker requests. Only papers with a page (D2), their DOI, title, date and slug.
import type { APIRoute, GetStaticPaths } from "astro";
import { catalog } from "../../../lib/catalog";
import { SOCIAL_SHARDS, socialShard } from "../../../lib/social";

export const getStaticPaths: GetStaticPaths = () =>
  Array.from({ length: SOCIAL_SHARDS }, (_, i) => ({ params: { shard: String(i).padStart(2, "0") } }));

type Paper = { doi: string; title: string; date: string; slug: string };
let built: Promise<Map<string, Record<string, Paper[]>>> | null = null;

async function shards(): Promise<Map<string, Record<string, Paper[]>>> {
  const by = new Map<string, Paper[]>();
  for (const a of catalog.articles) {
    if (!(a.page === true || a.code.length > 0)) continue;
    for (const au of a.authors ?? []) {
      if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(au.orcid ?? "")) continue;
      const list = by.get(au.orcid) ?? [];
      list.push({ doi: a.doi, title: a.title.slice(0, 300), date: (a.published ?? "").slice(0, 10), slug: a.slug });
      by.set(au.orcid, list);
    }
  }
  const out = new Map<string, Record<string, Paper[]>>();
  for (const [orcid, papers] of by) {
    const shard = await socialShard(orcid);
    const into = out.get(shard) ?? {};
    into[orcid] = papers.sort((x, y) => (x.date < y.date ? 1 : -1));
    out.set(shard, into);
  }
  return out;
}

export const GET: APIRoute = async ({ params }) => {
  built ??= shards();
  const shard = (await built).get(String(params.shard)) ?? {};
  return new Response(JSON.stringify(shard), { headers: { "Content-Type": "application/json; charset=utf-8" } });
};
