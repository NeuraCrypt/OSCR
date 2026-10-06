// The audit log of an organization, and its security overview (night phase 09, E3;
// docs/ORGANIZATIONS.md). The audit is phase 01's action log, per organization: one row per
// org-scoped write (org_audit), read as a key range (org_id), newest first, with filters (event,
// actor, since) and a text search over the target, and an export as JSON or CSV. Owners and
// moderators only: an organization's inner history is not public.
//
//   GET /api/forge/org/audit     an owner/moderator  {id, event?, actor?, since?, q?, format?}
//   GET /api/forge/org/security  an owner/moderator  {id}: phase 11's alerts over its pinned repositories
//
// A read only: no write, no GitHub call. Every read is a key or a key range (the plan's "never a
// scan"); a text search filters within the organization's key range, it does not scan the table.

import { signedIn, type SignedIn } from "../../account/guard.ts";
import { userById } from "../../account/store.ts";
import { json, problemAnswer } from "./http.ts";
import { auditOf, canModerate, memberOf, orgById, type MemberRow, type OrgRow } from "./org-core.ts";
import { alertsOf, all, first, triageOf } from "./store.ts";
import { ForgeProblem, type D1Database, type ForgeRequest } from "./types.ts";

interface AuditRow {
  org_id: string;
  at: number;
  nonce: string;
  actor: string;
  event: string;
  target: string;
  detail: string;
}

async function manager(r: ForgeRequest): Promise<{ s: SignedIn; o: OrgRow; me: MemberRow } | Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: false, touch: false });
  if (s instanceof Response) return s;
  const o = await first<OrgRow>(orgById(r.db, r.url.searchParams.get("id") ?? ""));
  if (!o || o.state === "deleted") return problemAnswer(new ForgeProblem(404, "not_found", "No such organization."), s.cookies);
  const me = await first<MemberRow>(memberOf(r.db, o.id, s.user.id));
  if (!canModerate(me)) return problemAnswer(new ForgeProblem(403, "manager_only", "The audit log is read by an owner or a moderator of the organization."), s.cookies);
  return { s, o, me: me! };
}

async function handleOf(community: D1Database, userId: string): Promise<string> {
  const u = await userById(community, userId);
  return (u?.display_name || u?.orcid || u?.github_login || "a member").slice(0, 100);
}

export async function handleAuditRead(r: ForgeRequest): Promise<Response> {
  const got = await manager(r);
  if (got instanceof Response) return got;
  const { s, o } = got;
  const q = r.url.searchParams;
  const since = Number(q.get("since") ?? "");
  const event = q.get("event") ?? undefined;
  const actorHandle = q.get("actor") ?? "";
  const search = (q.get("q") ?? "").trim().slice(0, 100);
  const limit = Math.min(Math.max(Number(q.get("limit") ?? 200) || 200, 1), 1000);

  // The filter on actor is by handle: resolve it to the organization's member whose handle matches
  // (a small set, the member list), so the audit reads by the user id it stores.
  let actorId: string | undefined;
  if (actorHandle) {
    const members = await all<MemberRow>(r.db.prepare("SELECT org_id, user_id, role, private, perms, added_by, joined_at FROM org_members WHERE org_id = ? LIMIT 1000").bind(o.id));
    for (const m of members) if ((await handleOf(s.db, m.user_id)).toLowerCase() === actorHandle.toLowerCase()) actorId = m.user_id;
    if (!actorId) actorId = "__none__"; // an actor nobody matches: an empty page, never the whole log.
  }

  let rows = await all<AuditRow>(auditOf(r.db, o.id, { since: Number.isFinite(since) && since > 0 ? since : undefined, event, actor: actorId, limit }));
  if (search) {
    const low = search.toLowerCase();
    rows = rows.filter((row) => row.target.toLowerCase().includes(low) || row.event.toLowerCase().includes(low));
  }
  const view = await Promise.all(
    rows.map(async (row) => ({ at: row.at, event: row.event, actor: await handleOf(s.db, row.actor), target: row.target, detail: safeParse(row.detail) })),
  );

  if (q.get("format") === "csv") {
    const lines = ["at,event,actor,target,detail"];
    for (const row of view) lines.push([row.at, row.event, csv(row.actor), csv(row.target), csv(JSON.stringify(row.detail))].join(","));
    const res = new Response(lines.join("\n") + "\n", { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${o.handle}-audit.csv"` } });
    for (const c of s.cookies) res.headers.append("Set-Cookie", c);
    return res;
  }

  return json({ org: { id: o.id, handle: o.handle }, events: view, count: view.length }, 200, s.cookies);
}

function csv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

interface AlertRow {
  kind: string;
  ref: string;
  severity: string;
}
interface TriageRow {
  kind: string;
  ref: string;
  state: string;
}

/** The security overview: phase 11's open alerts over the organization's pinned repositories (a key
 *  range of security_alerts per repository), grouped by severity. The pinned ids are read on the forge
 *  named by ?forge= (default github). A repository with none shows zero; a soft cap of 50 repositories
 *  keeps the read within the budget. */
export async function handleOrgSecurity(r: ForgeRequest): Promise<Response> {
  const got = await manager(r);
  if (got instanceof Response) return got;
  const { s, o } = got;
  const forge = r.url.searchParams.get("forge") === "memory" ? "memory" : "github";
  let pinned: string[] = [];
  try {
    const p = JSON.parse(o.pinned) as unknown;
    if (Array.isArray(p)) pinned = p.filter((x): x is string => typeof x === "string" && /^\d+$/.test(x)).slice(0, 50);
  } catch {
    pinned = [];
  }
  const severities = ["critical", "high", "moderate", "low", "unknown"] as const;
  const totals: Record<string, number> = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0, open: 0, dismissed: 0 };
  const repos: { repoId: string; open: number; bySeverity: Record<string, number> }[] = [];
  for (const repoId of pinned) {
    const alerts = await all<AlertRow>(alertsOf(r.db, forge, repoId));
    const triage = await all<TriageRow>(triageOf(r.db, forge, repoId));
    const dismissed = new Set(triage.filter((t) => t.state === "dismissed").map((t) => `${t.kind}:${t.ref}`));
    const bySeverity: Record<string, number> = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
    let open = 0;
    for (const a of alerts) {
      if (dismissed.has(`${a.kind}:${a.ref}`)) {
        totals.dismissed += 1;
        continue;
      }
      open += 1;
      const sev = (severities as readonly string[]).includes(a.severity) ? a.severity : "unknown";
      bySeverity[sev] += 1;
      totals[sev] += 1;
      totals.open += 1;
    }
    repos.push({ repoId, open, bySeverity });
  }
  return json(
    {
      org: { id: o.id, handle: o.handle },
      pinnedCount: pinned.length,
      totals,
      repos,
      note: pinned.length ? "Over the organization's pinned repositories." : "Pin repositories to see their security alerts here.",
    },
    200,
    s.cookies,
  );
}
