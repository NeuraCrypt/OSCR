// /data/entities/<plural>.json: the full public list of each entity type (the no-rate-limit bulk
// file the /api/v1/<type> list endpoint points to). The arrays are the site's own records, already
// email-free.
//
// A Cloudflare Workers static asset may not exceed 25 MiB. A list that would exceed that (authors,
// as the catalogue grows) is split: <plural>.json then holds a small MANIFEST
// `{ total, parts: ["<plural>-0", ...] }`, and each `<plural>-N.json` holds a chunk of the array.
// A small list stays a single array file, unchanged. The /api/v1 list endpoint reads the HEAD file,
// never this bulk, so splitting it changes nothing at runtime.
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

/** Keep every emitted file well under the 25 MiB asset limit. */
const MAX_BYTES = 22 * 1024 * 1024;

type Path = { params: { type: string }; props: { body: string } };

function pathsFor(plural: string, singular: string): Path[] {
  const arr = entityList(singular) as unknown[];
  const whole = JSON.stringify(arr);
  if (whole.length <= MAX_BYTES) return [{ params: { type: plural }, props: { body: whole } }];
  // Split the array into parts, each under MAX_BYTES.
  const out: Path[] = [];
  const parts: string[] = [];
  let cur: unknown[] = [];
  let curLen = 2; // the enclosing [].
  const flush = () => {
    const name = `${plural}-${parts.length}`;
    out.push({ params: { type: name }, props: { body: JSON.stringify(cur) } });
    parts.push(name);
    cur = [];
    curLen = 2;
  };
  for (const item of arr) {
    const s = JSON.stringify(item);
    if (cur.length && curLen + s.length + 1 > MAX_BYTES) flush();
    cur.push(item);
    curLen += s.length + 1;
  }
  if (cur.length) flush();
  out.unshift({ params: { type: plural }, props: { body: JSON.stringify({ total: arr.length, parts }) } });
  return out;
}

export function getStaticPaths(): Path[] {
  const items: Path[] = [];
  for (const t of TYPES) items.push(...pathsFor(t.plural, t.singular));
  items.push({ params: { type: "categories" }, props: { body: JSON.stringify(categories) } });
  return items;
}

export const GET: APIRoute = ({ props }) =>
  new Response((props as { body: string }).body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
