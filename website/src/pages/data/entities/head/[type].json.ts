// /data/entities/head/<plural>.json: the first 100 entries of each entity list, with the total.
// The /api/v1/<type> list endpoint reads THIS small file instead of parsing the full bulk (authors
// alone is ~17 MB): a Worker must not parse that on every cache miss. The full list stays the bulk
// file /data/entities/<plural>.json, a static download with no rate limit. A fixed number of files,
// one per type (counted in DATA_FIXED_FILES).
import type { APIRoute } from "astro";
import { entityList } from "../../../../lib/apidata";

/** How many entries the preview holds. The list endpoint paginates within these; a page past them
 *  is served by the bulk file, never by the Worker. */
const HEAD = 100;

const TYPES: { plural: string; singular: string }[] = [
  { plural: "authors", singular: "author" },
  { plural: "journals", singular: "journal" },
  { plural: "institutions", singular: "institution" },
  { plural: "tools", singular: "tool" },
  { plural: "datasets", singular: "dataset" },
];

function head(arr: unknown[]): string {
  return JSON.stringify({ total: arr.length, items: arr.slice(0, HEAD) });
}

// Only the five array lists the /api/v1/<type> endpoint paginates; categories is not a list endpoint.
export function getStaticPaths() {
  return TYPES.map((t) => ({ params: { type: t.plural }, props: { body: head(entityList(t.singular) as unknown[]) } }));
}

export const GET: APIRoute = ({ props }) =>
  new Response((props as { body: string }).body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
