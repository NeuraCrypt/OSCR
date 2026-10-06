// Issues in the reader's browser (night phase 05, E3): pure functions, no DOM, testable in Node
// (tests/forge-pages/issues.test.ts). The pages of phase 05 build on it: the list and the forms
// (repo-issues.ts), an issue (repo-issue.ts), the research issues (research.ts).
//
// Two kinds of issues (D00-6): GitHub's (read on the reader's own quota, written as the person, one
// authorization each: worker/forge/service/act-issues.ts) and the registry's research issues (its own,
// in D1: research-core.ts). One list shows both, as `IssueItem`s.
//
//   addresses      issues/?q=, issues/<n>, issues/new[/choose], labels, milestones, milestone/<n>;
//                  /research/<n>, /research/new
//   the query      GitHub's issue qualifiers, and the research ones (doi:, paper:, map-link:, path:,
//                  resolution:, outcome:), with AND, OR, parentheses, "-"; what GitHub's list endpoint
//                  can do, what needs its search; the match and the sorts over both kinds
//   words          states and reasons, research resolutions, timeline events, reactions
//   task lists     "- [ ]" items: progress, one ticked or unticked in the text
//   labels         the fixed palette (a hex colour → its nearest, never painted with a style
//                  attribute), GitHub's default labels and the research ones
//   writing        similar issues (lexical, no model), suggestions set by rule (with their reason),
//                  saved replies (kept in the browser), "@" and "#" completion, prefill by address
//
// Like every browser script, it never names the platform.

import { REACTION_WORDS } from "../../worker/forge/service/act-issues.ts";
import {
  OUTCOME_WORDS,
  RESOLUTION_WORDS,
  researchRefs,
  TYPE_WORDS,
  type IssueSummary,
  type ResearchEvent,
  type ResearchType,
  type Resolution,
} from "../../worker/forge/service/research-core.ts";
import type * as T from "../../worker/forge/types.ts";
import { repoPath, type RepoCoords } from "./forge.ts";
import { dateMatches, parseQuery, terms, type ParsedQuery, type QueryNode } from "./pulls.ts";

export { researchRefs };

// ─── addresses ───────────────────────────────────────────────────────────────

export type IssueTarget = { list: true } | { number: number } | { new: true } | { choose: true };

/** What the segments after issues/ name: the list, an issue, the form, the chooser. */
export function parseIssueTarget(rest: readonly string[]): IssueTarget | null {
  if (!rest.length) return { list: true };
  if (rest[0] === "new") return rest.length === 1 ? { new: true } : rest.length === 2 && rest[1] === "choose" ? { choose: true } : null;
  if (rest.length === 1 && /^[1-9][0-9]{0,9}$/.test(rest[0]) && Number(rest[0]) <= 2 ** 31) return { number: Number(rest[0]) };
  return null;
}

export const issuePath = (repo: RepoCoords, number: number): string => repoPath(repo, "issues", [String(number)]);
export const issuesPath = (repo: RepoCoords, q?: string): string => `${repoPath(repo, "issues")}${q ? `?${new URLSearchParams({ q })}` : ""}`;
export const chooserPath = (repo: RepoCoords): string => repoPath(repo, "issues", ["new", "choose"]);
export function newIssuePath(repo: RepoCoords, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `${repoPath(repo, "issues", ["new"])}${q ? `?${q}` : ""}`;
}
export const labelsPath = (repo: RepoCoords): string => repoPath(repo, "labels");
export const milestonesPath = (repo: RepoCoords): string => repoPath(repo, "milestones");
export const milestonePath = (repo: RepoCoords, number: number): string => repoPath(repo, "milestone", [String(number)]);

/** A research issue's page: one shell for all of them (public/_redirects: /research/* → /research/). */
export const researchPath = (id: number): string => `/research/${id}`;
export function newResearchPath(params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return `/research/new${q ? `?${q}` : ""}`;
}

export type ResearchTarget = { id: number } | { new: true } | { list: true };

/** What /research/… names: /research/12, /research/new, /research/ (a paper's list: ?paper=). */
export function parseResearchPath(pathname: string): ResearchTarget | null {
  const m = /^\/research\/?(?:([1-9][0-9]{0,9})|(new))?\/?$/.exec(pathname);
  if (!m) return null;
  if (m[1]) return Number(m[1]) <= 2 ** 31 ? { id: Number(m[1]) } : null;
  return m[2] ? { new: true } : { list: true };
}

// ─── one item for both kinds ─────────────────────────────────────────────────

export interface IssueItem {
  kind: "github" | "research";
  /** GitHub's number, or the research issue's. */
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  /** GitHub's close reason ("completed", "not_planned", "duplicate"), "" when open. */
  reason: string;
  resolution: "" | Resolution;
  author: string;
  labels: string[];
  assignees: string[];
  milestone: number | null;
  /** GitHub's type ("Bug"), or a research type. */
  type: string | null;
  research: ResearchType | null;
  locked: boolean;
  pinned: boolean;
  comments: number;
  reactions: number;
  reactionsBy: Partial<Record<T.Reaction, number>>;
  subIssues: { total: number; completed: number } | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Research: the paper ("doi:10.…"), the file, the lines, the paragraph. */
  paper: string | null;
  path: string | null;
  lines: { start: number; end: number } | null;
  paragraph: number | null;
  outcome: "failed" | "partially" | null;
  /** Research: the ordinary issue it was copied to. */
  copiedTo: number | null;
}

const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString());

export function fromGithub(i: T.Issue): IssueItem {
  const reactions = Object.values(i.reactions).reduce((n, x) => n + (x ?? 0), 0);
  return {
    kind: "github",
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    reason: i.state === "closed" ? (i.stateReason === "reopened" || !i.stateReason ? "completed" : i.stateReason) : "",
    resolution: "",
    author: i.author.login ?? "",
    labels: i.labels,
    assignees: i.assignees,
    milestone: i.milestone,
    type: i.type,
    research: null,
    locked: i.locked,
    pinned: i.pinned === true,
    comments: i.comments,
    reactions,
    reactionsBy: i.reactions,
    subIssues: i.subIssues,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    closedAt: i.closedAt,
    paper: null,
    path: null,
    lines: null,
    paragraph: null,
    outcome: null,
    copiedTo: null,
  };
}

export function fromResearch(r: IssueSummary): IssueItem {
  return {
    kind: "research",
    number: r.id,
    title: r.title,
    body: "",
    state: r.state,
    reason: r.close_reason,
    resolution: r.resolution,
    author: r.author,
    labels: r.labels,
    assignees: [],
    milestone: null,
    type: r.type,
    research: r.type,
    locked: r.locked,
    pinned: r.pinned,
    comments: r.comments,
    reactions: 0,
    reactionsBy: {},
    subIssues: null,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
    closedAt: iso(r.closed_at),
    paper: r.paper,
    path: r.anchor?.path || null,
    lines: r.anchor?.start ? { start: r.anchor.start, end: r.anchor.end ?? r.anchor.start } : null,
    paragraph: r.anchor?.paragraph ?? null,
    outcome: r.outcome,
    copiedTo: r.github_number,
  };
}

// ─── words ───────────────────────────────────────────────────────────────────

export const REASON_WORDS: Readonly<Record<string, string>> = { completed: "completed", not_planned: "not planned", duplicate: "a duplicate" };

/** The state in words: "Open", "Closed as completed", "Closed: fixed in the code". */
export function stateInWords(i: Pick<IssueItem, "state" | "reason" | "resolution">): string {
  if (i.state === "open") return "Open";
  if (i.resolution) return `Closed: ${RESOLUTION_WORDS[i.resolution]}`;
  return `Closed as ${REASON_WORDS[i.reason] ?? "completed"}`;
}

/** A type in words: GitHub's as it names it, a research one in the registry's words. */
export const typeInWords = (i: Pick<IssueItem, "type" | "research">): string | null => (i.research ? TYPE_WORDS[i.research] : i.type);

/** The research types' short names in queries: type:mismatch, type:reproduction, type:code-error. */
export const TYPE_QUERY: Readonly<Record<ResearchType, string>> = { code_error: "code-error", mismatch: "mismatch", reproduction: "reproduction" };

/** A reaction's character and its name (the page shows both; screen readers say the name). */
export const REACTIONS: readonly { key: T.Reaction; char: string; words: string }[] = (
  [["+1", "👍"], ["-1", "👎"], ["laugh", "😄"], ["hooray", "🎉"], ["confused", "😕"], ["heart", "❤️"], ["rocket", "🚀"], ["eyes", "👀"]] as const
).map(([key, char]) => ({ key, char, words: REACTION_WORDS[key] }));

/** One of GitHub's timeline events in words ("labelled data", "closed this as not planned"). */
export function eventInWords(e: T.TimelineEvent): string | null {
  const s = e.subject ?? "";
  switch (e.kind) {
    case "closed":
      return "closed this";
    case "reopened":
      return "reopened this";
    case "labeled":
      return `added the label “${s}”`;
    case "unlabeled":
      return `removed the label “${s}”`;
    case "assigned":
      return `assigned ${s}`;
    case "unassigned":
      return `unassigned ${s}`;
    case "milestoned":
      return `added this to the milestone “${s}”`;
    case "demilestoned":
      return `removed this from the milestone “${s}”`;
    case "renamed":
      return `changed the title to “${s}”`;
    case "locked":
      return `locked the conversation${s ? ` as ${s}` : ""}`;
    case "unlocked":
      return "unlocked the conversation";
    case "transferred":
      return `transferred this from ${s}`;
    case "cross-referenced":
      return `mentioned this in ${s}`;
    case "referenced":
      return `referenced this in the commit ${s.slice(0, 7)}`;
    case "merged":
      return "merged this";
    default:
      return null;
  }
}

/** One of a research issue's events in words. */
export function researchEventInWords(e: ResearchEvent): string {
  const s = e.s ?? "";
  switch (e.k) {
    case "closed": {
      const [reason, resolution, ...ref] = s.split(" ");
      const res = RESOLUTION_WORDS[resolution as Resolution];
      return `closed this${res ? `: ${res}` : ` as ${REASON_WORDS[reason] ?? "completed"}`}${ref.length ? ` (${ref.join(" ")})` : ""}`;
    }
    case "merged":
      return `closed this by merging the pull request ${s}: fixed in the code`;
    case "reopened":
      return "reopened this";
    case "renamed":
      return `changed the title (it was “${s}”)`;
    case "edited":
      return "edited the description";
    case "labeled":
      return `added the label “${s}”`;
    case "unlabeled":
      return `removed the label “${s}”`;
    case "locked":
      return `locked the conversation${s ? ` as ${s}` : ""}`;
    case "unlocked":
      return "unlocked the conversation";
    case "pinned":
      return "pinned this";
    case "unpinned":
      return "unpinned this";
    case "copied":
      return `copied this to GitHub as the issue ${s}`;
    default:
      return "changed this";
  }
}

export const outcomeInWords = (o: "failed" | "partially"): string => OUTCOME_WORDS[o];

// ─── the query ───────────────────────────────────────────────────────────────

/** The qualifiers the registry reads for issues (GitHub's names, and the research ones). */
export const ISSUE_QUALIFIERS = [
  "is", "state", "reason", "author", "assignee", "mentions", "commenter", "involves", "label", "milestone", "no", "has", "type",
  "sort", "created", "updated", "closed", "comments", "reactions", "interactions", "in", "linked", "doi", "paper", "map-link",
  "path", "resolution", "outcome",
] as const;

/** What only GitHub's search answers for its issues (comments, people involved, links). */
const SEARCH_ONLY = new Set(["commenter", "involves", "mentions", "linked", "in"]);
/** What only research issues have. */
const RESEARCH_ONLY = new Set(["doi", "paper", "map-link", "path", "resolution", "outcome"]);

export const DEFAULT_ISSUE_QUERY = "is:issue is:open";

export const parseIssueQuery = (q: string): ParsedQuery => parseQuery(q, ISSUE_QUALIFIERS);

export interface IssuePlan {
  state: "open" | "closed" | "all";
  /** GitHub's list endpoint's own filters (AND of labels; one milestone, assignee, creator). */
  labels: string[];
  milestone: string | null;
  assignee: string | null;
  creator: string | null;
  sort: "created" | "updated" | "comments" | "reactions" | "interactions" | "best-match";
  reaction: T.Reaction | null;
  direction: "asc" | "desc";
  /** The query needs GitHub's search (10 a minute). */
  search: boolean;
  /** Which kinds the query can match. */
  github: boolean;
  research: boolean;
}

export function planIssueQuery(parsed: ParsedQuery): IssuePlan {
  const all = terms(parsed.node);
  const top = all.filter((t) => !t.nested && !t.negated);
  const is = top.filter((t) => t.key === "is" || t.key === "state").map((t) => t.value.toLowerCase());
  const state = is.includes("closed") ? (is.includes("open") ? "all" : "closed") : is.includes("open") ? "open" : "all";
  const one = (key: string) => top.find((t) => t.key === key)?.value ?? null;
  const sortText = (one("sort") ?? "created-desc").toLowerCase();
  const m = /^(created|updated|comments|reactions|interactions|best-match)(?:-(\+1|-1|laugh|confused|heart|hooray|rocket|eyes))?(?:-(asc|desc))?$/.exec(sortText);
  const typeValues = top.filter((t) => t.key === "type").map((t) => t.value.toLowerCase());
  const researchTypes = new Set(Object.values(TYPE_QUERY));
  const onlyResearch = is.includes("research") || top.some((t) => RESEARCH_ONLY.has(t.key)) || (typeValues.length > 0 && typeValues.every((v) => researchTypes.has(v) || v === "research"));
  const noResearch = all.some((t) => t.key === "is" && t.value.toLowerCase() === "research" && t.negated && !t.nested) || is.includes("github") || top.some((t) => SEARCH_ONLY.has(t.key) || t.key === "milestone" || t.key === "assignee");
  const milestone = one("milestone");
  return {
    state,
    labels: top.filter((t) => t.key === "label" && !t.value.includes(",")).map((t) => t.value),
    milestone: milestone && milestone.toLowerCase() !== "none" ? milestone : null,
    assignee: one("assignee"),
    creator: one("author"),
    sort: (m?.[1] as IssuePlan["sort"]) ?? "created",
    reaction: (m?.[2] as T.Reaction | undefined) ?? null,
    direction: m?.[3] === "asc" ? "asc" : "desc",
    search: all.some((t) => SEARCH_ONLY.has(t.key)),
    github: !onlyResearch,
    research: !noResearch,
  };
}

/** A count condition: "3", ">3", ">=3", "<3", "1..5". */
export function countMatches(n: number, cond: string): boolean {
  const range = /^(\d+)\.\.(\d+|\*)$/.exec(cond);
  if (range) return n >= Number(range[1]) && (range[2] === "*" || n <= Number(range[2]));
  const m = /^(>=|<=|>|<)?(\d+)$/.exec(cond);
  if (!m) return true;
  const [, op = "", v] = m;
  const x = Number(v);
  return op === ">" ? n > x : op === ">=" ? n >= x : op === "<" ? n < x : op === "<=" ? n <= x : n === x;
}

export interface IssueMatchContext {
  me?: string | null;
  /** Milestones by number, for milestone:"title". */
  milestones?: ReadonlyMap<number, string>;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, "-");

/** Whether an issue matches a query node. Qualifiers only GitHub's search answers are taken as
 *  matching (the page asked the search for them); research qualifiers never match GitHub's issues. */
export function matchIssue(i: IssueItem, node: QueryNode, ctx: IssueMatchContext = {}): boolean {
  const who = (v: string) => (v.toLowerCase() === "@me" ? (ctx.me ?? "").toLowerCase() : v.toLowerCase().replace(/^@/, ""));
  switch (node.op) {
    case "and":
      return node.items.every((x) => matchIssue(i, x, ctx));
    case "or":
      return node.items.some((x) => matchIssue(i, x, ctx));
    case "not":
      return !matchIssue(i, node.item, ctx);
    case "text": {
      const t = node.value.toLowerCase();
      if (!t) return true;
      if (/^#\d+$/.test(t) || /^research#\d+$/.test(t)) return String(i.number) === t.replace(/^(?:research)?#/, "") && (t.startsWith("research") === (i.kind === "research"));
      return i.title.toLowerCase().includes(t) || i.body.toLowerCase().includes(t);
    }
    case "term": {
      const v = node.value.toLowerCase();
      switch (node.key) {
        case "is":
        case "state":
          if (v === "issue") return true;
          if (v === "pr" || v === "pull-request") return false;
          if (v === "open") return i.state === "open";
          if (v === "closed") return i.state === "closed";
          if (v === "locked") return i.locked;
          if (v === "unlocked") return !i.locked;
          if (v === "pinned") return i.pinned;
          if (v === "research") return i.kind === "research";
          if (v === "github") return i.kind === "github";
          return true;
        case "reason":
          return norm(i.reason) === norm(v.replace(/^"|"$/g, ""));
        case "resolution":
          return i.resolution !== "" && norm(i.resolution) === norm(v);
        case "author":
          return i.author.toLowerCase() === who(node.value);
        case "assignee":
          return v === "*" ? i.assignees.length > 0 : i.assignees.some((a) => a.toLowerCase() === who(node.value));
        case "label":
          return node.value.split(",").some((l) => i.labels.some((x) => x.toLowerCase() === l.trim().toLowerCase()));
        case "milestone": {
          if (v === "none") return i.milestone === null;
          if (i.milestone === null) return false;
          const title = ctx.milestones?.get(i.milestone);
          return String(i.milestone) === v || (title !== undefined && title.toLowerCase() === v);
        }
        case "type": {
          if (v === "research") return i.kind === "research";
          if (i.research) return TYPE_QUERY[i.research] === v || i.research === v;
          return (i.type ?? "").toLowerCase() === v;
        }
        case "no":
          return v === "label" ? !i.labels.length : v === "assignee" ? !i.assignees.length : v === "milestone" ? i.milestone === null : v === "type" ? !i.type : v === "sub-issues" ? !i.subIssues?.total : true;
        case "has":
          return v === "label" ? i.labels.length > 0 : v === "assignee" ? i.assignees.length > 0 : v === "milestone" ? i.milestone !== null : v === "type" ? !!i.type : v === "sub-issues" ? !!i.subIssues?.total : v === "map-link" ? i.paragraph !== null && !!i.path : true;
        case "created":
          return dateMatches(i.createdAt, node.value);
        case "updated":
          return dateMatches(i.updatedAt, node.value);
        case "closed":
          return dateMatches(i.closedAt, node.value);
        case "comments":
          return countMatches(i.comments, node.value);
        case "reactions":
          return countMatches(i.reactions, node.value);
        case "interactions":
          return countMatches(i.reactions + i.comments, node.value);
        case "doi":
        case "paper":
          return i.paper !== null && i.paper.replace(/^doi:/, "") === v.replace(/^doi:/, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
        case "path":
          return i.path !== null && (i.path.toLowerCase() === v || i.path.toLowerCase().startsWith(v.endsWith("/") ? v : `${v}/`));
        case "map-link": {
          // "14" (a paragraph), "src/filter.py" (a file), "14:src/filter.py" (both).
          if (i.paragraph === null || !i.path) return false;
          const [a, b] = v.includes(":") ? v.split(":", 2) : /^\d+$/.test(v) ? [v, ""] : ["", v];
          return (!a || String(i.paragraph) === a) && (!b || i.path.toLowerCase() === b);
        }
        case "outcome":
          return i.outcome !== null && (i.outcome === v || norm(OUTCOME_WORDS[i.outcome]) === norm(v));
        default:
          return true;
      }
    }
  }
}

/** The free words of a query, for "best match". */
export function queryWords(node: QueryNode): string[] {
  if (node.op === "text") return node.value ? [node.value.toLowerCase()] : [];
  if (node.op === "and" || node.op === "or") return node.items.flatMap(queryWords);
  return [];
}

/** The list's order: pinned first (as GitHub shows them above the list), then the sort. */
export function sortIssues(items: readonly IssueItem[], plan: Pick<IssuePlan, "sort" | "direction" | "reaction">, words: readonly string[] = []): IssueItem[] {
  const score = (i: IssueItem): number => {
    switch (plan.sort) {
      case "updated":
        return Date.parse(i.updatedAt);
      case "comments":
        return i.comments;
      case "reactions":
        return plan.reaction ? (i.reactionsBy[plan.reaction] ?? 0) : i.reactions;
      case "interactions":
        return i.comments + i.reactions;
      case "best-match":
        return words.reduce((n, w) => n + (i.title.toLowerCase().includes(w) ? 3 : 0) + (i.body.toLowerCase().includes(w) ? 1 : 0), 0);
      default:
        return Date.parse(i.createdAt);
    }
  };
  const out = [...items].sort((a, b) => score(a) - score(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (plan.direction === "desc") out.reverse();
  return [...out.filter((i) => i.pinned && i.state === "open"), ...out.filter((i) => !(i.pinned && i.state === "open"))];
}

/** The query for GitHub's search: the reader's, scoped to issues, without the registry's own
 *  qualifiers (the backend adds repo:). */
export function issueSearchQuery(q: string): string {
  const kept = q
    .replace(/(?:^|\s)-?(?:is:(?:research|github)|type:(?:research|mismatch|reproduction|code-error)|(?:doi|paper|map-link|path|resolution|outcome):(?:"[^"]*"|\S+))/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /(^|\s)(is|type):(issue)\b/.test(kept) ? kept : `is:issue ${kept}`.trim();
}

// ─── task lists ──────────────────────────────────────────────────────────────

export interface Task {
  /** The task's line in the text (0-based). */
  line: number;
  checked: boolean;
  text: string;
  /** "#12" or "research#3" when the task is an issue (it completes when that issue closes). */
  ref: string | null;
}

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/;

/** The task list items of a Markdown text, outside code blocks. */
export function tasksOf(text: string): Task[] {
  const out: Task[] = [];
  let fence: string | null = null;
  text.split("\n").forEach((line, n) => {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) {
      fence = fence === null ? f[1] : fence === f[1] ? null : fence;
      return;
    }
    if (fence !== null) return;
    const m = TASK.exec(line);
    if (!m) return;
    const ref = /^(?:(research)#|#)(\d+)\s*$/.exec(m[4].trim());
    out.push({ line: n, checked: m[2] !== " ", text: m[4], ref: ref ? `${ref[1] ? "research" : ""}#${ref[2]}` : null });
  });
  return out;
}

export function taskProgress(text: string): { done: number; total: number } {
  const t = tasksOf(text);
  return { done: t.filter((x) => x.checked).length, total: t.length };
}

/** The text with the index-th task ticked or unticked (the rest unchanged, line for line); null when
 *  there is no such task. */
export function toggleTask(text: string, index: number, checked: boolean): string | null {
  const t = tasksOf(text)[index];
  if (!t) return null;
  const lines = text.split("\n");
  lines[t.line] = lines[t.line].replace(TASK, (_, a: string, _b: string, c: string, d: string) => `${a}${checked ? "x" : " "}${c}${d}`);
  return lines.join("\n");
}

export const progressInWords = (p: { done: number; total: number }): string => (p.total ? `${p.done} of ${p.total} ${p.total === 1 ? "task" : "tasks"} done` : "");

// ─── labels: the palette, the defaults ───────────────────────────────────────

/** The fixed palette: science.css paints `[data-color="<name>"]`, never a style attribute. */
export const PALETTE: readonly { name: string; hex: string }[] = [
  { name: "red", hex: "d73a4a" },
  { name: "orange", hex: "e99695" },
  { name: "amber", hex: "fbca04" },
  { name: "yellow", hex: "e4e669" },
  { name: "lime", hex: "c2e0c6" },
  { name: "green", hex: "0e8a16" },
  { name: "teal", hex: "008672" },
  { name: "cyan", hex: "a2eeef" },
  { name: "blue", hex: "0075ca" },
  { name: "navy", hex: "1d76db" },
  { name: "violet", hex: "7057ff" },
  { name: "purple", hex: "d876e3" },
  { name: "pink", hex: "f9d0c4" },
  { name: "brown", hex: "8a5a2b" },
  { name: "gray", hex: "cfd3d7" },
  { name: "white", hex: "ffffff" },
];

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];

/** The palette's colour nearest a label's hex (GitHub's, or an import's). */
export function paletteOf(hex: string): string {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return "gray";
  const [r, g, b] = rgb(hex.toLowerCase());
  let best = PALETTE[0];
  let d = Infinity;
  for (const p of PALETTE) {
    const [pr, pg, pb] = rgb(p.hex);
    // A weighted distance, closer to how colours are seen than the plain one.
    const x = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
    if (x < d) {
      d = x;
      best = p;
    }
  }
  return best.name;
}

export const hexOf = (name: string): string => PALETTE.find((p) => p.name === name)?.hex ?? "cfd3d7";

/** GitHub's ten default labels, with its colours and descriptions, and the registry's three for
 *  research code. */
export const DEFAULT_LABELS: readonly { name: string; color: string; description: string }[] = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "documentation", color: "0075ca", description: "Improvements or additions to documentation" },
  { name: "duplicate", color: "cfd3d7", description: "This issue or pull request already exists" },
  { name: "enhancement", color: "a2eeef", description: "New feature or request" },
  { name: "good first issue", color: "7057ff", description: "Good for newcomers" },
  { name: "help wanted", color: "008672", description: "Extra attention is needed" },
  { name: "invalid", color: "e4e669", description: "This doesn't seem right" },
  { name: "question", color: "d876e3", description: "Further information is requested" },
  { name: "wontfix", color: "ffffff", description: "This will not be worked on" },
  { name: "accessibility", color: "0e8a16", description: "Accessibility of the software" },
  { name: "data", color: "1d76db", description: "The data the code reads or writes" },
  { name: "environment", color: "fbca04", description: "Versions, packages, the system the code runs on" },
  { name: "numerical difference", color: "e99695", description: "Results differ from the paper's numbers" },
];

/** The defaults a repository lacks (by name, in any case). */
export const missingDefaults = (have: readonly Pick<T.Label, "name">[]): typeof DEFAULT_LABELS => {
  const names = new Set(have.map((l) => l.name.toLowerCase()));
  return DEFAULT_LABELS.filter((l) => !names.has(l.name.toLowerCase()));
};

/** Labels suggested first in a picker: the ones used most on the issues read, then the rest. */
export function suggestedLabels(labels: readonly T.Label[], issues: readonly Pick<IssueItem, "labels">[]): T.Label[] {
  const used = new Map<string, number>();
  for (const i of issues) for (const l of i.labels) used.set(l.toLowerCase(), (used.get(l.toLowerCase()) ?? 0) + 1);
  return [...labels].sort((a, b) => (used.get(b.name.toLowerCase()) ?? 0) - (used.get(a.name.toLowerCase()) ?? 0) || a.name.localeCompare(b.name));
}

// ─── writing: similar issues, suggestions set by rule ────────────────────────

const STOP = new Set(
  "a an and are as at be but by can do does for from has have how i if in is it its not of on or our so that the their them then there these this to was we what when where which while why will with you your".split(" "),
);

/** A text's words for comparing issues: lower case, no stop words, a plural's "s" dropped. */
export function wordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9]{2,}/g) ?? []) {
    if (STOP.has(w)) continue;
    out.add(w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  }
  return out;
}

/** Issues like a draft (its title and text), by shared words: lexical, computed in the browser, no
 *  model (the Mac's nightly "similar issues" are phase 08's). Research issues on the same file or
 *  paragraph weigh more. */
export function similarIssues(draft: { title: string; body?: string; path?: string | null; paragraph?: number | null }, items: readonly IssueItem[], limit = 5): { item: IssueItem; score: number }[] {
  const a = wordsOf(`${draft.title} ${draft.title} ${draft.body ?? ""}`.slice(0, 5000));
  if (a.size < 2) return [];
  const out: { item: IssueItem; score: number }[] = [];
  for (const item of items) {
    const b = wordsOf(`${item.title} ${item.title} ${item.body}`.slice(0, 5000));
    if (!b.size) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    let score = shared / (a.size + b.size - shared);
    if (draft.path && item.path === draft.path) score += 0.15;
    if (draft.paragraph && item.paragraph === draft.paragraph) score += 0.15;
    if (score >= 0.2) out.push({ item, score });
  }
  return out.sort((x, y) => y.score - x.score || y.item.number - x.item.number).slice(0, limit);
}

export interface RuleSuggestion {
  field: "type" | "label";
  value: string;
  /** The rule, in words: what in the text set it. */
  reason: string;
  /** Always "rule" here; "model" is the Mac's (the owner's rule: rules first). */
  source: "rule";
}

const RULES: readonly { field: "type" | "label"; value: string; test: RegExp; reason: string }[] = [
  { field: "type", value: "mismatch", test: /\b(?:paper says|the paper|in the paper|equation|eq\.|methods? section)\b[\s\S]{0,200}\b(?:code|implementation|script)\b|\bparagraph\s+\d+/i, reason: "it compares what the paper says with what the code does" },
  { field: "type", value: "reproduction", test: /\b(?:reproduc\w*|replicat\w*|(?:figure|fig\.|table)\s+\d+\b[\s\S]{0,120}\b(?:differ|different|not the same|does not match|doesn't match|could not|cannot)|results? (?:differ|do not match|don't match))/i, reason: "it says a result of the paper did not come out" },
  { field: "type", value: "code_error", test: /\b(?:traceback|exception|segmentation fault|off[- ]by[- ]one|wrong (?:index|sign|unit|constant)|typo in the code)\b/i, reason: "it names an error of the code" },
  { field: "label", value: "data", test: /\b(?:datasets?|data (?:file|set|download)|openneuro|zenodo record|the data)\b/i, reason: "it is about the data" },
  { field: "label", value: "environment", test: /\b(?:version|numpy|scipy|pandas|matlab|r \d|python \d|requirements\.txt|environment\.yml|conda|docker|dependenc\w*)\b/i, reason: "it names versions or packages" },
  { field: "label", value: "numerical difference", test: /\b(?:rounding|precision|numerical(?:ly)?|decimal|differs? (?:by|from)|\d+\.\d+ instead of \d+\.\d+)\b/i, reason: "it reports numbers that differ" },
];

/** Suggestions set by rule for a draft, each with its reason: never applied without the person, who
 *  accepts or declines each ("Automated-decision transparency"). */
export function ruleSuggestions(text: string, have: { type?: string | null; labels?: readonly string[] } = {}): RuleSuggestion[] {
  const out: RuleSuggestion[] = [];
  const labels = new Set((have.labels ?? []).map((l) => l.toLowerCase()));
  for (const r of RULES) {
    if (!r.test.test(text.slice(0, 20_000))) continue;
    if (r.field === "type" && (have.type || out.some((s) => s.field === "type"))) continue;
    if (r.field === "label" && labels.has(r.value)) continue;
    out.push({ field: r.field, value: r.value, reason: r.reason, source: "rule" });
  }
  return out;
}

export const suggestionInWords = (s: RuleSuggestion): string =>
  `${s.field === "type" ? `The type “${TYPE_WORDS[s.value as ResearchType] ?? s.value}”` : `The label “${s.value}”`}, set by rule: ${s.reason}.`;

// ─── saved replies ───────────────────────────────────────────────────────────

export const REPLIES_KEY = "oscr-replies";
export const REPLIES_MAX = 100;

export interface SavedReply {
  name: string;
  body: string;
  builtIn?: boolean;
}

/** GitHub's built-in reply, and the registry's research ones. */
export const BUILT_IN_REPLIES: readonly SavedReply[] = [
  { name: "Duplicate issue", body: "Duplicate of #", builtIn: true },
  { name: "Environment requested", body: "Could you attach your environment: the system, the language's version and the packages (a lock file, or `pip freeze`, `conda env export`, `sessionInfo()`)?", builtIn: true },
  { name: "Reproduction report requested", body: "Could you file a reproduction report: the commit you ran, the data, the command, what the paper reports and what came out?", builtIn: true },
  { name: "Which commit?", body: "Which commit did you run? Its full id is on the repository's page, beside the latest commit.", builtIn: true },
];

type Store = Pick<Storage, "getItem" | "setItem"> | null;

/** The reader's saved replies (this browser only: GitHub's are an account's, and have no API). */
export function readReplies(store: Store): SavedReply[] {
  try {
    const v = JSON.parse(store?.getItem(REPLIES_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((r): r is SavedReply => !!r && typeof r.name === "string" && typeof r.body === "string").slice(0, REPLIES_MAX) : [];
  } catch {
    return [];
  }
}

/** A reply saved (replacing one of the same name); false when it cannot be kept. */
export function saveReply(store: Store, reply: SavedReply): boolean {
  const name = reply.name.trim().slice(0, 100);
  if (!name || !reply.body.trim() || reply.body.length > 65_536) return false;
  const list = readReplies(store).filter((r) => r.name !== name);
  if (list.length >= REPLIES_MAX) return false;
  try {
    store?.setItem(REPLIES_KEY, JSON.stringify([...list, { name, body: reply.body }]));
    return !!store;
  } catch {
    return false;
  }
}

export function deleteReply(store: Store, name: string): void {
  try {
    store?.setItem(REPLIES_KEY, JSON.stringify(readReplies(store).filter((r) => r.name !== name)));
  } catch {
    // kept
  }
}

/** Whether a comment is only a "+1" (GitHub's nudge: a reaction says it better). */
export const isPlusOne = (text: string): boolean => /^\s*(?:\+1|👍|me too|same here|same issue|same problem)[\s.!]*$/i.test(text);

/** A quoted reply: each line of the text after "> ". */
export const quoteReply = (text: string): string => `${text.trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;

// ─── "@" and "#" completion ──────────────────────────────────────────────────

/** What is being completed at the caret: "@ada" (a person), "#12" or "#filter" (an issue), or null. */
export function completionAt(text: string, caret: number): { kind: "@" | "#"; query: string; start: number } | null {
  const before = text.slice(Math.max(0, caret - 60), caret);
  const m = /(?:^|[\s(])([@#])([A-Za-z0-9_-]{0,39})$/.exec(before);
  if (!m) return null;
  return { kind: m[1] as "@" | "#", query: m[2], start: caret - m[2].length - 1 };
}

/** The issues whose number or title starts with / holds the query, newest first. */
export function issueCompletions(query: string, items: readonly IssueItem[], limit = 8): IssueItem[] {
  const q = query.toLowerCase();
  return items
    .filter((i) => (q === "" ? true : String(i.number).startsWith(q) || i.title.toLowerCase().includes(q)))
    .sort((a, b) => b.number - a.number)
    .slice(0, limit);
}

/** The people who took part (authors, assignees), matching the query: the only people "@" offers
 *  (the registry lists no one else, and never an address). */
export function personCompletions(query: string, people: Iterable<string>, limit = 8): string[] {
  const q = query.toLowerCase();
  return [...new Set([...people].filter((p) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(p)))].filter((p) => p.toLowerCase().startsWith(q)).sort().slice(0, limit);
}

// ─── prefill by address ──────────────────────────────────────────────────────

export interface IssuePrefill {
  title: string | null;
  body: string | null;
  template: string | null;
  labels: string[];
  assignees: string[];
  milestone: number | null;
  type: string | null;
  /** A sub-issue of this issue ("Create sub-issue"). */
  parent: number | null;
  /** Research: the paper, the code, where. */
  doi: string | null;
  repo: string | null;
  commit: string | null;
  path: string | null;
  lines: { start: number; end: number } | null;
  paragraph: number | null;
  section: string | null;
}

/** GitHub's query parameters of the new-issue page (title, body, labels, milestone, assignees,
 *  template, type), and the registry's (doi, repo, commit, path, lines, paragraph, section), each
 *  checked. No parameter carries personal data. */
export function issuePrefillOf(search: string): IssuePrefill {
  const q = new URLSearchParams(search);
  const text = (k: string, max: number) => {
    const v = q.get(k);
    return v !== null && v.length <= max ? v : null;
  };
  const template = text("template", 200);
  const lines = text("lines", 30);
  const lm = lines ? /^L?(\d{1,7})(?:-L?(\d{1,7}))?$/.exec(lines) : null;
  const doi = text("doi", 220)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:/i, "") ?? null;
  const commit = text("commit", 64);
  const path = text("path", 500);
  const milestone = text("milestone", 12);
  const paragraph = text("paragraph", 7);
  const parent = text("parent", 12);
  return {
    title: text("title", 256)?.replace(/[\r\n]+/g, " ") ?? null,
    body: text("body", 65_536),
    template: template && /^[A-Za-z0-9._ -]+\.(?:md|ya?ml)$/i.test(template) ? template : template && /^research:(?:mismatch|reproduction|code_error)$/.test(template) ? template : null,
    labels: (q.get("labels") ?? "").split(",").map((s) => s.trim()).filter((s) => s && s.length <= 50).slice(0, 20),
    assignees: (q.get("assignees") ?? "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(s)).slice(0, 10),
    milestone: milestone && /^[1-9]\d{0,9}$/.test(milestone) ? Number(milestone) : null,
    type: text("type", 50),
    parent: parent && /^[1-9]\d{0,9}$/.test(parent) ? Number(parent) : null,
    doi: doi && /^10\.\d{4,9}\/\S+$/.test(doi) ? doi.toLowerCase() : null,
    repo: text("repo", 140),
    commit: commit && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) ? commit : null,
    path: path && !path.startsWith("/") && !path.split("/").some((s) => !s || s === "." || s === "..") ? path : null,
    lines: lm ? { start: Number(lm[1]), end: Number(lm[2] ?? lm[1]) } : null,
    paragraph: paragraph && /^[1-9]\d{0,6}$/.test(paragraph) ? Number(paragraph) : null,
    section: text("section", 200),
  };
}
