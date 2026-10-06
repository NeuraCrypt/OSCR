// Pull requests in the reader's browser (night phase 04, E2): pure functions, no DOM, testable in
// Node (tests/forge-pages/pulls.test.ts). The pages of phase 04 build on it: the list (repo-pulls.ts),
// the pull request (repo-pull.ts), its files (repo-pull-files.ts) and its conflicts
// (repo-conflicts.ts). Pull requests are GitHub's objects (D00-6), read on the reader's own quota;
// every write is one authorized action (worker/forge/service/act-pulls.ts).
//
//   addresses      pull/<n>[/files|commits|checks|conflicts], pull/new/<branch>, pulls?q=, fork, forks
//   the list       GitHub's search qualifiers, parsed (AND, OR, parentheses, "-" negation), what the
//                  list endpoint can do and what needs GitHub's search, and the local filter
//   references     closing keywords ("fixes #12", owner/name#12, an issue's address), which close on
//                  merge (toward the default branch only), and plain mentions
//   the merge box  the state in words, from GitHub's mergeable state, the checks and the reviews
//   messages       GitHub's default merge and squash messages
//   the summary    a change in numbers, computed without a model: lines per language, notebooks, data,
//                  licence, dependency and citation files, workflows
//   suggestions    ```suggestion blocks: parsed, applied one at a time or as a batch
//   anchors        which lines of a diff take a comment; multi-line comments stay in one hunk
//   the browser    the pending review and the "Viewed" files, kept in localStorage
//   templates      where GitHub finds pull request templates, the research template, prefill by URL
//   reviewers      suggested: CODEOWNERS and the paper's verified authors
//
// Like every browser script, it never names the platform.

import type * as T from "../../worker/forge/types.ts";
import { type Owner, ownerInWords, ownersOfChange, type CodeOwners } from "./codeowners.ts";
import { DRAFT_PREFIX, repoPath, type RepoCoords } from "./forge.ts";
import type { Hunk } from "./history.ts";

// ─── addresses ───────────────────────────────────────────────────────────────

export type PullTab = "conversation" | "files" | "commits" | "checks" | "conflicts";
export const PULL_TABS: readonly PullTab[] = ["conversation", "commits", "checks", "files"];

export type PullTarget = { number: number; tab: PullTab } | { newFrom: string };

/** What the segments after pull/ name: a pull request and its tab, or pull/new/<branch> (GitHub's
 *  address for "open a pull request from this branch"). */
export function parsePullTarget(rest: readonly string[]): PullTarget | null {
  if (!rest.length) return null;
  if (rest[0] === "new" && rest.length >= 2) return { newFrom: rest.slice(1).join("/") };
  if (!/^[1-9][0-9]{0,9}$/.test(rest[0]) || Number(rest[0]) > 2 ** 31) return null;
  const number = Number(rest[0]);
  if (rest.length === 1) return { number, tab: "conversation" };
  if (rest.length === 2 && ["files", "commits", "checks", "conflicts", "changes"].includes(rest[1])) {
    // "changes" is GitHub's newer name of "files".
    return { number, tab: rest[1] === "changes" ? "files" : (rest[1] as PullTab) };
  }
  return null;
}

/** A pull request's page in the registry: /r/o/n/pull/12, /r/o/n/pull/12/files. */
export const pullPath = (repo: RepoCoords, number: number, tab: PullTab = "conversation"): string =>
  repoPath(repo, "pull", tab === "conversation" ? [String(number)] : [String(number), tab]);

/** The list, with a filter. */
export const pullsPath = (repo: RepoCoords, q?: string): string => `${repoPath(repo, "pulls")}${q ? `?${new URLSearchParams({ q })}` : ""}`;

/** The creation form: the comparison of base and head, expanded (GitHub's ?expand=1). */
export function newPullPath(repo: RepoCoords, base: string, head: string, params: Record<string, string> = {}): string {
  const q = new URLSearchParams({ expand: "1", ...params });
  return `${repoPath(repo, "compare", [`${base}...${head}`])}?${q}`;
}

// ─── the list's query ────────────────────────────────────────────────────────

export type QueryNode =
  | { op: "and" | "or"; items: QueryNode[] }
  | { op: "not"; item: QueryNode }
  | { op: "term"; key: string; value: string }
  | { op: "text"; value: string };

export interface ParsedQuery {
  node: QueryNode;
  errors: string[];
}

/** The qualifiers the registry reads (GitHub's names). */
export const QUALIFIERS = [
  "is", "state", "author", "assignee", "label", "no", "head", "base", "draft", "review", "review-requested",
  "reviewed-by", "sort", "created", "updated", "merged", "closed", "in", "involves", "mentions", "commenter",
  "milestone", "linked", "status", "comments",
] as const;

/** What only GitHub's search answers (reviews, comments, people involved, checks). */
const SEARCH_ONLY = new Set(["review", "reviewed-by", "involves", "mentions", "commenter", "comments", "linked", "status", "in"]);

export const DEFAULT_QUERY = "is:pr is:open";

function tokens(q: string): string[] {
  const out: string[] = [];
  const re = /\s*(\(|\)|-?[A-Za-z-]+:"[^"]*"|-?[A-Za-z-]+:\S+?(?=\)|\s|$)|"[^"]*"|[^\s()]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    if (m[1] === undefined) break;
    out.push(m[1]);
  }
  return out;
}

/** GitHub's query language, as far as a pull request list needs it: qualifiers `key:value` (quoted
 *  values allowed), free words, `-` to negate, `AND`, `OR` and parentheses (AND binds tighter; a
 *  space is AND). */
export function parsePullQuery(q: string): ParsedQuery {
  return parseQuery(q, QUALIFIERS);
}

/** GitHub's query language with these qualifiers (phase 05's issues read more of them). */
export function parseQuery(q: string, qualifiers: readonly string[]): ParsedQuery {
  const errors: string[] = [];
  const list = tokens(q.slice(0, 1000));
  let i = 0;
  const atom = (): QueryNode | null => {
    const t = list[i++];
    if (t === undefined) return null;
    if (t === "(") {
      const inner = orExpr();
      if (list[i] === ")") i++;
      else errors.push("A parenthesis is not closed.");
      return inner;
    }
    if (t === ")") {
      errors.push("A parenthesis closes nothing.");
      return null;
    }
    const neg = t.startsWith("-") && t.length > 1;
    const body = neg ? t.slice(1) : t;
    const m = /^([A-Za-z-]+):(.*)$/.exec(body);
    let node: QueryNode;
    if (m) {
      const key = m[1].toLowerCase();
      const value = m[2].replace(/^"(.*)"$/, "$1");
      if (!qualifiers.includes(key)) errors.push(`${key}: is not a qualifier the registry reads.`);
      node = { op: "term", key, value };
    } else node = { op: "text", value: body.replace(/^"(.*)"$/, "$1") };
    return neg ? { op: "not", item: node } : node;
  };
  const andExpr = (): QueryNode => {
    const items: QueryNode[] = [];
    while (i < list.length && list[i] !== ")" && list[i] !== "OR") {
      if (list[i] === "AND") {
        i++;
        continue;
      }
      const a = atom();
      if (a) items.push(a);
    }
    return items.length === 1 ? items[0] : { op: "and", items };
  };
  const orExpr = (): QueryNode => {
    const items = [andExpr()];
    while (list[i] === "OR") {
      i++;
      items.push(andExpr());
    }
    return items.length === 1 ? items[0] : { op: "or", items };
  };
  const node = orExpr();
  while (i < list.length) {
    if (list[i] === ")") errors.push("A parenthesis closes nothing.");
    i++;
  }
  return { node, errors };
}

export function terms(node: QueryNode, out: { key: string; value: string; negated: boolean; nested: boolean }[] = [], negated = false, nested = false): typeof out {
  if (node.op === "term") out.push({ key: node.key, value: node.value, negated, nested });
  else if (node.op === "not") terms(node.item, out, !negated, nested);
  else if (node.op === "and") node.items.forEach((x) => terms(x, out, negated, nested));
  else if (node.op === "or") node.items.forEach((x) => terms(x, out, negated, true));
  return out;
}

export interface QueryPlan {
  /** What GitHub's list endpoint is asked for. */
  state: "open" | "closed" | "all";
  base: string | null;
  head: string | null;
  sort: "created" | "updated" | "popularity" | "long-running";
  direction: "asc" | "desc";
  /** The query needs GitHub's search (reviews, comments, people involved): 10 searches a minute. */
  search: boolean;
}

/** What to ask GitHub for a query: the list endpoint with its few filters (the rest is filtered in
 *  the browser), or GitHub's search when the query needs what only it knows. */
export function planQuery(parsed: ParsedQuery): QueryPlan {
  const all = terms(parsed.node);
  const top = all.filter((t) => !t.nested && !t.negated);
  const is = top.filter((t) => t.key === "is" || t.key === "state").map((t) => t.value.toLowerCase());
  const state = is.includes("merged") || is.includes("closed") || is.includes("unmerged") ? (is.includes("open") ? "all" : "closed") : is.includes("open") ? "open" : "all";
  const one = (key: string) => top.find((t) => t.key === key)?.value ?? null;
  const sortText = (one("sort") ?? "created-desc").toLowerCase();
  const [sortKey, dir] = sortText.split("-");
  const sort = sortKey === "updated" ? "updated" : sortKey === "comments" || sortKey === "reactions" || sortKey === "interactions" ? "popularity" : sortKey === "long" ? "long-running" : "created";
  const needsSearch = all.some((t) => SEARCH_ONLY.has(t.key)) || (all.some((t) => t.key === "is" && t.value === "unmerged") && state !== "closed");
  return {
    state: state as QueryPlan["state"],
    base: one("base"),
    head: one("head"),
    sort,
    direction: dir === "asc" ? "asc" : "desc",
    search: needsSearch,
  };
}

/** The query for GitHub's search: the reader's, scoped to pull requests (the backend adds repo:). */
export function searchQuery(q: string): string {
  return /(^|\s)(is|type):(pr|pull-request)\b/.test(q) ? q.trim() : `is:pr ${q.trim()}`;
}

/** A date condition: "2026-01-01", ">2026-01-01", "<=2026-01-01", "2026-01-01..2026-02-01". */
export function dateMatches(iso: string | null, cond: string): boolean {
  if (!iso) return false;
  const day = iso.slice(0, 10);
  const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2}|\*)$/.exec(cond);
  if (range) return day >= range[1] && (range[2] === "*" || day <= range[2]);
  const m = /^(>=|<=|>|<)?(\d{4}-\d{2}-\d{2})$/.exec(cond);
  if (!m) return true;
  const [, op = "", d] = m;
  return op === ">" ? day > d : op === ">=" ? day >= d : op === "<" ? day < d : op === "<=" ? day <= d : day === d;
}

export interface MatchContext {
  /** The signed-in reader's GitHub login, for @me. */
  me?: string | null;
}

/** Whether a pull request (as GitHub's list gives it) matches a query node. Qualifiers only GitHub's
 *  search knows are taken as matching (the page asked the search for them). */
export function matchPull(pr: T.PullRequest, node: QueryNode, ctx: MatchContext = {}): boolean {
  const who = (v: string) => (v.toLowerCase() === "@me" ? (ctx.me ?? "").toLowerCase() : v.toLowerCase().replace(/^@/, ""));
  switch (node.op) {
    case "and":
      return node.items.every((x) => matchPull(pr, x, ctx));
    case "or":
      return node.items.some((x) => matchPull(pr, x, ctx));
    case "not":
      return !matchPull(pr, node.item, ctx);
    case "text": {
      const t = node.value.toLowerCase();
      return !t || pr.title.toLowerCase().includes(t) || pr.body.toLowerCase().includes(t) || String(pr.number) === t.replace(/^#/, "");
    }
    case "term": {
      const v = node.value.toLowerCase();
      switch (node.key) {
        case "is":
        case "state":
          if (v === "pr" || v === "pull-request") return true;
          if (v === "open") return pr.state === "open";
          if (v === "closed") return pr.state === "closed";
          if (v === "merged") return pr.merged;
          if (v === "unmerged") return !pr.merged;
          if (v === "draft") return pr.draft;
          if (v === "issue") return false;
          return true;
        case "draft":
          return v === "true" ? pr.draft : v === "false" ? !pr.draft : true;
        case "author":
          return (pr.author.login ?? "").toLowerCase() === who(node.value);
        case "assignee":
          return pr.assignees.some((a) => a.toLowerCase() === who(node.value));
        case "review-requested":
          return pr.requestedReviewers.some((a) => a.toLowerCase() === who(node.value));
        case "label":
          return node.value.split(",").some((l) => pr.labels.some((x) => x.toLowerCase() === l.trim().toLowerCase()));
        case "no":
          return v === "label" ? !pr.labels.length : v === "assignee" ? !pr.assignees.length : v === "milestone" ? pr.milestone === null : v === "reviewers" || v === "review-requested" ? !pr.requestedReviewers.length : true;
        case "head":
          return pr.head.ref.toLowerCase() === v || `${pr.head.repo?.owner ?? ""}:${pr.head.ref}`.toLowerCase() === v;
        case "base":
          return pr.base.ref.toLowerCase() === v;
        case "milestone":
          return v === "none" ? pr.milestone === null : true;
        case "created":
          return dateMatches(pr.createdAt, node.value);
        case "updated":
          return dateMatches(pr.updatedAt, node.value);
        case "merged":
          return dateMatches(pr.mergedAt, node.value);
        case "closed":
          return dateMatches(pr.closedAt, node.value);
        default:
          return true;
      }
    }
  }
}

/** The list's sort, in the browser (GitHub's list already sorts; the filter keeps its order). */
export function sortPulls(items: readonly T.PullRequest[], plan: Pick<QueryPlan, "sort" | "direction">): T.PullRequest[] {
  const key = (p: T.PullRequest) => (plan.sort === "updated" ? p.updatedAt : p.createdAt);
  const out = [...items].sort((a, b) => key(a).localeCompare(key(b)) || a.number - b.number);
  return plan.direction === "asc" ? out : out.reverse();
}

/** A pull request's state in words: "Open", "Draft", "Merged", "Closed". */
export const pullStateInWords = (p: Pick<T.PullRequest, "state" | "draft" | "merged">): string =>
  p.merged ? "Merged" : p.state === "closed" ? "Closed" : p.draft ? "Draft" : "Open";

// ─── references: closing keywords, mentions ──────────────────────────────────

export interface IssueRef {
  owner: string;
  name: string;
  number: number;
  /** The closing keyword ("fixes"), or null for a plain mention. */
  keyword: string | null;
}

const KEYWORD = "(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)";
const REPO_PART = "([A-Za-z0-9][A-Za-z0-9-]{0,38})\\/([A-Za-z0-9._-]{1,100})";

/** The issues a text references: with a closing keyword before each ("Fixes #12, closes
 *  ada/eeg#3", or an issue's address on GitHub), or merely mentioned (#12). One entry per issue, a
 *  closing reference winning over a mention. Code spans and blocks are left out, as on GitHub. */
export function issueRefs(text: string, repo: RepoCoords, web = "https://github.com"): IssueRef[] {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const host = web.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const target = `(?:${REPO_PART})?#([0-9]{1,9})|${host}\\/${REPO_PART}\\/(?:issues|pull)\\/([0-9]{1,9})`;
  const re = new RegExp(`(?:\\b${KEYWORD}:?\\s+)?(?:${target})`, "gi");
  const out = new Map<string, IssueRef>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain)) !== null) {
    const before = plain[m.index - 1];
    if (before && /[A-Za-z0-9_&/]/.test(before) && !m[1]) continue;
    const owner = m[2] ?? m[5] ?? repo.owner;
    const name = m[3] ?? m[6] ?? repo.name;
    const number = Number(m[4] ?? m[7]);
    if (!number) continue;
    const key = `${owner}/${name}#${number}`.toLowerCase();
    const keyword = m[1] ? m[1].toLowerCase() : null;
    const had = out.get(key);
    if (!had || (!had.keyword && keyword)) out.set(key, { owner, name, number, keyword });
  }
  return [...out.values()];
}

/** Whether merging closes the referenced issues: GitHub closes them only when the pull request
 *  merges into the repository's default branch. */
export const closesOnMerge = (pr: Pick<T.PullRequest, "base">, defaultBranch: string | null): boolean => defaultBranch !== null && pr.base.ref === defaultBranch;

/** The closing references of a pull request's text and of its commits' messages. */
export function closingRefs(texts: readonly string[], repo: RepoCoords, web?: string): IssueRef[] {
  const out = new Map<string, IssueRef>();
  for (const t of texts) for (const r of issueRefs(t, repo, web)) if (r.keyword) out.set(`${r.owner}/${r.name}#${r.number}`.toLowerCase(), r);
  return [...out.values()];
}

// ─── the merge box ───────────────────────────────────────────────────────────

export interface ChecksSummary {
  total: number;
  passed: number;
  failed: number;
  running: number;
  skipped: number;
}

/** The checks of a commit, counted: GitHub's check runs and commit statuses together. */
export function checksSummary(runs: readonly T.CheckRun[], status: T.CombinedStatus | null): ChecksSummary {
  const s: ChecksSummary = { total: 0, passed: 0, failed: 0, running: 0, skipped: 0 };
  for (const r of runs) {
    s.total++;
    if (r.status !== "completed") s.running++;
    else if (r.conclusion === "success") s.passed++;
    else if (r.conclusion === "skipped" || r.conclusion === "neutral") s.skipped++;
    else s.failed++;
  }
  for (const x of status?.statuses ?? []) {
    s.total++;
    if (x.state === "success") s.passed++;
    else if (x.state === "pending") s.running++;
    else s.failed++;
  }
  return s;
}

export function checksInWords(c: ChecksSummary): string {
  if (!c.total) return "No checks reported for its last commit.";
  const parts = [c.passed ? `${c.passed} passed` : "", c.failed ? `${c.failed} failed` : "", c.running ? `${c.running} still running` : "", c.skipped ? `${c.skipped} skipped or neutral` : ""].filter(Boolean);
  return `Checks of its last commit: ${parts.join(", ")}.`;
}

export interface ReviewsSummary {
  approved: string[];
  changesRequested: string[];
  commented: string[];
  requested: string[];
}

/** Each reviewer's latest decisive review (an approval or a change request; a later comment does not
 *  undo either; a dismissal does), and the reviews still asked for. */
export function reviewsSummary(reviews: readonly T.Review[], requested: readonly string[], author: string | null): ReviewsSummary {
  const latest = new Map<string, T.Review["state"]>();
  const commented = new Set<string>();
  for (const r of [...reviews].sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""))) {
    const who = r.author.login;
    if (!who || who === author) continue;
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED") latest.set(who, r.state);
    else if (r.state === "COMMENTED") commented.add(who);
  }
  const pick = (s: T.Review["state"]) => [...latest].filter(([, v]) => v === s).map(([k]) => k);
  const decided = new Set([...latest.keys()]);
  return {
    approved: pick("APPROVED"),
    changesRequested: pick("CHANGES_REQUESTED"),
    commented: [...commented].filter((c) => !decided.has(c)),
    requested: requested.filter((r) => !latest.has(r) || latest.get(r) === "DISMISSED"),
  };
}

export interface MergeBox {
  tone: "ok" | "warning" | "";
  /** The status line at the top of every tab: one sentence. */
  status: string;
  /** Each fact in its own sentence. */
  lines: string[];
  /** Whether the page offers the merge button (GitHub decides at the merge). */
  mergeable: boolean;
  /** The conflicts are the registry's to resolve in the browser. */
  conflicts: boolean;
  /** The base moved on: "Update branch" is offered. */
  behind: boolean;
}

const names = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The merge box in words. */
export function mergeBox(pr: T.PullRequest, checks: ChecksSummary | null, reviews: ReviewsSummary | null): MergeBox {
  const lines: string[] = [];
  if (pr.merged) {
    return { tone: "ok", status: `Merged into ${pr.base.ref}${pr.mergedAt ? ` on ${pr.mergedAt.slice(0, 10)}` : ""}.`, lines: [], mergeable: false, conflicts: false, behind: false };
  }
  if (pr.state === "closed") {
    return { tone: "", status: `Closed without merging${pr.closedAt ? ` on ${pr.closedAt.slice(0, 10)}` : ""}.`, lines: [], mergeable: false, conflicts: false, behind: false };
  }
  if (reviews) {
    if (reviews.changesRequested.length) lines.push(`Changes requested by ${names(reviews.changesRequested)}.`);
    if (reviews.approved.length) lines.push(`Approved by ${names(reviews.approved)}.`);
    if (reviews.requested.length) lines.push(`Review asked of ${names(reviews.requested)}.`);
    if (!reviews.approved.length && !reviews.changesRequested.length && !reviews.requested.length) lines.push("No review yet.");
  }
  if (checks) lines.push(checksInWords(checks));
  if (pr.autoMerge) lines.push(`Auto-merge is on (${pr.autoMerge === "merge" ? "a merge commit" : pr.autoMerge === "squash" ? "squash and merge" : "rebase and merge"}): GitHub merges it once its requirements are met.`);
  const failing = !!checks && checks.failed > 0;
  let status: string;
  let tone: MergeBox["tone"] = "";
  let mergeable = false;
  let conflicts = false;
  let behind = false;
  if (pr.draft) status = "A draft: it cannot be merged until it is marked ready for review.";
  else if (pr.mergeable === null || pr.mergeState === "unknown") {
    status = "GitHub is still checking whether it can be merged: read the page again in a moment.";
  } else if (pr.mergeable === false || pr.mergeState === "dirty") {
    status = `It has conflicts with ${pr.base.ref}: resolve them before merging.`;
    tone = "warning";
    conflicts = true;
  } else if (pr.mergeState === "blocked") {
    status = "Merging is blocked: a required review or check is missing (the repository's rules).";
    tone = "warning";
  } else if (pr.mergeState === "behind") {
    status = `Its branch is behind ${pr.base.ref}: the repository asks for it to be up to date before merging.`;
    tone = "warning";
    behind = true;
  } else if (pr.mergeState === "unstable" || failing) {
    status = "It can be merged, but some checks failed.";
    tone = "warning";
    mergeable = true;
  } else {
    status = "It can be merged: no conflicts with the base branch.";
    tone = "ok";
    mergeable = true;
  }
  return { tone, status, lines, mergeable, conflicts, behind };
}

// ─── default merge messages ──────────────────────────────────────────────────

/** GitHub's default title and message of a merge: a merge commit names the pull request and its
 *  branch, a squash takes the title with its number and lists the commits. */
export function defaultMergeMessage(pr: Pick<T.PullRequest, "number" | "title" | "head">, method: T.MergeMethod, commits: readonly Pick<T.CommitSummary, "message">[] = []): { title: string; message: string } {
  if (method === "merge") {
    const from = `${pr.head.repo?.owner ?? "unknown"}/${pr.head.ref}`;
    return { title: `Merge pull request #${pr.number} from ${from}`, message: pr.title };
  }
  if (method === "squash") {
    const list = commits.length === 1 ? "" : commits.map((c) => `* ${c.message.split("\n")[0]}`).join("\n");
    return { title: `${pr.title} (#${pr.number})`, message: list };
  }
  return { title: "", message: "" };
}

// ─── the change summary ──────────────────────────────────────────────────────

const NOTEBOOK = /\.ipynb$/i;
const DATA = /\.(csv|tsv|parquet|feather|h5|hdf5|nc|npy|npz|mat|rds|rdata|sav|dta|xlsx?|json|jsonl|fits|nii(\.gz)?|edf|bdf|zarr)$/i;
const LICENCE = /(^|\/)(licen[cs]e|copying)(\.[a-z]+)?$/i;
const CITATION = /(^|\/)(CITATION\.cff|codemeta\.json|\.zenodo\.json)$/;
const DEPENDENCIES = /(^|\/)(requirements[^/]*\.txt|environment\.ya?ml|pyproject\.toml|setup\.py|setup\.cfg|Pipfile(\.lock)?|poetry\.lock|uv\.lock|conda-lock\.ya?ml|renv\.lock|DESCRIPTION|Project\.toml|Manifest\.toml|package(-lock)?\.json|yarn\.lock|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|pom\.xml|build\.gradle|Dockerfile|apptainer\.def|Singularity)$/;
const WORKFLOW = /^\.github\/workflows\//;

export interface ChangeSummary {
  files: number;
  additions: number;
  deletions: number;
  /** Lines changed per language, most first. */
  languages: { language: string; lines: number }[];
  notebooks: string[];
  data: string[];
  licence: string[];
  dependencies: string[];
  citation: string[];
  workflows: string[];
}

/** A change in numbers, computed without a model: it never replaces the author's own words. */
export function changeSummary(files: readonly Pick<T.FileChangeSummary, "path" | "additions" | "deletions">[], languageOf: (path: string) => string | null): ChangeSummary {
  const by = new Map<string, number>();
  const s: ChangeSummary = { files: files.length, additions: 0, deletions: 0, languages: [], notebooks: [], data: [], licence: [], dependencies: [], citation: [], workflows: [] };
  for (const f of files) {
    s.additions += f.additions;
    s.deletions += f.deletions;
    const lang = NOTEBOOK.test(f.path) ? "Jupyter Notebook" : (languageOf(f.path) ?? "Other");
    by.set(lang, (by.get(lang) ?? 0) + f.additions + f.deletions);
    if (NOTEBOOK.test(f.path)) s.notebooks.push(f.path);
    else if (DATA.test(f.path)) s.data.push(f.path);
    if (LICENCE.test(f.path)) s.licence.push(f.path);
    if (DEPENDENCIES.test(f.path)) s.dependencies.push(f.path);
    if (CITATION.test(f.path)) s.citation.push(f.path);
    if (WORKFLOW.test(f.path)) s.workflows.push(f.path);
  }
  s.languages = [...by].map(([language, lines]) => ({ language, lines })).sort((a, b) => b.lines - a.lines || a.language.localeCompare(b.language));
  return s;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/** The summary in sentences. `mapLinks`: the tracing-map links the change touches. */
export function summaryInWords(s: ChangeSummary, mapLinks = 0): string[] {
  const out = [`${plural(s.files, "file")} changed: ${plural(s.additions, "line")} added, ${plural(s.deletions, "line")} deleted.`];
  const langs = s.languages.filter((l) => l.lines > 0).slice(0, 5);
  if (langs.length) out.push(`By language: ${langs.map((l) => `${l.language} ${plural(l.lines, "line")}`).join(", ")}.`);
  if (mapLinks) out.push(`${plural(mapLinks, "tracing-map link")} to a paper ${mapLinks === 1 ? "is" : "are"} touched.`);
  if (s.notebooks.length) out.push(`Notebooks: ${s.notebooks.join(", ")}.`);
  if (s.data.length) out.push(`Data files: ${s.data.slice(0, 10).join(", ")}${s.data.length > 10 ? ` and ${s.data.length - 10} more` : ""}.`);
  if (s.licence.length) out.push(`The licence changes (${s.licence.join(", ")}): what others may do with the code changes with it.`);
  if (s.dependencies.length) out.push(`The environment changes: ${s.dependencies.join(", ")}.`);
  if (s.citation.length) out.push(`The citation metadata changes: ${s.citation.join(", ")}.`);
  if (s.workflows.length) out.push(`Continuous integration changes: ${s.workflows.join(", ")}.`);
  return out;
}

// ─── suggestions ─────────────────────────────────────────────────────────────

/** The ```suggestion blocks of a comment's body: each block's lines (an empty block deletes the
 *  lines). */
export function suggestionsOf(body: string): string[][] {
  const out: string[][] = [];
  const re = /^[ \t]*```suggestion[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const inner = m[1].replace(/\r?\n$/, "");
    out.push(m[1] === "" ? [] : inner.split(/\r?\n/));
  }
  // An empty block: "```suggestion\n```".
  if (!out.length && /^[ \t]*```suggestion[ \t]*\r?\n[ \t]*```[ \t]*$/m.test(body)) out.push([]);
  return out;
}

/** A comment's body with a suggestion block: the lines it replaces, written as they are. */
export const suggestionBody = (lines: readonly string[], note = ""): string => `${note ? `${note.trim()}\n` : ""}\`\`\`suggestion\n${lines.join("\n")}${lines.length ? "\n" : ""}\`\`\``;

export interface Suggestion {
  /** The review comment's id. */
  id: string;
  path: string;
  /** 1-based, inclusive, on the head's version of the file. */
  start: number;
  end: number;
  lines: string[];
  /** Who suggested it, for the commit's co-author credit. */
  author: T.Actor;
}

/** The suggestion of a review comment, or why it cannot be applied (outdated, on the old side,
 *  several blocks). */
export function suggestionOf(c: Pick<T.ReviewComment, "id" | "path" | "line" | "startLine" | "side" | "body" | "author">): Suggestion | string | null {
  const blocks = suggestionsOf(c.body);
  if (!blocks.length) return null;
  if (blocks.length > 1) return "This comment holds several suggestions: apply it by hand.";
  if (c.side === "LEFT") return "This suggestion is on the old side of the diff.";
  if (c.line === null) return "Outdated: the lines it suggests changing have changed since.";
  return { id: c.id, path: c.path, start: c.startLine ?? c.line, end: c.line, lines: blocks[0], author: c.author };
}

/** A file's text with suggestions applied, in one pass (a batch): refused when two overlap or one
 *  names lines the file does not have. The file's line ending is kept. */
export function applySuggestions(text: string, list: readonly Pick<Suggestion, "start" | "end" | "lines">[]): string | { problem: string } {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const final = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (final) lines.pop();
  const sorted = [...list].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.start < 1 || s.end < s.start || s.end > lines.length) return { problem: `A suggestion names lines ${s.start} to ${s.end}, which the file does not have now.` };
    if (i > 0 && s.start <= sorted[i - 1].end) return { problem: "Two suggestions change the same lines: apply them one at a time." };
  }
  for (const s of [...sorted].reverse()) lines.splice(s.start - 1, s.end - s.start + 1, ...s.lines);
  return lines.join(eol) + (final && lines.length ? eol : "");
}

// ─── anchors: which lines of a diff take a comment ──────────────────────────

/** Whether a line of a side is shown by the diff's hunks (GitHub takes comments on those only). */
export function commentable(hunks: readonly Hunk[], side: "LEFT" | "RIGHT", line: number): number | null {
  for (let i = 0; i < hunks.length; i++) {
    for (const l of hunks[i].lines) {
      if (l.kind === "note") continue;
      if (side === "RIGHT" && l.new === line && l.kind !== "del") return i;
      if (side === "LEFT" && l.old === line && l.kind === "del") return i;
      if (side === "LEFT" && l.old === line && l.kind === "context") return i;
    }
  }
  return null;
}

/** A comment on several lines: both ends in the same hunk, on the same side, start before end. */
export function commentRange(hunks: readonly Hunk[], side: "LEFT" | "RIGHT", start: number, end: number): { start: number; end: number } | null {
  const [a, b] = start <= end ? [start, end] : [end, start];
  const ha = commentable(hunks, side, a);
  const hb = commentable(hunks, side, b);
  return ha !== null && ha === hb ? { start: a, end: b } : null;
}

// ─── what the browser keeps: the pending review, the files viewed ────────────

/** A pending review is one of the drafts the callback page drops once GitHub took it (forge.ts
 *  DRAFT_PREFIX), and only then. */
export const REVIEW_PREFIX = `${DRAFT_PREFIX}review:`;
export const VIEWED_PREFIX = "oscr-viewed:";
/** A month, like the editor's drafts. */
export const KEPT_SECONDS = 30 * 24 * 3600;

export interface PendingComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  body: string;
}

export interface PendingReview {
  /** The head the comments were written on. */
  commit: string;
  comments: PendingComment[];
  body: string;
  at: number;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

export const reviewKey = (repo: RepoCoords, number: number): string => `${REVIEW_PREFIX}${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${number}`;
export const viewedKey = (repo: RepoCoords, number: number): string => `${VIEWED_PREFIX}${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${number}`;

function readJson(store: Store, key: string): unknown {
  try {
    const t = store?.getItem(key);
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}

function writeJson(store: Store, key: string, value: unknown): boolean {
  try {
    store?.setItem(key, JSON.stringify(value));
    return !!store;
  } catch {
    return false;
  }
}

/** The pending review kept for a pull request, or null (none, unreadable, older than a month). */
export function readPendingReview(store: Store, repo: RepoCoords, number: number, now: number): PendingReview | null {
  const v = readJson(store, reviewKey(repo, number)) as PendingReview | null;
  if (!v || typeof v.commit !== "string" || !Array.isArray(v.comments) || typeof v.at !== "number" || now - v.at > KEPT_SECONDS) return null;
  const comments = v.comments.filter((c) => c && typeof c.path === "string" && Number.isInteger(c.line) && (c.side === "LEFT" || c.side === "RIGHT") && typeof c.body === "string").slice(0, 100);
  return { commit: v.commit, comments, body: typeof v.body === "string" ? v.body : "", at: v.at };
}

export const writePendingReview = (store: Store, repo: RepoCoords, number: number, review: PendingReview): boolean => writeJson(store, reviewKey(repo, number), review);

export function dropPendingReview(store: Store, repo: RepoCoords, number: number): void {
  try {
    store?.removeItem(reviewKey(repo, number));
  } catch {
    // kept; it expires in a month
  }
}

/** The files marked viewed: path → the blob seen. A file changed since is unviewed again. */
export function readViewed(store: Store, repo: RepoCoords, number: number): Map<string, string> {
  const v = readJson(store, viewedKey(repo, number));
  const out = new Map<string, string>();
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (typeof s === "string") out.set(k, s);
  return out;
}

export const writeViewed = (store: Store, repo: RepoCoords, number: number, viewed: Map<string, string>): boolean => writeJson(store, viewedKey(repo, number), Object.fromEntries(viewed));

/** Whether a file is still viewed: marked on the blob it has now. */
export const isViewed = (viewed: Map<string, string>, f: Pick<T.FileChangeSummary, "path" | "blob">): boolean => viewed.has(f.path) && viewed.get(f.path) === (f.blob ?? "removed");

// ─── templates, and prefilling by address ────────────────────────────────────

/** Where GitHub looks for one template, in the default branch. */
export const TEMPLATE_FILES = [
  ".github/pull_request_template.md",
  "pull_request_template.md",
  "docs/pull_request_template.md",
] as const;
/** The folders of several templates (?template=<file> chooses one). */
export const TEMPLATE_DIRS = [".github/PULL_REQUEST_TEMPLATE", "PULL_REQUEST_TEMPLATE", "docs/PULL_REQUEST_TEMPLATE"] as const;

/** The templates of a tree (GitHub matches the names in any case): the single one, and the several. */
export function findTemplates(paths: Iterable<string>): { single: string | null; several: string[] } {
  const all = [...paths];
  const lower = new Map(all.map((p) => [p.toLowerCase(), p]));
  const single = TEMPLATE_FILES.map((p) => lower.get(p.toLowerCase())).find((p): p is string => !!p) ?? null;
  const several: string[] = [];
  for (const dir of TEMPLATE_DIRS) {
    const prefix = `${dir.toLowerCase()}/`;
    for (const p of all) if (p.toLowerCase().startsWith(prefix) && /\.md$/i.test(p) && !p.slice(prefix.length).includes("/")) several.push(p);
  }
  return { single, several: several.sort() };
}

/** The template ?template= names among the several, or null. */
export function chosenTemplate(several: readonly string[], name: string | null): string | null {
  if (!name) return null;
  return several.find((p) => p.split("/").pop()?.toLowerCase() === name.toLowerCase()) ?? null;
}

/** The registry's research template: the questions a change to a paper's code should answer. */
export function researchTemplate(papers: readonly { title: string | null; doi: string }[] = []): string {
  const paper = papers.length ? papers.map((p) => `- ${p.title ?? p.doi} (doi:${p.doi})`).join("\n") : "- (none linked)";
  return [
    "## What this changes",
    "",
    "",
    "## Does it alter results reported in the paper?",
    "",
    "- [ ] No: the figures and numbers of the paper stay the same.",
    "- [ ] Yes: say which, and why.",
    "",
    "## The paper",
    "",
    paper,
    "",
    "## How it was checked",
    "",
    "- [ ] The tests pass.",
    "- [ ] The analysis was run again on the same data.",
    "",
    "## Linked issues",
    "",
    "Fixes #",
    "",
  ].join("\n");
}

export interface Prefill {
  title: string | null;
  body: string | null;
  template: string | null;
  labels: string[];
  assignees: string[];
  reviewers: string[];
  draft: boolean;
  expand: boolean;
}

/** GitHub's query parameters of the comparison page: title, body, template, labels, assignees (and
 *  the registry's reviewers and draft), each checked. */
export function prefillOf(search: string): Prefill {
  const q = new URLSearchParams(search);
  const text = (k: string, max: number) => {
    const v = q.get(k);
    return v !== null && v.length <= max ? v : null;
  };
  const logins = (k: string) => (q.get(k) ?? "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(s)).slice(0, 15);
  const template = text("template", 200);
  return {
    title: text("title", 256)?.replace(/[\r\n]+/g, " ") ?? null,
    body: text("body", 65_536),
    template: template && /^[A-Za-z0-9._ -]+\.md$/i.test(template) ? template : null,
    labels: (q.get("labels") ?? "").split(",").map((s) => s.trim()).filter((s) => s && s.length <= 50).slice(0, 20),
    assignees: logins("assignees"),
    reviewers: logins("reviewers"),
    draft: q.get("draft") === "1" || q.get("draft") === "true",
    expand: q.get("expand") === "1" || q.get("quick_pull") === "1",
  };
}

/** A title from the branch or its only commit, as GitHub proposes it: "ada-patch-1" → "Ada patch 1". */
export function defaultTitle(head: string, commits: readonly Pick<T.CommitSummary, "message">[]): string {
  if (commits.length === 1) return commits[0].message.split("\n")[0].slice(0, 256);
  const branch = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
  const words = branch.split("/").pop()!.replace(/[-_]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : branch;
}

// ─── reviewers suggested ─────────────────────────────────────────────────────

export interface SuggestedReviewer {
  /** A GitHub login; a team or an owner named by address is said, never asked. */
  login: string | null;
  owner: Owner | null;
  reasons: string[];
}

/** The reviewers the page suggests: the code owners of the changed files (CODEOWNERS), then the
 *  paper's verified authors (the registry's roles), never the pull request's author, nor someone
 *  asked already. */
export function suggestReviewers(opts: {
  codeowners: CodeOwners | null;
  paths: readonly string[];
  authors: readonly { login: string; papers: readonly string[] }[];
  author: string | null;
  requested: readonly string[];
}): SuggestedReviewer[] {
  const skip = new Set([opts.author ?? "", ...opts.requested].map((s) => s.toLowerCase()));
  const out = new Map<string, SuggestedReviewer>();
  if (opts.codeowners) {
    for (const { owner, paths } of ownersOfChange(opts.codeowners, opts.paths)) {
      const login = owner.kind === "user" ? owner.login : null;
      if (login && skip.has(login.toLowerCase())) continue;
      const key = login ? login.toLowerCase() : ownerInWords(owner);
      const reason = `owns ${paths.length === 1 ? paths[0] : `${paths.length} of the changed files`} (CODEOWNERS)`;
      out.set(key, { login, owner, reasons: [reason] });
    }
  }
  for (const a of opts.authors) {
    if (skip.has(a.login.toLowerCase())) continue;
    const key = a.login.toLowerCase();
    const reason = `a verified author of ${a.papers.length === 1 ? `the paper ${a.papers[0]}` : `${a.papers.length} of its papers`}`;
    const had = out.get(key);
    if (had) had.reasons.push(reason);
    else out.set(key, { login: a.login, owner: null, reasons: [reason] });
  }
  return [...out.values()];
}
