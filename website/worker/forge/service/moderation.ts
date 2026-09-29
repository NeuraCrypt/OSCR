// Reports, the owner's moderation queue, appeals (night phase 16, E1). The pure part is
// moderation-core.ts; what the reads drop, hidden.ts. The contract: docs/MODERATION.md.
//
//   POST /api/forge/report             anyone    a report, with or without an account, behind Turnstile
//                                                (3 rows: the report, its open entry, the action row)
//   GET  /api/forge/moderation         the owner the queue: open reports, open appeals, open data-rights
//                                                requests; ?target= one thing's moderation row
//   POST /api/forge/moderation         the owner a decision: dismiss a report, hide, restore, answer an
//                                                appeal (2–6 rows, and a suspended account's tokens and hooks)
//   POST /api/forge/appeal             signed in the person whose thing was hidden appeals, or answers a
//                                                copyright takedown with a counter-notice (Turnstile; 3 rows)
//   GET  /api/forge/moderation/mine    signed in what of theirs is hidden, and their data-rights requests
//
// Who moderates: the owner, the account whose linked GitHub id is FORGE_OWNER_GITHUB_ID (moderators by
// role come later: D16-4). Reports and appeals are open whatever FORGE_OPEN says: the registry's pages
// are public, so is the way to report them. A suspended account may still appeal and read its page.

import { signedIn, type SignedIn } from "../../account/guard.ts";
import { sessionValue } from "../../account/session.ts";
import { identityOwner, userById } from "../../account/store.ts";
import { dailyCaps, globalCap, overCap } from "./gate.ts";
import { readCapped } from "./flow.ts";
import { hiddenOne, moderationRow, moderationView, type HiddenRow } from "./hidden.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import {
  ANONYMOUS_REPORTS_DAY,
  defaultNotice,
  KIND_WORDS,
  keyOf,
  listOfTarget,
  MODERATION_BODY_BYTES,
  personOfTarget,
  QUEUE_MAX,
  readTarget,
  REASON_WORDS,
  researchOfTarget,
  validateAppeal,
  validateDecision,
  validateReport,
  type HiddenKind,
  type HideReason,
  type Target,
} from "./moderation-core.ts";
import { issueById } from "./research-core.ts";
import { tokensOf } from "./tokens-core.ts";
import { checkTurnstile, requireHuman } from "./turnstile.ts";
import { utcDay } from "./caps.ts";
import { who } from "./who.ts";
import { actionRow, all, first, newNonce, repoByKey, rowsOf, statements } from "./store.ts";
import { ForgeProblem, type D1Database, type ForgeRequest, type RepoRow, type Write } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
/** How far back the queue reads open reports and appeals (a year: older ones are the owner's to find
 *  with `oscr forge moderation`). */
const QUEUE_DAYS = 366;

/** Whether this account is the registry's owner (its linked GitHub id is FORGE_OWNER_GITHUB_ID). */
export async function isOwner(r: ForgeRequest, s: SignedIn): Promise<boolean> {
  const owner = (r.env.FORGE_OWNER_GITHUB_ID ?? "").trim();
  if (!/^\d{1,20}$/.test(owner)) return false;
  return (await linkedGithub(s.db, s.user.id)) === owner;
}

const ownerOnly = () => new ForgeProblem(403, "owner_only", "The moderation queue is the owner's: your account cannot read or decide it.");

/** A JSON body of at most MODERATION_BODY_BYTES. */
async function readBody(r: ForgeRequest): Promise<unknown | ForgeProblem> {
  if (!(r.request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return bad("The request is not JSON.");
  const text = await readCapped(r.request, MODERATION_BODY_BYTES);
  if (text === null) return new ForgeProblem(413, "too_large", "This is longer than a report may be.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return bad("The request is not readable.");
  }
}

/** The request comes from the registry's own pages (Origin, and Sec-Fetch-Site when sent): what a
 *  signed-out report can prove, besides Turnstile. */
function sameSite(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  return request.headers.get("Origin") === new URL(request.url).origin && (site === null || site === "same-origin");
}

// ─── targets ─────────────────────────────────────────────────────────────────

/** What a target is in the registry: the moderation row it is kept under, the words the queue shows,
 *  the person whose thing it is (users.id, '' when it is nobody's account: a GitHub issue's author). */
export interface Resolved {
  kind: HiddenKind;
  key: string;
  label: string;
  ownerUser: string;
  /** For a person: their linked GitHub numeric id (the `github` row hides their GitHub events). */
  github: string | null;
}

/** A target resolved against the registry's rows, or a problem (404: it is not there). One or two
 *  reads by key. `scope` "profile" names a person's profile rather than their account. */
export async function resolveTarget(r: ForgeRequest, community: D1Database, t: Target, scope: "account" | "profile" | null = null, label = ""): Promise<Resolved | ForgeProblem> {
  const missing = (what: string) => new ForgeProblem(404, "not_found", `The registry has no ${what} by that name.`);
  if (t.kind === "snippet") return new ForgeProblem(501, "not_built", "Snippets are not built yet: there is nothing to report.");
  if (t.kind === "person" || t.kind === "list") {
    const person = personOfTarget(t.kind === "list" ? listOfTarget(t.target)!.person : t.target)!;
    const userId = await identityOwner(community, person.provider, person.subject);
    const user = userId ? await userById(community, userId) : null;
    if (!user) return missing("account");
    const handle = user.github_login ?? user.orcid ?? (user.display_name || "a reader");
    if (t.kind === "list") {
      const list = await first<{ name: string }>(r.db.prepare("SELECT name FROM star_lists WHERE user_id = ? AND list_id = ?").bind(user.id, listOfTarget(t.target)!.listId));
      if (!list) return missing("star list");
      return { kind: "list", key: `${user.id}/${listOfTarget(t.target)!.listId}`, label: `${handle}'s list “${list.name}”`, ownerUser: user.id, github: null };
    }
    const github = person.provider === "github" ? person.subject : await linkedGithub(community, user.id);
    return { kind: scope === "profile" ? "profile" : "account", key: user.id, label: handle, ownerUser: user.id, github };
  }
  if (t.kind === "research" || t.kind === "comment") {
    const ref = researchOfTarget(t.target)!;
    const issue = await first<{ title: string; author_id: string }>(issueById(r.db, ref.id));
    if (!issue) return missing("research issue");
    if (ref.comment === null) return { kind: "research", key: String(ref.id), label: `research#${ref.id} “${issue.title}”`, ownerUser: issue.author_id, github: null };
    const c = await first<{ author_id: string; deleted: number }>(r.db.prepare("SELECT author_id, deleted FROM research_comments WHERE issue_id = ? AND n = ?").bind(ref.id, ref.comment));
    if (!c || c.deleted) return missing("comment");
    return { kind: "comment", key: `${ref.id}#${ref.comment}`, label: `comment ${ref.comment} on research#${ref.id} “${issue.title}”`, ownerUser: c.author_id, github: null };
  }
  // A repository, or something on one: the repository must be one the registry knows.
  const k = keyOf(t)!;
  const m = /^(?:repo|issue|pull|release|status):(github|memory):([0-9]+)/.exec(t.target)!;
  const repo = await first<RepoRow>(repoByKey(r.db, m[1], m[2]));
  if (!repo || !repo.name) return missing("repository");
  const path = `${repo.owner_login}/${repo.name}`;
  if (t.kind === "repo") return { kind: "repo", key: k.key, label: path, ownerUser: repo.linked_by, github: null };
  if (t.kind === "status") {
    const [, , , sha, context] = /^status:(github|memory):([0-9]+):([0-9a-f]+):(.+)$/s.exec(t.target)!;
    const st = await first<{ by_user: string }>(r.db.prepare("SELECT by_user FROM statuses WHERE forge = ? AND repo_id = ? AND sha = ? AND context = ?").bind(m[1], m[2], sha, context));
    if (!st) return missing("commit status");
    return { kind: "status", key: k.key, label: `the status “${context}” on ${path}@${sha.slice(0, 7)}`, ownerUser: st.by_user, github: null };
  }
  const what = t.target.slice(t.target.indexOf("#") + 1);
  const words = label || (t.kind === "release" ? `the release ${t.target.slice(t.target.indexOf("/") + 1)} of ${path}` : `${t.kind === "issue" ? "issue" : "pull request"} #${what} of ${path}`);
  return { kind: k.kind, key: k.key, label: words.slice(0, 200), ownerUser: "", github: null };
}

// ─── POST /api/forge/report ──────────────────────────────────────────────────

export async function handleReport(r: ForgeRequest): Promise<Response> {
  if (!sameSite(r.request)) return problemAnswer(new ForgeProblem(403, "bad_origin", "This request did not come from the registry's own pages."));
  // Signed in when a session comes with it (then its CSRF token too); otherwise without an account.
  let s: SignedIn | null = null;
  if (sessionValue(r.request)) {
    const got = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
    if (got instanceof Response) {
      if (got.status !== 401) return got;
    } else s = got;
  }
  const cookies = s?.cookies ?? [];
  const say = (p: ForgeProblem) => problemAnswer(p, cookies);
  const body = await readBody(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateReport(body);
  if (p instanceof ForgeProblem) return say(p);
  // Night phase 16 (E5): a copyright notice names its claimant, who is answered in the site: it needs an
  // account. A report of private information does not (the person concerned may not want one).
  if (p.reason === "copyright" && !s) {
    return say(new ForgeProblem(401, "sign_in_required", "A copyright notice needs an account, so that the owner can answer you in the site (never by email): sign in, then send it again."));
  }
  const human = await checkTurnstile(r.env, p.turnstile, r.deps.turnstileFetch);
  if (human) return say(human);
  const community = r.env.COMMUNITY;
  if (!community) return say(new ForgeProblem(503, "not_configured", "Accounts are not set up yet."));
  const resolved = await resolveTarget(r, community, p.target, null, p.label);
  if (resolved instanceof ForgeProblem) return say(resolved);
  const reporter = s?.user.id ?? "";
  // The caps: an account's own (20 a day); without an account, every such report together (50 a day).
  const caps = await dailyCaps(r.db, reporter, "report", r.t);
  if (s && caps.exceeded) return say(overCap(caps.exceeded));
  if (!s && caps.used.reports >= ANONYMOUS_REPORTS_DAY) {
    return say(new ForgeProblem(429, "too_many", "The registry has received as many reports without an account as it takes in a day: sign in to report, or come back tomorrow."));
  }
  const since = utcDay(r.t) - QUEUE_DAYS;
  if (s) {
    const again = await first(r.db.prepare("SELECT id FROM content_reports WHERE state = 'open' AND day >= ? AND target = ? AND reporter = ? LIMIT 1").bind(since, p.target.target, reporter));
    if (again) return say(new ForgeProblem(409, "already_reported", "You have already reported it: the owner will look at your report."));
  }
  const quota = await globalCap(r.db, r.t, 3);
  if (quota) return say(quota);
  const nonce = newNonce();
  const report: Write = {
    rows: 2,
    stmt: r.db
      .prepare("INSERT INTO content_reports (day, at, reporter, kind, target, label, reason, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(utcDay(r.t), Math.floor(r.t), reporter, p.target.kind, p.target.target, resolved.label.slice(0, 200), p.reason, p.details),
  };
  const github = s ? ((await linkedGithub(s.db, s.user.id)) ?? "") : "";
  const action = actionRow(r.db, { userId: reporter, t: r.t, nonce, kind: "report", githubUser: github, outcome: "done", rows: 1 + report.rows, subject: p.target.target });
  const out = await r.db.batch([report.stmt, action.stmt]);
  const id = Number(out[0]?.meta?.last_row_id ?? 0);
  return json({ id, sentence: `Thank you: your report of ${KIND_WORDS[p.target.kind]} (${REASON_WORDS[p.reason]}) is in the owner's queue.` }, 201, cookies);
}

// ─── the owner's queue ───────────────────────────────────────────────────────

interface ReportRow {
  id: number;
  at: number;
  reporter: string;
  kind: string;
  target: string;
  label: string;
  reason: HideReason;
  details: string;
}

/** A report as the queue shows it: never who made it, only whether they had an account. */
const reportView = (x: ReportRow) => ({
  id: x.id,
  at: x.at,
  kind: x.kind,
  target: x.target,
  label: x.label,
  reason: x.reason,
  words: REASON_WORDS[x.reason],
  details: x.details,
  signedIn: x.reporter !== "",
});

/** A moderation row as the owner reads it (never the person's account id). */
const rowView = (x: HiddenRow) => ({
  kind: x.kind,
  target: x.target,
  label: x.label,
  state: x.state,
  reason: x.reason,
  words: REASON_WORDS[x.reason],
  notice: x.notice,
  message: x.message,
  by: x.by_whom,
  appeal: x.appeal,
  appealKind: x.appeal_kind,
  appealText: x.appeal_text,
  appealAt: x.appeal_at,
  since: x.created_at,
  updated: x.updated_at,
});

export async function handleModerationRead(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  if (!(await isOwner(r, s))) return problemAnswer(ownerOnly());
  const since = utcDay(r.t) - QUEUE_DAYS;
  const target = r.url.searchParams.get("target");
  if (target !== null) {
    const t = readTarget(target);
    if (!t) return problemAnswer(bad("This is not a target the registry names."));
    const resolved = await resolveTarget(r, s.db, t, (r.url.searchParams.get("scope") as "profile" | null) === "profile" ? "profile" : null);
    if (resolved instanceof ForgeProblem) return problemAnswer(resolved);
    const row = await moderationRow(r.db, resolved.kind, resolved.key);
    return json({ target: t.target, label: resolved.label, moderation: row ? rowView(row) : null });
  }
  const [open, rights] = await Promise.all([
    all<ReportRow>(r.db.prepare("SELECT id, at, reporter, kind, target, label, reason, details FROM content_reports WHERE state = 'open' AND day >= ? ORDER BY day, id LIMIT ?").bind(since, 2 * QUEUE_MAX)),
    all<{ id: string; at: number; kind: string; details: string; user_id: string }>(
      r.db.prepare("SELECT id, at, kind, details, user_id FROM rights_requests WHERE state = 'open' AND at >= ? ORDER BY at LIMIT ?").bind(Math.floor(r.t) - QUEUE_DAYS * 86_400, QUEUE_MAX),
    ),
  ]);
  // Who asked, by their public handles (the owner's page only: the owner acts on the account); never the
  // account's id.
  const rightsView = [];
  for (const x of rights) {
    const u = await userById(s.db, x.user_id);
    rightsView.push({ id: x.id, at: x.at, kind: x.kind, details: x.details, who: u ? { github: u.github_login, orcid: u.orcid, name: u.display_name } : null });
  }
  // The appeals and counter-notices wait in the same queue; each is shown with the decision it answers.
  const isAppeal = (x: ReportRow) => (x.reason as string) === "appeal" || (x.reason as string) === "counter_notice";
  const reports = open.filter((x) => !isAppeal(x)).slice(0, QUEUE_MAX);
  const appeals = [];
  for (const x of open.filter(isAppeal).slice(0, QUEUE_MAX)) {
    const t = readTarget(x.target);
    const resolved = t ? await resolveTarget(r, s.db, t) : null;
    const row = resolved && !(resolved instanceof ForgeProblem) ? await moderationRow(r.db, resolved.kind, resolved.key) : null;
    appeals.push({ ...(row ? rowView(row) : { target: x.target, label: x.label }), report: x.id, appealKind: x.reason, appealText: x.details, appealAt: x.at });
  }
  return json({ reports: reports.map(reportView), appeals, rights: rightsView, owner: true });
}

/** The moderation row written (inserted, or made hidden again), as one statement: 2 rows (the row, its
 *  person's index entry). */
function hideWrite(r: ForgeRequest, x: Resolved, target: string, reason: HideReason, notice: string, message: string, report: number | null, by: "owner" | "registry"): Write {
  const t = Math.floor(r.t);
  return {
    rows: 2,
    stmt: r.db
      .prepare(
        "INSERT INTO moderation (kind, ref, target, label, state, reason, notice, message, owner_user, by_whom, report_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, 'hidden', ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (kind, ref) DO UPDATE SET state = 'hidden', reason = excluded.reason, notice = excluded.notice, message = excluded.message, " +
          "label = excluded.label, by_whom = excluded.by_whom, report_id = excluded.report_id, appeal = '', appeal_kind = '', appeal_text = '', " +
          "appeal_at = NULL, created_at = excluded.created_at, updated_at = excluded.updated_at",
      )
      .bind(x.kind, x.key, target, x.label.slice(0, 200), reason, notice, message, x.ownerUser, by, report, t, t),
  };
}

/** The open reports of a target closed with a decision (1 row each, 2 with the index entry). */
function closeReports(r: ForgeRequest, target: string, state: "actioned" | "dismissed", count: number): Write {
  return {
    rows: 2 * count,
    stmt: r.db
      .prepare("UPDATE content_reports SET state = ?, decided_at = ? WHERE state = 'open' AND day >= ? AND target = ?")
      .bind(state, Math.floor(r.t), utcDay(r.t) - QUEUE_DAYS, target),
  };
}

export async function handleModerationWrite(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  if (!(await isOwner(r, s))) return say(ownerOnly());
  const body = await readBody(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateDecision(body);
  if (p instanceof ForgeProblem) return say(p);
  const t = Math.floor(r.t);
  const writes: Write[] = [];
  let subject = "";
  let sentence = "";

  if (p.op === "dismiss") {
    const rep = await first<{ target: string; state: string }>(r.db.prepare("SELECT target, state FROM content_reports WHERE id = ?").bind(p.report));
    if (!rep) return say(new ForgeProblem(404, "not_found", "There is no report of this number."));
    if (rep.state !== "open") return json({ ok: true, unchanged: true }, 200, s.cookies);
    writes.push({ rows: 2, stmt: r.db.prepare("UPDATE content_reports SET state = 'dismissed', decided_at = ? WHERE id = ? AND state = 'open'").bind(t, p.report) });
    subject = rep.target;
    sentence = `Report ${p.report} dismissed: nothing was hidden.`;
  } else {
    const target = p.target!;
    const resolved = await resolveTarget(r, s.db, target, p.scope, p.label);
    if (resolved instanceof ForgeProblem) return say(resolved);
    if (resolved.ownerUser && resolved.ownerUser === s.user.id && resolved.kind === "account") return say(bad("The owner's own account cannot be suspended from here."));
    subject = target.target;
    const current = await moderationRow(r.db, resolved.kind, resolved.key);
    const open = await all<{ id: number }>(
      r.db.prepare("SELECT id FROM content_reports WHERE state = 'open' AND day >= ? AND target = ? LIMIT 200").bind(utcDay(r.t) - 366, target.target),
    );
    if (p.op === "hide") {
      const notice = p.notice || defaultNotice(resolved.kind, p.reason!);
      writes.push(hideWrite(r, resolved, target.target, p.reason!, notice, p.message, p.report, "owner"));
      if (open.length) writes.push(closeReports(r, target.target, "actioned", open.length));
      if (resolved.kind === "account") {
        // Its GitHub account's events (webhooks) hidden with it; its tokens revoked, its webhooks paused
        // (D10-14): a suspended account's automation stops at once.
        if (resolved.github) writes.push(hideWrite(r, { ...resolved, kind: "github", key: resolved.github }, target.target, p.reason!, notice, p.message, p.report, "owner"));
        const tokens = await all<{ id: string }>(tokensOf(r.db, resolved.key));
        if (tokens.length) writes.push({ rows: 2 * tokens.length, stmt: r.db.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(resolved.key) });
        const hooks = await all<{ id: string }>(r.db.prepare("SELECT id FROM hooks WHERE user_id = ? AND active = 1 LIMIT 100").bind(resolved.key));
        if (hooks.length) writes.push({ rows: hooks.length, stmt: r.db.prepare("UPDATE hooks SET active = 0, updated_at = ? WHERE user_id = ? AND active = 1").bind(t, resolved.key) });
      }
      sentence = `Hidden: ${resolved.label} (${REASON_WORDS[p.reason!]}).`;
    } else {
      if (!current || current.state !== "hidden") return say(new ForgeProblem(409, "not_hidden", "This is not hidden: there is nothing to restore or to appeal."));
      const restore = p.op === "restore" || p.appeal === "accepted";
      // Restoring while an appeal waits answers it; an appeal's answer is the owner's word.
      const appeal = p.op === "appeal" ? p.appeal! : restore && current.appeal === "open" ? "accepted" : current.appeal;
      if (p.op === "appeal" && current.appeal !== "open") return say(new ForgeProblem(409, "no_appeal", "No appeal of this decision is waiting."));
      const notice = restore ? `${current.notice} Restored on ${new Date(t * 1000).toISOString().slice(0, 10)}.`.slice(0, 1000) : current.notice;
      const set = (kind: HiddenKind, key: string, companion = false): Write => ({
        rows: !companion && appeal !== current.appeal ? 2 : 1,
        stmt: companion
          // The GitHub account's row follows its account's state; the appeal lives on the account's row.
          ? r.db.prepare("UPDATE moderation SET state = ?, notice = ?, updated_at = ? WHERE kind = ? AND ref = ?").bind(restore ? "restored" : "hidden", notice, t, kind, key)
          : r.db
              .prepare("UPDATE moderation SET state = ?, notice = ?, message = ?, appeal = ?, updated_at = ? WHERE kind = ? AND ref = ?")
              .bind(restore ? "restored" : "hidden", notice, p.message || current.message, appeal, t, kind, key),
      });
      writes.push(set(resolved.kind, resolved.key));
      if (resolved.kind === "account" && resolved.github && (await hiddenOne(r.db, "github", resolved.github))) writes.push(set("github", resolved.github, true));
      // Its open reports and its appeal leave the queue: restored, they are answered; an appeal rejected is
      // answered too, the reports that asked for it stay done.
      if (open.length && (restore || p.op === "appeal")) writes.push(closeReports(r, target.target, restore ? "actioned" : "dismissed", open.length));
      sentence = restore ? `Restored: ${resolved.label}.` : `The appeal is rejected: ${resolved.label} stays hidden.`;
    }
  }
  const quota = await globalCap(r.db, r.t, 1 + rowsOf(writes));
  if (quota) return say(quota);
  const github = (await linkedGithub(s.db, s.user.id)) ?? "";
  const action = actionRow(r.db, { userId: s.user.id, t: r.t, nonce: newNonce(), kind: "moderate", githubUser: github, outcome: "done", rows: 1 + rowsOf(writes), subject });
  await r.db.batch([...statements(writes), action.stmt]);
  return json({ ok: true, sentence }, 200, s.cookies);
}

// ─── appeals ─────────────────────────────────────────────────────────────────

export async function handleAppeal(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true, suspendedOk: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readBody(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateAppeal(body);
  if (p instanceof ForgeProblem) return say(p);
  // The human check when it is set up (signed in, an appeal is open even before: turnstile.ts).
  const human = await requireHuman(r, p.turnstile);
  if (human) return say(human);
  const scope = r.url.searchParams.get("scope") === "profile" || (body as { scope?: unknown }).scope === "profile" ? "profile" : null;
  const resolved = await resolveTarget(r, s.db, p.target, scope);
  if (resolved instanceof ForgeProblem) return say(resolved);
  const row = await moderationRow(r.db, resolved.kind, resolved.key);
  if (!row || row.state !== "hidden" || row.owner_user !== s.user.id) return say(new ForgeProblem(404, "not_found", "Nothing of yours is hidden by that name."));
  if (row.appeal === "open") return say(new ForgeProblem(409, "appeal_open", "Your appeal is waiting for the owner: you will read the answer on this page."));
  if (row.appeal === "rejected" || row.appeal === "accepted") return say(new ForgeProblem(409, "appeal_decided", "Your appeal of this decision was already answered."));
  if (p.kind === "counter_notice" && row.reason !== "copyright") return say(bad("A counter-notice answers a copyright takedown only: send an appeal."));
  const caps = await dailyCaps(r.db, s.user.id, "appeal", r.t);
  if (caps.exceeded) return say(overCap(caps.exceeded));
  const t = Math.floor(r.t);
  const writes: Write[] = [
    {
      rows: 1,
      stmt: r.db
        .prepare("UPDATE moderation SET appeal = 'open', appeal_kind = ?, appeal_text = ?, appeal_at = ?, updated_at = ? WHERE kind = ? AND ref = ? AND appeal = ''")
        .bind(p.kind, p.text, t, t, resolved.kind, resolved.key),
    },
    // Its place in the owner's queue: a row of the reports' queue, its reason the appeal's kind.
    {
      rows: 2,
      stmt: r.db
        .prepare("INSERT INTO content_reports (day, at, reporter, kind, target, label, reason, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(utcDay(r.t), t, s.user.id, p.target.kind, p.target.target, resolved.label.slice(0, 200), p.kind, p.text),
    },
  ];
  const quota = await globalCap(r.db, r.t, 1 + rowsOf(writes));
  if (quota) return say(quota);
  const github = (await linkedGithub(s.db, s.user.id)) ?? "";
  const action = actionRow(r.db, { userId: s.user.id, t: r.t, nonce: newNonce(), kind: "appeal", githubUser: github, outcome: "done", rows: 1 + rowsOf(writes), subject: p.target.target });
  await r.db.batch([...statements(writes), action.stmt]);
  return json({ ok: true, sentence: p.kind === "counter_notice" ? "Your counter-notice is sent: the owner reviews it, and restores the content unless its claimant goes further." : "Your appeal is sent: the owner reviews it, and you will read the answer on this page." }, 200, s.cookies);
}

/** GET /api/forge/moderation/mine: what of the reader's is hidden or was restored, and their
 *  data-rights requests with their answers. Two reads by index. */
export async function handleModerationMine(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const [rows, rights] = await Promise.all([
    all<HiddenRow>(r.db.prepare("SELECT * FROM moderation WHERE owner_user = ? AND owner_user != '' AND kind != 'github' ORDER BY updated_at DESC LIMIT 200").bind(s.user.id)),
    all<{ id: string; at: number; kind: string; details: string; state: string; answer: string; answered_at: number | null }>(
      r.db.prepare("SELECT id, at, kind, details, state, answer, answered_at FROM rights_requests WHERE user_id = ? ORDER BY at DESC LIMIT 50").bind(s.user.id),
    ),
  ]);
  return json({
    hidden: rows.map((x) => ({
      kind: x.kind,
      target: x.target,
      label: x.label,
      state: x.state,
      message: x.message,
      ...moderationView(x),
      appealKind: x.appeal_kind,
      canAppeal: x.state === "hidden" && x.appeal === "",
      counterNotice: x.state === "hidden" && x.appeal === "" && x.reason === "copyright",
    })),
    rights,
    suspended: rows.some((x) => x.kind === "account" && x.state === "hidden"),
  });
}
