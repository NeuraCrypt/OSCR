// The Worker's own code. The site is static: its pages are the Worker's assets, served first,
// free and unlimited. This code runs for /api/* (wrangler.toml, `run_worker_first`), and for a
// request that no static file answers (`not_found_handling = "none"`): a paper's page past
// STATIC_PAPERS, or the 404 page (pages.ts). Each run counts against the free plan's 100,000
// requests a day, cached or not.
//
// The routes, the first that matches wins:
//   GET /api/search      the search (api.ts, search.ts; the contract: docs/SEARCH.md)
//   /api/auth/*          sign-in with ORCID, GitHub, Google (account/; docs/ACCOUNTS.md)
//   /api/account/*       the signed-in reader's account (account/)
//   /api/contributions, /api/submissions, /api/claims, /api/edits, /api/validations,
//   /api/reports         what a signed-in reader asks of the registry (contributions/;
//                        docs/CONTRIBUTIONS.md)
//   /api/rights          the signed-in person's data rights: what the site holds about them, and
//                        their requests (rights/; docs/CONTRIBUTIONS.md "Data rights")
//   anything else under /api/   a JSON 404
//   anything else        pages.ts: a paper rendered on demand, else the site's 404 page
//
// The search's answers are public and cached (Cache-Control: public, api.ts); the accounts' and
// the contributions' depend on the reader (a session cookie) and all say `Cache-Control: no-store`.
//
// Only the default export: the runtime takes every export of the main module for an entry point.
import { handleAccount } from "./account/index.ts";
import { error, handleSearch } from "./api.ts";
import { handleContributions } from "./contributions/index.ts";
import type { Context, Env, Handler } from "./env.ts";
import { asset, handlePage, SITE_HEADERS } from "./pages.ts";
import { handleRights } from "./rights/index.ts";
import { handleV1 } from "./v1/index.ts";

type Route = { path: string; handle: Handler } | { prefix: string; handle: Handler };

/** The accounts answer for their own paths; one they do not know is a 404 like any other. */
const account: Handler = async (request, env, ctx) =>
  (await handleAccount(request, env, ctx)) ?? error(404, "not_found", "No such route.");
/** The contributions (Phase 6), likewise. */
const contributions: Handler = async (request, env, ctx) =>
  (await handleContributions(request, env, ctx)) ?? error(404, "not_found", "No such route.");
/** The data rights, likewise. */
const rights: Handler = async (request, env, ctx) => (await handleRights(request, env, ctx)) ?? error(404, "not_found", "No such route.");

const ROUTES: Route[] = [
  { path: "/api/v1", handle: handleV1 },
  { prefix: "/api/v1/", handle: handleV1 },
  { path: "/api/search", handle: handleSearch },
  { prefix: "/api/auth/", handle: account },
  { prefix: "/api/account/", handle: account },
  { path: "/api/contributions", handle: contributions },
  { prefix: "/api/contributions/", handle: contributions },
  { path: "/api/submissions", handle: contributions },
  { prefix: "/api/submissions/", handle: contributions },
  { path: "/api/claims", handle: contributions },
  { path: "/api/edits", handle: contributions },
  { path: "/api/validations", handle: contributions },
  { path: "/api/reports", handle: contributions },
  { path: "/api/rights", handle: rights },
];

function route(pathname: string): Handler | undefined {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  for (const r of ROUTES) {
    if ("path" in r ? path === r.path : pathname.startsWith(r.prefix)) return r.handle;
  }
  return undefined;
}

/** GET /api and /api/ : the human-readable API page. /api/* runs the Worker first (wrangler.toml),
 *  so the static page (dist/api/index.html) is served through the ASSETS binding here, not by the
 *  assets themselves. It gets the site-wide headers, the same as every static page. */
async function apiPage(request: Request, assets: Env["ASSETS"]): Promise<Response> {
  const url = new URL(request.url);
  const head = request.method === "HEAD";
  if (request.method !== "GET" && !head) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  if (!assets) return new Response("Not found", { status: 404 });
  const res = await asset(assets, url, "/api/");
  if (!res.ok) return handlePage(request, assets);
  const body = head ? null : await res.text();
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=600", ...SITE_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const path = new URL(request.url).pathname;
    const handle = route(path);
    if (handle) return handle(request, env, ctx);
    if (path === "/api" || path === "/api/") return apiPage(request, env.ASSETS);
    if (path === "/api" || path.startsWith("/api/")) return error(404, "not_found", "No such route.");
    return handlePage(request, env.ASSETS);
  },
};
