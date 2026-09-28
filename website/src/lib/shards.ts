// The site's file budget (docs/PLATFORM_PLAN.md §6, docs/ARCHITECTURE.md "How pages are
// rendered"): a Worker serves at most 20,000 static files per version, so the number of files
// must not grow with the catalogue. Shared by the build (Astro), the browser's scripts, the
// Worker and the checks (scripts/check.mjs): nothing here reads a file or the network.
//
//   - a paper's page, and its Code ↔ Paper reader, are static for the STATIC_PAPERS most
//     recent papers with a page; the others are rendered on demand by the Worker, from
//     /records/paper/NN.json (worker/pages.ts);
//   - an author, journal, institution, tool or dataset has no file of its own: one shell page
//     per type (/author/, …) is served for /author/<orcid>/ by a rewrite of public/_redirects,
//     and the browser renders the entity from /records/<type>/NN.json;
//   - the DOI lookup is 256 shards, /lookup/NN.json.
//
// A shard is named after the leading bits of the SHA-1 of its key, as many as the number of
// shards needs (a power of two), in hexadecimal: 256 shards are the first two hex characters of
// the SHA-1, the lookup's rule in Python (oscr/entities.py); 64, the first byte's top six bits;
// 1,024, the first ten bits, in three characters. The same rule here, in the browser, in the
// Worker and in the check.

/** The files a Worker's static assets may hold, and the margin the check keeps under it. */
export const FILE_LIMIT = 20_000;
export const FILE_MARGIN = 15_000;

/** How many papers have a static page (and, with code, a static Code ↔ Paper reader): the most
 *  recent papers with a page, by publication date. At most two files each: 12,000 files at
 *  worst. Past it, a paper's page is rendered on demand by the Worker. */
export const STATIC_PAPERS = 6_000;

/** What every other kind of file may take at most, whatever the catalogue's size: the shards
 *  below and the lookup's (2,560 in all), 256 lots of scripts (oscr/catalog.py N_LOTS), the
 *  category pages (the classification's vocabulary, about 60 values: MAX_CATEGORIES at most),
 *  27 pages of the authors' list, and the fixed pages and bundles. With the papers' 12,000, the
 *  margin exactly: 2 × STATIC_PAPERS + FIXED_FILES_MAX = FILE_MARGIN. The check holds the build
 *  to both. */
export const MAX_CATEGORIES = 200;
export const FIXED_FILES_MAX = 3_000;

/** The lookup's shards: the first LOOKUP_HEX hex characters of sha1(DOI), 16² = 256. The same
 *  number as oscr/entities.py LOOKUP_HEX (a test checks it). */
export const LOOKUP_HEX = 2;

/** The entity types rendered from shards, each at /<type>/<key>/. */
export const ENTITY_TYPES = ["author", "journal", "institution", "tool", "dataset"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export type RecordType = EntityType | "paper";

/** Shards per type, a power of two: fixed, so that the number of files is the same for 4,000
 *  papers with a page as for the 50–90k of the full neuro stock; only their size grows. Chosen
 *  for ~300 KB at most a shard at the full stock (~20 KB today), from the sizes measured on the
 *  real catalogue on 2026-09-28 (docs/PLATFORM_PLAN.md §6): ~1.2 KB of record and rows per
 *  author, ~2.5 KB per institution (OpenAlex places each author), ~1.2 KB per paper past
 *  STATIC_PAPERS. */
export const SHARDS: Readonly<Record<RecordType, number>> = {
  author: 1024,
  institution: 512,
  tool: 256,
  journal: 128,
  dataset: 128,
  paper: 256,
};

/** The papers an entity's page lists, the most recent first. Past it (a tool such as NumPy, found
 *  in thousands of papers; a large journal), the page says how many more there are and links to
 *  the search, which filters by tool, journal, author, ROR id and dataset. */
export const ENTITY_ROWS_MAX = 200;

/** The links a list of an entity's page shows at most (a tool's repositories, an institution's
 *  authors, an author's tools), the most relevant first; the page says how many more there are.
 *  NumPy was found in 1,496 repositories on 2026-09-28. */
export const LINKS_MAX = 300;

/** The key of an entity as its address carries it, normalized the way the build names it: an
 *  ORCID iD in capitals (its check digit may be X), anything else in lower case. "" when the
 *  address cannot hold one (a slash, a space, a control character, too long). */
export function keyOf(type: RecordType, raw: string): string {
  let key = raw;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return "";
  }
  key = key.trim();
  if (!/^[\w.-]{1,160}$/.test(key)) return "";
  return type === "author" ? key.toUpperCase() : key.toLowerCase();
}

async function sha1(text: string): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) throw new Error("this browser can only read the registry's data over https");
  return new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text)));
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** The shard of a key among `n` (a power of two, at most 65,536): the leading log2(n) bits of
 *  its SHA-1, in hexadecimal, two characters at least ("00" … "ff" for 256, "000" … "3ff" for
 *  1,024). */
export async function shardOf(key: string, n: number): Promise<string> {
  if (!Number.isInteger(n) || n < 1 || n > 65_536 || (n & (n - 1)) !== 0) throw new RangeError(`${n} shards: a power of two, at most 65,536`);
  const bits = Math.log2(n);
  const d = await sha1(key);
  const lead = ((d[0] << 8) | d[1]) >> (16 - bits);
  return lead.toString(16).padStart(Math.max(2, Math.ceil(bits / 4)), "0");
}

/** The lookup's shard of a normalized DOI: the first LOOKUP_HEX hex characters of its SHA-1. */
export async function lookupShard(doi: string): Promise<string> {
  return [...(await sha1(doi))].map(hex2).join("").slice(0, LOOKUP_HEX);
}

/** Items grouped into their shards, by key: the files of one type. However many the items, there
 *  are at most `n` shards. */
export async function groupShards<T>(items: Iterable<readonly [string, T]>, n: number): Promise<Map<string, Map<string, T>>> {
  const out = new Map<string, Map<string, T>>();
  for (const [key, value] of items) {
    const name = await shardOf(key, n);
    if (!out.has(name)) out.set(name, new Map());
    out.get(name)!.set(key, value);
  }
  return new Map([...out.entries()].sort(([x], [y]) => (x < y ? -1 : 1)));
}

/** Entities packed into their shards: each shard holds its entities by key and, once each, the
 *  rows of their papers (a paper listed by two entities of one shard is written once). At most
 *  `n` files, whatever the number of entities. */
export async function packEntities<R, W>(
  entries: Iterable<{ key: string; record: R; rows: Iterable<[string, W]> }>,
  n: number,
): Promise<Map<string, { entities: Record<string, R>; rows: Record<string, W> }>> {
  const groups = await groupShards([...entries].filter((e) => e.key !== "").map((e) => [e.key, e] as const), n);
  const out = new Map<string, { entities: Record<string, R>; rows: Record<string, W> }>();
  for (const [name, members] of groups) {
    const entities: Record<string, R> = {};
    const rows: Record<string, W> = {};
    for (const [key, e] of members) {
      entities[key] = e.record;
      for (const [slug, row] of e.rows) rows[slug] ??= row;
    }
    out.set(name, { entities, rows });
  }
  return out;
}

/** The papers that get a static page: the `max` most recent, by publication date (a partial date,
 *  2026-09, counts before the days of its month), then by page name, so that every build of the
 *  same export chooses the same ones. */
export function staticSelection<T extends { slug: string; published: string }>(papers: readonly T[], max = STATIC_PAPERS): Set<string> {
  const sorted = [...papers].sort((x, y) =>
    x.published === y.published ? (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0) : x.published < y.published ? 1 : -1,
  );
  return new Set(sorted.slice(0, Math.max(0, max)).map((a) => a.slug));
}
