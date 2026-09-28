// GET /api/search: the search over the two D1 databases that `oscr d1 push` fills
// (migrations/d1/). The contract is in docs/SEARCH.md.
//
// The cost, in D1 rows read (5 million a day on the free plan), is kept small and bounded:
//
// - a query or a filter runs ONE statement on oscr_search: the full-text index returns, in the
//   order asked, at most WINDOW + 1 rows, each with the facet values of its paper (`fx`). That
//   window gives the page of results, the total (exact up to WINDOW) and the facet counts
//   (exact over the results up to WINDOW; beyond, over the first WINDOW results, and said so);
// - then ONE statement on oscr_catalog fetches the page's result rows by key;
// - the pages go as far as the window (25 pages of 20): past it, a search says to narrow the
//   query, the filters or the dates, and reads nothing more. The worst case is then the window
//   and one page: ~540 rows read at 20 results per page, ~600 at 50;
// - the empty query reads oscr_catalog only: its newest (or most cited) papers, and the
//   precomputed counts of the unfiltered view.

import { ALL_TOKEN, FACET_BY_CODE, FACET_BY_PARAM, FACETS, facetToken } from "../src/lib/facets.ts";
import { type Node, parseQuery, toMatch } from "../src/lib/query.ts";
import type { D1Database, D1PreparedStatement, D1Result } from "./d1.ts";

/** Results read from the index for one query: the exact total, the facet counts, the citation
 *  sort and the pages go up to it. */
export const WINDOW = 500;
export const PAGE_SIZE = 20;
export const MAX_SIZE = 50;
/** The largest `page` accepted (with `size=1`, the window's last result). */
export const MAX_PAGE = WINDOW;
/** Filter values in one search, and characters in one value. */
export const MAX_VALUES = 20;
export const MAX_VALUE_CHARS = 200;
/** Rows per statement when the result rows are fetched by key (D1: 100 bound parameters). */
const KEYS_PER_STATEMENT = 100;
/** The largest key: a date range with no end. */
const LAST_KEY = 99_999_999 * 100_000 + 99_999;

export const SORTS = ["relevance", "newest", "oldest", "cited"] as const;
export type Sort = (typeof SORTS)[number];
export const FORMATS = ["csv", "json"] as const;
export type Format = (typeof FORMATS)[number];

/** The two databases a search reads (the Worker's bindings, env.ts). */
export type Databases = { CATALOG: D1Database; SEARCH: D1Database };

/** A request the reader can fix: HTTP 400, never a quota message. */
export class BadRequest extends Error {}

export type Query = {
  q: string;
  /** [facet parameter, values], in the order of FACETS. */
  filters: [string, string[]][];
  from: string;
  to: string;
  /** "" lets the search choose: relevance when words are searched, else the newest first. */
  sort: Sort | "";
  page: number;
  size: number;
  format: Format | "";
};

/** What a result row shows (oscr_catalog.papers.doc, written by oscr/d1.py). */
export type Doc = {
  slug: string;
  doi: string;
  title: string;
  journal: string;
  published: string;
  status: string;
  code: { name: string; url: string; license: string }[];
  data: number;
  files: number;
  pairs: number;
  map?: string;
  cited?: number | null;
};

export type FacetCounts = Record<string, [string, number][]>;

export type Outcome = {
  /** Everything but the result rows. */
  meta: {
    query: {
      q: string;
      match: string | null;
      filters: Record<string, string[]>;
      from: string;
      to: string;
      sort: Sort;
      page: number;
      size: number;
    };
    /** Exact when `complete`; otherwise at least this many. */
    total: number;
    complete: boolean;
    window: number;
    /** The pages one can open. */
    pages: number;
    facets: FacetCounts;
    /** results: over every result; window: over the first `window` results; catalogue: the
     *  whole catalogue (the unfiltered view). */
    facets_scope: "results" | "window" | "catalogue" | "none";
    notices: string[];
    cost: { queries: number; rows_read: number };
  };
  /** The result rows, as the JSON text oscr_catalog stores: spliced into the answer as is. */
  docs: string[];
};

const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

function checkDate(name: string, value: string): string {
  const v = value.trim();
  if (!v) return "";
  const m = DATE.exec(v);
  if (!m || (m[2] && (+m[2] < 1 || +m[2] > 12)) || (m[3] && (+m[3] < 1 || +m[3] > 31))) {
    throw new BadRequest(`“${name}” must be a year, a month or a day, such as 2020, 2020-03 or 2020-03-15.`);
  }
  return v;
}

function integer(name: string, value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest(`“${name}” must be a whole number from ${min} to ${max}.`);
  return n;
}

/** The first or last day of a date, possibly partial, as YYYYMMDD: ("2020", start) → 20200000,
 *  ("2020", end) → 20209999, ("2020-03-05", …) → 20200305. A paper dated "2020" only has the
 *  key of 2020-00-00: it is in any range that covers the whole year. */
export function dayKey(date: string, end: boolean): number {
  const m = DATE.exec(date);
  if (!m) return end ? 99_999_999 : 0;
  const month = m[2] ? Number(m[2]) : end ? 99 : 0;
  const day = m[3] ? Number(m[3]) : end ? 99 : 0;
  return Number(m[1]) * 10_000 + month * 100 + day;
}

/** The search asked for in the URL's parameters; BadRequest when a parameter is wrong. */
export function readQuery(params: URLSearchParams): Query {
  const q = (params.get("q") ?? "").trim();
  const filters: [string, string[]][] = [];
  let count = 0;
  for (const f of FACETS) {
    const values = [...new Set(params.getAll(f.param).map((v) => v.trim()).filter(Boolean))];
    if (values.length === 0) continue;
    const long = values.find((v) => v.length > MAX_VALUE_CHARS);
    if (long) throw new BadRequest(`A “${f.param}” value is longer than ${MAX_VALUE_CHARS} characters.`);
    count += values.length;
    filters.push([f.param, values]);
  }
  if (count > MAX_VALUES) throw new BadRequest(`A search takes ${MAX_VALUES} filter values at most.`);
  const from = checkDate("from", params.get("from") ?? "");
  const to = checkDate("to", params.get("to") ?? "");
  if (from && to && dayKey(from, false) > dayKey(to, true)) throw new BadRequest("“from” is after “to”.");
  const sort = params.get("sort") ?? "";
  if (sort && !(SORTS as readonly string[]).includes(sort)) {
    throw new BadRequest(`“sort” must be one of: ${SORTS.join(", ")}.`);
  }
  const format = params.get("format") ?? "";
  if (format && !(FORMATS as readonly string[]).includes(format)) {
    throw new BadRequest(`“format” must be one of: ${FORMATS.join(", ")}.`);
  }
  return {
    q,
    filters,
    from,
    to,
    sort: sort as Sort | "",
    page: integer("page", params.get("page"), 1, 1, MAX_PAGE),
    size: integer("size", params.get("size"), PAGE_SIZE, 1, MAX_SIZE),
    format: format as Format | "",
  };
}

/** The canonical parameters of a search: one search, one address, one cache entry. */
export function canonicalSearch(query: Query): string {
  const p = new URLSearchParams();
  if (query.q) p.set("q", query.q);
  for (const [param, values] of query.filters) for (const v of [...values].sort()) p.append(param, v);
  if (query.from) p.set("from", query.from);
  if (query.to) p.set("to", query.to);
  if (query.sort) p.set("sort", query.sort);
  if (query.page !== 1) p.set("page", String(query.page));
  if (query.size !== PAGE_SIZE) p.set("size", String(query.size));
  if (query.format) p.set("format", query.format);
  return p.toString();
}

/** Whether a query searches for something (a word or a phrase not excluded): only then does
 *  relevance mean anything. */
function searchesWords(node: Node | null): boolean {
  if (!node) return false;
  switch (node.t) {
    case "word":
    case "phrase":
      return true;
    case "not":
      return false;
    case "group":
      return searchesWords(node.item);
    default:
      return node.items.some(searchesWords);
  }
}

/** What the index will run: the MATCH expression and the key range, or null for the empty
 *  query (no words, no filter, no date); `ranked` when words are searched. */
export async function plan(query: Query): Promise<{
  match: string | null;
  range: [number, number] | null;
  sort: Sort;
  ranked: boolean;
  notices: string[];
}> {
  const parsed = parseQuery(query.q);
  const ranked = searchesWords(parsed.node);
  const clauses: string[] = [];
  if (parsed.node) clauses.push(`(${toMatch(parsed.node, ALL_TOKEN)})`);
  for (const [param, values] of query.filters) {
    const facet = FACET_BY_PARAM.get(param)!;
    const tokens = await Promise.all(values.map((v) => facetToken(facet.code, v)));
    clauses.push(`{facets} : (${tokens.map((t) => `"${t}"`).join(" OR ")})`);
  }
  const range: [number, number] | null =
    query.from || query.to
      ? [query.from ? dayKey(query.from, false) * 100_000 : 0, query.to ? dayKey(query.to, true) * 100_000 + 99_999 : LAST_KEY]
      : null;
  const notices = [...parsed.notices];
  let sort: Sort = query.sort || (ranked ? "relevance" : "newest");
  if (sort === "relevance" && !ranked) {
    if (query.sort) notices.push("Without words to search, the results are sorted by date, the newest first.");
    sort = "newest";
  }
  const match = clauses.length > 0 ? clauses.join(" AND ") : range ? `{facets} : "${ALL_TOKEN}"` : null;
  return { match, range, sort, ranked, notices };
}

type Hit = { pid: number; cited: number; fx: unknown[] };

/** The window's rows with their facet values: each `fx` is [cited_by_count, code, value, code,
 *  value…]. All of them are parsed at once (one JSON.parse for the window, not one per row); a
 *  row whose `fx` cannot be read keeps its place, without values. */
function readWindow(found: { pid: number; fx: string }[]): Hit[] {
  let all: unknown[] | null = null;
  try {
    all = JSON.parse(`[${found.map((r) => (typeof r.fx === "string" && r.fx ? r.fx : "[]")).join(",")}]`) as unknown[];
  } catch {
    all = null;
  }
  return found.map((r, i) => {
    let fx: unknown = all ? all[i] : null;
    if (!all) {
      try {
        fx = JSON.parse(r.fx);
      } catch {
        fx = null;
      }
    }
    const a = Array.isArray(fx) ? fx : [];
    return { pid: Number(r.pid), cited: typeof a[0] === "number" ? a[0] : 0, fx: a };
  });
}

/** The counts, facet by facet in FACETS' order: the values with the most papers first (years:
 *  the newest first), `top` of them at most. */
function shapeFacets(counts: Map<string, Map<string, number>>): FacetCounts {
  const out: FacetCounts = {};
  for (const f of FACETS) {
    const values = counts.get(f.code);
    if (!values || values.size === 0) continue;
    const entries = [...values.entries()];
    entries.sort(f.param === "year" ? (a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0) : (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    out[f.param] = entries.slice(0, f.top);
  }
  return out;
}

function countFacets(rows: Hit[]): FacetCounts {
  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const a = r.fx;
    for (let i = 1; i + 1 < a.length; i += 2) {
      const code = a[i];
      const value = a[i + 1];
      if (typeof code !== "string" || typeof value !== "string" || !FACET_BY_CODE.has(code)) continue;
      let values = counts.get(code);
      if (!values) counts.set(code, (values = new Map()));
      values.set(value, (values.get(value) ?? 0) + 1);
    }
  }
  return shapeFacets(counts);
}

type Rows<T> = D1Result<T>;

class Meter {
  queries = 0;
  rows_read = 0;
  add<T>(r: Rows<T>): Rows<T> {
    this.queries += 1;
    this.rows_read += r.meta?.rows_read ?? 0;
    return r;
  }
}

async function run<T>(meter: Meter, stmt: D1PreparedStatement): Promise<T[]> {
  return meter.add(await stmt.all<T>()).results;
}

async function runBatch(meter: Meter, db: D1Database, stmts: D1PreparedStatement[]): Promise<Rows<Record<string, unknown>>[]> {
  if (stmts.length === 1) return [meter.add(await stmts[0].all())];
  return (await db.batch(stmts)).map((r) => meter.add(r));
}

/** The result rows of these papers, in this order. A paper missing from the catalogue (the two
 *  databases are pushed one after the other) is left out. */
async function docsOf(env: Databases, meter: Meter, pids: number[]): Promise<string[]> {
  if (pids.length === 0) return [];
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < pids.length; i += KEYS_PER_STATEMENT) {
    const keys = pids.slice(i, i + KEYS_PER_STATEMENT);
    stmts.push(env.CATALOG.prepare(`SELECT pid, doc FROM papers WHERE pid IN (${keys.map(() => "?").join(",")})`).bind(...keys));
  }
  const byPid = new Map<number, string>();
  for (const r of await runBatch(meter, env.CATALOG, stmts)) {
    for (const row of r.results) byPid.set(Number(row.pid), String(row.doc));
  }
  return pids.flatMap((p) => (byPid.has(p) ? [byPid.get(p)!] : []));
}

/** The whole search: the index, then the catalogue. An export (`format`) returns the whole
 *  window, without facets. */
export async function runSearch(env: Databases, query: Query): Promise<Outcome> {
  const meter = new Meter();
  const { match, range, sort, ranked, notices } = await plan(query);
  const exporting = query.format !== "";
  const offset = (query.page - 1) * query.size;
  const past = !exporting && offset >= WINDOW;
  if (past) notices.push(`Only the first ${WINDOW} results can be shown: narrow the query, the filters or the dates to see the others.`);
  const filters = Object.fromEntries(query.filters);
  const base = {
    query: { q: query.q, match, filters, from: query.from, to: query.to, sort, page: query.page, size: query.size },
    window: WINDOW,
    notices,
  };

  if (match === null) {
    // The empty query: the catalogue itself, and the counts precomputed for it.
    const order = sort === "oldest" ? "pid ASC" : sort === "cited" ? "cited_by_count DESC, pid DESC" : "pid DESC";
    const limit = exporting ? WINDOW : past ? 0 : query.size;
    const stmts = [
      env.CATALOG.prepare(`SELECT pid, doc FROM papers ORDER BY ${order} LIMIT ? OFFSET ?`).bind(limit, exporting ? 0 : offset),
      env.CATALOG.prepare("SELECT value FROM meta WHERE name = 'papers'"),
    ];
    if (!exporting) stmts.push(env.CATALOG.prepare("SELECT facet, value, papers FROM facet_counts ORDER BY facet, rank"));
    const [page, meta, counts] = await runBatch(meter, env.CATALOG, stmts);
    const total = Number(meta.results[0]?.value ?? 0);
    const byCode = new Map<string, Map<string, number>>();
    for (const row of counts?.results ?? []) {
      const facet = FACET_BY_PARAM.get(String(row.facet));
      if (!facet) continue;
      if (!byCode.has(facet.code)) byCode.set(facet.code, new Map());
      byCode.get(facet.code)!.set(String(row.value), Number(row.papers));
    }
    return {
      meta: {
        ...base,
        total,
        complete: exporting ? total <= WINDOW : true,
        pages: Math.ceil(Math.min(total, WINDOW) / query.size),
        facets: shapeFacets(byCode),
        facets_scope: exporting ? "none" : "catalogue",
        cost: meter,
      },
      docs: page.results.map((r) => String(r.doc)),
    };
  }

  // A query, filters or dates: the index. The key range is CAST: D1 binds a JavaScript number as
  // a REAL, and FTS5 uses a rowid bound only when it is an INTEGER (otherwise it reads every
  // match, and SQLite filters them: measured, 650 rows read instead of 73).
  const where = range
    ? "paper_fts MATCH ? AND rowid BETWEEN CAST(? AS INTEGER) AND CAST(? AS INTEGER)"
    : "paper_fts MATCH ?";
  const binds: unknown[] = range ? [match, range[0], range[1]] : [match];
  // "Most cited" sorts the window: the most relevant results when words are searched, else the
  // most recent (without words, every rank is 0).
  const order = sort === "oldest" ? "rowid ASC" : sort === "relevance" || (sort === "cited" && ranked) ? "rank" : "rowid DESC";
  const found = await run<{ pid: number; fx: string }>(
    meter,
    env.SEARCH.prepare(`SELECT rowid AS pid, fx FROM paper_fts WHERE ${where} ORDER BY ${order} LIMIT ${WINDOW + 1}`).bind(...binds),
  );
  const complete = found.length <= WINDOW;
  let rows = readWindow(found.slice(0, WINDOW));
  if (sort === "cited") rows = [...rows].sort((a, b) => b.cited - a.cited || b.pid - a.pid);
  if (sort === "cited" && !complete) {
    const which = ranked ? "most relevant" : "most recent";
    notices.push(`Sorted by citations among the ${WINDOW} ${which} results: add words or filters to sort them all.`);
  }

  const pids = (exporting ? rows : rows.slice(offset, offset + query.size)).map((r) => r.pid);
  const total = rows.length;
  return {
    meta: {
      ...base,
      total,
      complete,
      pages: Math.ceil(total / query.size),
      facets: exporting ? {} : countFacets(rows),
      facets_scope: exporting ? "none" : complete ? "results" : "window",
      cost: meter,
    },
    docs: await docsOf(env, meter, pids),
  };
}

/** The API's JSON answer: the result rows spliced as stored, then the rest. */
export function toJson(outcome: Outcome): string {
  const { cost, ...meta } = outcome.meta;
  const rest = JSON.stringify({ ...meta, cost: { queries: cost.queries, rows_read: cost.rows_read } });
  return `{"results":[${outcome.docs.join(",")}],${rest.slice(1)}`;
}

/** A downloadable JSON export: the query, the total, and the results. */
export function toExportJson(outcome: Outcome): string {
  const { query, total, complete } = outcome.meta;
  return `{"query":${JSON.stringify(query)},"total":${total},"complete":${complete},"results":[${outcome.docs.join(",")}]}\n`;
}

const CSV_COLUMNS = [
  "doi", "title", "journal", "published", "status", "page", "code_repositories", "code_licenses", "datasets", "cited_by_count",
] as const;

/** A CSV cell: quoted when needed (RFC 4180), and never read as a formula by a spreadsheet. */
function cell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A downloadable CSV export: one paper per line. */
export function toCsv(outcome: Outcome, origin: string): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const text of outcome.docs) {
    let d: Doc;
    try {
      d = JSON.parse(text) as Doc;
    } catch {
      continue;
    }
    const code = Array.isArray(d.code) ? d.code : [];
    lines.push(
      [
        d.doi, d.title, d.journal, d.published, d.status, `${origin}/paper/${d.slug}/`,
        code.map((c) => c.url).filter(Boolean).join(" "),
        [...new Set(code.map((c) => c.license).filter(Boolean))].join(" "),
        d.data ?? 0,
        d.cited ?? "",
      ].map(cell).join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** What went wrong, in the three kinds the page tells apart. */
export function classify(error: unknown): "quota" | "bad_query" | "unavailable" {
  const message = String((error as Error)?.message ?? error);
  if (/fts5|syntax error|malformed match|unterminated string/i.test(message)) return "bad_query";
  if (/daily row (read|write) limit|free tier daily|exceeded .*limit|too many requests|\b429\b/i.test(message)) return "quota";
  return "unavailable";
}
