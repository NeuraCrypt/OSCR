// A pull request's page (night phase 04, E4): pure, no DOM, testable in Node
// (tests/forge-pages/pull-page.test.ts). The script (src/scripts/repo-pull.ts) reads GitHub on the
// reader's quota and shows these view trees through src/scripts/dom.ts.
//
// - The header: the title, its number, its state in words, who wants to merge what into what, and
//   the merge status at the top of every tab (GitHub's 2026 change).
// - The tabs: Conversation, Commits, Checks, Files changed (a nav.tabs, the current one marked).
// - The conversation's timeline: the comments, the reviews with their line comments, and the
//   conversations (a review comment and its replies), in time order; a comment that holds a
//   suggestion says so; an outdated one says so.
// - Role labels in words: the pull request's author, a verified author of the paper (the registry's
//   roles), a code owner.
// - The checks, in words.

import type * as T from "../../worker/forge/types.ts";
import { plural } from "./format.ts";
import type { RepoCoords } from "./forge.ts";
import { type MergeBox, pullPath, type PullTab, pullStateInWords, suggestionsOf } from "./pulls.ts";
import { type El, h } from "./repo-view.ts";

// ─── the header and the tabs ─────────────────────────────────────────────────

const who = (a: T.Actor | null | undefined): string => a?.login ?? a?.name ?? "someone";
export const dayOf = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");

/** "from" as the page names it: the branch, or "owner:branch" from a fork. */
export function headName(repo: RepoCoords, pr: Pick<T.PullRequest, "head">): string {
  const r = pr.head.repo;
  if (!r) return `${pr.head.ref} (its fork was deleted)`;
  return r.owner.toLowerCase() === repo.owner.toLowerCase() && r.name.toLowerCase() === repo.name.toLowerCase() ? pr.head.ref : `${r.owner}:${pr.head.ref}`;
}

/** Who wants to merge what, or what happened, in one sentence. */
export function pullSentence(repo: RepoCoords, pr: T.PullRequest): string {
  const commits = plural(pr.counts.commits, "commit");
  const from = headName(repo, pr);
  if (pr.merged) return `${who(pr.author)}'s ${commits} from ${from} were merged into ${pr.base.ref}${pr.mergedAt ? ` on ${dayOf(pr.mergedAt)}` : ""}.`;
  if (pr.state === "closed") return `${who(pr.author)} asked to merge ${commits} into ${pr.base.ref} from ${from}; closed without merging${pr.closedAt ? ` on ${dayOf(pr.closedAt)}` : ""}.`;
  return `${who(pr.author)} wants to merge ${commits} into ${pr.base.ref} from ${from}${pr.draft ? " (a draft)" : ""}. Opened ${dayOf(pr.createdAt)}.`;
}

/** The header: the title and number, the state in a word, the sentence, the merge status. */
export function pullHeader(repo: RepoCoords, pr: T.PullRequest, box: MergeBox | null): El {
  const state = pullStateInWords(pr);
  return h(
    "div",
    { class: "pull-head" },
    h("h2", null, pr.title, " ", h("span", { class: "pull-number" }, `#${pr.number}`)),
    h("p", { class: "status-line" }, h("span", { class: `pull-state ${pr.merged ? "ok" : pr.state === "closed" || pr.draft ? "muted" : ""}` }, state), " ", pullSentence(repo, pr)),
    box ? h("p", { class: `merge-status ${box.tone}` }, box.status) : null,
  );
}

/** The pull request's tabs, the current one marked, with their counts. */
export function pullTabsNav(repo: RepoCoords, pr: Pick<T.PullRequest, "number" | "counts">, current: PullTab): El {
  const tab = (t: PullTab, label: string) => h("li", null, h("a", { href: pullPath(repo, pr.number, t), "aria-current": t === current ? "page" : null }, label));
  return h(
    "nav",
    { class: "tabs pull-tabs", "aria-label": "Pull request" },
    h(
      "ul",
      null,
      tab("conversation", "Conversation"),
      tab("commits", `Commits (${pr.counts.commits})`),
      tab("checks", "Checks"),
      tab("files", `Files changed (${pr.counts.changedFiles})`),
    ),
  );
}

// ─── roles ───────────────────────────────────────────────────────────────────

export interface Roles {
  /** The pull request's author. */
  author: string | null;
  /** Logins of the paper's verified authors (the registry's roles), lower case. */
  paperAuthors: ReadonlySet<string>;
  /** Logins named by CODEOWNERS for the changed files, lower case. */
  codeOwners: ReadonlySet<string>;
}

/** A person's roles on this pull request, in words: "author", "verified author of the paper", "code owner". */
export function rolesOf(login: string | null, roles: Roles): string[] {
  if (!login) return [];
  const l = login.toLowerCase();
  const out: string[] = [];
  if (roles.author && roles.author.toLowerCase() === l) out.push("author");
  if (roles.paperAuthors.has(l)) out.push("verified author of the paper");
  if (roles.codeOwners.has(l)) out.push("code owner");
  return out;
}

// ─── the timeline ────────────────────────────────────────────────────────────

export interface Thread {
  /** The first comment's id: replies and resolving name it. */
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  side: "LEFT" | "RIGHT";
  outdated: boolean;
  comments: T.ReviewComment[];
}

export type TimelineItem =
  | { kind: "comment"; at: string; comment: T.IssueComment }
  | { kind: "review"; at: string; review: T.Review; threads: Thread[] }
  | { kind: "event"; at: string; event: T.TimelineEvent };

/** Review comments as conversations: each first comment with its replies, in order. */
export function threadsOf(comments: readonly T.ReviewComment[]): Thread[] {
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(a.id) - Number(b.id));
  const byId = new Map<string, Thread>();
  const out: Thread[] = [];
  for (const c of sorted) {
    const root = c.inReplyTo ? byId.get(c.inReplyTo) : undefined;
    if (root) {
      root.comments.push(c);
      byId.set(c.id, root);
      continue;
    }
    const t: Thread = { id: c.id, path: c.path, line: c.line, startLine: c.startLine, side: c.side, outdated: c.line === null, comments: [c] };
    byId.set(c.id, t);
    out.push(t);
  }
  return out;
}

/** The conversation in time order: comments, reviews (each with the conversations it started),
 *  events. A review that only answered conversations (GitHub makes one per reply) is left out: its
 *  replies are in their conversation. */
export function timelineOf(comments: readonly T.IssueComment[], reviews: readonly T.Review[], reviewComments: readonly T.ReviewComment[], events: readonly T.TimelineEvent[] = []): TimelineItem[] {
  const threads = threadsOf(reviewComments);
  const byReview = new Map<string, Thread[]>();
  const loose: Thread[] = [];
  for (const t of threads) {
    const rid = t.comments[0].reviewId;
    if (rid) byReview.set(rid, [...(byReview.get(rid) ?? []), t]);
    else loose.push(t);
  }
  const items: TimelineItem[] = [];
  for (const c of comments) items.push({ kind: "comment", at: c.createdAt, comment: c });
  for (const r of reviews) {
    const own = byReview.get(r.id) ?? [];
    if (r.state === "PENDING") continue;
    if (r.state === "COMMENTED" && !r.body.trim() && !own.length) continue;
    items.push({ kind: "review", at: r.submittedAt ?? "", review: r, threads: own });
  }
  // Conversations whose review is not listed (older than the reviews' page): on their own.
  for (const t of loose) items.push({ kind: "review", at: t.comments[0].createdAt, review: { id: `thread-${t.id}`, author: t.comments[0].author, state: "COMMENTED", body: "", commit: t.comments[0].commit, submittedAt: t.comments[0].createdAt }, threads: [t] });
  for (const e of events) if (["merged", "closed", "reopened", "renamed", "cross-referenced", "referenced", "labeled", "unlabeled", "assigned", "milestoned"].includes(e.kind)) items.push({ kind: "event", at: e.createdAt, event: e });
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

/** A review's decision in words: "approved these changes". */
export function reviewWords(state: T.Review["state"]): string {
  switch (state) {
    case "APPROVED":
      return "approved these changes";
    case "CHANGES_REQUESTED":
      return "requested changes";
    case "DISMISSED":
      return "reviewed (the review was dismissed)";
    case "PENDING":
      return "is writing a review";
    default:
      return "reviewed";
  }
}

/** An event in words. */
export function eventWords(e: T.TimelineEvent): string {
  const actor = who(e.actor);
  switch (e.kind) {
    case "merged":
      return `${actor} merged it${e.subject ? ` (${e.subject.slice(0, 7)})` : ""}.`;
    case "closed":
      return `${actor} closed it.`;
    case "reopened":
      return `${actor} reopened it.`;
    case "renamed":
      return `${actor} changed the title${e.subject ? ` to “${e.subject}”` : ""}.`;
    case "cross-referenced":
    case "referenced":
      return `${actor} mentioned it${e.subject ? ` in ${e.subject}` : ""}.`;
    case "labeled":
      return `${actor} added the label ${e.subject ?? ""}.`.replace(" .", ".");
    case "unlabeled":
      return `${actor} removed the label ${e.subject ?? ""}.`.replace(" .", ".");
    case "assigned":
      return `${actor} assigned ${e.subject ?? "someone"}.`;
    case "milestoned":
      return `${actor} added it to a milestone${e.subject ? `, ${e.subject}` : ""}.`;
    default:
      return `${actor}: ${e.kind}.`;
  }
}

/** Where a conversation is, in words: "analysis.py, lines 3 to 5 (outdated)". */
export function threadWhere(t: Pick<Thread, "path" | "line" | "startLine" | "side" | "outdated">): string {
  const lines = t.line === null ? "" : t.startLine && t.startLine !== t.line ? `, lines ${t.startLine} to ${t.line}` : `, line ${t.line}`;
  return `${t.path}${lines}${t.side === "LEFT" && t.line !== null ? " of the old version" : ""}${t.outdated ? " (outdated: the lines changed since)" : ""}`;
}

/** The anchor of a file's line in the Files changed tab: "#diff-3-R12". */
export const lineAnchor = (fileIndex: number, side: "LEFT" | "RIGHT", line: number): string => `diff-${fileIndex + 1}-${side === "LEFT" ? "L" : "R"}${line}`;

/** Whether a comment's body carries a suggested change. */
export const hasSuggestion = (body: string): boolean => suggestionsOf(body).length > 0;

/** The head of a comment: who, their roles, when. */
export function commentHead(author: T.Actor, at: string, roles: Roles, what = "commented"): El {
  const labels = rolesOf(author.login, roles);
  return h("p", { class: "comment-head" }, h("strong", null, who(author)), labels.length ? h("span", { class: "role" }, ` (${labels.join(", ")})`) : null, ` ${what} on ${dayOf(at)}`);
}

// ─── the checks ──────────────────────────────────────────────────────────────

/** A check in words: its name, what it concluded. */
export function checkWords(r: T.CheckRun): { text: string; tone: string } {
  if (r.status !== "completed") return { text: `${r.name}: ${r.status === "queued" ? "waiting to start" : "running"}`, tone: "" };
  const c = r.conclusion;
  const said = c === "success" ? "passed" : c === "failure" ? "failed" : c === "timed_out" ? "took too long (timed out)" : c === "cancelled" ? "was cancelled" : c === "action_required" ? "waits for someone to act" : c === "skipped" ? "was skipped" : "is neutral";
  return { text: `${r.name}: ${said}`, tone: c === "success" ? "ok" : c === "failure" || c === "timed_out" || c === "cancelled" || c === "action_required" ? "warning" : "" };
}

export function statusWords(s: T.CombinedStatus["statuses"][number]): { text: string; tone: string } {
  const said = s.state === "success" ? "passed" : s.state === "pending" ? "is running" : s.state === "failure" ? "failed" : "reported an error";
  return { text: `${s.context}: ${said}${s.description ? ` — ${s.description}` : ""}`, tone: s.state === "success" ? "ok" : s.state === "pending" ? "" : "warning" };
}
