// The search API's HTTP side: parameters in, JSON or CSV out, every failure a JSON error the
// search page can say in words: the daily quota is spent (`quota`), the databases do not answer
// (`unavailable`), they are not set up yet (`not_configured`), or the request is wrong
// (`bad_query`). The Worker's entry point is index.ts, which exports nothing else (the runtime
// takes every export of the main module for an entry point).

import type { Context, Env } from "./env.ts";
import { BadRequest, canonicalSearch, classify, readQuery, runSearch, toCsv, toExportJson, toJson } from "./search.ts";
import { ForgeSearchError, readForgeQuery, runForgeSearch } from "./forge-search.ts";
import { withoutHidden } from "./forge/service/hidden-search.ts";

export type { Env };

/** How long a browser, and the Cache API on a custom domain, keep an answer: an identical
 *  search within that time reads nothing from D1. */
export const CACHE_SECONDS = 600;

const MESSAGES = {
  quota:
    "The search has used its daily quota. Please try again tomorrow; meanwhile, Browse and the DOI lookup are static and always work.",
  unavailable:
    "The search is unavailable at the moment. Please try again later; meanwhile, Browse and the DOI lookup are static and always work.",
  not_configured: "The search is not set up yet. Browse and the DOI lookup are static and always work.",
} as const;

/** What D1 answers when the free plan's daily limits are spent (developers.cloudflare.com,
 *  "Debug D1"), and when a database is overloaded. */
const SIMULATED: Record<string, string> = {
  quota:
    "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",
  unavailable: "D1_ERROR: D1 DB is overloaded. Requests queued for too long.",
};

function headers(extra: Record<string, string>): Headers {
  return new Headers({ "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex", ...extra });
}

/** Seconds until 00:00 UTC, when D1's daily limits start again. */
function untilMidnightUtc(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

export function error(status: number, code: string, message: string): Response {
  const extra: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (code === "quota") extra["Retry-After"] = String(untilMidnightUtc());
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: headers(extra) });
}

function cacheOf(): Cache | undefined {
  // `caches.default` exists in the Workers runtime only. It works on a custom domain; on
  // workers.dev its operations do nothing (developers.cloudflare.com, "Cache"), and the
  // browser's own cache still serves a repeated search.
  return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
}

export async function handleSearch(request: Request, env: Env, ctx: Context): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return error(405, "method_not_allowed", "The search answers GET requests only.");
  }
  const url = new URL(request.url);
  // Night phase 08: the GitHub side's types (repositories, issues, people, topics) have their own
  // index in oscr_search (forge-search.ts); "papers" stays the first type, and the default.
  const type = url.searchParams.get("type");
  if (type !== null && type !== "papers") return handleForgeSearch(url, env, ctx);
  let query;
  try {
    query = readQuery(url.searchParams);
  } catch (e) {
    if (e instanceof BadRequest) return error(400, "bad_query", e.message);
    throw e;
  }
  if (!env.CATALOG || !env.SEARCH) return error(503, "not_configured", MESSAGES.not_configured);

  const key = new Request(`${url.origin}/api/search?${canonicalSearch(query)}`);
  const cache = cacheOf();
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) {
    const response = new Response(hit.body, hit);
    response.headers.set("X-Search-Cache", "hit");
    return response;
  }

  let response: Response;
  try {
    if (env.SEARCH_SIMULATE_FAILURE) throw new Error(SIMULATED[env.SEARCH_SIMULATE_FAILURE] ?? SIMULATED.unavailable);
    const outcome = await runSearch({ CATALOG: env.CATALOG, SEARCH: env.SEARCH }, query);
    const cached = { "Cache-Control": `public, max-age=${CACHE_SECONDS}`, ...costHeader(outcome.meta.cost) };
    if (query.format === "csv") {
      response = new Response(toCsv(outcome, url.origin), {
        headers: headers({ ...cached, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="search-results.csv"' }),
      });
    } else if (query.format === "json") {
      response = new Response(toExportJson(outcome), {
        headers: headers({ ...cached, "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="search-results.json"' }),
      });
    } else {
      response = new Response(toJson(outcome), { headers: headers({ ...cached, "Content-Type": "application/json; charset=utf-8" }) });
    }
  } catch (e) {
    const kind = classify(e);
    console.error(`search failed (${kind}): ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    if (kind === "bad_query") return error(400, "bad_query", "The query could not be understood: check its quotes and parentheses.");
    return error(503, kind, MESSAGES[kind]);
  }
  if (cache) ctx.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
  return response;
}

/** What an answer cost D1, for every format (the JSON answer also says it in `cost`). */
function costHeader(cost: { queries: number; rows_read: number }): Record<string, string> {
  return { "X-Search-Cost": `queries=${cost.queries}; rows_read=${cost.rows_read}` };
}

/** GET /api/search?type=repositories|issues|people|topics: the GitHub side's search (night phase 08),
 *  with the papers' answers: cached alike, the same errors in words (the quota's first). */
async function handleForgeSearch(url: URL, env: Env, ctx: Context): Promise<Response> {
  let query;
  try {
    query = readForgeQuery(url.searchParams);
  } catch (e) {
    if (e instanceof ForgeSearchError) return error(400, "bad_query", e.message);
    throw e;
  }
  if (!env.SEARCH) return error(503, "not_configured", MESSAGES.not_configured);
  const canonical = new URLSearchParams({ type: query.type, q: query.q, ...(query.page !== 1 ? { page: String(query.page) } : {}) });
  const key = new Request(`${url.origin}/api/search?${canonical}`);
  const cache = cacheOf();
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) {
    const response = new Response(hit.body, hit);
    response.headers.set("X-Search-Cache", "hit");
    return response;
  }
  let response: Response;
  try {
    if (env.SEARCH_SIMULATE_FAILURE) throw new Error(SIMULATED[env.SEARCH_SIMULATE_FAILURE] ?? SIMULATED.unavailable);
    const outcome = await runForgeSearch(env.SEARCH, query);
    // Night phase 16: what moderation hid since the index's last push leaves the answer at once (the
    // push itself leaves it out from the next night: oscr/moderation.py).
    if (env.FORGE) outcome.results = await withoutHidden(env.FORGE, outcome.results);
    response = new Response(JSON.stringify(outcome), {
      headers: headers({ "Cache-Control": `public, max-age=${CACHE_SECONDS}`, ...costHeader(outcome.cost), "Content-Type": "application/json; charset=utf-8" }),
    });
  } catch (e) {
    const kind = classify(e);
    console.error(`forge search failed (${kind}): ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    if (kind === "bad_query") return error(400, "bad_query", "The query could not be understood: check its quotes.");
    return error(503, kind, MESSAGES[kind]);
  }
  if (cache) ctx.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
  return response;
}
