// What every route of the Worker receives: its bindings (wrangler.toml) and its context.
import type { D1Database } from "./d1.ts";

export interface Env {
  /** D1 `oscr_catalog`: the result rows and the counts of the search (Phase 3, docs/SEARCH.md). */
  CATALOG?: D1Database;
  /** D1 `oscr_search`: the full-text index (Phase 3). */
  SEARCH?: D1Database;
  // Phase 5 (accounts) adds its database here: `COMMUNITY?: D1Database;` (accounts, identities,
  // sessions…, docs/PLATFORM_PLAN.md §4 "Community"), bound in wrangler.toml.
  /** Development only (`wrangler dev --var SEARCH_SIMULATE_FAILURE:quota`): answer every search
   *  with this failure, "quota" or "unavailable", to see what the page then says. Never set in
   *  wrangler.toml. */
  SEARCH_SIMULATE_FAILURE?: string;
}

export type Context = { waitUntil(promise: Promise<unknown>): void };

/** A route's handler. */
export type Handler = (request: Request, env: Env, ctx: Context) => Promise<Response>;
