// The routes of research issues (night phase 05, E2): what research-core.ts describes, read and
// written for a signed-in reader. See research-core.ts for the whole contract.

import type { SignedIn } from "../../account/guard.ts";
import { who as whoAsks } from "./who.ts";
import { FORGE_ROWS_PER_DAY } from "./caps.ts";
import { readCapped } from "./flow.ts";
import { closed, dailyCaps, globalCap, mayWrite, overCap } from "./gate.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import { communityRepoKey, paperId } from "./papers.ts";
import {
  commentsOf,
  commentViewOf,
  insertComment,
  insertIssue,
  issueById,
  issuesOfPaper,
  LIST_PAPERS,
  personOf,
  RESEARCH_BODY_BYTES,
  RESEARCH_COMMENTS,
  RESEARCH_LABELS,
  RESEARCH_PINNED,
  RESOLUTION_WORDS,
  RESOLUTIONS_OF,
  summaryOf,
  TYPE_WORDS,
  updateComment,
  updateIssue,
  validateComment,
  validateEdit,
  validateOpen,
  viewOf,
  type CommentRow,
  type IssueRow,
  type IssueSummary,
  type OpenParsed,
  type ResearchEvent,
} from "./research-core.ts";
import { eventWrite, researchOpenedWrites, type EventKind, type NewEvent } from "./events.ts";
import { mentionsIn } from "../github/webhooks.ts";
import { autoFollowWrite } from "./social-core.ts";
import { actionRow, all, first, newNonce, repoByKey, rowsOf, statements } from "./store.ts";
import { ForgeProblem, type D1Database, type ForgeRequest, type RepoRow, type ResearchKind, type Write } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 31;
const parseList = (text: unknown): string[] => {
  try {
    const v = JSON.parse(String(text));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

interface Roles {
  papers: Set<string>;
  repos: Set<string>;
  moderator: boolean;
}

/** The reader's roles (oscr_community, by the roles' key prefix: the person's few rows). */
async function rolesOf(community: D1Database, userId: string): Promise<Roles> {
  const rows = await all<{ role: string; scope_kind: string; scope_id: string }>(
    community.prepare("SELECT role, scope_kind, scope_id FROM roles WHERE user_id = ?").bind(userId),
  );
  return {
    papers: new Set(rows.filter((r) => r.role === "verified_author" && r.scope_kind === "paper").map((r) => r.scope_id.toLowerCase())),
    repos: new Set(rows.filter((r) => r.role === "maintainer" && r.scope_kind === "repo").map((r) => r.scope_id.toLowerCase())),
    moderator: rows.some((r) => r.role === "moderator" || r.role === "admin"),
  };
}

const repoKeyOf = (i: { forge: string; repo_path: string }): string | null =>
  i.repo_path && (i.forge === "github" || i.forge === "memory") ? communityRepoKey(i.forge, i.repo_path.split("/")[0], i.repo_path.split("/")[1]) : null;

/** The role a person writes with on this issue: a verified author of its paper, a maintainer of its
 *  code, or none. */
function roleOn(roles: Roles, i: { paper_id: string; forge: string; repo_path: string }): "verified_author" | "maintainer" | "" {
  if (roles.papers.has(i.paper_id)) return "verified_author";
  const key = repoKeyOf(i);
  return key && roles.repos.has(key) ? "maintainer" : "";
}

/** Whether the reader manages the issue's repository in the registry, as the pull request pages
 *  count it (D04-10): the person who linked or created it through the registry, or its owner (the
 *  repository is in the reader's GitHub account). One read by the repository's key. */
async function managesRepo(db: D1Database, user: SignedIn["user"], i: { forge: string; repo_id: string }): Promise<boolean> {
  if (!i.repo_id || (i.forge !== "github" && i.forge !== "memory")) return false;
  const row = await first<RepoRow>(repoByKey(db, i.forge, i.repo_id));
  if (!row || row.state === "hidden" || row.state === "deleted") return false;
  return row.linked_by === user.id || (!!user.github_login && row.owner_login === user.github_login.toLowerCase());
}

/** Who triages a research issue: a verified author of its paper, a maintainer of its code (the
 *  registry's roles), the person who manages its repository in the registry, a moderator. */
const triages = async (db: D1Database, user: SignedIn["user"], roles: Roles, i: { paper_id: string; forge: string; repo_id: string; repo_path: string }): Promise<boolean> =>
  roles.moderator || roleOn(roles, i) !== "" || (await managesRepo(db, user, i));

// ─── the routes ──────────────────────────────────────────────────────────────

async function readPost(r: ForgeRequest): Promise<Record<string, unknown> | ForgeProblem> {
  if (!(r.request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return bad("The request is not JSON.");
  const text = await readCapped(r.request, RESEARCH_BODY_BYTES);
  if (text === null) return new ForgeProblem(413, "too_large", "This is larger than a research issue may be (64 KiB of text).");
  try {
    const v = JSON.parse(text) as unknown;
    return isObject(v) ? v : bad("The request is not readable.");
  } catch {
    return bad("The request is not readable.");
  }
}

/** Who may write (FORGE_OPEN), the caps, the day's rows: the problem, or the linked GitHub
 *  account's id ("" without one) for the action row. */
async function mayResearch(r: ForgeRequest, s: SignedIn, kind: ResearchKind, rows: number): Promise<ForgeProblem | { github: string }> {
  const github = await linkedGithub(s.db, s.user.id);
  if (!mayWrite(r.env, github)) return closed();
  const caps = await dailyCaps(r.db, s.user.id, kind, r.t);
  if (caps.exceeded) return overCap(caps.exceeded);
  return (await globalCap(r.db, r.t, Math.min(rows, FORGE_ROWS_PER_DAY))) ?? { github: github ?? "" };
}

/** The writes and their action row, in ONE batch; the batch's results. Phase 08: the action row
 *  names the paper (its `subject`) and shares its nonce with the event the write made, so that a
 *  person's activity finds the event from the action. */
async function commit(r: ForgeRequest, s: SignedIn, kind: ResearchKind, github: string, writes: Write[], repo: { forge: string; repoId: string } | null, nonce = newNonce(), subject = "") {
  const action = actionRow(r.db, {
    userId: s.user.id,
    t: r.t,
    nonce,
    kind,
    forge: repo?.forge ?? "",
    repoId: repo?.repoId ?? "",
    githubUser: github,
    outcome: "done",
    rows: 1 + rowsOf(writes),
    subject,
  });
  return r.db.batch([...statements(writes), action.stmt]);
}

/** Phase 08: the event of a research write, under its paper's subject, with the actor's words. */
function researchEvent(s: SignedIn, github: string, issue: { id: number; paper_id: string; title: string; author_id: string; repo_path: string }, kind: EventKind, nonce: string, t: number, mentions: string[] = []): NewEvent {
  return {
    subject: `paper:${issue.paper_id}`,
    at: t,
    nonce,
    kind,
    thread: `research:${issue.id}`,
    title: issue.title,
    url: `/research/${issue.id}`,
    repoPath: issue.repo_path,
    paperId: issue.paper_id,
    actorUser: s.user.id,
    actorGithub: github,
    actorName: personOf(s.user).author,
    threadAuthor: `user:${issue.author_id}`,
    mentions,
  };
}

/** Whether the registry knows this repository as this paper's code: linked in oscr_forge
 *  (repo_papers, by key), or the Mac's fact in oscr_community (paper_repo, by key). The registry's
 *  own row, when there is one, gives the repository's path. */
async function knownCode(r: ForgeRequest, community: D1Database, repo: NonNullable<OpenParsed["repo"]>, paper: string): Promise<{ path: string } | null> {
  const row = await first<RepoRow>(repoByKey(r.db, repo.forge, repo.id));
  if (row && row.state !== "hidden" && row.name) {
    const linked = await first(r.db.prepare("SELECT 1 AS x FROM repo_papers WHERE forge = ? AND repo_id = ? AND paper_id = ?").bind(repo.forge, repo.id, paper));
    if (linked) return { path: `${row.owner_login}/${row.name}` };
  }
  const [owner, name] = repo.path.split("/");
  const fact = await first(community.prepare("SELECT 1 AS x FROM paper_repo WHERE repo = ? AND paper_id = ?").bind(communityRepoKey(repo.forge, owner, name), paper));
  return fact ? { path: row && row.name ? `${row.owner_login}/${row.name}` : repo.path } : null;
}

export async function handleResearchRead(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const q = r.url.searchParams;
  const writes = mayWrite(r.env, await linkedGithub(s.db, s.user.id));
  const roles = await rolesOf(s.db, s.user.id);
  if (q.has("id")) {
    const id = Number(q.get("id"));
    if (!isId(id)) return problemAnswer(bad("A research issue is named by its number."));
    const row = await first<IssueRow>(issueById(r.db, id));
    if (!row) return problemAnswer(new ForgeProblem(404, "not_found", "The registry has no research issue of this number."));
    const comments = (await all<CommentRow>(commentsOf(r.db, id))).map((c) => ({ ...commentViewOf(c), mine: c.author_id === s.user.id }));
    const triage = await triages(r.db, s.user, roles, row);
    return json({
      issue: { ...viewOf(row), mine: row.author_id === s.user.id },
      comments,
      can: { write: writes, comment: writes && (!row.locked || triage), edit: writes && (triage || row.author_id === s.user.id), triage: writes && triage },
    });
  }
  const papers = [...new Set(q.getAll("paper").map(paperId))];
  if (!papers.length || papers.some((p) => p === null) || papers.length > LIST_PAPERS) {
    return problemAnswer(bad(`Name 1 to ${LIST_PAPERS} papers by their DOIs.`));
  }
  let repo: { forge: string; id: string } | null = null;
  const repoParam = q.get("repo");
  if (repoParam !== null) {
    const m = /^(github|memory):([0-9]{1,20})$/.exec(repoParam);
    if (!m) return problemAnswer(bad("The repository is <forge>:<id>."));
    repo = { forge: m[1], id: m[2] };
  }
  const issues: IssueSummary[] = [];
  for (const paper of papers as string[]) {
    for (const row of await all<Parameters<typeof summaryOf>[0]>(issuesOfPaper(r.db, paper))) {
      if (repo && (row.forge !== repo.forge || row.repo_id !== repo.id)) continue;
      issues.push(summaryOf(row));
    }
  }
  issues.sort((a, b) => b.id - a.id);
  return json({ issues, can: { write: writes, triage: writes && (roles.moderator || (papers as string[]).some((p) => roles.papers.has(p))) } });
}

export async function handleResearchOpen(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const parsed = validateOpen(body);
  if (parsed instanceof ForgeProblem) return say(parsed);
  if (parsed.repo) {
    const known = await knownCode(r, s.db, parsed.repo, parsed.paper);
    if (!known) {
      return say(new ForgeProblem(404, "unknown_code", "The registry does not know this repository as the code of this paper: link them first (the repository's page, “Papers”), or name the code the paper itself gives."));
    }
    parsed.repo.path = known.path;
  }
  const gate = await mayResearch(r, s, "research_open", 5);
  if (gate instanceof ForgeProblem) return say(gate);
  const roles = await rolesOf(s.db, s.user.id);
  const who = personOf(s.user);
  const role = roleOn(roles, { paper_id: parsed.paper, forge: parsed.repo?.forge ?? "", repo_path: parsed.repo?.path ?? "" });
  // Phase 08: the event (the paper's watchers' inbox) and the author's follow of the thread, in the
  // same batch: 5 rows.
  const nonce = newNonce();
  const subject = `paper:${parsed.paper}`;
  const event = researchEvent(s, gate.github, { id: 0, paper_id: parsed.paper, title: parsed.title, author_id: s.user.id, repo_path: parsed.repo?.path ?? "" }, "research_opened", nonce, r.t, mentionsIn(parsed.body));
  const results = await commit(
    r,
    s,
    "research_open",
    gate.github,
    [insertIssue(r.db, parsed, who, role, r.t), ...researchOpenedWrites(r.db, s.user.id, event)],
    parsed.repo ? { forge: parsed.repo.forge, repoId: parsed.repo.id } : null,
    nonce,
    subject,
  );
  const id = Number(results[0]?.meta?.last_row_id ?? 0);
  return json({ id, page: `/research/${id}`, sentence: `Open the research issue “${parsed.title}” (${TYPE_WORDS[parsed.type].toLowerCase()})` }, 201, s.cookies);
}

export async function handleResearchComment(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateComment(body);
  if (p instanceof ForgeProblem) return say(p);
  const issue = await first<IssueRow>(issueById(r.db, p.id));
  if (!issue) return say(new ForgeProblem(404, "not_found", "The registry has no research issue of this number."));
  const roles = await rolesOf(s.db, s.user.id);
  const triage = await triages(r.db, s.user, roles, issue);
  const who = personOf(s.user);
  let writes: Write[];
  let created = false;
  if (p.n === null) {
    if (issue.locked && !triage) return say(new ForgeProblem(403, "locked", "The conversation is locked: only the paper's verified authors and the code's maintainers comment now."));
    if (issue.comments >= RESEARCH_COMMENTS) return say(new ForgeProblem(409, "full", `The issue holds ${RESEARCH_COMMENTS.toLocaleString("en-GB")} comments, the most one may: open another and link this one.`));
    writes = insertComment(r.db, p.id, p.body ?? "", who, roleOn(roles, issue), r.t);
    created = true;
  } else {
    const c = await first<CommentRow>(r.db.prepare("SELECT * FROM research_comments WHERE issue_id = ? AND n = ?").bind(p.id, p.n));
    if (!c || c.deleted) return say(new ForgeProblem(404, "not_found", "This comment is not there (deleted, or never written)."));
    const mine = c.author_id === s.user.id;
    if (p.hide !== null) {
      if (!triage) return say(new ForgeProblem(403, "forbidden", "Hiding a comment is for the paper's verified authors and the code's maintainers."));
      writes = [updateComment(r.db, p.id, p.n, { hidden: p.hide })];
    } else if (p.delete) {
      if (!mine && !triage) return say(new ForgeProblem(403, "forbidden", "Only its author, the paper's verified authors and the code's maintainers delete a comment."));
      writes = [updateComment(r.db, p.id, p.n, { body: "", deleted: 1, edited_at: Math.floor(r.t) })];
    } else {
      if (!mine) return say(new ForgeProblem(403, "forbidden", "Only its author edits a comment."));
      writes = [updateComment(r.db, p.id, p.n, { body: p.body ?? "", edited_at: Math.floor(r.t) })];
    }
  }
  // Phase 08: a new comment is an event of the paper, and its author now follows the thread.
  const nonce = newNonce();
  const github = await linkedGithub(s.db, s.user.id);
  if (created) {
    writes.push(eventWrite(r.db, researchEvent(s, github ?? "", issue, "research_comment", nonce, r.t, mentionsIn(p.body ?? ""))));
    writes.push(autoFollowWrite(r.db, s.user.id, `paper:${issue.paper_id}#research:${issue.id}`, r.t));
  }
  const gate = await mayResearch(r, s, "research_comment", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  await commit(r, s, "research_comment", gate.github, writes, issue.repo_id ? { forge: issue.forge, repoId: issue.repo_id } : null, nonce, created ? `paper:${issue.paper_id}` : "");
  return json({ id: p.id, page: `/research/${p.id}` }, 200, s.cookies);
}

export async function handleResearchEdit(r: ForgeRequest): Promise<Response> {
  const s = await whoAsks(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readPost(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateEdit(body);
  if (p instanceof ForgeProblem) return say(p);
  const issue = await first<IssueRow>(issueById(r.db, p.id));
  if (!issue) return say(new ForgeProblem(404, "not_found", "The registry has no research issue of this number."));
  const roles = await rolesOf(s.db, s.user.id);
  const triage = await triages(r.db, s.user, roles, issue);
  const mine = issue.author_id === s.user.id;
  if (!triage && !mine) return say(new ForgeProblem(403, "forbidden", "Only the issue's author, the paper's verified authors and the code's maintainers change it."));
  if (!triage && (p.labels || p.locked !== null || p.pinned !== null)) {
    return say(new ForgeProblem(403, "forbidden", "Labels, locks and pins are for the paper's verified authors and the code's maintainers."));
  }
  if (p.resolution && !RESOLUTIONS_OF[issue.type].includes(p.resolution)) {
    return say(bad(`A ${TYPE_WORDS[issue.type].toLowerCase()} is not resolved as “${RESOLUTION_WORDS[p.resolution]}”.`));
  }
  if (p.duplicateOf && !(await first(issueById(r.db, p.duplicateOf)))) return say(bad(`The registry has no research issue #${p.duplicateOf}.`));
  const by = personOf(s.user).author;
  const at = Math.floor(r.t);
  const set: Record<string, string | number | null> = {};
  const events: ResearchEvent[] = [];
  if (p.title !== null && p.title !== issue.title) {
    set.title = p.title;
    events.push({ k: "renamed", by, at, s: issue.title });
  }
  if (p.body !== null && p.body !== issue.body) {
    set.body = p.body;
    events.push({ k: "edited", by, at });
  }
  if (p.state === "closed") {
    Object.assign(set, { state: "closed", close_reason: p.reason ?? "completed", resolution: p.resolution ?? "", resolution_ref: p.ref, closed_at: at });
    events.push({ k: "closed", by, at, s: [p.reason ?? "completed", p.resolution ?? "", p.ref].filter(Boolean).join(" ") });
  } else if (p.state === "open" && issue.state === "closed") {
    Object.assign(set, { state: "open", close_reason: "", resolution: "", resolution_ref: "", closed_at: null });
    events.push({ k: "reopened", by, at });
  }
  if (p.labels) {
    const have = parseList(issue.labels);
    const drop = new Set(p.labels.remove.map((x) => x.toLowerCase()));
    const next = have.filter((x) => !drop.has(x.toLowerCase()));
    for (const a of p.labels.add) if (!next.some((x) => x.toLowerCase() === a.toLowerCase())) next.push(a);
    if (next.length > RESEARCH_LABELS) return say(bad(`A research issue holds ${RESEARCH_LABELS} labels at most.`));
    set.labels = JSON.stringify(next);
    for (const a of next.filter((x) => !have.includes(x))) events.push({ k: "labeled", by, at, s: a });
    for (const x of have.filter((x) => !next.includes(x))) events.push({ k: "unlabeled", by, at, s: x });
  }
  if (p.locked !== null && p.locked !== (issue.locked === 1)) {
    Object.assign(set, { locked: p.locked ? 1 : 0, lock_reason: p.locked ? p.lockReason : "" });
    events.push({ k: p.locked ? "locked" : "unlocked", by, at, s: p.locked ? p.lockReason || undefined : undefined });
  }
  if (p.pinned !== null && p.pinned !== (issue.pinned === 1)) {
    if (p.pinned) {
      const pinned = await all<{ id: number }>(r.db.prepare("SELECT id FROM research_issues WHERE paper_id = ? AND pinned = 1 LIMIT 4").bind(issue.paper_id));
      if (pinned.length >= RESEARCH_PINNED) return say(new ForgeProblem(409, "three_pinned", `A paper pins ${RESEARCH_PINNED} research issues at most: unpin one first.`));
    }
    set.pinned = p.pinned ? 1 : 0;
    events.push({ k: p.pinned ? "pinned" : "unpinned", by, at });
  }
  if (!Object.keys(set).length) return json({ id: p.id, page: `/research/${p.id}`, unchanged: true }, 200, s.cookies);
  const writes = [updateIssue(r.db, p.id, set, events, r.t)];
  // Phase 08: closing and reopening are events of the paper (labels, locks and pins are not).
  const nonce = newNonce();
  const stateKind: EventKind | null = set.state === "closed" ? "research_closed" : set.state === "open" ? "research_reopened" : null;
  if (stateKind) writes.push(eventWrite(r.db, researchEvent(s, (await linkedGithub(s.db, s.user.id)) ?? "", { ...issue, title: String(set.title ?? issue.title) }, stateKind, nonce, r.t)));
  const gate = await mayResearch(r, s, "research_edit", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  await commit(r, s, "research_edit", gate.github, writes, issue.repo_id ? { forge: issue.forge, repoId: issue.repo_id } : null, nonce, stateKind ? `paper:${issue.paper_id}` : "");
  return json({ id: p.id, page: `/research/${p.id}` }, 200, s.cookies);
}
