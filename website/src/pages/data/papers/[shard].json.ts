// /data/papers/NN.json: every paper's public API record, grouped into at most SHARDS.paper files
// (the same shard rule as /records/paper/, but covering EVERY paper with a page, static and on
// demand). The /api/v1/paper/{doi} endpoint resolves the DOI to a slug, then reads its shard here.
import type { APIRoute } from "astro";
import { apiPaperShards } from "../../../lib/apidata";

export async function getStaticPaths() {
  const shards = await apiPaperShards();
  return [...shards].map(([shard, content]) => ({ params: { shard }, props: { body: JSON.stringify(content) } }));
}

export const GET: APIRoute = ({ props }) =>
  new Response((props as { body: string }).body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
