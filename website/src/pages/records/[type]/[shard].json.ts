// The records of the pages that are not built ahead of time, grouped into shards: at most
// SHARDS[type] files per type (lib/shards.ts), however large the catalogue.
//
//   /records/author/NN.json … /records/dataset/NN.json   an entity's page, rendered in the
//                                                        browser (src/scripts/entity.ts)
//   /records/paper/NN.json                               a paper past STATIC_PAPERS, rendered
//                                                        by the Worker (worker/pages.ts)
//
// NN: the first byte of the SHA-1 of the key (an ORCID iD, a ROR id, a page's name), modulo the
// number of shards, in hexadecimal. Only the shards that hold something are written.
import type { APIRoute } from "astro";
import { recordFiles } from "../../../lib/records";

export async function getStaticPaths() {
  return (await recordFiles()).map((f) => ({ params: { type: f.type, shard: f.shard }, props: { body: JSON.stringify(f.content) } }));
}

export const GET: APIRoute = ({ props }) =>
  new Response((props as { body: string }).body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
