// An issue's page (night phase 05, E5): pure, no DOM, testable in Node
// (tests/forge-pages/issue-page.test.ts). The script (src/scripts/repo-issue.ts) reads GitHub on the
// reader's quota and shows these view trees through src/scripts/dom.ts.
//
// - the header: the title and number, the state in words (and its reason), who opened it and when,
//   the type, the lock;
// - the timeline: the description, the comments and GitHub's events in time order, each event in
//   words;
// - reactions: each of GitHub's eight as its character and its name, with the count;
// - the sidebar's parts: assignees, labels, type, milestone and its progress, relationships
//   (sub-issues and their progress, what blocks it), development (the branch GitHub would name, the
//   mentions), the participants.
// - what a closed issue says: "Closed as not planned", "Duplicate of #n".

import type * as T from "../../worker/forge/types.ts";
import { plural } from "./format.ts";
import type { RepoCoords } from "./forge.ts";
import { dayOf, labelsLine, milestoneInWords } from "./issue-view.ts";
import { eventInWords, issuePath, REACTIONS, REASON_WORDS, stateInWords, taskProgress, progressInWords, fromGithub } from "./issues.ts";
import { type El, h } from "./repo-view.ts";

const who = (a: T.Actor | null | undefined): string => a?.login ?? a?.name ?? "someone";

/** The header: title, number, state in words with its reason, who opened it, the type, the lock. */
export function issueHeader(i: T.Issue): El {
  const item = fromGithub(i);
  const tasks = taskProgress(i.body);
  return h(
    "div",
    { class: "pull-head issue-head" },
    h("h2", null, i.title, " ", h("span", { class: "pull-number" }, `#${i.number}`)),
    h(
      "p",
      { class: "status-line" },
      h("span", { class: `issue-state${i.state === "open" ? "" : " muted"}` }, stateInWords(item)),
      i.type ? ` · ${i.type}` : "",
      ` · opened ${dayOf(i.createdAt)} by ${who(i.author)}`,
      i.comments ? ` · ${plural(i.comments, "comment")}` : "",
      tasks.total ? ` · ${progressInWords(tasks)}` : "",
      i.locked ? ` · locked${i.lockReason ? ` as ${i.lockReason}` : ""}: only collaborators comment` : "",
    ),
  );
}

export type IssueTimelineItem = { kind: "comment"; at: string; comment: T.IssueComment } | { kind: "event"; at: string; event: T.TimelineEvent };

/** The comments and the events worth saying, in time order (a comment's own "commented" event is the
 *  comment). */
export function issueTimeline(comments: readonly T.IssueComment[], events: readonly T.TimelineEvent[]): IssueTimelineItem[] {
  const out: IssueTimelineItem[] = comments.map((c) => ({ kind: "comment" as const, at: c.createdAt, comment: c }));
  for (const e of events) if (e.kind !== "commented" && eventInWords(e)) out.push({ kind: "event", at: e.createdAt, event: e });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** An event in one line: "ada-fixture added the label “data” on 2026-09-28". */
export function eventLine(e: T.TimelineEvent, repo: RepoCoords): El {
  const words = eventInWords(e) ?? "changed this";
  // "mentioned this in owner/name#12": the registry's page of that issue, when it is this repository.
  const m = e.kind === "cross-referenced" && e.subject ? /^([^/]+)\/([^#]+)#(\d+)$/.exec(e.subject) : null;
  const here = m && m[1].toLowerCase() === repo.owner.toLowerCase() && m[2].toLowerCase() === repo.name.toLowerCase();
  return h(
    "p",
    { class: "timeline-event" },
    h("strong", null, who(e.actor)),
    " ",
    here && m ? ["mentioned this in ", h("a", { href: issuePath(repo, Number(m[3])) }, `#${m[3]}`)] : words,
    e.createdAt ? ` on ${dayOf(e.createdAt)}` : "",
  );
}

/** Reactions in words and characters: "👍 thumbs up 3 · 👀 eyes 1" (none: null). */
export function reactionsLine(r: Partial<Record<T.Reaction, number>>): El | null {
  const shown = REACTIONS.filter((x) => (r[x.key] ?? 0) > 0);
  if (!shown.length) return null;
  return h(
    "p",
    { class: "reactions", "aria-label": "Reactions" },
    ...shown.flatMap((x, i) => [i ? " · " : "", h("span", { class: "reaction", title: x.words }, `${x.char} ${x.words} ${r[x.key]}`)]),
  );
}

/** What closed it, in words, from its reason and the "Duplicate of #n" comment GitHub reads. */
export function closedInWords(i: Pick<T.Issue, "state" | "stateReason" | "closedAt">, comments: readonly T.IssueComment[]): string | null {
  if (i.state !== "closed") return null;
  const reason = REASON_WORDS[i.stateReason && i.stateReason !== "reopened" ? i.stateReason : "completed"] ?? "completed";
  const dup = i.stateReason === "duplicate" ? comments.map((c) => /^\s*Duplicate of #(\d+)\s*$/i.exec(c.body)).find((m) => m) : null;
  return `Closed as ${reason}${dup ? `: a duplicate of #${dup[1]}` : ""}${i.closedAt ? ` on ${dayOf(i.closedAt)}` : ""}.`;
}

/** The people who took part: the author, the commenters, the assignees (GitHub logins only). */
export function participants(i: T.Issue, comments: readonly T.IssueComment[]): string[] {
  const out = new Set<string>();
  for (const l of [i.author.login, ...comments.map((c) => c.author.login), ...i.assignees]) if (l) out.add(l);
  return [...out];
}

export interface SidebarFacts {
  colors: ReadonlyMap<string, string>;
  milestone: T.Milestone | null;
  subIssues: T.Issue[];
  blockedBy: T.Issue[];
  people: string[];
  /** The branch GitHub names for it, when it exists. */
  branch: string | null;
  /** Issues and pull requests that mention it (from the timeline). */
  mentions: string[];
}

/** The sidebar's facts, each in words (the actions are the script's). */
export function sidebarFacts(repo: RepoCoords, i: T.Issue, f: SidebarFacts, labelsHref: (name: string) => string): El[] {
  const out: El[] = [];
  out.push(h("h3", null, "Assignees"), h("p", { class: "summary-line" }, i.assignees.length ? i.assignees.join(", ") : "Nobody yet."));
  out.push(h("h3", null, "Labels"), h("p", { class: "summary-line" }, ...(i.labels.length ? labelsLine(i.labels, f.colors, labelsHref).slice(1) : ["None yet."])));
  out.push(h("h3", null, "Type"), h("p", { class: "summary-line" }, i.type ?? "None (issue types are an organization's)."));
  out.push(h("h3", null, "Milestone"), h("p", { class: "summary-line" }, f.milestone ? [h("a", { href: `/r/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/milestone/${f.milestone.number}` }, f.milestone.title), `: ${milestoneInWords(f.milestone)}`] : i.milestone !== null ? `#${i.milestone}` : "None."));
  const rel: El[] = [];
  if (f.subIssues.length) {
    const done = f.subIssues.filter((s) => s.state === "closed").length;
    rel.push(h("p", { class: "summary-line" }, `Sub-issues: ${done} of ${f.subIssues.length} closed.`));
    rel.push(h("ul", { class: "sub-issues" }, ...f.subIssues.map((s) => h("li", null, h("a", { href: issuePath(repo, s.number) }, `#${s.number} ${s.title}`), s.state === "closed" ? " (closed)" : ""))));
  }
  if (f.blockedBy.length) {
    const open = f.blockedBy.filter((b) => b.state === "open").length;
    rel.push(h("p", { class: `summary-line${open ? " warning" : ""}` }, open ? `Blocked: ${plural(open, "issue")} it waits for ${open === 1 ? "is" : "are"} still open.` : "Nothing blocks it now."));
    rel.push(h("ul", { class: "sub-issues" }, ...f.blockedBy.map((b) => h("li", null, "Blocked by ", h("a", { href: issuePath(repo, b.number) }, `#${b.number} ${b.title}`), b.state === "closed" ? " (closed)" : ""))));
  }
  out.push(h("h3", null, "Relationships"), ...(rel.length ? rel : [h("p", { class: "summary-line" }, "No sub-issue, nothing blocks it.")]));
  const dev: El[] = [];
  if (f.branch) dev.push(h("p", { class: "summary-line" }, "Its branch: ", h("a", { href: `/r/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/tree/${f.branch.split("/").map(encodeURIComponent).join("/")}` }, f.branch), "."));
  if (f.mentions.length) dev.push(h("p", { class: "summary-line" }, `Mentioned in ${f.mentions.join(", ")}. A pull request that says “Fixes #${i.number}” closes it when it merges into the default branch.`));
  out.push(h("h3", null, "Development"), ...(dev.length ? dev : [h("p", { class: "summary-line" }, `No branch or pull request yet. A pull request that says “Fixes #${i.number}” closes it on merge.`)]));
  out.push(h("h3", null, "Participants"), h("p", { class: "summary-line" }, f.people.join(", ") || "Nobody yet."));
  return out;
}

/** The mentions a timeline holds, as "#12" (this repository) or "owner/name#12". */
export function mentionsOf(events: readonly T.TimelineEvent[], repo: RepoCoords): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind !== "cross-referenced" || !e.subject) continue;
    const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(e.subject);
    const name = m && m[1].toLowerCase() === repo.owner.toLowerCase() && m[2].toLowerCase() === repo.name.toLowerCase() ? `#${m[3]}` : e.subject;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
