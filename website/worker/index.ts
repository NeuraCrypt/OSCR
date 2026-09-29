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
//   /api/forge/*         the GitHub side (night phase 01): one authorized action (start, act),
//                        GitHub's webhooks, OSCR's layer over a repository (forge/service/;
//                        docs/FORGE.md). The repository pages themselves are static (/r/*).
//   /api/v1, /api/v1/*   the public API (night phase 10): bearer tokens, CORS, dated versions
//                        (forge/service/api.ts; docs/API.md).
//   anything else under /api/   a JSON 404
//   anything else        pages.ts: a paper rendered on demand, else the site's 404 page
//
// The search's answers are public and cached (Cache-Control: public, api.ts); the accounts', the
// contributions' and the forge's depend on the reader (a session cookie) or change the registry,
// and all say `Cache-Control: no-store`.
//
// Only the default export: the runtime takes every export of the main module for an entry point.
import { handleAccount } from "./account/index.ts";
import { error, handleSearch } from "./api.ts";
import { handleContributions } from "./contributions/index.ts";
import type { Context, Env, Handler } from "./env.ts";
import { handleApi } from "./forge/service/api.ts";
import { handleForge } from "./forge/service/index.ts";
import { handlePage } from "./pages.ts";

type Route = { path: string; handle: Handler } | { prefix: string; handle: Handler };

/** The accounts answer for their own paths; one they do not know is a 404 like any other. */
const account: Handler = async (request, env, ctx) =>
  (await handleAccount(request, env, ctx)) ?? error(404, "not_found", "No such route.");
/** The contributions (Phase 6), likewise. */
const contributions: Handler = async (request, env, ctx) =>
  (await handleContributions(request, env, ctx)) ?? error(404, "not_found", "No such route.");
/** The forge service (night phase 01), likewise: GitHub's backend, built from the environment. */
const forge: Handler = async (request, env, ctx) =>
  (await handleForge(request, env, ctx)) ?? error(404, "not_found", "No such route.");
/** The public API (night phase 10), likewise. */
const api: Handler = async (request, env, ctx) => (await handleApi(request, env, ctx)) ?? error(404, "not_found", "No such route.");

const ROUTES: Route[] = [
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
  { prefix: "/api/forge/", handle: forge },
  { path: "/api/v1", handle: api },
  { prefix: "/api/v1/", handle: api },
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
    const path = new URL(request.url).pathname;
    const handle = route(path);
    if (handle) return handle(request, env, ctx);
    if (path === "/api" || path.startsWith("/api/")) return error(404, "not_found", "No such route.");
    return handlePage(request, env.ASSETS);
  },
};
