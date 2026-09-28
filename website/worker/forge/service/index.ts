// The forge service (night phase 01): the GitHub side's dynamic routes, above GitBackend. One entry
// point, `handleForge`, which the Worker's entry (worker/index.ts) calls for /api/forge/*:
//
//   POST /api/forge/start     signed in   the first half of one authorized action → {location}   start.ts (E1)
//   POST /api/forge/act       signed in   its second half: {code, state, payload} → the result     act.ts (E1)
//   POST /api/forge/webhook   GitHub      a delivery of the mirror mode (HMAC, ≤ 1 MiB)             webhook.ts (E3)
//   GET  /api/forge/repo      signed in   OSCR's layer for one repository (?id= or ?path=)         read.ts (E6)
//   GET  /api/forge/mine      signed in   "Your repositories"                                       read.ts (E6)
//
// What every route gets here, in order: its path (another is 404), its method (405), the FORGE
// binding (503 not_configured without it), and for the signed-in routes the accounts (COMMUNITY and
// SESSION_KEY: 503 not_configured without them). Then the route's handler; whatever it throws
// becomes an answer in words (http.ts `failure`: D1's quota is 503 quota). Every answer is JSON,
// `Cache-Control: no-store`. The contract: docs/FORGE.md.
//
// Who may write is gate.ts (FORGE_OPEN, D01-1); what an action is, types.ts and actions.ts; OSCR's
// rows, store.ts. The repository pages themselves are static (/r/*, D00-5): signed out, a reader
// asks this Worker nothing.

import { measured, now, ready } from "../../account/guard.ts";
import { counted } from "../../account/metrics.ts";
import type { AccountEnv } from "../../account/types.ts";
import type { GitBackend } from "../gitbackend.ts";
import { handleAct } from "./act.ts";
import { ACTIONS } from "./actions.ts";
import { forgeBackend } from "./backend.ts";
import { failure, problem, wrongMethod } from "./http.ts";
import { handleMine, handleRepo } from "./read.ts";
import { handleStart } from "./start.ts";
import type { Context, D1Database, ForgeDeps, ForgeRequest, ForgeServiceEnv, RouteHandler } from "./types.ts";
import { handleWebhook } from "./webhook.ts";

export type { ForgeDeps, ForgeServiceEnv } from "./types.ts";

interface Route {
  method: "GET" | "POST";
  /** A signed-in reader's route: the accounts must be set up. */
  signedIn: boolean;
  handle: RouteHandler;
}

/** The routes, by path (without a final "/"). */
export const FORGE_ROUTES: Readonly<Record<string, Route>> = {
  "/api/forge/start": { method: "POST", signedIn: true, handle: (r) => handleStart(r) },
  "/api/forge/act": { method: "POST", signedIn: true, handle: (r) => handleAct(r) },
  "/api/forge/webhook": { method: "POST", signedIn: false, handle: (r) => handleWebhook(r) },
  "/api/forge/repo": { method: "GET", signedIn: true, handle: (r) => handleRepo(r) },
  "/api/forge/mine": { method: "GET", signedIn: true, handle: (r) => handleMine(r) },
};

const PREFIX = "/api/forge/";

/** Whether the forge service answers this path. */
export const isForgePath = (pathname: string): boolean => pathname.startsWith(PREFIX);

const noWait: Context = { waitUntil: (p) => void p.catch(() => undefined) };

/** The forge service's answer to `request`, or null when its path is not under /api/forge/. */
export async function handleForge(
  request: Request,
  env: ForgeServiceEnv | object,
  ctx: Context = noWait,
  deps: ForgeDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isForgePath(url.pathname)) return null;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const route = FORGE_ROUTES[path];
  if (!route) return problem(404, "not_found", "No such route.");
  const get = request.method === "GET" || request.method === "HEAD";
  if (route.method === "GET" ? !get : request.method !== "POST") return wrongMethod(route.method);
  const e = env as ForgeServiceEnv;
  const forgeDb: D1Database | undefined = e.FORGE;
  if (!forgeDb) return problem(503, "not_configured", "The GitHub side is not set up yet.");
  if (route.signedIn && !ready(e as AccountEnv)) return problem(503, "not_configured", "Accounts are not set up yet.");
  const t = deps.now ? deps.now() : now();

  // Development only (ACCOUNT_DEV_METRICS=1): D1's figures for both databases in the answer.
  const metrics = e.ACCOUNT_DEV_METRICS === "1" ? counted(forgeDb) : null;
  const run = async (accountEnv: AccountEnv): Promise<Response> => {
    const full = { ...(accountEnv as ForgeServiceEnv), FORGE: metrics ? metrics.db : forgeDb };
    let backend: GitBackend | null = null;
    const r: ForgeRequest = {
      request,
      url,
      path,
      env: full,
      db: full.FORGE,
      ctx,
      t,
      backend: () => (backend ??= forgeBackend(full, deps)),
      actions: deps.actions ?? ACTIONS,
      deps,
    };
    try {
      return await route.handle(r);
    } catch (err) {
      return failure(err, path, t);
    }
  };
  const res = await measured(e, run);
  if (metrics) {
    res.headers.set("X-D1-Forge-Queries", String(metrics.totals.queries));
    res.headers.set("X-D1-Forge-Rows-Read", String(metrics.totals.read));
    res.headers.set("X-D1-Forge-Rows-Written", String(metrics.totals.written));
  }
  return res;
}
