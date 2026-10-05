// The public read API, versioned and keyless, under /api/v1/ (apispec.ts lists every route). GET
// and HEAD only, CORS open to any origin, no credentials. Heavy data is in static files under
// /data/ (built by src/pages/data/, served by the CDN for free and without a rate limit); this
// Worker is the thin convenience layer: it resolves a DOI, reads the right static file through the
// ASSETS binding (free, no request counted), reshapes it into a stable envelope, and sets cache
// headers so repeat calls are served from the cache. The search is the ONE quota-bound endpoint
// (it reads D1); everything else is unlimited.
//
// Every rule of CLAUDE.md holds: only facts leave (no PDF, no paper full text, no email address);
// a withdrawn paper is already absent from the catalogue, a withheld map carries no DOI. The error
// body is the documented shape { error, message, documentation_url }, distinct from the site's own
// /api/search error ({ error: { code, message } }), which is unchanged.
import {
  API_BASE, API_DOCS, apiError, buildOpenapi, DATA_BASE, ENDPOINTS, LIST_ID, REPO_SHARDS, type ApiEntityType,
} from "../../src/lib/apispec.ts";
import type { Context, Env } from "../env.ts";
import { asset, type Assets } from "../pages.ts";
import { BadRequest, classify, readQuery, runSearch, toJson } from "../search.ts";
import { keyOf, lookupShard, shardOf, SHARDS } from "../../src/lib/shards.ts";

/** How long a browser, and the Cache on a custom domain, keep an answer (the records change once a
 *  night). The same window as the search and the pages. */
const CACHE_SECONDS = 600;

/** The search's messages, in words, when its databases cannot answer (the same spirit as the
 *  site's search page). */
const SEARCH_MESSAGES: Record<string, string> = {
  quota: "The search has used its daily quota. Try again tomorrow; the static files and the dataset are unlimited.",
  unavailable: "The search is unavailable at the moment. Try again later; the static files and the dataset are unlimited.",
  not_configured: "The search is not set up on this deployment. The static files and the dataset still answer.",
};

/** The headers every answer carries: CORS open to any origin, GET/HEAD only, no credentials, and
 *  (for a data answer) a cache window. */
function cors(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
}

/** A JSON answer, cached, with the envelope already applied by the caller. */
function jsonResponse(body: string, status = 200, cache = true, head = false): Response {
  const headers = cors({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cache ? `public, max-age=${CACHE_SECONDS}` : "no-store",
  });
  return new Response(head ? null : body, { status, headers });
}

/** An error, in the documented shape, never cached. */
function fail(status: number, code: string, message: string, origin: string, head = false): Response {
  return jsonResponse(JSON.stringify(apiError(code, message, origin)), status, false, head);
}

/** The envelope every record is wrapped in: the version, the canonical self link, then the payload. */
function envelope(self: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ oscr_api: "v1", self, ...payload });
}

/** Read a static JSON asset through the ASSETS binding (free). undefined when it is absent. */
async function readJson<T>(assets: Assets, url: URL, path: string): Promise<T | undefined> {
  const res = await asset(assets, url, path);
  if (!res.ok) return undefined;
  try {
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** "https://doi.org/10.1234/ABC" or "doi:10.1234/abc" → "10.1234/abc"; "" when it is not a DOI.
 *  The same rule as normalizeDoi in src/scripts/lookup.ts and normalize_doi in oscr/entities.py
 *  (a test on the lookup page checks the shared vectors). */
function normalizeDoi(text: string): string {
  let doi = text.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").trim();
  if (doi.includes("%")) {
    try {
      doi = decodeURIComponent(doi);
    } catch {
      // not an encoded DOI: kept as typed
    }
  }
  doi = doi.toLowerCase();
  return /^10\.\d{3,9}\/\S+$/.test(doi) ? doi : "";
}

const ENTITY_SINGULAR = new Set<ApiEntityType>(["author", "journal", "institution", "tool", "dataset"]);
const LIST_PATHS = new Map(Object.entries(LIST_ID).map(([singular, plural]) => [`/${plural}`, singular as ApiEntityType]));

/** The public read API. Returns a Response for any /api/v1 request (index.ts routes them here). */
export async function handleV1(request: Request, env: Env, _ctx: Context): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const self = url.toString();
  const head = request.method === "HEAD";
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (request.method !== "GET" && !head) return fail(405, "method_not_allowed", "The API answers GET and HEAD only.", origin);
  if (!env.ASSETS) return fail(503, "unavailable", "The API's data is not available on this deployment.", origin);
  const assets = env.ASSETS;

  // The path under /api/v1, without a trailing slash ("" is the index).
  let rest = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
  if (rest.length > 1 && rest.endsWith("/")) rest = rest.slice(0, -1);

  // The index.
  if (rest === "" || rest === "/") return index(self, origin, head);
  if (rest === "/openapi.json") return openapi(self, origin, head);
  if (rest === "/stats") return stats(assets, url, self, origin, head);
  if (rest === "/search") return search(url, env, self, origin, head);

  // A paper by DOI: the path (URL-encoded, slashes and all) or the ?doi= query.
  const paperMatch = rest.match(/^\/paper\/(.+)$/);
  if (paperMatch || rest === "/paper") {
    const raw = paperMatch ? decodeURIComponentSafe(paperMatch[1]) : url.searchParams.get("doi") ?? "";
    return paper(assets, url, raw, self, origin, head);
  }

  // A list of entities.
  if (LIST_PATHS.has(rest)) return list(assets, url, LIST_PATHS.get(rest)!, self, origin, head);

  // One entity: /author/<orcid>, /tool/<slug>, …
  const entityMatch = rest.match(/^\/([a-z]+)\/(.+)$/);
  if (entityMatch && ENTITY_SINGULAR.has(entityMatch[1] as ApiEntityType)) {
    return entity(assets, url, entityMatch[1] as ApiEntityType, entityMatch[2], self, origin, head);
  }

  // A repository: /repository/<host>/<owner>/<name>.
  const repoMatch = rest.match(/^\/repository\/(.+)$/);
  if (repoMatch) return repository(assets, url, decodeURIComponentSafe(repoMatch[1]), self, origin, head);

  return fail(404, "not_found", `No such endpoint. See ${API_DOCS} for the list.`, origin, head);
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** GET /api/v1/ : the index, in code (no asset read). */
function index(self: string, origin: string, head: boolean): Response {
  const endpoints = ENDPOINTS.filter((e) => e.id !== "index").map((e) => ({
    id: e.id,
    summary: e.summary,
    path: `${API_BASE}${e.path}`,
    example: `${origin}${API_BASE}${e.example}`,
    ...(e.quota ? { quota: true } : {}),
  }));
  return jsonResponse(
    envelope(self, {
      name: "OSCR public read API",
      version: "v1",
      description: "A free, keyless, read-only API over the registry's catalogue. GET and HEAD only.",
      documentation: `${origin}${API_DOCS}`,
      openapi: `${origin}${API_BASE}/openapi.json`,
      bulk: `${origin}${DATA_BASE}/`,
      endpoints,
    }),
    200,
    true,
    head,
  );
}

/** GET /api/v1/openapi.json : the built document, with this deployment's origin as the server. */
function openapi(self: string, origin: string, head: boolean): Response {
  // Built from the routes themselves (apispec.ts); the static copy is /data/openapi.json.
  return jsonResponse(JSON.stringify(buildOpenapi(origin)), 200, true, head);
}

/** GET /api/v1/stats : the catalogue's figures. */
async function stats(assets: Assets, url: URL, self: string, origin: string, head: boolean): Promise<Response> {
  const data = await readJson<Record<string, unknown>>(assets, url, `${DATA_BASE}/stats.json`);
  if (!data) return fail(503, "unavailable", "The figures are not available on this deployment.", origin, head);
  return jsonResponse(envelope(self, { ...data, source: `${DATA_BASE}/stats.json` }), 200, true, head);
}

/** GET /api/v1/paper/{doi} : one paper's record, resolved through the DOI lookup. */
async function paper(assets: Assets, url: URL, raw: string, self: string, origin: string, head: boolean): Promise<Response> {
  const doi = normalizeDoi(raw);
  if (!doi) return fail(400, "bad_doi", "Give a DOI, URL-encoded in the path or as ?doi=. Example: 10.1234/abcd.", origin, head);
  const lookup = await readJson<Record<string, [string, string, string?]>>(assets, url, `/lookup/${await lookupShard(doi)}.json`);
  const entry = lookup?.[doi];
  if (!entry) return fail(404, "not_found", "The registry has no record of this DOI.", origin, head);
  const slug = entry[2];
  if (!slug) {
    // Read, but no page (no code found, D2): say so, with what the lookup knows.
    return jsonResponse(
      envelope(self, { doi, page: false, status: entry[0], day_read: entry[1], message: "This paper is in the registry but has no page: no authors' code was found." }),
      200,
      true,
      head,
    );
  }
  const shardName = await shardOf(slug, SHARDS.paper);
  const papers = await readJson<Record<string, Record<string, unknown>>>(assets, url, `${DATA_BASE}/papers/${shardName}.json`);
  const record = papers?.[slug];
  if (!record) return fail(404, "not_found", "The registry has no record of this DOI.", origin, head);
  return jsonResponse(envelope(self, { paper: record }), 200, true, head);
}

/** GET /api/v1/{type}/{id} : one entity, read from its site record shard. */
async function entity(assets: Assets, url: URL, type: ApiEntityType, rawId: string, self: string, origin: string, head: boolean): Promise<Response> {
  const key = keyOf(type, rawId);
  if (!key) return fail(400, "bad_key", "That key cannot be an entity's key.", origin, head);
  const shardName = await shardOf(key, SHARDS[type]);
  const shard = await readJson<{ entities?: Record<string, unknown>; rows?: Record<string, unknown> }>(assets, url, `/records/${type}/${shardName}.json`);
  const record = shard?.entities?.[key];
  if (!record) return fail(404, "not_found", `No ${type} with that key.`, origin, head);
  // The rows of the papers the entity lists (the site keeps them beside the entities).
  const rows: Record<string, unknown> = {};
  for (const slug of (record as { papers?: string[] }).papers ?? []) if (shard?.rows?.[slug]) rows[slug] = shard.rows[slug];
  return jsonResponse(envelope(self, { type, key, entity: record, papers: rows, source: `/records/${type}/${shardName}.json` }), 200, true, head);
}

/** GET /api/v1/{type}s : a page of a list, and the static file that holds them all. */
async function list(assets: Assets, url: URL, type: ApiEntityType, self: string, origin: string, head: boolean): Promise<Response> {
  const plural = LIST_ID[type];
  const bulk = `${DATA_BASE}/entities/${plural}.json`;
  const all = await readJson<unknown[]>(assets, url, bulk);
  if (!Array.isArray(all)) return fail(503, "unavailable", "That list is not available on this deployment.", origin, head);
  const size = clampInt(url.searchParams.get("size"), 50, 1, 100);
  const page = clampInt(url.searchParams.get("page"), 1, 1, 1_000_000);
  const start = (page - 1) * size;
  const items = all.slice(start, start + size);
  const pages = Math.max(1, Math.ceil(all.length / size));
  const next = page < pages ? `${origin}${API_BASE}/${plural}?page=${page + 1}&size=${size}` : null;
  return jsonResponse(
    envelope(self, {
      type,
      total: all.length,
      page,
      size,
      pages,
      next,
      bulk: `${origin}${bulk}`,
      note: "The whole list is the bulk file; it is a static download with no rate limit.",
      items,
    }),
    200,
    true,
    head,
  );
}

/** GET /api/v1/repository/{host}/{owner}/{name} : one repository's record. */
async function repository(assets: Assets, url: URL, repo: string, self: string, origin: string, head: boolean): Promise<Response> {
  if (!/^[^/]+\/[^/]+\/.+$/.test(repo)) {
    return fail(400, "bad_repository", "Give the host, owner and name: repository/github.com/owner/name.", origin, head);
  }
  const shardName = await shardOf(repo, REPO_SHARDS);
  const shard = await readJson<Record<string, unknown>>(assets, url, `${DATA_BASE}/repos/${shardName}.json`);
  const record = shard?.[repo];
  if (!record) return fail(404, "not_found", "The registry does not know this repository.", origin, head);
  return jsonResponse(envelope(self, { repository: record, source: `${DATA_BASE}/repos/${shardName}.json` }), 200, true, head);
}

/** GET /api/v1/search : the catalogue's full-text search, wrapped. The one quota-bound endpoint. */
async function search(url: URL, env: Env, self: string, origin: string, head: boolean): Promise<Response> {
  let query;
  try {
    query = readQuery(url.searchParams);
  } catch (e) {
    if (e instanceof BadRequest) return fail(400, "bad_query", e.message, origin, head);
    throw e;
  }
  if (!env.CATALOG || !env.SEARCH) return fail(503, "not_configured", SEARCH_MESSAGES.not_configured, origin, head);
  try {
    const outcome = await runSearch({ CATALOG: env.CATALOG, SEARCH: env.SEARCH }, query);
    // The search's own JSON, wrapped in the API envelope (it starts with "{"results":[…],…").
    const inner = toJson(outcome);
    const body = `{"oscr_api":"v1","self":${JSON.stringify(self)},"quota":true,${inner.slice(1)}`;
    return jsonResponse(body, 200, true, head);
  } catch (e) {
    const kind = classify(e);
    if (kind === "bad_query") return fail(400, "bad_query", "The query could not be understood: check its quotes and parentheses.", origin, head);
    return fail(503, kind, SEARCH_MESSAGES[kind] ?? SEARCH_MESSAGES.unavailable, origin, head);
  }
}

/** A whole number from a query parameter, defaulted and clamped. */
function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
