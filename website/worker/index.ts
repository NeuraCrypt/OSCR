// The Worker's own code. The site is static: its pages are the Worker's assets, served first,
// free and unlimited. This code runs only for /api/* (wrangler.toml, `run_worker_first`), and
// each run counts against the free plan's 100,000 requests a day, cached or not.
//
// The routes, the first that matches wins:
//   GET /api/search      the search (api.ts, search.ts; the contract: docs/SEARCH.md)
//
// Phase 5 (accounts) plugs in here, and nowhere else in this file:
//   import { handleAccount } from "./account/index.ts";
//   ROUTES: { prefix: "/api/auth/", handle: handleAccount }, { prefix: "/api/account/", handle: handleAccount }
// with its D1 database bound as COMMUNITY (wrangler.toml; typed in env.ts). Both prefixes are
// already under `run_worker_first = ["/api/*"]`. The search's answers are public and cached
// (Cache-Control: public, api.ts); an answer that depends on the reader (a session cookie) must
// say `Cache-Control: private, no-store`.
//
// Only the default export: the runtime takes every export of the main module for an entry point.
import { error, handleSearch } from "./api.ts";
import type { Context, Env, Handler } from "./env.ts";

type Route = { path: string; handle: Handler } | { prefix: string; handle: Handler };

const ROUTES: Route[] = [
  { path: "/api/search", handle: handleSearch },
];

function route(pathname: string): Handler | undefined {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  for (const r of ROUTES) {
    if ("path" in r ? path === r.path : pathname.startsWith(r.prefix)) return r.handle;
  }
  return undefined;
}

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const handle = route(new URL(request.url).pathname);
    if (handle) return handle(request, env, ctx);
    return error(404, "not_found", "No such route.");
  },
};
