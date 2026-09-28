// What every route of the Worker receives: its bindings (wrangler.toml) and its context.
import type { CheckEnv } from "./contributions/checks.ts";
import type { D1Database } from "./d1.ts";
import type { ForgeServiceEnv } from "./forge/service/types.ts";

/** The accounts (Phase 5) bring `COMMUNITY`, the D1 `oscr_community`, and their secrets
 *  (account/types.ts; docs/ACCOUNTS.md); the contributions (Phase 6) the development mock of
 *  their checks (contributions/checks.ts); the forge service (night phase 01) `FORGE`, the D1
 *  `oscr_forge`, the GitHub App's secrets, FORGE_OPEN and FORGE_OWNER_GITHUB_ID
 *  (forge/service/types.ts; docs/FORGE.md). ForgeServiceEnv includes the accounts' AccountEnv. */
export interface Env extends ForgeServiceEnv, CheckEnv {
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
