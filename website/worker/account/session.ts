// Sessions. A signed-in browser holds a random 256-bit id in the cookie `__Host-oscr_session`;
// D1 keeps only its SHA-256 (`sessions.id_hash`), so a copy of the database signs nobody in.
//
// - 30 days from the sign-in; the expiry slides at most once a day, `last_seen_at` moves at most
//   once an hour (one row written, the index untouched): a busy session costs at most 24 writes
//   a day, an idle one none.
// - Signing out deletes the row: the cookie is then worth nothing, even if it was copied.
// - The CSRF token of a session is an HMAC of its id's hash under the server key: bound to the
//   session, stored nowhere, it changes with every sign-in.

import { hmac, hmacCheck, randomToken, sha256Hex } from "./crypto.ts";
import { readCookie, setCookie } from "./http.ts";
import type { D1Database } from "./types.ts";

export const SESSION_COOKIE = "__Host-oscr_session";
export const SESSION_SECONDS = 30 * 86_400;
/** The expiry slides at most this often. */
export const SLIDE_SECONDS = 86_400;
/** `last_seen_at` moves at most this often. */
export const SEEN_SECONDS = 3_600;
/** A session cookie's value: 32 random bytes in base64url. */
const VALUE = /^[A-Za-z0-9_-]{43}$/;

export interface Session {
  idHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

/** The session cookie's value, when it has the right shape. */
export function sessionValue(request: Request): string | null {
  const value = readCookie(request, SESSION_COOKIE);
  return value && VALUE.test(value) ? value : null;
}

export function sessionHash(value: string): Promise<string> {
  return sha256Hex(value);
}

/** The live session of this id hash; an expired one is deleted on the way. */
export async function loadSession(db: D1Database, idHash: string, now: number): Promise<Session | null> {
  const row = await db
    .prepare("SELECT user_id, created_at, expires_at, last_seen_at FROM sessions WHERE id_hash = ?")
    .bind(idHash)
    .first<{ user_id: string; created_at: number; expires_at: number; last_seen_at: number }>();
  if (!row) return null;
  if (row.expires_at <= now) {
    await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
    return null;
  }
  return { idHash, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at, lastSeenAt: row.last_seen_at };
}

/** A session in use: `last_seen_at` at most once an hour and, at most once a day, the expiry
 *  moved to 30 days on. Returns the cookie to send again when the expiry moved. */
export async function touchSession(db: D1Database, s: Session, value: string, now: number): Promise<string | null> {
  if (now - s.lastSeenAt < SEEN_SECONDS) return null;
  const slide = now + SESSION_SECONDS - s.expiresAt >= SLIDE_SECONDS;
  const expires = slide ? now + SESSION_SECONDS : s.expiresAt;
  await db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?").bind(now, expires, s.idHash).run();
  s.lastSeenAt = now;
  s.expiresAt = expires;
  return slide ? setCookie(SESSION_COOKIE, value, SESSION_SECONDS) : null;
}

/** A new session for `userId`, in one batch: the row, then the user's expired sessions deleted
 *  (through the `sessions_user` index), and the browser's previous session, if any. Returns the
 *  cookie's value (the id itself, which D1 never sees). */
export async function openSession(
  db: D1Database,
  userId: string,
  now: number,
  agent: string,
  replacing: string | null,
): Promise<string> {
  const value = randomToken(32);
  const idHash = await sessionHash(value);
  const statements = [
    db
      .prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, user_agent_hint) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(idHash, userId, now, now + SESSION_SECONDS, now, agent),
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").bind(userId, now),
  ];
  if (replacing) statements.push(db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(replacing));
  await db.batch(statements);
  return value;
}

export async function closeSession(db: D1Database, idHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
}

export function sessionCookie(value: string): string {
  return setCookie(SESSION_COOKIE, value, SESSION_SECONDS);
}

/** The CSRF token of a session. */
export function csrfToken(key: string, idHash: string): Promise<string> {
  return hmac(key, "csrf", idHash);
}

export function csrfValid(key: string, idHash: string, token: string): Promise<boolean> {
  return hmacCheck(key, "csrf", idHash, token);
}

/** "Firefox on macOS": enough for a person to recognize their own sessions later, too little
 *  to follow anyone (no version, no full string). */
export function agentHint(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  const system = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return [browser, system].filter(Boolean).join(" on ");
}
