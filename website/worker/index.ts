// The Worker's own code. The site is static: its pages are the Worker's assets, served first,
// free and unlimited. This code runs only for /api/* (wrangler.toml, `run_worker_first`), and
// each run counts against the free plan's 100,000 requests a day, cached or not.
//
// The routes, the first that matches wins:
//   GET /api/search      the search (api.ts, search.ts; the contract: docs/SEARCH.md)
//   /api/auth/*          sign-in with ORCID, GitHub, Google (account/; docs/ACCOUNTS.md)
//   /api/account/*       the signed-in reader's account (account/)
//
// The search's answers are public and cached (Cache-Control: public, api.ts); the accounts'
// depend on the reader (a session cookie) and all say `Cache-Control: no-store`.
//
// Only the default export: the runtime takes every export of the main module for an entry point.
import { handleAccount } from "./account/index.ts";
import { error, handleSearch } from "./api.ts";
import type { Context, Env, Handler } from "./env.ts";

type Route = { path: string; handle: Handler } | { prefix: string; handle: Handler };

/** The accounts answer for their own paths; one they do not know is a 404 like any other. */
const account: Handler = async (request, env, ctx) =>
  (await handleAccount(request, env, ctx)) ?? error(404, "not_found", "No such route.");

const ROUTES: Route[] = [
  { path: "/api/search", handle: handleSearch },
  { prefix: "/api/auth/", handle: account },
  { prefix: "/api/account/", handle: account },
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
