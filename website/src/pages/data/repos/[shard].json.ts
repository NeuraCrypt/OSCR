// /data/repos/NN.json: every repository's public API record, grouped into at most REPO_SHARDS
// files, keyed by the repository (github.com/owner/name). The /api/v1/repository/... endpoint
// reads its shard here. Never the code text: that is in the scripts dataset and the reader.
import type { APIRoute } from "astro";
import { apiRepoShards } from "../../../lib/apidata";

export async function getStaticPaths() {
  const shards = await apiRepoShards();
  return [...shards].map(([shard, content]) => ({ params: { shard }, props: { body: JSON.stringify(content) } }));
}

export const GET: APIRoute = ({ props }) =>
  new Response((props as { body: string }).body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
