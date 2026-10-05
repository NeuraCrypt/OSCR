// /data/entities/<plural>.json: the full public list of each entity type (the no-rate-limit bulk
// file the /api/v1/<type> list endpoint points to). The arrays are the site's own records, already
// email-free. A fixed number of files (one per type).
import type { APIRoute } from "astro";
import { categories } from "../../../lib/entities";
import { entityList } from "../../../lib/apidata";

/** The plural file name of each type, and the singular entityList() asks for. */
const TYPES: { plural: string; singular: string }[] = [
  { plural: "authors", singular: "author" },
  { plural: "journals", singular: "journal" },
  { plural: "institutions", singular: "institution" },
  { plural: "tools", singular: "tool" },
  { plural: "datasets", singular: "dataset" },
];

export function getStaticPaths() {
  const items = TYPES.map((t) => ({ params: { type: t.plural }, props: { body: JSON.stringify(entityList(t.singular)) } }));
  items.push({ params: { type: "categories" }, props: { body: JSON.stringify(categories) } });
  return items;
}

export const GET: APIRoute = ({ props }) =>
  new Response((props as { body: string }).body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
