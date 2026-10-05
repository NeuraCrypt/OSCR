// Membership, roles, research permissions and teams of an organization (night phase 09, E2;
// docs/ORGANIZATIONS.md). The owner invites, removes, reinstates, changes roles and research
// permissions, and makes teams; a member accepts or declines an invitation, sets their own visibility,
// and leaves. Research permissions (propose, flag or validate a tracing map, tie a release to a paper
// version) ride on a membership and are checked by the research routes on an org-owned repository.
//
//   POST /api/forge/org/members   signed in  {id, op, ...}: invite, revoke_invite, accept, decline,
//                                            remove, reinstate, set_role, set_perms, set_visibility, leave
//   POST /api/forge/org/teams     signed in  {id, op, ...}: create, member, remove_member, delete
//   GET  /api/forge/org?export=members&format=csv   a member the member list as CSV
//
// The owner's writes (invite, remove, roles, perms, reinstate, teams) are behind FORGE_OPEN and the
// manager's role; a person's own writes (accept, decline, set_visibility, leave) are not gated by
// FORGE_OPEN (you may always answer an invitation you received or leave), only by the caps and the
// day's rows. The last owner is protected: they cannot be removed, demoted or leave. Every write is
// logged in the audit and the action log in one batch.

import { signedIn } from "../../account/guard.ts";
import { identityOwner, userById } from "../../account/store.ts";
import { commitAutomation, mayAutomate, readJsonBody } from "./automation.ts";
import { dailyCaps, globalCap, overCap } from "./gate.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import {
  auditWrite,
  canManage,
  canModerate,
  cleanPerms,
  deleteMember,
  deleteTeamMember,
  insertInvitation,
  insertTeam,
  invitationById,
  isMember,
  memberOf,
  membersOf,
  newInviteId,
  ORG_BODY_BYTES,
  orgById,
  permsOf,
  setInvitationState,
  upsertMember,
  upsertTeamMember,
  type InvitationRow,
  type MemberRow,
  type OrgRole,
  type OrgRow,
} from "./org-core.ts";
import { all, first, newNonce, rowsOf, statements } from "./store.ts";
import { ForgeProblem, type D1Database, type ForgeRequest, type Write } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const notFound = () => new ForgeProblem(404, "not_found", "No such organization.");

/** How long an invitation stays open: 30 days (the default), 1 to 90 if asked. */
const INVITE_DAYS_DEFAULT = 30;

const ROLES: ReadonlySet<string> = new Set(["owner", "moderator", "member"]);

/** The person an invitation or a membership names, by their OSCR user id, their ORCID iD, or their
 *  GitHub numeric id (each a key lookup: never a scan). */
async function resolveUser(community: D1Database, body: Record<string, unknown>): Promise<string | ForgeProblem> {
  if (typeof body.userId === "string" && /^u_[A-Za-z0-9_-]{1,60}$/.test(body.userId)) {
    const u = await userById(community, body.userId);
    return u ? u.id : new ForgeProblem(404, "no_such_person", "No account with that id.");
  }
  if (typeof body.orcid === "string" && /^\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$/.test(body.orcid)) {
    const owner = await identityOwner(community, "orcid", body.orcid);
    return owner ?? new ForgeProblem(404, "no_such_person", "No account is signed in with that ORCID iD yet.");
  }
  if (typeof body.githubId === "string" && /^\d{1,20}$/.test(body.githubId)) {
    const owner = await identityOwner(community, "github", body.githubId);
    return owner ?? new ForgeProblem(404, "no_such_person", "No account is signed in with that GitHub account yet.");
  }
  return bad("Name the person: a userId, an orcid, or a githubId.");
}

/** How many owners the organization has (a key range over its members). */
function ownerCount(members: MemberRow[]): number {
  return members.filter((m) => m.role === "owner").length;
}

/** The leaving checklist: what removal or leaving changes, in plain words (shown before and after). */
function leavingChecklist(role: string): string[] {
  return [
    role === "owner" ? "You lose the owner role of this organization." : role === "moderator" ? "You lose the moderator role." : "You lose your membership.",
    "Your research permissions in this organization are removed.",
    "Teams of this organization no longer list you, and a private member list stops showing you.",
    "Your validated tracing maps and their DOIs stay yours: they belong to you and the paper, not to the organization.",
    "Repositories stay where they are on GitHub: git rights there are GitHub's, untouched.",
  ];
}

/** A person's own write (accept, decline, set_visibility, leave): the caps and the day's rows, not
 *  FORGE_OPEN (you may always answer an invitation or leave). Returns the linked GitHub id for the row. */
async function mayAnswer(r: ForgeRequest, userId: string, rows: number, community: D1Database): Promise<ForgeProblem | { github: string }> {
  const caps = await dailyCaps(r.db, userId, "member", r.t);
  if (caps.exceeded) return overCap(caps.exceeded);
  const quota = await globalCap(r.db, r.t, rows);
  if (quota) return quota;
  return { github: (await linkedGithub(community, userId)) ?? "" };
}

/** Commit the person's own write (no FORGE_OPEN): the writes, the audit and the action row, one batch. */
async function commitAnswer(r: ForgeRequest, userId: string, github: string, writes: Write[], subject: string): Promise<number> {
  const action = {
    rows: 1,
    stmt: r.db
      .prepare("INSERT INTO actions (day, user_id, at, nonce, kind, forge, repo_id, github_user, outcome, rows, subject) VALUES (?, ?, ?, ?, 'member', '', '', ?, 'done', ?, ?)")
      .bind(Math.floor(r.t / 86_400), userId, Math.floor(r.t), newNonce(), github, 1 + rowsOf(writes), subject.slice(0, 342)),
  };
  await r.db.batch([...statements(writes), action.stmt]);
  return 1 + rowsOf(writes);
}

export async function handleMembersWrite(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = (await readJsonBody(r, ORG_BODY_BYTES)) as Record<string, unknown> | ForgeProblem;
  if (body instanceof ForgeProblem) return say(body);
  const id = typeof body.id === "string" ? body.id : "";
  const op = typeof body.op === "string" ? body.op : "";
  const o = await first<OrgRow>(orgById(r.db, id));
  if (!o || o.state === "deleted") return say(notFound());
  const me = await first<MemberRow>(memberOf(r.db, o.id, s.user.id));
  const members = await all<MemberRow>(membersOf(r.db, o.id));

  // ── the person's own answers (not gated by FORGE_OPEN) ──────────────────────
  if (op === "accept" || op === "decline") {
    const inviteId = typeof body.inviteId === "string" ? body.inviteId : "";
    const inv = await first<InvitationRow>(invitationById(r.db, o.id, inviteId));
    if (!inv || inv.state !== "pending") return say(new ForgeProblem(404, "no_invitation", "No pending invitation of that name."));
    if (inv.invitee !== s.user.id) return say(new ForgeProblem(403, "not_yours", "This invitation is not addressed to you."));
    if (inv.expires_at <= r.t) {
      // Mark it expired, record nothing else.
      await setInvitationState(r.db, o.id, inviteId, "expired").stmt.run();
      return say(new ForgeProblem(410, "expired", "This invitation has expired: ask the organization to invite you again."));
    }
    const gate = await mayAnswer(r, s.user.id, op === "accept" ? 4 : 2, s.db);
    if (gate instanceof ForgeProblem) return say(gate);
    const nonce = newNonce();
    const writes: Write[] = [setInvitationState(r.db, o.id, inviteId, op === "accept" ? "accepted" : "declined")];
    if (op === "accept") {
      writes.push(upsertMember(r.db, { orgId: o.id, userId: s.user.id, role: inv.role, perms: cleanPerms(JSON.parse(inv.perms || "[]")), private: o.members_private === 1, addedBy: inv.invited_by, t: r.t }));
    }
    writes.push(auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: op === "accept" ? "member.join" : "invitation.decline", target: inv.role }));
    const written = await commitAnswer(r, s.user.id, gate.github, writes, `org:${o.id}`);
    return json({ ok: true, written, joined: op === "accept" }, 200, s.cookies);
  }

  if (op === "set_visibility") {
    if (!isMember(me)) return say(new ForgeProblem(403, "not_a_member", "Only a member sets their visibility in an organization."));
    const priv = body.private === true;
    const gate = await mayAnswer(r, s.user.id, 2, s.db);
    if (gate instanceof ForgeProblem) return say(gate);
    const nonce = newNonce();
    const writes: Write[] = [
      upsertMember(r.db, { orgId: o.id, userId: s.user.id, role: me!.role, perms: permsOf(me), private: priv, addedBy: me!.added_by, t: me!.joined_at }),
      auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: "member.visibility", detail: { private: priv } }),
    ];
    const written = await commitAnswer(r, s.user.id, gate.github, writes, `org:${o.id}`);
    return json({ ok: true, written, private: priv }, 200, s.cookies);
  }

  if (op === "leave") {
    if (!isMember(me)) return say(new ForgeProblem(404, "not_a_member", "You are not a member of this organization."));
    if (me!.role === "owner" && ownerCount(members) <= 1) return say(new ForgeProblem(409, "last_owner", "You are the only owner: name another owner first, then leave."));
    const gate = await mayAnswer(r, s.user.id, 2, s.db);
    if (gate instanceof ForgeProblem) return say(gate);
    const nonce = newNonce();
    const written = await commitAnswer(
      r,
      s.user.id,
      gate.github,
      [deleteMember(r.db, o.id, s.user.id), auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: "member.leave", target: me!.role })],
      `org:${o.id}`,
    );
    return json({ ok: true, written, checklist: leavingChecklist(me!.role) }, 200, s.cookies);
  }

  // ── the owner's and moderators' writes (FORGE_OPEN + role) ───────────────────
  const gate = await mayAutomate(r, s, "member", 5);
  if (gate instanceof ForgeProblem) return say(gate);
  const nonce = newNonce();

  if (op === "invite") {
    if (!canModerate(me)) return say(new ForgeProblem(403, "manager_only", "Only an owner or a moderator invites."));
    const invitee = await resolveUser(s.db, body);
    if (invitee instanceof ForgeProblem) return say(invitee);
    const role = ROLES.has(String(body.role)) ? (String(body.role) as OrgRole) : "member";
    if (role === "owner" && !canManage(me)) return say(new ForgeProblem(403, "owner_only", "Only an owner invites another owner."));
    const perms = cleanPerms(body.perms);
    const already = await first<MemberRow>(memberOf(r.db, o.id, invitee));
    if (already) return say(new ForgeProblem(409, "already_member", "That person is already a member."));
    const days = Number.isInteger(body.days) && (body.days as number) >= 1 && (body.days as number) <= 90 ? (body.days as number) : INVITE_DAYS_DEFAULT;
    const inviteId = newInviteId();
    const writes: Write[] = [
      insertInvitation(r.db, { orgId: o.id, id: inviteId, invitee, role, perms, invitedBy: s.user.id, t: r.t, expiresAt: r.t + days * 86_400 }),
      auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: "member.invite", target: role, detail: { days } }),
    ];
    const written = await commitAutomation(r, s, "member", gate.github, writes, `org:${o.id}`);
    return json({ ok: true, written, inviteId, expiresAt: r.t + days * 86_400 }, 201, s.cookies);
  }

  if (op === "revoke_invite") {
    if (!canModerate(me)) return say(new ForgeProblem(403, "manager_only", "Only an owner or a moderator revokes an invitation."));
    const inviteId = typeof body.inviteId === "string" ? body.inviteId : "";
    const inv = await first<InvitationRow>(invitationById(r.db, o.id, inviteId));
    if (!inv || inv.state !== "pending") return say(new ForgeProblem(404, "no_invitation", "No pending invitation of that name."));
    const written = await commitAutomation(r, s, "member", gate.github, [setInvitationState(r.db, o.id, inviteId, "revoked"), auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: "invitation.revoke" })], `org:${o.id}`);
    return json({ ok: true, written }, 200, s.cookies);
  }

  if (op === "remove" || op === "reinstate" || op === "set_role" || op === "set_perms") {
    if (!canManage(me)) return say(new ForgeProblem(403, "owner_only", "Only an owner changes a membership."));
    const userId = await resolveUser(s.db, body);
    if (userId instanceof ForgeProblem) return say(userId);
    const target = members.find((m) => m.user_id === userId) ?? null;

    if (op === "remove") {
      if (!target) return say(new ForgeProblem(404, "not_a_member", "That person is not a member."));
      if (target.role === "owner" && ownerCount(members) <= 1) return say(new ForgeProblem(409, "last_owner", "This is the only owner: name another owner first."));
      const written = await commitAutomation(r, s, "member", gate.github, [deleteMember(r.db, o.id, userId), auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: "member.remove", target: target.role })], `org:${o.id}`);
      return json({ ok: true, written, checklist: leavingChecklist(target.role) }, 200, s.cookies);
    }
    if (op === "reinstate") {
      if (target) return say(new ForgeProblem(409, "already_member", "That person is already a member."));
      const role = ROLES.has(String(body.role)) ? (String(body.role) as OrgRole) : "member";
      if (role === "owner") return say(new ForgeProblem(400, "bad_payload", "Reinstate as a member or a moderator; make an owner with set_role afterwards."));
      const written = await commitAutomation(r, s, "member", gate.github, [upsertMember(r.db, { orgId: o.id, userId, role, perms: cleanPerms(body.perms), private: o.members_private === 1, addedBy: s.user.id, t: r.t }), auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: "member.reinstate", target: role })], `org:${o.id}`);
      return json({ ok: true, written }, 201, s.cookies);
    }
    if (!target) return say(new ForgeProblem(404, "not_a_member", "That person is not a member."));
    if (op === "set_role") {
      const role = ROLES.has(String(body.role)) ? (String(body.role) as OrgRole) : null;
      if (!role) return say(bad("A role is owner, moderator or member."));
      if (target.role === "owner" && role !== "owner" && ownerCount(members) <= 1) return say(new ForgeProblem(409, "last_owner", "This is the only owner: name another owner first."));
      const written = await commitAutomation(r, s, "member", gate.github, [upsertMember(r.db, { orgId: o.id, userId, role, perms: permsOf(target), private: target.private === 1, addedBy: target.added_by, t: target.joined_at }), auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: "member.role", target: role })], `org:${o.id}`);
      return json({ ok: true, written, role }, 200, s.cookies);
    }
    // set_perms
    const perms = cleanPerms(body.perms);
    const written = await commitAutomation(r, s, "member", gate.github, [upsertMember(r.db, { orgId: o.id, userId, role: target.role, perms, private: target.private === 1, addedBy: target.added_by, t: target.joined_at }), auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: "member.perms", detail: { perms } })], `org:${o.id}`);
    return json({ ok: true, written, perms }, 200, s.cookies);
  }

  return say(bad("Say what to do: invite, revoke_invite, accept, decline, remove, reinstate, set_role, set_perms, set_visibility or leave."));
}

// ─── teams ────────────────────────────────────────────────────────────────────

const TEAM_ID = /^[a-z0-9-]{1,39}$/;

export async function handleTeamsWrite(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = (await readJsonBody(r, ORG_BODY_BYTES)) as Record<string, unknown> | ForgeProblem;
  if (body instanceof ForgeProblem) return say(body);
  const id = typeof body.id === "string" ? body.id : "";
  const op = typeof body.op === "string" ? body.op : "";
  const o = await first<OrgRow>(orgById(r.db, id));
  if (!o || o.state === "deleted") return say(notFound());
  const me = await first<MemberRow>(memberOf(r.db, o.id, s.user.id));
  if (!canModerate(me)) return say(new ForgeProblem(403, "manager_only", "Only an owner or a moderator changes teams."));
  const gate = await mayAutomate(r, s, "team", 3);
  if (gate instanceof ForgeProblem) return say(gate);
  const nonce = newNonce();
  const teamId = typeof body.teamId === "string" ? body.teamId.toLowerCase() : "";
  if (!TEAM_ID.test(teamId)) return say(bad("A team id is 1 to 39 letters, digits or hyphens."));

  if (op === "create") {
    const name = typeof body.name === "string" ? body.name.replace(/@/g, "").trim().slice(0, 100) : "";
    const description = typeof body.description === "string" ? body.description.replace(/@/g, "").trim().slice(0, 500) : "";
    const visibility = body.visibility === "secret" ? "secret" : "visible";
    const parent = typeof body.parent === "string" && TEAM_ID.test(body.parent.toLowerCase()) ? body.parent.toLowerCase() : "";
    const exists = await first<{ id: string }>(r.db.prepare("SELECT id FROM teams WHERE org_id = ? AND id = ?").bind(o.id, teamId));
    if (exists) return say(new ForgeProblem(409, "team_taken", "A team with that id already exists in this organization."));
    const written = await commitAutomation(r, s, "team", gate.github, [insertTeam(r.db, { orgId: o.id, id: teamId, name, description, visibility, parent, t: r.t }), auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: "team.create", target: teamId, detail: { visibility } })], `org:${o.id}`);
    return json({ ok: true, written, teamId }, 201, s.cookies);
  }
  if (op === "member" || op === "remove_member") {
    const team = await first<{ id: string }>(r.db.prepare("SELECT id FROM teams WHERE org_id = ? AND id = ?").bind(o.id, teamId));
    if (!team) return say(new ForgeProblem(404, "no_team", "No team of that id."));
    const userId = await resolveUser(s.db, body);
    if (userId instanceof ForgeProblem) return say(userId);
    const member = await first<MemberRow>(memberOf(r.db, o.id, userId));
    if (!member) return say(new ForgeProblem(409, "not_a_member", "A team's members are members of the organization: add them to it first."));
    if (op === "member") {
      const teamRole = body.teamRole === "maintainer" ? "maintainer" : "member";
      const written = await commitAutomation(r, s, "team", gate.github, [upsertTeamMember(r.db, { orgId: o.id, teamId, userId, teamRole, t: r.t }), auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: "team.member", target: teamId, detail: { teamRole } })], `org:${o.id}`);
      return json({ ok: true, written }, 200, s.cookies);
    }
    const written = await commitAutomation(r, s, "team", gate.github, [deleteTeamMember(r.db, o.id, teamId, userId), auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: "team.remove_member", target: teamId })], `org:${o.id}`);
    return json({ ok: true, written }, 200, s.cookies);
  }
  if (op === "delete") {
    const removed = await r.db.batch([
      r.db.prepare("DELETE FROM team_members WHERE org_id = ? AND team_id = ?").bind(o.id, teamId),
      r.db.prepare("DELETE FROM teams WHERE org_id = ? AND id = ?").bind(o.id, teamId),
    ]);
    if (!removed[1]?.meta?.changes) return say(new ForgeProblem(404, "no_team", "No team of that id."));
    await commitAutomation(r, s, "team", gate.github, [auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event: "team.delete", target: teamId })], `org:${o.id}`);
    return json({ ok: true }, 200, s.cookies);
  }
  return say(bad("Say what to do: create, member, remove_member or delete."));
}
