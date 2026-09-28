// Who is asking, for every route that reads or changes an account (the accounts' own, and the
// contributions' of Phase 6, worker/contributions/): the session behind the request, and for a
// POST the proofs that it comes from the registry's own pages — the site's Origin (and
// Sec-Fetch-Site when the browser sends it) and the session's CSRF token.

import { clearCookie, problem, readCookie } from "./http.ts";
import { counted } from "./metrics.ts";
import {
  csrfValid,
  hintCookie,
  loadSession,
  SESSION_COOKIE,
  sessionHash,
  sessionValue,
  touchSession,
  type Session,
} from "./session.ts";
import { userById, type User } from "./store.ts";
import type { AccountEnv, D1Database } from "./types.ts";

/** The largest request body read (a form's JSON). */
export const MAX_BODY = 8192;

export const now = () => Math.floor(Date.now() / 1000);

/** The accounts work once the community database is bound and the server key is set. */
export function ready(env: AccountEnv): env is AccountEnv & { COMMUNITY: D1Database; SESSION_KEY: string } {
  return !!env.COMMUNITY && typeof env.SESSION_KEY === "string" && env.SESSION_KEY.length >= 32;
}

export type SignedIn = { db: D1Database; key: string; session: Session; user: User; cookies: string[] };

/** The cookies that end a session the browser still holds: the session's, and its hint. */
export function staleCookies(request: Request): string[] {
  return readCookie(request, SESSION_COOKIE) !== null ? [clearCookie(SESSION_COOKIE), hintCookie(false)] : [];
}

/** The signed-in account behind a request. A POST must also come from the site's own pages
 *  (Origin, and Sec-Fetch-Site when the browser sends it) and carry the session's CSRF token. */
export async function signedIn(request: Request, env: AccountEnv, t: number, a: { post: boolean; touch: boolean }): Promise<SignedIn | Response> {
  if (!ready(env)) return problem(503, "not_configured", "Accounts are not set up yet.");
  if (a.post) {
    const site = request.headers.get("Sec-Fetch-Site");
    if (request.headers.get("Origin") !== new URL(request.url).origin || (site !== null && site !== "same-origin")) {
      return problem(403, "bad_origin", "This request did not come from the registry's own pages.");
    }
  }
  const db = env.COMMUNITY;
  const value = sessionValue(request);
  const session = value ? await loadSession(db, await sessionHash(value), t) : null;
  const user = session ? await userById(db, session.userId) : null;
  if (!value || !session || !user) return problem(401, "signed_out", "You are not signed in.", staleCookies(request));
  if (a.post && !(await csrfValid(env.SESSION_KEY, session.idHash, request.headers.get("X-CSRF-Token") ?? ""))) {
    return problem(403, "bad_csrf", "This page is out of date: reload it, then try again.");
  }
  const slid = a.touch ? await touchSession(db, session, value, t) : null;
  return { db, key: env.SESSION_KEY, session, user, cookies: slid ? [slid, hintCookie(true)] : [] };
}

/** A request's JSON object body, or null: not JSON, too large, not an object. */
export async function readJson(request: Request, max = MAX_BODY): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return null;
  // A body larger than a form is not read at all.
  if (Number(request.headers.get("Content-Length") ?? 0) > max) return null;
  const text = await request.text();
  if (text.length > max) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Development only (ACCOUNT_DEV_METRICS=1): the D1 binding counted, and the answer given D1's
 *  figures (X-D1-Queries, X-D1-Rows-Read, X-D1-Rows-Written). */
export async function measured(env: AccountEnv, run: (env: AccountEnv) => Promise<Response>): Promise<Response> {
  const metrics = env.ACCOUNT_DEV_METRICS === "1" && env.COMMUNITY ? counted(env.COMMUNITY) : null;
  const res = await run(metrics ? { ...env, COMMUNITY: metrics.db } : env);
  if (metrics) {
    res.headers.set("X-D1-Queries", String(metrics.totals.queries));
    res.headers.set("X-D1-Rows-Read", String(metrics.totals.read));
    res.headers.set("X-D1-Rows-Written", String(metrics.totals.written));
  }
  return res;
}
