// GitHub's JSON as GitBackend's types. Each field is read with a type check; a wrong shape is
// `unavailable` ("unexpected answer"), never a half-filled object.
//
// Never read: `email`, anywhere. A commit's author is built from `commit.author.name` and
// `commit.author.date`, with the linked account's `author.login` and `author.id`; the same holds
// for committers, users, pushers and senders. The types have no field for an address, and the
// tests feed fixtures that carry some.

import type * as T from "../types.ts";
import { unexpected } from "./http.ts";

export type J = Record<string, unknown>;

export function obj(v: unknown, what: string): J {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw unexpected(what);
  return v as J;
}

export function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw unexpected(what);
  return v;
}

export function str(o: J, k: string): string {
  const v = o[k];
  if (typeof v !== "string") throw unexpected(k);
  return v;
}

export function optStr(o: J, k: string): string | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw unexpected(k);
  return v;
}

export function num(o: J, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw unexpected(k);
  return v;
}

export function optNum(o: J, k: string): number | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw unexpected(k);
  return v;
}

export function bool(o: J, k: string, fallback?: boolean): boolean {
  const v = o[k];
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  if (typeof v !== "boolean") throw unexpected(k);
  return v;
}

/** A GitHub id (a number) as decimal text. */
export function id(o: J, k = "id"): string {
  const v = o[k];
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (typeof v === "string" && /^\d{1,20}$/.test(v)) return v;
  throw unexpected(k);
}

export function optId(o: J, k = "id"): string | null {
  const v = o[k];
  return v === undefined || v === null ? null : id(o, k);
}

export function sha(o: J, k = "sha"): T.ObjectId {
  const v = str(o, k);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v)) throw unexpected(k);
  return v;
}

const optObj = (o: J, k: string): J | null => (o[k] === undefined || o[k] === null ? null : obj(o[k], k));

// ─── people ───────────────────────────────────────────────────────────────

/** A forge account (a user, a bot, an organization); a deleted one is GitHub's "ghost". */
export function user(v: unknown): T.Actor {
  if (v === null || v === undefined) return { name: "ghost", login: null, id: null };
  const u = obj(v, "user");
  const login = str(u, "login");
  return { name: login, login, id: optId(u) };
}

/** A commit's author or committer: the name in the commit, the account GitHub links to it. */
export function signature(git: J, account: unknown): T.Actor {
  const acc = account === null || account === undefined ? null : obj(account, "account");
  return { name: optStr(git, "name") ?? "", login: acc ? optStr(acc, "login") : null, id: acc ? optId(acc) : null };
}

export function permissionOf(p: unknown): T.Permission | null {
  if (!p || typeof p !== "object") return null;
  const q = p as Record<string, unknown>;
  if (q.admin === true) return "admin";
  if (q.maintain === true) return "maintain";
  if (q.push === true) return "write";
  if (q.triage === true) return "triage";
  if (q.pull === true) return "read";
  return "none";
}

// ─── repositories ─────────────────────────────────────────────────────────

const VISIBILITY = new Set(["public", "private", "internal"]);

export function refOf(v: unknown): T.RepoRef {
  const r = obj(v, "repository");
  const owner = obj(r.owner, "owner");
  return { forge: "github", owner: str(owner, "login"), name: str(r, "name") };
}

export function repo(v: unknown): T.RepoInfo {
  const r = obj(v, "repository");
  const owner = obj(r.owner, "owner");
  const visibility = typeof r.visibility === "string" && VISIBILITY.has(r.visibility) ? (r.visibility as T.RepoInfo["visibility"]) : bool(r, "private") ? "private" : "public";
  const license = optObj(r, "license");
  const spdx = license ? optStr(license, "spdx_id") : null;
  const topics = r.topics === undefined || r.topics === null ? [] : list(r.topics, "topics").map((t) => (typeof t === "string" ? t : ""));
  return {
    key: { forge: "github", id: id(r) },
    nodeId: optStr(r, "node_id"),
    ref: { forge: "github", owner: str(owner, "login"), name: str(r, "name") },
    owner: { id: id(owner), login: str(owner, "login"), type: owner.type === "Organization" ? "organization" : "user" },
    visibility,
    archived: bool(r, "archived", false),
    disabled: bool(r, "disabled", false),
    isTemplate: bool(r, "is_template", false),
    parent: r.parent ? refOf(r.parent) : null,
    template: r.template_repository ? refOf(r.template_repository) : null,
    defaultBranch: optStr(r, "default_branch"),
    description: optStr(r, "description") ?? "",
    homepage: optStr(r, "homepage") ?? "",
    topics: topics.filter(Boolean),
    licenseSpdx: spdx && spdx !== "NOASSERTION" ? spdx : null,
    sizeKb: optNum(r, "size") ?? 0,
    createdAt: str(r, "created_at"),
    pushedAt: typeof r.pushed_at === "number" ? new Date(r.pushed_at * 1000).toISOString() : optStr(r, "pushed_at"),
    features: {
      issues: bool(r, "has_issues", true),
      wiki: bool(r, "has_wiki", false),
      autoMerge: bool(r, "allow_auto_merge", false),
      deleteBranchOnMerge: bool(r, "delete_branch_on_merge", false),
    },
    permission: permissionOf(r.permissions),
    signoffRequired: bool(r, "web_commit_signoff_required", false),
    webUrl: str(r, "html_url"),
    cloneUrl: optStr(r, "clone_url") ?? `${str(r, "html_url")}.git`,
  };
}

/** A repository as webhooks and installation listings give it. */
export function stub(v: unknown): T.RepoStub {
  const r = obj(v, "repository");
  const full = optStr(r, "full_name");
  const owner = r.owner ? str(obj(r.owner, "owner"), "login") : full ? full.split("/")[0] : "";
  const name = optStr(r, "name") ?? (full ? full.split("/")[1] : "");
  if (!owner || !name) throw unexpected("repository");
  const visibility = typeof r.visibility === "string" && VISIBILITY.has(r.visibility) ? (r.visibility as T.RepoStub["visibility"]) : r.private === true ? "private" : "public";
  return { key: { forge: "github", id: id(r) }, ref: { forge: "github", owner, name }, visibility, defaultBranch: optStr(r, "default_branch") };
}

export function installation(v: unknown): T.Installation {
  const i = obj(v, "installation");
  const account = obj(i.account, "account");
  return {
    id: id(i),
    account: { id: id(account), login: str(account, "login"), type: account.type === "Organization" ? "organization" : "user" },
    selection: i.repository_selection === "selected" ? "selected" : "all",
    suspended: i.suspended_at !== undefined && i.suspended_at !== null,
  };
}

// ─── refs, trees ──────────────────────────────────────────────────────────

export function branch(v: unknown): T.Branch {
  const b = obj(v, "branch");
  return { name: str(b, "name"), sha: sha(obj(b.commit, "commit")), protected: bool(b, "protected", false) };
}

export function tag(v: unknown): T.Tag {
  const t = obj(v, "tag");
  return { name: str(t, "name"), sha: sha(obj(t.commit, "commit")), annotation: null };
}

const MODES = new Set(["100644", "100755", "120000", "040000", "160000"]);

export function treeEntry(v: unknown, prefix = ""): T.TreeEntry {
  const e = obj(v, "tree entry");
  let mode = str(e, "mode");
  if (mode === "40000") mode = "040000";
  if (!MODES.has(mode)) throw unexpected("mode");
  const type = str(e, "type");
  if (type !== "blob" && type !== "tree" && type !== "commit") throw unexpected("type");
  return {
    path: prefix + str(e, "path"),
    mode: mode as T.TreeEntry["mode"],
    type,
    sha: sha(e),
    size: type === "blob" ? (optNum(e, "size") ?? null) : null,
  };
}

// ─── commits ──────────────────────────────────────────────────────────────

export function commit(v: unknown): T.CommitSummary {
  const c = obj(v, "commit");
  const git = obj(c.commit, "commit");
  const author = obj(git.author, "author");
  const committer = obj(git.committer, "committer");
  const verification = optObj(git, "verification");
  return {
    sha: sha(c),
    parents: list(c.parents, "parents").map((p) => sha(obj(p, "parent"))),
    tree: sha(obj(git.tree, "tree")),
    message: str(git, "message"),
    author: signature(author, c.author),
    authoredAt: str(author, "date"),
    committer: signature(committer, c.committer),
    committedAt: str(committer, "date"),
    verified: verification ? bool(verification, "verified", false) : null,
  };
}

const STATUSES = new Set(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]);

export function fileChange(v: unknown): T.FileChangeSummary {
  const f = obj(v, "file");
  const status = str(f, "status");
  if (!STATUSES.has(status)) throw unexpected("status");
  const blob = optStr(f, "sha");
  return {
    path: str(f, "filename"),
    previousPath: optStr(f, "previous_filename"),
    status: status as T.FileStatus,
    additions: optNum(f, "additions") ?? 0,
    deletions: optNum(f, "deletions") ?? 0,
    patch: optStr(f, "patch"),
    blob: status === "removed" || !blob || /^0+$/.test(blob) ? null : blob,
  };
}

export function commitDetail(v: unknown, next: string | null): T.CommitDetail {
  const c = obj(v, "commit");
  const stats = optObj(c, "stats");
  return {
    ...commit(c),
    stats: { additions: stats ? num(stats, "additions") : 0, deletions: stats ? num(stats, "deletions") : 0, total: stats ? num(stats, "total") : 0 },
    files: { items: c.files === undefined ? [] : list(c.files, "files").map(fileChange), next },
  };
}

export function comparison(v: unknown, next: string | null): T.Comparison {
  const c = obj(v, "comparison");
  const status = str(c, "status");
  if (status !== "identical" && status !== "ahead" && status !== "behind" && status !== "diverged") throw unexpected("status");
  return {
    status,
    aheadBy: num(c, "ahead_by"),
    behindBy: num(c, "behind_by"),
    mergeBase: sha(obj(c.merge_base_commit, "merge base")),
    commits: list(c.commits, "commits").map(commit),
    files: { items: c.files === undefined ? [] : list(c.files, "files").map(fileChange), next },
  };
}

// ─── pull requests ────────────────────────────────────────────────────────

const METHODS: Record<string, T.MergeMethod> = { MERGE: "merge", SQUASH: "squash", REBASE: "rebase", merge: "merge", squash: "squash", rebase: "rebase" };
const MERGE_STATES = new Set(["clean", "dirty", "blocked", "behind", "unstable", "draft", "unknown"]);

const names = (v: unknown, key: string): string[] =>
  v === undefined || v === null ? [] : list(v, key).map((x) => str(obj(x, key), key === "labels" ? "name" : "login"));

export function pull(v: unknown): T.PullRequest {
  const p = obj(v, "pull request");
  const head = obj(p.head, "head");
  const base = obj(p.base, "base");
  const auto = optObj(p, "auto_merge");
  const milestone = optObj(p, "milestone");
  const state = str(p, "state");
  const mergeState = (optStr(p, "mergeable_state") ?? "unknown").toLowerCase();
  return {
    number: num(p, "number"),
    id: id(p),
    nodeId: optStr(p, "node_id"),
    title: str(p, "title"),
    body: optStr(p, "body") ?? "",
    state: state === "closed" ? "closed" : "open",
    draft: bool(p, "draft", false),
    merged: p.merged === true || (p.merged_at !== undefined && p.merged_at !== null),
    mergedAt: optStr(p, "merged_at"),
    mergeCommit: p.merged_at ? optStr(p, "merge_commit_sha") : null,
    author: user(p.user),
    createdAt: str(p, "created_at"),
    updatedAt: str(p, "updated_at"),
    closedAt: optStr(p, "closed_at"),
    head: { repo: head.repo ? refOf(head.repo) : null, ref: str(head, "ref"), sha: sha(head) },
    base: { repo: refOf(base.repo), ref: str(base, "ref"), sha: sha(base) },
    mergeable: typeof p.mergeable === "boolean" ? p.mergeable : null,
    mergeState: (MERGE_STATES.has(mergeState) ? mergeState : "unknown") as T.PullRequest["mergeState"],
    requestedReviewers: names(p.requested_reviewers, "requested_reviewers"),
    labels: names(p.labels, "labels"),
    assignees: names(p.assignees, "assignees"),
    milestone: milestone ? num(milestone, "number") : null,
    autoMerge: auto ? (METHODS[str(auto, "merge_method")] ?? null) : null,
    maintainerCanModify: bool(p, "maintainer_can_modify", false),
    counts: {
      commits: optNum(p, "commits") ?? 0,
      additions: optNum(p, "additions") ?? 0,
      deletions: optNum(p, "deletions") ?? 0,
      changedFiles: optNum(p, "changed_files") ?? 0,
      comments: (optNum(p, "comments") ?? 0) + (optNum(p, "review_comments") ?? 0),
    },
  };
}

const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);

export function review(v: unknown): T.Review {
  const r = obj(v, "review");
  const state = str(r, "state");
  if (!REVIEW_STATES.has(state)) throw unexpected("state");
  return {
    id: id(r),
    author: user(r.user),
    state: state as T.Review["state"],
    body: optStr(r, "body") ?? "",
    commit: optStr(r, "commit_id"),
    submittedAt: optStr(r, "submitted_at"),
  };
}

export function reviewComment(v: unknown): T.ReviewComment {
  const c = obj(v, "review comment");
  return {
    id: id(c),
    reviewId: optId(c, "pull_request_review_id"),
    inReplyTo: optId(c, "in_reply_to_id"),
    author: user(c.user),
    path: str(c, "path"),
    line: optNum(c, "line"),
    startLine: optNum(c, "start_line"),
    side: c.side === "LEFT" ? "LEFT" : "RIGHT",
    commit: sha(c, "commit_id"),
    originalCommit: sha(c, "original_commit_id"),
    body: str(c, "body"),
    createdAt: str(c, "created_at"),
    updatedAt: str(c, "updated_at"),
  };
}

/** A GraphQL review thread (pulls.threads, resolveThread). */
export function thread(v: unknown): T.ReviewThread {
  const t = obj(v, "thread");
  const comments = obj(t.comments, "comments");
  return {
    id: str(t, "id"),
    resolved: bool(t, "isResolved"),
    outdated: bool(t, "isOutdated", false),
    path: str(t, "path"),
    line: optNum(t, "line"),
    comments: list(comments.nodes, "comments").map((n) => {
      const c = obj(n, "comment");
      const author = c.author ? obj(c.author, "author") : null;
      const commitOf = (k: string) => {
        const x = optObj(c, k);
        return x ? sha(x, "oid") : "";
      };
      const review = optObj(c, "pullRequestReview");
      const replyTo = optObj(c, "replyTo");
      return {
        id: id(c, "databaseId"),
        reviewId: review ? optId(review, "databaseId") : null,
        inReplyTo: replyTo ? optId(replyTo, "databaseId") : null,
        author: author ? { name: str(author, "login"), login: str(author, "login"), id: author.databaseId === undefined ? null : optId(author, "databaseId") } : { name: "ghost", login: null, id: null },
        path: str(c, "path"),
        line: optNum(c, "line"),
        startLine: optNum(c, "startLine"),
        side: c.diffSide === "LEFT" ? "LEFT" : "RIGHT",
        commit: commitOf("commit"),
        originalCommit: commitOf("originalCommit"),
        body: str(c, "body"),
        createdAt: str(c, "createdAt"),
        updatedAt: str(c, "updatedAt"),
      } satisfies T.ReviewComment;
    }),
  };
}

// ─── issues ───────────────────────────────────────────────────────────────

const REACTIONS: T.Reaction[] = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"];
const STATE_REASONS = new Set(["completed", "not_planned", "duplicate", "reopened"]);
const LOCK_REASONS = new Set(["off-topic", "too heated", "resolved", "spam"]);

export function reactions(v: unknown): Partial<Record<T.Reaction, number>> {
  if (!v || typeof v !== "object") return {};
  const r = v as Record<string, unknown>;
  const out: Partial<Record<T.Reaction, number>> = {};
  for (const k of REACTIONS) if (typeof r[k] === "number" && (r[k] as number) > 0) out[k] = r[k] as number;
  return out;
}

export function issue(v: unknown): T.Issue {
  const i = obj(v, "issue");
  const milestone = optObj(i, "milestone");
  const summary = optObj(i, "sub_issues_summary");
  const reason = optStr(i, "state_reason");
  const lock = optStr(i, "active_lock_reason");
  const type = optObj(i, "type");
  return {
    number: num(i, "number"),
    id: id(i),
    nodeId: optStr(i, "node_id"),
    title: str(i, "title"),
    body: optStr(i, "body") ?? "",
    state: i.state === "closed" ? "closed" : "open",
    stateReason: reason && STATE_REASONS.has(reason) ? (reason as T.StateReason) : null,
    author: user(i.user),
    labels: i.labels === undefined ? [] : list(i.labels, "labels").map((l) => (typeof l === "string" ? l : str(obj(l, "label"), "name"))),
    assignees: names(i.assignees, "assignees"),
    milestone: milestone ? num(milestone, "number") : null,
    locked: bool(i, "locked", false),
    lockReason: lock && LOCK_REASONS.has(lock) ? (lock as T.LockReason) : null,
    pinned: null,
    comments: optNum(i, "comments") ?? 0,
    reactions: reactions(i.reactions),
    subIssues: summary ? { total: num(summary, "total"), completed: num(summary, "completed") } : null,
    type: type ? (optStr(type, "name") ?? null) : null,
    isPullRequest: i.pull_request !== undefined && i.pull_request !== null,
    createdAt: str(i, "created_at"),
    updatedAt: str(i, "updated_at"),
    closedAt: optStr(i, "closed_at"),
  };
}

export function issueComment(v: unknown): T.IssueComment {
  const c = obj(v, "comment");
  return {
    id: id(c),
    author: user(c.user),
    body: optStr(c, "body") ?? "",
    createdAt: str(c, "created_at"),
    updatedAt: str(c, "updated_at"),
    reactions: reactions(c.reactions),
  };
}

export function label(v: unknown): T.Label {
  const l = obj(v, "label");
  return { name: str(l, "name"), color: optStr(l, "color") ?? "", description: optStr(l, "description") ?? "" };
}

export function milestone(v: unknown): T.Milestone {
  const m = obj(v, "milestone");
  return {
    number: num(m, "number"),
    title: str(m, "title"),
    description: optStr(m, "description") ?? "",
    state: m.state === "closed" ? "closed" : "open",
    dueOn: optStr(m, "due_on"),
    openIssues: optNum(m, "open_issues") ?? 0,
    closedIssues: optNum(m, "closed_issues") ?? 0,
  };
}

const TIMELINE = new Set([
  "commented", "cross-referenced", "referenced", "closed", "reopened", "labeled", "unlabeled", "assigned", "unassigned",
  "milestoned", "demilestoned", "renamed", "locked", "unlocked", "transferred", "merged", "reviewed",
]);

export function timelineEvent(v: unknown): T.TimelineEvent {
  const e = obj(v, "timeline event");
  const event = optStr(e, "event") ?? "other";
  const kind = (TIMELINE.has(event) ? event : "other") as T.TimelineEvent["kind"];
  const who = e.actor ?? e.user ?? null;
  const at = optStr(e, "created_at") ?? optStr(e, "submitted_at") ?? optStr(e, "updated_at") ?? "";
  let subject: string | null = null;
  if (kind === "cross-referenced") {
    const source = optObj(e, "source");
    const src = source ? optObj(source, "issue") : null;
    const r = src ? optObj(src, "repository") : null;
    if (src && r) subject = `${str(r, "full_name")}#${num(src, "number")}`;
  } else if (kind === "labeled" || kind === "unlabeled") {
    const l = optObj(e, "label");
    subject = l ? optStr(l, "name") : null;
  } else if (kind === "renamed") {
    const r = optObj(e, "rename");
    subject = r ? optStr(r, "to") : null;
  } else if (kind === "milestoned" || kind === "demilestoned") {
    const m = optObj(e, "milestone");
    subject = m ? optStr(m, "title") : null;
  } else if (kind === "assigned" || kind === "unassigned") {
    const a = optObj(e, "assignee");
    subject = a ? optStr(a, "login") : null;
  } else {
    subject = optStr(e, "commit_id");
  }
  return { kind, actor: who ? user(who) : null, createdAt: at, subject };
}

// ─── releases, checks ─────────────────────────────────────────────────────

export function asset(v: unknown): T.ReleaseAsset {
  const a = obj(v, "asset");
  return {
    id: id(a),
    name: str(a, "name"),
    label: optStr(a, "label") ?? "",
    contentType: optStr(a, "content_type") ?? "application/octet-stream",
    size: num(a, "size"),
    downloads: optNum(a, "download_count") ?? 0,
    downloadUrl: str(a, "browser_download_url"),
    createdAt: str(a, "created_at"),
    digest: sha256Of(optStr(a, "digest")),
  };
}

/** GitHub's "sha256:<hex>" as its hex, or null. */
function sha256Of(digest: string | null): string | null {
  const m = digest === null ? null : /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return m ? m[1].toLowerCase() : null;
}

export function release(v: unknown): T.Release {
  const r = obj(v, "release");
  return {
    id: id(r),
    tagName: str(r, "tag_name"),
    target: optStr(r, "target_commitish") ?? "",
    name: optStr(r, "name") ?? "",
    body: optStr(r, "body") ?? "",
    draft: bool(r, "draft", false),
    prerelease: bool(r, "prerelease", false),
    immutable: bool(r, "immutable", false),
    author: user(r.author),
    createdAt: str(r, "created_at"),
    publishedAt: optStr(r, "published_at"),
    assets: r.assets === undefined ? [] : list(r.assets, "assets").map(asset),
    webUrl: str(r, "html_url"),
  };
}

const CHECK_STATUSES = new Set(["queued", "in_progress", "completed"]);
const CONCLUSIONS = new Set(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required"]);

export function checkRun(v: unknown): T.CheckRun {
  const c = obj(v, "check run");
  const status = str(c, "status");
  const conclusion = optStr(c, "conclusion");
  const output = optObj(c, "output");
  const app = optObj(c, "app");
  return {
    id: id(c),
    name: str(c, "name"),
    headSha: sha(c, "head_sha"),
    status: (CHECK_STATUSES.has(status) ? status : "queued") as T.CheckStatus,
    conclusion: conclusion && CONCLUSIONS.has(conclusion) ? (conclusion as T.CheckConclusion) : null,
    startedAt: optStr(c, "started_at"),
    completedAt: optStr(c, "completed_at"),
    detailsUrl: optStr(c, "details_url"),
    app: app ? optStr(app, "slug") : null,
    output: {
      title: output ? (optStr(output, "title") ?? "") : "",
      summary: output ? (optStr(output, "summary") ?? "") : "",
      annotations: output ? (optNum(output, "annotations_count") ?? 0) : 0,
    },
  };
}

const STATUS_STATES = new Set(["success", "failure", "pending", "error"]);

export function combinedStatus(v: unknown): T.CombinedStatus {
  const s = obj(v, "status");
  const state = str(s, "state");
  const stateOf = (x: string) => (STATUS_STATES.has(x) ? (x as T.StatusState) : "pending");
  return {
    state: stateOf(state),
    statuses: list(s.statuses, "statuses").map((x) => {
      const o = obj(x, "status");
      return { context: str(o, "context"), state: stateOf(str(o, "state")), description: optStr(o, "description") ?? "", targetUrl: optStr(o, "target_url") };
    }),
  };
}

/** A GraphQL commit (blame) as a summary. */
export function graphCommit(v: unknown): T.CommitSummary {
  const c = obj(v, "commit");
  const who = (k: string): T.Actor => {
    const a = optObj(c, k);
    if (!a) return { name: "", login: null, id: null };
    const u = optObj(a, "user");
    return { name: optStr(a, "name") ?? "", login: u ? optStr(u, "login") : null, id: u ? optId(u, "databaseId") : null };
  };
  const parents = obj(c.parents, "parents");
  const sig = optObj(c, "signature");
  return {
    sha: sha(c, "oid"),
    parents: list(parents.nodes, "parents").map((p) => sha(obj(p, "parent"), "oid")),
    tree: sha(obj(c.tree, "tree"), "oid"),
    message: str(c, "message"),
    author: who("author"),
    authoredAt: str(c, "authoredDate"),
    committer: who("committer"),
    committedAt: str(c, "committedDate"),
    verified: sig ? bool(sig, "isValid", false) : null,
  };
}
