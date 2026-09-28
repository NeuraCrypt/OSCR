// What every route of the Worker receives: its bindings (wrangler.toml) and its context.
import type { AccountEnv } from "./account/types.ts";
import type { D1Database } from "./d1.ts";

/** The accounts (Phase 5) bring `COMMUNITY`, the D1 `oscr_community`, and their secrets
 *  (account/types.ts; docs/ACCOUNTS.md). */
export interface Env extends AccountEnv {
  /** D1 `oscr_catalog`: the result rows and the counts of the search (Phase 3, docs/SEARCH.md). */
  CATALOG?: D1Database;
  /** D1 `oscr_search`: the full-text index (Phase 3). */
  SEARCH?: D1Database;
  /** Development only (`wrangler dev --var SEARCH_SIMULATE_FAILURE:quota`): answer every search
   *  with this failure, "quota" or "unavailable", to see what the page then says. Never set in
   *  wrangler.toml. */
  SEARCH_SIMULATE_FAILURE?: string;
}

export type Context = { waitUntil(promise: Promise<unknown>): void };

/** A route's handler. */
export type Handler = (request: Request, env: Env, ctx: Context) => Promise<Response>;
