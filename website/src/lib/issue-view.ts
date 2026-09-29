// The issue pages' view trees (night phase 05, E4): pure, no DOM, testable in Node
// (tests/forge-pages/issue-view.test.ts). The scripts (src/scripts/repo-issues.ts, repo-issue.ts,
// research.ts) show them through src/scripts/dom.ts: allowed elements only, text masked for email
// addresses (every title, body and comment is someone's text: it never becomes markup).
//
// - research issues as the Worker answers them and as the nightly shards keep them, read field by
//   field (`parseSummaries`, `parseView`);
// - a row of the list for either kind, a label as a word with its colour mark (`data-color`, the
//   palette's: never a style attribute, never a pill), where a research issue points (the paper's
//   paragraph, the file and its lines);
// - references in a rendered text: "#12" and "research#3" become links to the registry's pages.

import { maskEmails } from "../../worker/forge/mask.ts";
import {
  RESEARCH_TYPES,
  RESOLUTIONS,
  type CommentView,
  type IssueSummary,
  type IssueView,
  type Report,
  type ResearchEvent,
} from "../../worker/forge/service/research-core.ts";
import type * as T from "../../worker/forge/types.ts";
import { plural } from "./format.ts";
import type { RepoCoords } from "./forge.ts";
import { issuePath, type IssueItem, outcomeInWords, paletteOf, progressInWords, researchPath, stateInWords, taskProgress, typeInWords } from "./issues.ts";
import { type Child, type El, h } from "./repo-view.ts";

// ─── research issues, read field by field ────────────────────────────────────

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const txt = (v: unknown, max: number): string => (typeof v === "string" ? maskEmails(v).slice(0, max) : "");
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const DOI = /^doi:10\.\d{4,9}\/\S{1,200}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A research issue's summary (the Worker's answer or a nightly shard's), checked; null if not one. */
export function parseSummary(v: unknown): IssueSummary | null {
  const o = rec(v);
  if (!o) return null;
  const id = int(o.id);
  const type = o.type as IssueSummary["type"];
  if (!id || !RESEARCH_TYPES.includes(type) || typeof o.paper !== "string" || !DOI.test(o.paper) || typeof o.title !== "string") return null;
  const repo = rec(o.repo);
  const anchor = rec(o.anchor);
  const state = o.state === "closed" ? "closed" : "open";
  const reason = ["completed", "not_planned", "duplicate"].includes(o.close_reason as string) ? (o.close_reason as IssueSummary["close_reason"]) : "";
  const resolution = (RESOLUTIONS as readonly unknown[]).includes(o.resolution) ? (o.resolution as IssueSummary["resolution"]) : "";
  return {
    id,
    paper: o.paper,
    repo: repo && typeof repo.id === "string" && /^\d{1,20}$/.test(repo.id) && typeof repo.path === "string" && /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/.test(repo.path) ? { forge: "github", id: repo.id, path: repo.path } : null,
    code_url: typeof o.code_url === "string" && /^https:\/\/[^\s"<>@]{3,300}$/.test(o.code_url) ? o.code_url : "",
    type,
    title: txt(o.title, 256),
    state,
    close_reason: state === "closed" ? reason || "completed" : "",
    resolution: state === "closed" ? resolution : "",
    resolution_ref: txt(o.resolution_ref, 300),
    labels: (Array.isArray(o.labels) ? o.labels : []).filter((l): l is string => typeof l === "string" && l.length <= 50).map((l) => maskEmails(l)).slice(0, 10),
    locked: o.locked === true,
    pinned: o.pinned === true,
    author: txt(o.author, 100) || "A reader",
    author_via: o.author_via === "orcid" || o.author_via === "name" ? o.author_via : "github",
    author_role: o.author_role === "verified_author" || o.author_role === "maintainer" ? o.author_role : "",
    comments: int(o.comments) ?? 0,
    created_at: int(o.created_at) ?? 0,
    updated_at: int(o.updated_at) ?? 0,
    closed_at: int(o.closed_at),
    anchor: anchor
      ? {
          commit: typeof anchor.commit === "string" && OID.test(anchor.commit) ? anchor.commit : "",
          path: txt(anchor.path, 500),
          start: int(anchor.start),
          end: int(anchor.end),
          paragraph: int(anchor.paragraph),
          section: txt(anchor.section, 200),
        }
      : null,
    outcome: o.outcome === "failed" || o.outcome === "partially" ? o.outcome : null,
    github_number: int(o.github_number),
  };
}

export const parseSummaries = (v: unknown): IssueSummary[] =>
  (Array.isArray(v) ? v.slice(0, 1000) : []).map(parseSummary).filter((x): x is IssueSummary => x !== null);

/** A research issue's whole view (its text, report and events), checked. */
export function parseView(v: unknown): IssueView | null {
  const o = rec(v);
  const s = parseSummary(o);
  if (!o || !s) return null;
  const r = rec(o.report);
  const report: Report | null =
    r && (r.outcome === "failed" || r.outcome === "partially")
      ? {
          outcome: r.outcome,
          environment: txt(r.environment, 4000),
          datasets: (Array.isArray(r.datasets) ? r.datasets : []).filter((d): d is string => typeof d === "string" && (DOI.test(d) || /^https:\/\/[^\s"<>@]{3,300}$/.test(d))).slice(0, 10),
          command: txt(r.command, 1000),
          expected: txt(r.expected, 4000),
          observed: txt(r.observed, 4000),
          figure: txt(r.figure, 200),
        }
      : null;
  const events: ResearchEvent[] = (Array.isArray(o.events) ? o.events.slice(-100) : [])
    .map(rec)
    .filter((e): e is Record<string, unknown> => !!e && typeof e.k === "string" && /^[a-z]{1,20}$/.test(e.k) && typeof e.at === "number")
    .map((e) => ({ k: e.k as string, by: txt(e.by, 100), at: e.at as number, s: typeof e.s === "string" ? txt(e.s, 400) : undefined }));
  return { ...s, body: txt(o.body, 65_536), report, lock_reason: (["off-topic", "too heated", "resolved", "spam"] as const).find((x) => x === o.lock_reason) ?? "", events };
}

export function parseComments(v: unknown): (CommentView & { mine: boolean; moderated: string })[] {
  return (Array.isArray(v) ? v.slice(0, 2500) : [])
    .map(rec)
    .filter((c): c is Record<string, unknown> => !!c && int(c.n) !== null)
    .map((c) => ({
      n: int(c.n) as number,
      author: txt(c.author, 100) || "A reader",
      author_via: c.author_via === "orcid" || c.author_via === "name" ? c.author_via : "github",
      author_role: c.author_role === "verified_author" || c.author_role === "maintainer" ? c.author_role : "",
      body: txt(c.body, 65_536),
      created_at: int(c.created_at) ?? 0,
      edited_at: int(c.edited_at),
      deleted: c.deleted === true,
      hidden: (["spam", "abuse", "off-topic", "outdated", "duplicate", "resolved", "low-quality"] as const).find((x) => x === c.hidden) ?? "",
      mine: c.mine === true,
      // Night phase 16: hidden by moderation (the reason in words); its words withheld but from its author.
      moderated: rec(c.moderated) ? txt(rec(c.moderated)!.words, 200) : "",
    }));
}

// ─── rows, labels, where ─────────────────────────────────────────────────────

/** "2026-09-20" of an ISO time. */
export const dayOf = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");
/** "2026-09-20" of Unix seconds. */
export const dayOfSeconds = (t: number | null | undefined): string => (t ? new Date(t * 1000).toISOString().slice(0, 10) : "");

/** A label: its name after a small mark of its colour (the palette's nearest, science.css
 *  `.label-mark[data-color]`). A word, never a pill. */
export function labelEl(name: string, color?: string | null, href?: string | null): El {
  const mark = h("span", { class: "label-mark", "data-color": paletteOf(color ?? "cfd3d7"), "aria-hidden": "true" });
  return h("span", { class: "label" }, mark, href ? h("a", { href }, name) : name);
}

/** Labels in a line: "Labels: ▪ bug, ▪ data". */
export function labelsLine(names: readonly string[], colors: ReadonlyMap<string, string>, href?: (name: string) => string): Child[] {
  if (!names.length) return [];
  return ["Labels: ", ...names.flatMap((n, i) => [i ? ", " : "", labelEl(n, colors.get(n.toLowerCase()) ?? null, href ? href(n) : null)])];
}

/** Where a research issue points: "the paper's paragraph 14 (2.3 Filtering) · src/filter.py, lines
 *  12–18". */
export function whereInWords(i: Pick<IssueItem, "paragraph" | "path" | "lines"> & { section?: string }): string {
  const parts: string[] = [];
  if (i.paragraph !== null) parts.push(`the paper's paragraph ${i.paragraph}${i.section ? ` (${i.section})` : ""}`);
  if (i.path) parts.push(`${i.path}${i.lines ? (i.lines.end !== i.lines.start ? `, lines ${i.lines.start}–${i.lines.end}` : `, line ${i.lines.start}`) : ""}`);
  return parts.join(" · ");
}

/** A person as an issue names them: a GitHub login, an ORCID iD, a display name. */
export const byline = (author: string, via: "github" | "orcid" | "name" = "github"): string => (via === "orcid" ? `ORCID ${author}` : author);

/** The role an author writes with on a research issue, in words. */
export const roleInWords = (role: "" | "verified_author" | "maintainer"): string => (role === "verified_author" ? "a verified author of the paper" : role === "maintainer" ? "a maintainer of the code" : "");

export interface RowOptions {
  select?: boolean;
  colors?: ReadonlyMap<string, string>;
  milestones?: ReadonlyMap<number, string>;
  /** Research: the nightly shard's (said "as of last night"), or live. */
  asOfLastNight?: boolean;
}

/** One issue of the list, either kind: its state in words, its type, its title (its page in the
 *  registry), its number, who opened it and when, labels, assignees, milestone, tasks, comments; for a
 *  research issue, where it points and its report's outcome. */
export function issueRow(repo: RepoCoords, i: IssueItem, o: RowOptions = {}): El {
  const research = i.kind === "research";
  const href = research ? researchPath(i.number) : issuePath(repo, i.number);
  const type = typeInWords(i);
  const tasks = taskProgress(i.body);
  const where = research ? whereInWords(i) : "";
  return h(
    "li",
    { class: `issue-row${i.pinned && i.state === "open" ? " pinned" : ""}` },
    o.select && !research ? h("input", { type: "checkbox", name: "issue", value: String(i.number), "aria-label": `Choose #${i.number}` }) : null,
    h(
      "div",
      null,
      h(
        "p",
        { class: "title" },
        h("span", { class: `issue-state${i.state === "open" ? "" : " muted"}` }, stateInWords(i)),
        type ? [" · ", h("span", { class: research ? "issue-type research" : "issue-type" }, type)] : null,
        " ",
        h("a", { href }, i.title),
        i.pinned && i.state === "open" ? h("span", { class: "issue-flag" }, " (pinned)") : null,
        i.locked ? h("span", { class: "issue-flag" }, " (locked)") : null,
      ),
      h(
        "p",
        { class: "line" },
        `${research ? "research" : ""}#${i.number} opened ${dayOf(i.createdAt)} by ${i.author}`,
        where ? ` · ${where}` : null,
        i.outcome ? ` · ${outcomeInWords(i.outcome)}` : null,
        i.comments ? ` · ${plural(i.comments, "comment")}` : null,
        i.assignees.length ? ` · Assigned to ${i.assignees.join(", ")}` : null,
        i.milestone !== null ? ` · Milestone: ${o.milestones?.get(i.milestone) ?? `#${i.milestone}`}` : null,
        tasks.total ? ` · ${progressInWords(tasks)}` : null,
        i.subIssues?.total ? ` · ${i.subIssues.completed} of ${plural(i.subIssues.total, "sub-issue")} closed` : null,
        i.copiedTo ? ` · copied to GitHub as #${i.copiedTo}` : null,
        research && o.asOfLastNight ? " · as of last night" : null,
      ),
      i.labels.length ? h("p", { class: "line labels" }, ...labelsLine(i.labels, o.colors ?? new Map())) : null,
    ),
  );
}

/** A label's row on the labels page: the mark, the name, the description, its open issues. */
export function labelRow(l: T.Label, issuesHref: string): El {
  return h(
    "li",
    { class: "label-row" },
    labelEl(l.name, l.color),
    l.description ? h("span", { class: "label-about" }, ` — ${l.description}`) : null,
    " · ",
    h("a", { href: issuesHref }, "its open issues"),
  );
}

/** A milestone's progress in words: "3 of 5 issues closed (60%), due 2026-12-01". */
export function milestoneInWords(m: T.Milestone): string {
  const total = m.openIssues + m.closedIssues;
  const pct = total ? Math.round((m.closedIssues / total) * 100) : 0;
  const due = m.dueOn ? `, due ${m.dueOn.slice(0, 10)}` : "";
  return `${total ? `${m.closedIssues} of ${plural(total, "issue")} closed (${pct}%)` : "No issue yet"}${due}${m.state === "closed" ? "; closed" : ""}`;
}

// ─── references in a rendered text ───────────────────────────────────────────

const REF = /(^|[^A-Za-z0-9_/&#-])(research#([1-9][0-9]{0,9})|#([1-9][0-9]{0,9}))\b/g;

/** A rendered text with its references as links: "#12" to the issue (or pull request: GitHub
 *  numbers them together, and its page says which) in this repository, "research#3" to the research
 *  issue. Code, links and pre-formatted text are left as they are. */
export function linkRefs(node: El, repo: RepoCoords | null): El {
  const skip = new Set(["a", "code", "pre", "kbd", "samp"]);
  const walk = (n: El): El => {
    if (skip.has(n.tag)) return n;
    const children: (string | El)[] = [];
    for (const c of n.children) {
      if (typeof c !== "string") {
        children.push(walk(c));
        continue;
      }
      let last = 0;
      let m: RegExpExecArray | null;
      REF.lastIndex = 0;
      while ((m = REF.exec(c)) !== null) {
        const at = m.index + m[1].length;
        if (at > last) children.push(c.slice(last, at));
        if (m[3]) children.push(h("a", { href: researchPath(Number(m[3])), class: "ref" }, m[2]));
        else if (repo) children.push(h("a", { href: issuePath(repo, Number(m[4])), class: "ref" }, m[2]));
        else children.push(m[2]);
        last = at + m[2].length;
      }
      if (last < c.length) children.push(c.slice(last));
    }
    return { ...n, children };
  };
  return walk(node);
}
