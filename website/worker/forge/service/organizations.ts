// Organizations in OSCR (night phase 09, E1; docs/ORGANIZATIONS.md). An organization is OSCR's own
// layer over a lab, a group or a project: its profile, settings, pinned repositories, a verified
// domain and an announcement banner. A lab's GitHub organization is LINKED, not replaced: git rights
// on its repositories stay GitHub's, and nothing here ever asks GitHub for a write.
//
//   GET  /api/forge/orgs          signed in  the reader's organizations and pending invitations
//   GET  /api/forge/org           signed in  one organization (?handle= or ?id=): its profile, the
//                                            member list (private membership refused to non-members),
//                                            the members-only README to members only
//   POST /api/forge/org/create    signed in  a new organization, the creator its owner (5 rows)
//   POST /api/forge/org/update    an owner   settings, rename, archive, unarchive, delete, the banner,
//                                            a domain claim
//
// Every write is behind FORGE_OPEN (gate.ts: until phase 16, the owner of the registry only), counted
// against the account's `orgs` cap and the day's rows, and logged in the audit (org_audit) and the
// action log in one batch. The members-only README and a private member list are never put in a
// public output: a read is refused to non-members here, and no static shard carries them (deferred;
// a future shard applies the same filter, D09).

import { signedIn } from "../../account/guard.ts";
import { userById } from "../../account/store.ts";
import { commitAutomation, mayAutomate, readJsonBody } from "./automation.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import {
  auditWrite,
  canManage,
  cleanPerms,
  insertOrg,
  invitationsOf,
  isMember,
  memberOf,
  membersOf,
  newOrgId,
  ORG_BODY_BYTES,
  orgByHandle,
  orgById,
  orgsOfUser,
  PERM_WORDS,
  permsOf,
  RESEARCH_PERMS,
  teamsOf,
  updateOrg,
  upsertMember,
  validateCreate,
  validateHandle,
  validatePatch,
  type InvitationRow,
  type MemberRow,
  type OrgRow,
  type TeamRow,
} from "./org-core.ts";
import { all, first, newNonce } from "./store.ts";
import { ForgeProblem, type D1Database, type ForgeRequest, type Write } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);

/** A display name for a handle shown on a member row: the account's display name, else its handle. */
async function nameOf(community: D1Database, userId: string): Promise<string> {
  const u = await userById(community, userId);
  return (u?.display_name || u?.orcid || u?.github_login || "a member").slice(0, 100);
}

/** The public view of an organization (never a private field). */
function orgView(o: OrgRow) {
  let pinned: string[] = [];
  try {
    const p = JSON.parse(o.pinned) as unknown;
    if (Array.isArray(p)) pinned = p.filter((x): x is string => typeof x === "string");
  } catch {
    pinned = [];
  }
  return {
    id: o.id,
    handle: o.handle,
    displayName: o.display_name,
    kind: o.kind,
    ror: o.ror,
    bio: o.bio,
    readme: o.readme_public,
    picture: o.picture,
    banner: o.banner,
    pinned,
    domain: o.domain,
    domainVerified: o.domain_verified === 1,
    membersPrivate: o.members_private === 1,
    state: o.state,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

export async function handleOrgsMine(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: false, touch: false });
  if (s instanceof Response) return s;
  const mine = await all<MemberRow>(orgsOfUser(r.db, s.user.id));
  const orgs: ReturnType<typeof orgView>[] = [];
  for (const m of mine) {
    const o = await first<OrgRow>(orgById(r.db, m.org_id));
    if (o && o.state !== "deleted") orgs.push({ ...orgView(o), ...{ myRole: m.role } } as ReturnType<typeof orgView>);
  }
  const invites = await all<InvitationRow>(r.db.prepare("SELECT * FROM org_invitations WHERE invitee = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 100").bind(s.user.id));
  const invitations = [] as { orgId: string; id: string; handle: string; role: string; expiresAt: number; expired: boolean }[];
  for (const inv of invites) {
    const o = await first<OrgRow>(orgById(r.db, inv.org_id));
    if (o && o.state === "active") invitations.push({ orgId: inv.org_id, id: inv.id, handle: o.handle, role: inv.role, expiresAt: inv.expires_at, expired: inv.expires_at <= r.t });
  }
  return json({ organizations: orgs, invitations, can: { create: mayCreate(r.env, await linkedGithub(s.db, s.user.id)) } }, 200, s.cookies);
}

function mayCreate(env: ForgeRequest["env"], github: string | null): boolean {
  // The same gate as a write, read-only (gate.ts mayWrite): the button is shown only when a create
  // would be taken.
  const owner = (env.FORGE_OWNER_GITHUB_ID ?? "").trim();
  const open = (env.FORGE_OPEN ?? "").trim() === "true" && typeof env.TURNSTILE_SECRET_KEY === "string" && env.TURNSTILE_SECRET_KEY.length > 0;
  return open || (/^\d{1,20}$/.test(owner) && github === owner);
}

export async function handleOrgRead(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: false, touch: false });
  if (s instanceof Response) return s;
  const handle = r.url.searchParams.get("handle");
  const id = r.url.searchParams.get("id");
  const o = handle ? await first<OrgRow>(orgByHandle(r.db, handle)) : id ? await first<OrgRow>(orgById(r.db, id)) : null;
  if (!o || o.state === "deleted") return problemAnswer(new ForgeProblem(404, "not_found", "No such organization."), s.cookies);
  const me = await first<MemberRow>(memberOf(r.db, o.id, s.user.id));
  const viewerIsMember = isMember(me);

  // The members-only README and a private member list, to members only.
  const view = orgView(o);
  const readmeMembers = viewerIsMember ? o.readme_members : "";

  const rows = await all<MemberRow>(membersOf(r.db, o.id));
  let members: { handle: string; role: string; perms: string[]; private: boolean }[] = [];
  if (viewerIsMember) {
    members = await Promise.all(rows.map(async (m) => ({ handle: await nameOf(s.db, m.user_id), role: m.role, perms: permsOf(m), private: m.private === 1 })));
  } else if (!o.members_private) {
    const shown = rows.filter((m) => m.private === 0);
    members = await Promise.all(shown.map(async (m) => ({ handle: await nameOf(s.db, m.user_id), role: m.role, perms: permsOf(m), private: false })));
  } // else: private membership, no list to a non-member.

  const teamRows = await all<TeamRow>(teamsOf(r.db, o.id));
  const teams = teamRows
    .filter((tm) => viewerIsMember || (!o.members_private && tm.visibility === "visible"))
    .map((tm) => ({ id: tm.id, name: tm.name, description: tm.description, visibility: tm.visibility, parent: tm.parent }));

  // The pending invitations, to an owner only.
  const invitations = canManage(me) ? await all<InvitationRow>(invitationsOf(r.db, o.id)) : [];

  return json(
    {
      org: { ...view, readmeMembers },
      viewer: {
        member: me ? { role: me.role, perms: permsOf(me), private: me.private === 1 } : null,
        can: { manage: canManage(me), moderate: me?.role === "owner" || me?.role === "moderator" },
      },
      // The domain proof (the DNS TXT value to publish) is shown to an owner only.
      manage: canManage(me) ? { domainProof: o.domain_proof } : null,
      memberCount: rows.length,
      members,
      membersHidden: !viewerIsMember && o.members_private === 1,
      teams,
      invitations: invitations.filter((inv) => inv.state === "pending").map((inv) => ({ id: inv.id, invitee: inv.invitee, role: inv.role, expiresAt: inv.expires_at, expired: inv.expires_at <= r.t })),
      permsCatalog: RESEARCH_PERMS.map((p) => ({ id: p, words: PERM_WORDS[p] })),
    },
    200,
    s.cookies,
  );
}

export async function handleOrgCreate(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readJsonBody(r, ORG_BODY_BYTES);
  if (body instanceof ForgeProblem) return say(body);
  const parsed = validateCreate(body);
  if (parsed instanceof ForgeProblem) return say(parsed);
  // The handle must be free (a deleted organization keeps its handle, so it is not reused).
  const taken = await first<{ id: string }>(r.db.prepare("SELECT id FROM organizations WHERE handle = ?").bind(parsed.handle));
  if (taken) return say(new ForgeProblem(409, "handle_taken", "This handle is already an organization's: choose another."));
  const gate = await mayAutomate(r, s, "org", 5);
  if (gate instanceof ForgeProblem) return say(gate);
  const id = newOrgId();
  const nonce = newNonce();
  const writes: Write[] = [
    insertOrg(r.db, parsed, id, s.user.id, r.t),
    upsertMember(r.db, { orgId: id, userId: s.user.id, role: "owner", perms: [], private: false, addedBy: s.user.id, t: r.t }),
    auditWrite(r.db, { orgId: id, at: r.t, nonce, actor: s.user.id, event: "org.create", target: parsed.handle, detail: { kind: parsed.kind } }),
  ];
  const written = await commitAutomation(r, s, "org", gate.github, writes, `org:${id}`);
  const o = await first<OrgRow>(orgById(r.db, id));
  return json({ ok: true, written, org: o ? orgView(o) : null }, 201, s.cookies);
}

/** POST /api/forge/org/update: the owner's lifecycle and profile writes. */
export async function handleOrgUpdate(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = (await readJsonBody(r, ORG_BODY_BYTES)) as Record<string, unknown> | ForgeProblem;
  if (body instanceof ForgeProblem) return say(body);
  const id = typeof body.id === "string" ? body.id : "";
  const op = typeof body.op === "string" ? body.op : "";
  const o = await first<OrgRow>(orgById(r.db, id));
  if (!o || o.state === "deleted") return say(new ForgeProblem(404, "not_found", "No such organization."));
  const me = await first<MemberRow>(memberOf(r.db, o.id, s.user.id));
  if (!canManage(me)) return say(new ForgeProblem(403, "owner_only", "Only an owner of the organization changes it."));

  const gate = await mayAutomate(r, s, "org", 3);
  if (gate instanceof ForgeProblem) return say(gate);
  const nonce = newNonce();
  let write: Write;
  let event: string;
  let target = o.handle;
  let detail: Record<string, unknown> = {};

  if (op === "settings") {
    const patch = validatePatch(body.patch);
    if (patch instanceof ForgeProblem) return say(patch);
    const sets: string[] = [];
    const values: unknown[] = [];
    const col = (name: string, value: unknown) => {
      sets.push(`${name} = ?`);
      values.push(value);
    };
    if (patch.display_name !== undefined) col("display_name", patch.display_name);
    if (patch.kind !== undefined) col("kind", patch.kind);
    if (patch.ror !== undefined) col("ror", patch.ror);
    if (patch.bio !== undefined) col("bio", patch.bio);
    if (patch.readme_public !== undefined) col("readme_public", patch.readme_public);
    if (patch.readme_members !== undefined) col("readme_members", patch.readme_members);
    if (patch.picture !== undefined) col("picture", patch.picture);
    if (patch.banner !== undefined) col("banner", patch.banner);
    if (patch.members_private !== undefined) col("members_private", patch.members_private ? 1 : 0);
    if (patch.pinned !== undefined) col("pinned", JSON.stringify(patch.pinned));
    if (!sets.length) return say(bad("Nothing to change."));
    write = updateOrg(r.db, o.id, sets, values, false, r.t);
    event = "org.settings";
    detail = { fields: sets.map((x) => x.split(" ")[0]) };
  } else if (op === "rename") {
    const handle = validateHandle(body.handle);
    if (handle instanceof ForgeProblem) return say(handle);
    if (handle !== o.handle) {
      const taken = await first<{ id: string }>(r.db.prepare("SELECT id FROM organizations WHERE handle = ?").bind(handle));
      if (taken) return say(new ForgeProblem(409, "handle_taken", "This handle is already an organization's: choose another."));
    }
    write = updateOrg(r.db, o.id, ["handle = ?"], [handle], handle !== o.handle, r.t);
    event = "org.rename";
    target = handle;
    detail = { from: o.handle, to: handle };
  } else if (op === "archive" || op === "unarchive") {
    const state = op === "archive" ? "archived" : "active";
    write = updateOrg(r.db, o.id, ["state = ?"], [state], false, r.t);
    event = `org.${op}`;
  } else if (op === "delete") {
    // A soft delete: the row is kept (so the handle is not reused) but the organization has no page.
    write = updateOrg(r.db, o.id, ["state = ?"], ["deleted"], false, r.t);
    event = "org.delete";
  } else if (op === "banner") {
    const banner = typeof body.banner === "string" ? body.banner.replace(/@/g, "").trim().slice(0, 500) : "";
    write = updateOrg(r.db, o.id, ["banner = ?"], [banner], false, r.t);
    event = banner ? "org.banner" : "org.banner_clear";
  } else if (op === "domain") {
    // A domain CLAIM only: OSCR records the domain and a verification token to publish as a DNS TXT
    // record; the actual DNS check runs on the Mac (it has the network), never from the Worker (zero
    // cost, no outside call). Until it is confirmed, domain_verified stays 0 (shown "pending").
    const domain = typeof body.domain === "string" ? body.domain.toLowerCase().replace(/@/g, "").trim().slice(0, 253) : "";
    if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return say(bad("A domain looks like lab.example.org, or leave it empty to remove a claim."));
    const proof = domain ? `oscr-domain-verify=${newNonce()}` : "";
    write = updateOrg(r.db, o.id, ["domain = ?", "domain_proof = ?", "domain_verified = ?"], [domain, proof, 0], false, r.t);
    event = domain ? "org.domain_claim" : "org.domain_clear";
    detail = domain ? { domain } : {};
  } else {
    return say(bad("Say what to do: settings, rename, archive, unarchive, delete, banner or domain."));
  }

  const written = await commitAutomation(r, s, "org", gate.github, [write, auditWrite(r.db, { orgId: o.id, at: r.t, nonce, actor: s.user.id, event, target, detail })], `org:${o.id}`);
  const after = await first<OrgRow>(orgById(r.db, o.id));
  return json({ ok: true, written, event, org: after && after.state !== "deleted" ? orgView(after) : null }, 200, s.cookies);
}

// Re-exported for members.ts (shared validation of research permissions on an invitation/role).
export { cleanPerms };
