// A request of the public API (/api/forge/v1/*, api.ts) and the token it carries (night phase 10, E1;
// docs/API.md "Authentication", "Rate limits"): who asks, what the token allows, and how many
// requests it may still make.
//
// - `Authorization: Bearer oscr_pat_…` (or `token oscr_pat_…`, as GitHub also reads): the token's
//   SHA-256 found by the key of `api_tokens` (1 row read), refused when it is unknown (revoked, or it
//   never existed), expired, or its account is gone. The token itself is never logged, stored or
//   answered; a malformed header is refused before any hashing.
// - The person behind it becomes the request's `principal`: the site's own handlers read it in place of
//   a session (who.ts), so the API writes through the same code, the same caps and the same FORGE_OPEN
//   as the site. No cookie is read or set: a bearer token is never sent by a browser on its own, so
//   the API needs no CSRF token, and it answers any Origin (CORS without credentials).
// - Its last use is written at most once a day (1 row, in waitUntil).
// - Rate limits, per token: 60 requests a minute and 1,000 a day, counted in the isolate's memory
//   (free, but per isolate: Cloudflare may run several, so this is a ceiling per isolate, not an exact
//   global count; a global count would need a row per request, D08-18). When the owner binds
//   Cloudflare's rate-limiting binding as API_LIMITER (not in wrangler.toml: its price on the free plan
//   is the owner's to confirm, D10-n), it is asked too. The Worker's own daily quota stays the last
//   word: past it, every /api/* answers 429.

import type { SignedIn } from "../../account/guard.ts";
import type { Session } from "../../account/session.ts";
import { userById } from "../../account/store.ts";
import { utcDay, untilNextDay } from "./caps.ts";
import { first } from "./store.ts";
import { scopesOf, tokenByDigest, tokenDigest, TOKEN_SHAPE, touchWrite, type Scope, type TokenRow } from "./tokens-core.ts";
import { ForgeProblem, type Context, type D1Database, type ForgeServiceEnv } from "./types.ts";

/** The person behind a token, in the shape the site's handlers take (account/guard.ts SignedIn), and
 *  the token's public facts. */
export interface Principal extends SignedIn {
  token: { id: string; scopes: Scope[]; expiresAt: number; digest: string };
}

/** The token a request carries, or null when it carries none; a problem when the header is there but
 *  is not one. */
export function tokenOf(request: Request): string | null | ForgeProblem {
  const header = request.headers.get("Authorization");
  if (header === null) return null;
  const m = /^(?:Bearer|token)\s+(\S+)\s*$/i.exec(header);
  if (!m || !TOKEN_SHAPE.test(m[1])) {
    return new ForgeProblem(401, "bad_credentials", "This is not a token of the registry: it reads “Authorization: Bearer oscr_pat_…”.");
  }
  return m[1];
}

const unknown = () => new ForgeProblem(401, "bad_credentials", "This token is not valid: it was revoked, or it never existed. Make a new one in your settings.");

// ─── bad tokens, per address (night phase 16, D10-14) ────────────────────────
// A request with a wrong token costs one read of D1: past BAD_TOKENS_PER_MINUTE from one address, the
// isolate refuses the next ones for the rest of the minute before any read. The address (Cloudflare's
// CF-Connecting-IP) lives in the isolate's memory for that minute only: never written, never logged.

export const BAD_TOKENS_PER_MINUTE = 20;
const BAD_TOKENS = new Map<string, { minute: number; n: number }>();
const BAD_KEYS = 5_000;

const addressOf = (request: Request): string => request.headers.get("CF-Connecting-IP") ?? "";

/** Whether this address sent too many bad tokens this minute. */
export function tooManyBadTokens(request: Request, t: number): boolean {
  const a = addressOf(request);
  const w = a ? BAD_TOKENS.get(a) : undefined;
  return !!w && w.minute === Math.floor(t / 60) && w.n >= BAD_TOKENS_PER_MINUTE;
}

/** One more bad token from this address. */
export function badToken(request: Request, t: number): void {
  const a = addressOf(request);
  if (!a) return;
  const minute = Math.floor(t / 60);
  const w = BAD_TOKENS.get(a);
  if (w && w.minute === minute) w.n += 1;
  else {
    if (BAD_TOKENS.size >= BAD_KEYS) BAD_TOKENS.clear();
    BAD_TOKENS.set(a, { minute, n: 1 });
  }
}

const tooMany = (t: number) =>
  new ForgeProblem(429, "too_many_bad_tokens", "Too many requests with a wrong token from this address: wait a minute, then use a valid token.", { retryAfter: 60 - (Math.floor(t) % 60) });

/** The principal of a request that carries a token, or the problem that refuses it. */
export async function bearer(
  request: Request,
  env: ForgeServiceEnv & { FORGE: D1Database },
  t: number,
  ctx: Context,
): Promise<Principal | ForgeProblem | null> {
  const token = tokenOf(request);
  if (token === null) return token;
  if (tooManyBadTokens(request, t)) return tooMany(t);
  if (token instanceof ForgeProblem) {
    badToken(request, t);
    return token;
  }
  if (!env.COMMUNITY || typeof env.SESSION_KEY !== "string") return new ForgeProblem(503, "not_configured", "Accounts are not set up yet.");
  const digest = await tokenDigest(token);
  const row = await first<TokenRow>(tokenByDigest(env.FORGE, digest));
  if (!row) {
    badToken(request, t);
    return unknown();
  }
  if (row.expires_at <= t) {
    return new ForgeProblem(401, "token_expired", `This token expired on ${new Date(row.expires_at * 1000).toISOString().slice(0, 10)}: make a new one in your settings.`);
  }
  const user = await userById(env.COMMUNITY, row.user_id);
  if (!user) return unknown();
  if (row.last_used_day === null || row.last_used_day < utcDay(t)) {
    const touch = touchWrite(env.FORGE, digest, t);
    ctx.waitUntil(touch.stmt.run().catch(() => undefined));
  }
  const session: Session = { idHash: `token:${row.id}`, userId: user.id, createdAt: row.created_at, expiresAt: row.expires_at, lastSeenAt: t };
  return {
    db: env.COMMUNITY,
    key: env.SESSION_KEY,
    session,
    user,
    cookies: [],
    token: { id: row.id, scopes: scopesOf(row), expiresAt: row.expires_at, digest },
  };
}

// ─── rate limits ─────────────────────────────────────────────────────────────

export const API_RATE = { perMinute: 60, perDay: 1_000 } as const;

export interface RateState {
  ok: boolean;
  /** The day's limit, its use and what remains (the X-RateLimit-* headers). */
  limit: number;
  used: number;
  remaining: number;
  /** Unix seconds: when the day's count starts again (00:00 UTC). */
  reset: number;
  /** Seconds to wait when refused. */
  retryAfter: number | null;
  /** What refused: the minute's burst or the day's total. */
  which: "minute" | "day" | null;
}

interface Window {
  day: number;
  inDay: number;
  minute: number;
  inMinute: number;
}

/** The isolate's counts, by token id. Never a token, never a person. */
export const RATE_WINDOWS = new Map<string, Window>();
const MAX_KEYS = 5_000;

function windowOf(key: string, t: number, windows: Map<string, Window>): Window {
  const day = utcDay(t);
  const minute = Math.floor(t / 60);
  let w = windows.get(key);
  if (!w) {
    if (windows.size >= MAX_KEYS) for (const [k, v] of windows) if (v.day < day) windows.delete(k);
    w = { day, inDay: 0, minute, inMinute: 0 };
    windows.set(key, w);
  }
  if (w.day !== day) Object.assign(w, { day, inDay: 0 });
  if (w.minute !== minute) Object.assign(w, { minute, inMinute: 0 });
  return w;
}

function stateOf(w: Window, t: number, ok: boolean, which: RateState["which"]): RateState {
  const reset = (utcDay(t) + 1) * 86_400;
  const retryAfter = ok ? null : which === "minute" ? Math.max(1, 60 - (Math.floor(t) % 60)) : untilNextDay(t);
  return { ok, limit: API_RATE.perDay, used: w.inDay, remaining: Math.max(0, API_RATE.perDay - w.inDay), reset, retryAfter, which };
}

/** One request of a token: counted, or refused when it goes over the minute's or the day's limit. */
export function takeRequest(key: string, t: number, windows = RATE_WINDOWS): RateState {
  const w = windowOf(key, t, windows);
  if (w.inDay >= API_RATE.perDay) return stateOf(w, t, false, "day");
  if (w.inMinute >= API_RATE.perMinute) return stateOf(w, t, false, "minute");
  w.inDay += 1;
  w.inMinute += 1;
  return stateOf(w, t, true, null);
}

/** A request that should not count after all (an answer 304, as GitHub does not count them). */
export function giveBack(key: string, t: number, windows = RATE_WINDOWS): void {
  const w = windowOf(key, t, windows);
  w.inDay = Math.max(0, w.inDay - 1);
  w.inMinute = Math.max(0, w.inMinute - 1);
}

/** The state without counting (GET /api/forge/v1/rate_limit, which never counts). */
export function peekRate(key: string, t: number, windows = RATE_WINDOWS): RateState {
  return stateOf(windowOf(key, t, windows), t, true, null);
}

/** Cloudflare's rate-limiting binding, when the owner binds it (API_LIMITER): false when it refuses.
 *  Without it, or when it fails, the isolate's own count stands alone. */
export async function sharedLimit(env: ForgeServiceEnv, key: string): Promise<boolean> {
  const limiter = env.API_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") return true;
  try {
    const out = await limiter.limit({ key });
    return out?.success !== false;
  } catch {
    return true;
  }
}

/** The answer's rate-limit headers (GitHub's names). */
export function rateHeaders(state: RateState): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(state.limit),
    "X-RateLimit-Remaining": String(state.remaining),
    "X-RateLimit-Used": String(state.used),
    "X-RateLimit-Reset": String(state.reset),
    "X-RateLimit-Resource": "core",
  };
}
