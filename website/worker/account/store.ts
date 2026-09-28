// The accounts in D1 (migrations/d1-community/0001_accounts.sql): users and their identities,
// roles and claims, and the Mac's facts (paper_orcid, repo_owner), which this code only reads.
// Every write says what it costs; docs/ACCOUNTS.md adds them up per sign-in.

import { randomToken } from "./crypto.ts";
import type { Person, ProviderName } from "./providers.ts";
import type { D1Database, D1PreparedStatement } from "./types.ts";

export interface User {
  id: string;
  display_name: string;
  orcid: string | null;
  github_login: string | null;
  created_at: number;
}

export interface Identity {
  provider: ProviderName;
  subject: string;
  linked_at: number;
}

export interface Role {
  role: string;
  scope_kind: string;
  scope_id: string;
  granted_by: string;
  granted_at: number;
}

export interface Claim {
  id: number;
  kind: "author" | "maintainer";
  paper_id: string;
  repo: string;
  status: "pending" | "verified" | "rejected";
  evidence: string;
  /** The owner's words on a decided claim (Phase 6). */
  message?: string;
  created_at: number;
  decided_at: number | null;
}

export interface PaperFact {
  paper_id: string;
  slug: string | null;
  title: string | null;
}

export class AccountError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function identityOwner(db: D1Database, provider: ProviderName, subject: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?")
    .bind(provider, subject)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export function userById(db: D1Database, id: string): Promise<User | null> {
  return db.prepare("SELECT id, display_name, orcid, github_login, created_at FROM users WHERE id = ?").bind(id).first<User>();
}

/** The reads of the account page, as statements: /api/account/me sends them in one batch. */
export const reads = {
  identities: (db: D1Database, userId: string): D1PreparedStatement =>
    db
      .prepare(
        "SELECT provider, subject, linked_at FROM identities WHERE user_id = ? " +
          "ORDER BY CASE provider WHEN 'orcid' THEN 0 WHEN 'github' THEN 1 ELSE 2 END",
      )
      .bind(userId),
  roles: (db: D1Database, userId: string): D1PreparedStatement =>
    db.prepare("SELECT role, scope_kind, scope_id, granted_by, granted_at FROM roles WHERE user_id = ? ORDER BY role, scope_id").bind(userId),
  /** The papers a user is a verified author of, with their pages (the facts of their ORCID iD). */
  papers: (db: D1Database, userId: string, orcid: string | null): D1PreparedStatement =>
    db
      .prepare(
        "SELECT r.scope_id AS paper_id, p.slug AS slug, p.title AS title FROM roles r " +
          "LEFT JOIN paper_orcid p ON p.orcid = ? AND p.paper_id = r.scope_id " +
          "WHERE r.user_id = ? AND r.role = 'verified_author' AND r.scope_kind = 'paper' ORDER BY p.title, r.scope_id",
      )
      .bind(orcid ?? "", userId),
  claims: (db: D1Database, userId: string): D1PreparedStatement =>
    db
      .prepare(
        "SELECT id, kind, paper_id, repo, status, evidence, message, created_at, decided_at FROM claims WHERE user_id = ? " +
          "ORDER BY created_at DESC, id DESC LIMIT 100",
      )
      .bind(userId),
};

export async function identitiesOf(db: D1Database, userId: string): Promise<Identity[]> {
  return (await reads.identities(db, userId).all<Identity>()).results;
}

/** The public handle a person brings to the `users` row: the ORCID iD, the GitHub login. */
function handles(person: Person): { orcid: string | null; github_login: string | null } {
  return {
    orcid: person.provider === "orcid" ? person.handle : null,
    github_login: person.provider === "github" ? person.handle : null,
  };
}

function insertIdentity(db: D1Database, userId: string, person: Person, now: number): D1PreparedStatement {
  // 2 rows written: the row, and its entry in identities_user.
  return db
    .prepare("INSERT INTO identities (provider, subject, user_id, linked_at) VALUES (?, ?, ?, ?)")
    .bind(person.provider, person.subject, userId, now);
}

function isConflict(e: unknown): boolean {
  return /UNIQUE constraint failed|PRIMARY KEY|SQLITE_CONSTRAINT/i.test(String((e as Error)?.message ?? e));
}

/** A new account for a person nobody has linked yet: the user (1 row written) and the identity
 *  (2), in one batch. When the same person is being created at the same moment by another
 *  request, that account wins and is returned. */
export async function createUser(db: D1Database, person: Person, now: number): Promise<User> {
  const user: User = { id: `u_${randomToken(16)}`, display_name: person.name, ...handles(person), created_at: now };
  try {
    await db.batch([
      db
        .prepare("INSERT INTO users (id, display_name, orcid, github_login, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(user.id, user.display_name, user.orcid, user.github_login, now),
      insertIdentity(db, user.id, person, now),
    ]);
    return user;
  } catch (e) {
    if (!isConflict(e)) throw e;
    const owner = await identityOwner(db, person.provider, person.subject);
    const existing = owner ? await userById(db, owner) : null;
    if (!existing) throw e;
    return existing;
  }
}

/** What a sign-in brings to an account that exists: a GitHub login renamed since, a name where
 *  there was none, a handle not kept yet. Written only when something changed (1 row). */
export async function refreshUser(db: D1Database, user: User, person: Person): Promise<User> {
  const h = handles(person);
  const next: User = {
    ...user,
    orcid: h.orcid ?? user.orcid,
    github_login: h.github_login ?? user.github_login,
    display_name: user.display_name || person.name,
  };
  if (next.orcid !== user.orcid || next.github_login !== user.github_login || next.display_name !== user.display_name) {
    await db
      .prepare("UPDATE users SET display_name = ?, orcid = ?, github_login = ? WHERE id = ?")
      .bind(next.display_name, next.orcid, next.github_login, user.id)
      .run();
  }
  return next;
}

/** Link a person's identity to a signed-in account: the identity (2 rows written), and the
 *  account's handle and name (1, when they change). A user has at most one identity per
 *  provider, and an identity belongs to one account. */
export async function linkIdentity(db: D1Database, user: User, person: Person, now: number): Promise<User> {
  const owner = await identityOwner(db, person.provider, person.subject);
  if (owner === user.id) return refreshUser(db, user, person);
  if (owner) throw new AccountError("identity_in_use", "This account of the provider is linked to another account of the registry.");
  const mine = await identitiesOf(db, user.id);
  if (mine.some((i) => i.provider === person.provider)) {
    throw new AccountError("provider_already_linked", "Your account already has an identity of this provider.");
  }
  const h = handles(person);
  const next: User = {
    ...user,
    orcid: h.orcid ?? user.orcid,
    github_login: h.github_login ?? user.github_login,
    display_name: user.display_name || person.name,
  };
  const statements = [insertIdentity(db, user.id, person, now)];
  if (next.orcid !== user.orcid || next.github_login !== user.github_login || next.display_name !== user.display_name) {
    statements.push(
      db.prepare("UPDATE users SET display_name = ?, orcid = ?, github_login = ? WHERE id = ?").bind(next.display_name, next.orcid, next.github_login, user.id),
    );
  }
  try {
    await db.batch(statements);
  } catch (e) {
    if (isConflict(e)) throw new AccountError("identity_in_use", "This account of the provider is linked to another account of the registry.");
    throw e;
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// Roles. `member` is implied for every user and never stored.

export async function rolesOf(db: D1Database, userId: string): Promise<Role[]> {
  return (await reads.roles(db, userId).all<Role>()).results;
}

export async function hasRole(db: D1Database, userId: string, role: string, kind: string, id: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS yes FROM roles WHERE user_id = ? AND role = ? AND scope_kind = ? AND scope_id = ?")
    .bind(userId, role, kind, id)
    .first<{ yes: number }>();
  return row !== null;
}

/** Author verification: a user whose ORCID iD the papers' metadata names (`paper_orcid`) is a
 *  verified author of those papers. Two statements whatever the number of papers: the missing
 *  roles inserted (1 row written each), the automatic ones whose fact has gone deleted (1 each);
 *  a role a moderator granted is never touched. Returns how many were granted and revoked. */
export async function syncAuthorRoles(db: D1Database, userId: string, orcid: string, now: number): Promise<{ granted: number; revoked: number }> {
  const [added, removed] = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) " +
          "SELECT ?, 'verified_author', 'paper', paper_id, 'system', ? FROM paper_orcid WHERE orcid = ?",
      )
      .bind(userId, now, orcid),
    db
      .prepare(
        "DELETE FROM roles WHERE user_id = ? AND role = 'verified_author' AND scope_kind = 'paper' AND granted_by = 'system' " +
          "AND scope_id NOT IN (SELECT paper_id FROM paper_orcid WHERE orcid = ?)",
      )
      .bind(userId, orcid),
  ]);
  return { granted: added?.meta?.changes ?? 0, revoked: removed?.meta?.changes ?? 0 };
}

export async function authoredPapers(db: D1Database, userId: string, orcid: string | null): Promise<PaperFact[]> {
  return (await reads.papers(db, userId, orcid).all<PaperFact>()).results;
}

// ---------------------------------------------------------------------------------------------
// Repositories and claims.

export function repoOwner(db: D1Database, repo: string): Promise<{ repo: string; host: string; owner: string } | null> {
  return db.prepare("SELECT repo, host, owner FROM repo_owner WHERE repo = ?").bind(repo).first();
}

export async function claimsOf(db: D1Database, userId: string): Promise<Claim[]> {
  return (await reads.claims(db, userId).all<Claim>()).results;
}

export async function pendingClaims(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM claims WHERE user_id = ? AND status = 'pending'")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** A maintainer verified: the role (1 row written) and the claim that keeps its evidence, as
 *  verified by the system (2 when new: the row and claims_user_target; 1 when it existed). */
export async function grantMaintainer(db: D1Database, userId: string, repo: string, evidence: unknown, now: number): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES (?, 'maintainer', 'repo', ?, 'system', ?)",
      )
      .bind(userId, repo, now),
    db
      .prepare(
        "INSERT INTO claims (user_id, kind, repo, evidence, status, created_at, decided_by, decided_at) " +
          "VALUES (?, 'maintainer', ?, ?, 'verified', ?, 'system', ?) " +
          "ON CONFLICT (user_id, kind, paper_id, repo) DO UPDATE SET evidence = excluded.evidence, status = 'verified', " +
          "decided_by = 'system', decided_at = excluded.decided_at",
      )
      .bind(userId, repo, JSON.stringify(evidence), now, now),
  ]);
}

/** A maintainer claim the evidence could not settle: pending, for the owner (`oscr claims`; the
 *  moderators with Phase 7). A pending claim asked again gets the new evidence; a rejected one
 *  stays rejected. With a job for the Mac while it is pending (Phase 6's `jobs`): 3 rows written
 *  for a new claim (the row, its index entry, the job), 2 when asked again. Returns the claim as
 *  it now is. */
export async function pendingMaintainer(db: D1Database, userId: string, repo: string, evidence: unknown, now: number): Promise<Claim> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO claims (user_id, kind, repo, evidence, status, created_at) VALUES (?, 'maintainer', ?, ?, 'pending', ?) " +
          "ON CONFLICT (user_id, kind, paper_id, repo) DO UPDATE SET evidence = excluded.evidence WHERE claims.status = 'pending'",
      )
      .bind(userId, repo, JSON.stringify(evidence), now),
    db
      .prepare(
        "INSERT INTO jobs (kind, ref, user_id, created_at) SELECT 'claim', id, user_id, ? FROM claims " +
          "WHERE user_id = ? AND kind = 'maintainer' AND paper_id = '' AND repo = ? AND status = 'pending'",
      )
      .bind(now, userId, repo),
  ]);
  const claim = await db
    .prepare(
      "SELECT id, kind, paper_id, repo, status, evidence, created_at, decided_at FROM claims WHERE user_id = ? AND kind = 'maintainer' AND paper_id = '' AND repo = ?",
    )
    .bind(userId, repo)
    .first<Claim>();
  if (!claim) throw new Error("the claim was not recorded");
  return claim;
}
