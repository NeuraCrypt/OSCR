// The pure parts of phase 09's organizations, teams, roles and research permissions (the rows of
// migrations/d1-forge/0013_organizations.sql, as reads and Writes; the validation; the permission
// checks). The routes are organizations.ts (E1) and members.ts (E2); both read and write only
// through here, so a read is always a key or a key range (never a scan) and a Write always carries
// the rows D1 bills (its index entries included).
//
// No email address is stored (every text is cleaned and the migration CHECKs for '@'); a lab's
// GitHub organization is linked, not replaced, so nothing here grants a git right.

import { randomToken } from "../../account/crypto.ts";
import { utcDay } from "./caps.ts";
import { ForgeProblem, type D1Database, type D1PreparedStatement, type Write } from "./types.ts";

// ─── shapes ──────────────────────────────────────────────────────────────────

export interface OrgRow {
  id: string;
  handle: string;
  display_name: string;
  kind: string;
  ror: string;
  bio: string;
  readme_public: string;
  readme_members: string;
  picture: string;
  banner: string;
  pinned: string;
  domain: string;
  domain_proof: string;
  domain_verified: number;
  members_private: number;
  state: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface MemberRow {
  org_id: string;
  user_id: string;
  role: "owner" | "moderator" | "member";
  private: number;
  perms: string;
  added_by: string;
  joined_at: number;
}

export interface InvitationRow {
  org_id: string;
  id: string;
  invitee: string;
  role: "owner" | "moderator" | "member";
  perms: string;
  state: "pending" | "accepted" | "declined" | "revoked" | "expired";
  invited_by: string;
  created_at: number;
  expires_at: number;
}

export interface TeamRow {
  org_id: string;
  id: string;
  name: string;
  description: string;
  visibility: "visible" | "secret";
  parent: string;
  created_at: number;
}

export interface TeamMemberRow {
  org_id: string;
  team_id: string;
  user_id: string;
  team_role: "maintainer" | "member";
  added_at: number;
}

// ─── constants, in words ───────────────────────────────────────────────────────

export const ORG_KINDS_LIST = ["lab", "group", "department", "institution", "project", "other"] as const;
export const ORG_ROLES = ["owner", "moderator", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** The research permissions a role may carry (the plan: who may propose, flag or validate a tracing
 *  map, or tie a release to a paper version). A map a page shows, a flag on a code-paper link, a
 *  validation that deposits a DOI, a release pinned to a paper version. */
export const RESEARCH_PERMS = ["propose_map", "flag_map", "validate_map", "tie_release"] as const;
export type ResearchPerm = (typeof RESEARCH_PERMS)[number];

export const PERM_WORDS: Readonly<Record<ResearchPerm, string>> = {
  propose_map: "propose a tracing map",
  flag_map: "flag a code-paper link",
  validate_map: "validate a map (a DOI is deposited)",
  tie_release: "tie a release to a version of a paper",
};

/** Handles the site's own routes need, never an organization's. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "new", "settings", "api", "org", "orgs", "organizations", "account", "accounts", "admin", "about",
  "help", "policies", "privacy", "brand", "labs", "taxonomy", "search", "paper", "papers", "login",
  "logout", "signin", "signout", "device", "r", "lookup", "list", "browse", "sitemap", "robots",
]);

export const ORG_BODY_BYTES = 64 * 1024;

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);

/** A text trimmed, control characters and any at sign dropped, held to `max`. */
export function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // deno-lint-ignore no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/@/g, "").trim().slice(0, max);
}

const HANDLE = /^[a-z0-9-]{1,39}$/;

/** A handle a person typed, lowercased, or a problem (shape, reserved, all hyphens). */
export function validateHandle(value: unknown): string | ForgeProblem {
  const h = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!HANDLE.test(h)) return bad("A handle is 1 to 39 letters, digits or hyphens.");
  if (/^-|-$|--/.test(h)) return bad("A handle does not begin or end with a hyphen, and has no double hyphen.");
  if (RESERVED_HANDLES.has(h)) return bad("This handle is kept for the site itself: choose another.");
  return h;
}

export interface NewOrg {
  handle: string;
  display_name: string;
  kind: string;
  ror: string;
  bio: string;
  members_private: boolean;
}

/** The body of a create, checked. */
export function validateCreate(body: unknown): NewOrg | ForgeProblem {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("The request is not readable.");
  const b = body as Record<string, unknown>;
  const handle = validateHandle(b.handle);
  if (handle instanceof ForgeProblem) return handle;
  const kind = typeof b.kind === "string" && (ORG_KINDS_LIST as readonly string[]).includes(b.kind) ? b.kind : "lab";
  const ror = clean(b.ror, 40);
  if (ror && !/^0[a-hj-km-np-tv-z0-9]{6}[0-9]{2}$/.test(ror) && !/^https?:\/\/ror\.org\/0[a-hj-km-np-tv-z0-9]{6}[0-9]{2}$/.test(ror)) {
    return bad("A ROR id looks like 05dxps055 (or its ror.org address), or leave it empty.");
  }
  return {
    handle,
    display_name: clean(b.display_name, 100) || handle,
    kind,
    ror: ror.replace(/^https?:\/\/ror\.org\//, ""),
    bio: clean(b.bio, 2000),
    members_private: b.members_private === true,
  };
}

/** The fields a settings edit may set, each checked; unknown or absent fields are left. */
export interface OrgPatch {
  display_name?: string;
  kind?: string;
  ror?: string;
  bio?: string;
  readme_public?: string;
  readme_members?: string;
  picture?: string;
  banner?: string;
  members_private?: boolean;
  pinned?: string[];
}

export function validatePatch(body: unknown): OrgPatch | ForgeProblem {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("The request is not readable.");
  const b = body as Record<string, unknown>;
  const p: OrgPatch = {};
  if ("display_name" in b) p.display_name = clean(b.display_name, 100);
  if ("kind" in b) {
    if (!(ORG_KINDS_LIST as readonly string[]).includes(String(b.kind))) return bad("That is not a kind of organization.");
    p.kind = String(b.kind);
  }
  if ("ror" in b) p.ror = clean(b.ror, 40).replace(/^https?:\/\/ror\.org\//, "");
  if ("bio" in b) p.bio = clean(b.bio, 2000);
  if ("readme_public" in b) p.readme_public = clean(b.readme_public, 16384);
  if ("readme_members" in b) p.readme_members = clean(b.readme_members, 16384);
  if ("picture" in b) {
    const url = clean(b.picture, 300);
    if (url && !/^https:\/\//.test(url)) return bad("A picture is given by its https address, or left empty.");
    p.picture = url;
  }
  if ("banner" in b) p.banner = clean(b.banner, 500);
  if ("members_private" in b) p.members_private = b.members_private === true;
  if ("pinned" in b) {
    if (!Array.isArray(b.pinned) || b.pinned.some((x) => typeof x !== "string") || b.pinned.length > 20) return bad("Pinned repositories are given as a list of at most 20 ids.");
    p.pinned = (b.pinned as string[]).map((x) => x.slice(0, 80));
  }
  return p;
}

export function newOrgId(): string {
  return `o_${randomToken(12)}`;
}

export function newInviteId(): string {
  return randomToken(9);
}

// ─── reads (a key or a key range) ────────────────────────────────────────────

export function orgById(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM organizations WHERE id = ?").bind(id);
}

/** By its handle (organizations_handle). A deleted organization has no page. */
export function orgByHandle(db: D1Database, handle: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM organizations WHERE handle = ? AND state != 'deleted'").bind(handle.toLowerCase());
}

/** An organization's members (the key range), ordered owners first, then by join time. */
export function membersOf(db: D1Database, orgId: string): D1PreparedStatement {
  return db
    .prepare("SELECT org_id, user_id, role, private, perms, added_by, joined_at FROM org_members WHERE org_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, joined_at")
    .bind(orgId);
}

/** One membership (the key: 1 row). */
export function memberOf(db: D1Database, orgId: string, userId: string): D1PreparedStatement {
  return db.prepare("SELECT org_id, user_id, role, private, perms, added_by, joined_at FROM org_members WHERE org_id = ? AND user_id = ?").bind(orgId, userId);
}

/** A person's organizations (org_members_user), newest first. */
export function orgsOfUser(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare("SELECT org_id, user_id, role, private, perms, added_by, joined_at FROM org_members WHERE user_id = ? ORDER BY joined_at DESC LIMIT 200").bind(userId);
}

/** An organization's invitations (the key range). */
export function invitationsOf(db: D1Database, orgId: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM org_invitations WHERE org_id = ? ORDER BY created_at DESC LIMIT 200").bind(orgId);
}

export function invitationById(db: D1Database, orgId: string, id: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM org_invitations WHERE org_id = ? AND id = ?").bind(orgId, id);
}

/** A person's pending invitations (org_invitations_invitee). */
export function invitationsForUser(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM org_invitations WHERE invitee = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 100").bind(userId);
}

export function teamsOf(db: D1Database, orgId: string): D1PreparedStatement {
  return db.prepare("SELECT org_id, id, name, description, visibility, parent, created_at FROM teams WHERE org_id = ? ORDER BY id LIMIT 200").bind(orgId);
}

export function teamMembersOf(db: D1Database, orgId: string, teamId: string): D1PreparedStatement {
  return db.prepare("SELECT org_id, team_id, user_id, team_role, added_at FROM team_members WHERE org_id = ? AND team_id = ? ORDER BY team_role, added_at").bind(orgId, teamId);
}

// ─── writes (a Write: the statement and the rows D1 bills, index entries included) ──────────────

/** Insert an organization and its creator as owner, in two Writes (the caller batches them with the
 *  action and audit rows). 2 rows each (the row and one index entry). */
export function insertOrg(db: D1Database, o: NewOrg, id: string, createdBy: string, t: number): Write {
  return {
    rows: 2, // organizations + organizations_handle
    stmt: db
      .prepare(
        "INSERT INTO organizations (id, handle, display_name, kind, ror, bio, members_private, created_by, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(id, o.handle, o.display_name, o.kind, o.ror, o.bio, o.members_private ? 1 : 0, createdBy, Math.floor(t), Math.floor(t)),
  };
}

/** Set or change a membership (role, perms, visibility). 2 rows (org_members + org_members_user). */
export function upsertMember(
  db: D1Database,
  m: { orgId: string; userId: string; role: OrgRole; perms: ResearchPerm[]; private: boolean; addedBy: string; t: number },
): Write {
  return {
    rows: 2,
    stmt: db
      .prepare(
        "INSERT INTO org_members (org_id, user_id, role, private, perms, added_by, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role, private = excluded.private, perms = excluded.perms",
      )
      .bind(m.orgId, m.userId, m.role, m.private ? 1 : 0, JSON.stringify(m.perms), m.addedBy, Math.floor(m.t)),
  };
}

export function deleteMember(db: D1Database, orgId: string, userId: string): Write {
  return { rows: 2, stmt: db.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").bind(orgId, userId) };
}

export function insertInvitation(
  db: D1Database,
  inv: { orgId: string; id: string; invitee: string; role: OrgRole; perms: ResearchPerm[]; invitedBy: string; t: number; expiresAt: number },
): Write {
  return {
    rows: 2, // org_invitations + org_invitations_invitee
    stmt: db
      .prepare("INSERT INTO org_invitations (org_id, id, invitee, role, perms, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(inv.orgId, inv.id, inv.invitee, inv.role, JSON.stringify(inv.perms), inv.invitedBy, Math.floor(inv.t), Math.floor(inv.expiresAt)),
  };
}

/** Move an invitation to a terminal state, only while it is pending. 1 row (state is not indexed). */
export function setInvitationState(db: D1Database, orgId: string, id: string, state: InvitationRow["state"]): Write {
  return { rows: 1, stmt: db.prepare("UPDATE org_invitations SET state = ? WHERE org_id = ? AND id = ? AND state = 'pending'").bind(state, orgId, id) };
}

export function insertTeam(db: D1Database, team: { orgId: string; id: string; name: string; description: string; visibility: TeamRow["visibility"]; parent: string; t: number }): Write {
  return {
    rows: 1,
    stmt: db
      .prepare("INSERT INTO teams (org_id, id, name, description, visibility, parent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(team.orgId, team.id, team.name, team.description, team.visibility, team.parent, Math.floor(team.t)),
  };
}

export function upsertTeamMember(db: D1Database, m: { orgId: string; teamId: string; userId: string; teamRole: TeamMemberRow["team_role"]; t: number }): Write {
  return {
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO team_members (org_id, team_id, user_id, team_role, added_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT (org_id, team_id, user_id) DO UPDATE SET team_role = excluded.team_role",
      )
      .bind(m.orgId, m.teamId, m.userId, m.teamRole, Math.floor(m.t)),
  };
}

export function deleteTeamMember(db: D1Database, orgId: string, teamId: string, userId: string): Write {
  return { rows: 1, stmt: db.prepare("DELETE FROM team_members WHERE org_id = ? AND team_id = ? AND user_id = ?").bind(orgId, teamId, userId) };
}

/** An update of the organization's own row. `touchesHandle` is true when the handle changes (the one
 *  index is then written too). The caller builds the SET from a patch and gives the values. */
export function updateOrg(db: D1Database, id: string, sets: string[], values: unknown[], touchesHandle: boolean, t: number): Write {
  return {
    rows: touchesHandle ? 2 : 1,
    stmt: db.prepare(`UPDATE organizations SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`).bind(...values, Math.floor(t), id),
  };
}

// ─── the audit log and the security log ───────────────────────────────────────

/** One org-audit row, written in the same batch as its action row. 1 row (no index). */
export function auditWrite(
  db: D1Database,
  a: { orgId: string; at: number; nonce: string; actor: string; event: string; target?: string; detail?: Record<string, unknown> },
): Write {
  return {
    rows: 1,
    stmt: db
      .prepare("INSERT INTO org_audit (org_id, at, nonce, actor, event, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(a.orgId, Math.floor(a.at), a.nonce, (a.actor ?? "").slice(0, 100), a.event.slice(0, 60), (a.target ?? "").slice(0, 200), JSON.stringify(a.detail ?? {}).slice(0, 2000)),
  };
}

/** One personal-security-log row. 1 row (no index). */
export function securityLogWrite(
  db: D1Database,
  a: { userId: string; at: number; nonce: string; event: string; detail?: Record<string, unknown> },
): Write {
  return {
    rows: 1,
    stmt: db
      .prepare("INSERT INTO security_log (user_id, at, nonce, event, detail) VALUES (?, ?, ?, ?, ?)")
      .bind(a.userId, Math.floor(a.at), a.nonce, a.event.slice(0, 60), JSON.stringify(a.detail ?? {}).slice(0, 1000)),
  };
}

export function auditOf(db: D1Database, orgId: string, opts: { since?: number; event?: string; actor?: string; limit?: number } = {}): D1PreparedStatement {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 100), 1), 1000);
  const where = ["org_id = ?"];
  const values: unknown[] = [orgId];
  if (opts.since) {
    where.push("at >= ?");
    values.push(Math.floor(opts.since));
  }
  if (opts.event) {
    where.push("event = ?");
    values.push(opts.event);
  }
  if (opts.actor) {
    where.push("actor = ?");
    values.push(opts.actor);
  }
  values.push(limit);
  return db.prepare(`SELECT org_id, at, nonce, actor, event, target, detail FROM org_audit WHERE ${where.join(" AND ")} ORDER BY at DESC LIMIT ?`).bind(...values);
}

export function securityLogOf(db: D1Database, userId: string, limit = 100): D1PreparedStatement {
  return db.prepare("SELECT user_id, at, nonce, event, detail FROM security_log WHERE user_id = ? ORDER BY at DESC LIMIT ?").bind(userId, Math.min(Math.max(limit, 1), 500));
}

// ─── permissions ────────────────────────────────────────────────────────────

export const isOwner = (m: MemberRow | null): boolean => m?.role === "owner";
export const canManage = (m: MemberRow | null): boolean => m?.role === "owner";
export const canModerate = (m: MemberRow | null): boolean => m?.role === "owner" || m?.role === "moderator";
export const isMember = (m: MemberRow | null): boolean => m !== null;

/** A member's research permissions, as a clean list. */
export function permsOf(m: MemberRow | null): ResearchPerm[] {
  if (!m) return [];
  try {
    const list = JSON.parse(m.perms) as unknown;
    return Array.isArray(list) ? list.filter((p): p is ResearchPerm => (RESEARCH_PERMS as readonly string[]).includes(p as string)) : [];
  } catch {
    return [];
  }
}

/** Only known research permissions, de-duplicated, order kept. */
export function cleanPerms(value: unknown): ResearchPerm[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: ResearchPerm[] = [];
  for (const p of value) if (typeof p === "string" && (RESEARCH_PERMS as readonly string[]).includes(p) && !seen.has(p)) {
    seen.add(p);
    out.push(p as ResearchPerm);
  }
  return out;
}

/** The day of a time, for the caller's convenience. */
export const dayOf = (t: number): number => utcDay(t);
