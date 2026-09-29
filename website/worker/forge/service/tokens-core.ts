// The registry's own personal tokens (night phase 10, E1; docs/API.md "Authentication"): what a token
// is, its scopes, its rows in D1 oscr_forge `api_tokens` (migrations/d1-forge/0009_automation.sql).
// The routes are tokens.ts (made and revoked on the site, signed in) and bearer.ts (a request of the
// public API that carries one).
//
// - A token is `oscr_pat_` and 43 base64url characters: 256 random bits. The prefix lets a secret
//   scanner (GitHub's push protection, a person's own tools) recognise a leaked one; the redaction of
//   the logs knows it (http.ts `redact`).
// - Only its SHA-256 is kept (`digest`, the table's key): the token is answered once, when it is made,
//   and never again. A random value of 256 bits needs neither salt nor slow hash: its digest reveals
//   nothing a guess could use.
// - It is scoped (`area:read` or `area:write`, a write granting the read of its area), expires after
//   1 to 366 days (30 by default; no token lives for ever), is revocable at once (its row deleted:
//   nothing kept), and is listed with its last use, to the day (written at most once a day: 1 row).
// - It serves the public API only (/api/v1/*), never the site's own routes (a cookie and a CSRF token
//   there), and never git: git goes to GitHub with GitHub's own tokens (D00-3).
// - It acts as its person, within their caps, and within FORGE_OPEN: until phase 16, only the owner
//   of the registry may make one (tokens.ts), so only the owner can use the API's writes.

import { randomToken, sha256Hex } from "../../account/crypto.ts";
import { utcDay } from "./caps.ts";
import { cleanLine } from "./social-core.ts";
import { ForgeProblem, type D1Database, type D1PreparedStatement, type Write } from "./types.ts";

export const TOKEN_PREFIX = "oscr_pat_";
/** A token as it is written: the prefix and 43 base64url characters (32 random bytes). */
export const TOKEN_SHAPE = /^oscr_pat_[A-Za-z0-9_-]{43}$/;

/** What a token may be allowed, area by area. A write grants the read of its area. */
export const SCOPES = [
  "repos:read",
  "research:read",
  "research:write",
  "social:read",
  "social:write",
  "notifications:read",
  "notifications:write",
  "hooks:read",
  "hooks:write",
  "statuses:write",
] as const;
export type Scope = (typeof SCOPES)[number];

/** Each scope in words (the settings page, the API's reference). */
export const SCOPE_WORDS: Readonly<Record<Scope, string>> = {
  "repos:read": "read the registry's layer over repositories: their papers, their state, the commit statuses posted to it",
  "research:read": "read research issues and their comments",
  "research:write": "open, comment on, edit, close and reopen research issues, as you",
  "social:read": "read your stars, lists and follows, people's public profiles and your feed",
  "social:write": "star, list, follow and watch, and change your profile, as you",
  "notifications:read": "read your notifications (the registry's own inbox)",
  "notifications:write": "mark your notifications read, done or saved, and unsubscribe",
  "hooks:read": "read your outgoing webhooks and their deliveries",
  "hooks:write": "make, change, test, redeliver and delete your outgoing webhooks",
  "statuses:write": "post commit statuses on the repositories the registry knows (a CI or a reproduction service)",
};

export const isScope = (v: unknown): v is Scope => typeof v === "string" && (SCOPES as readonly string[]).includes(v);

/** Whether scopes held grant `needed`: the scope itself, or the write of its area for a read. */
export function grants(held: readonly string[], needed: Scope): boolean {
  if (held.includes(needed)) return true;
  const [area, level] = needed.split(":");
  return level === "read" && held.includes(`${area}:write`);
}

/** A token's life, in days. */
export const EXPIRY = { min: 1, max: 366, default: 30 } as const;
/** Tokens an account may hold at once (expired ones included, until they are deleted). */
export const TOKENS_PER_ACCOUNT = 20;
/** The body of the site's token route. */
export const TOKEN_BODY_BYTES = 4 * 1024;

export interface TokenRequest {
  name: string;
  scopes: Scope[];
  days: number;
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);

/** A token's name, scopes and life, as a person asked for them; a problem in words otherwise. */
export function validateToken(payload: unknown): TokenRequest | ForgeProblem {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  if (!p) return bad("The request is not readable.");
  const name = cleanLine(p.name, 60);
  if (!name) return bad("A token needs a name: what it is for (a lab's CI, a script, a notebook).");
  if (name.includes("@")) return bad("A token's name holds no address.");
  if (!Array.isArray(p.scopes) || !p.scopes.length) return bad("Choose at least one thing the token may do.");
  if (p.scopes.length > SCOPES.length) return bad("Too many scopes.");
  const scopes: Scope[] = [];
  for (const s of p.scopes) {
    if (!isScope(s)) return bad(`“${String(s).slice(0, 40)}” is not a scope of the registry's tokens.`);
    if (!scopes.includes(s)) scopes.push(s);
  }
  scopes.sort((a, b) => SCOPES.indexOf(a) - SCOPES.indexOf(b));
  const days = p.days === undefined ? EXPIRY.default : p.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < EXPIRY.min || days > EXPIRY.max) {
    return bad(`A token expires after ${EXPIRY.min} to ${EXPIRY.max} days: none lives for ever.`);
  }
  return { name, scopes, days };
}

/** A new token: the value answered once, its public id, and the digest the row keeps. */
export async function newToken(): Promise<{ token: string; id: string; digest: string }> {
  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  return { token, id: randomToken(12), digest: await sha256Hex(token) };
}

/** The digest a request's token is found by. */
export const tokenDigest = (token: string): Promise<string> => sha256Hex(token);

export interface TokenRow {
  digest: string;
  id: string;
  user_id: string;
  name: string;
  scopes: string;
  created_at: number;
  expires_at: number;
  last_used_day: number | null;
}

/** A token made: its row and its index entry (2 rows). */
export function tokenInsert(db: D1Database, row: Omit<TokenRow, "last_used_day">): Write {
  return {
    rows: 2,
    stmt: db
      .prepare("INSERT INTO api_tokens (digest, id, user_id, name, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(row.digest, row.id, row.user_id, row.name, row.scopes, Math.floor(row.created_at), Math.floor(row.expires_at)),
  };
}

/** A token revoked: its row and its index entry deleted (2 rows), found by the person's key. */
export function tokenDelete(db: D1Database, userId: string, id: string): Write {
  return { rows: 2, stmt: db.prepare("DELETE FROM api_tokens WHERE user_id = ? AND id = ?").bind(userId, id) };
}

/** A person's tokens (api_tokens_user: their few rows). */
export function tokensOf(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").bind(userId, TOKENS_PER_ACCOUNT + 5);
}

/** A token by its digest (the key: 1 row read). */
export function tokenByDigest(db: D1Database, digest: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM api_tokens WHERE digest = ?").bind(digest);
}

/** Its last use, to the day: 1 row, and only when the day changed (never a counter). */
export function touchWrite(db: D1Database, digest: string, t: number): Write {
  const day = utcDay(t);
  return {
    rows: 1,
    stmt: db.prepare("UPDATE api_tokens SET last_used_day = ? WHERE digest = ? AND (last_used_day IS NULL OR last_used_day < ?)").bind(day, digest, day),
  };
}

export const scopesOf = (row: Pick<TokenRow, "scopes">): Scope[] => row.scopes.split(" ").filter(isScope);

const dayIso = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);

/** A token as its person's settings page shows it: never its digest, never the account's id. */
export function tokenView(row: TokenRow, t: number) {
  return {
    id: row.id,
    name: row.name,
    scopes: scopesOf(row),
    created_at: new Date(row.created_at * 1000).toISOString(),
    expires_at: new Date(row.expires_at * 1000).toISOString(),
    expired: row.expires_at <= t,
    last_used: row.last_used_day === null ? null : dayIso(row.last_used_day),
  };
}
