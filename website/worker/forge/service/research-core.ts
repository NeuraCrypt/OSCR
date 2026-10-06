// Research issues: the registry's own issues (night phase 05, E2; docs/ISSUES.md; D00-6, D05-*).
// This file is their pure core, the words, the references, what a new issue, a comment and a change
// say, the rows as statements, the views the pages read, shared by the routes (research.ts), the
// merge that closes them (act-pulls.ts), their copy on GitHub (act-research.ts) and the pages.
//
// Three types a researcher files about a paper's code, which GitHub has no word for:
//   code_error     "Code error": an error in the code that may change the paper's results;
//   mismatch       "Code–paper mismatch": the code does not do what the paper says, on ONE
//                  tracing-map link (the paper's paragraph, and the lines at a commit);
//   reproduction   "Reproduction failure": the reader ran the authors' code and did not get the
//                  paper's result; the issue carries the reproduction report (the outcome, the
//                  environment, the commit, the data, the command, what was expected and seen).
// Each belongs to a paper (its DOI) and to its code: a GitHub repository the registry knows as that
// paper's code (oscr_forge repo_papers, or the Mac's oscr_community paper_repo facts), or the code's
// address elsewhere (Zenodo, OSF…: a place the registry recognizes, contributions/links.ts).
//
// The routes (docs/FORGE.md):
//   GET  /api/forge/research?id=N                    one issue, its comments, what the reader may do
//   GET  /api/forge/research?paper=doi:…[&paper=…][&repo=<forge>:<id>]
//                                                    the papers' issues (≤ 10 papers, 100 each), the
//                                                    repository's only when `repo` is given
//   POST /api/forge/research/open                    a new issue (3 rows: its row, its index entry,
//                                                    the action row)
//   POST /api/forge/research/comment                 a comment (3 rows: its row, the issue's count,
//                                                    the action row); its edit, deletion or hiding (2)
//   POST /api/forge/research/edit                    title, description, close with a reason and a
//                                                    research resolution, reopen, labels, lock, pin (2)
// Signed in: the reads need a session (a signed-out reader reads the nightly static shards: 0 Worker
// requests); the writes the session, its CSRF token and the site's Origin (account/guard.ts), and
// FORGE_OPEN (gate.ts: the owner only until phase 16), then the per-account caps (100 writes a day,
// 20 research issues) and the day's 5,000 rows, counted from the action rows each write adds.
//
// Who may do what: anyone signed in opens and comments (a locked issue takes comments from its
// triagers only); the issue's author edits its title and text, closes and reopens it; its triagers -
// the paper's verified authors, the repository's maintainers (oscr_community roles), the
// registry's moderators, do that too, and label, lock, pin, hide comments. Every text is masked for
// email addresses before it is stored (CLAUDE.md; oscr_forge holds none), and rendered by the pages
// as view trees, never as HTML.

import type { SignedIn } from "../../account/guard.ts";
import { recognize } from "../../contributions/links.ts";
import { BODY_CHARS } from "../limits.ts";
import { maskEmails } from "../mask.ts";
import { LOGIN } from "../paths.ts";
import { paperId } from "./papers.ts";
import { ForgeProblem, type D1Database, type Write } from "./types.ts";

// ─── the words ───────────────────────────────────────────────────────────────

export type ResearchType = "code_error" | "mismatch" | "reproduction";
export const RESEARCH_TYPES: readonly ResearchType[] = ["code_error", "mismatch", "reproduction"];
export const TYPE_WORDS: Readonly<Record<ResearchType, string>> = {
  code_error: "Code error",
  mismatch: "Code–paper mismatch",
  reproduction: "Reproduction failure",
};

export type CloseReason = "completed" | "not_planned" | "duplicate";
export const CLOSE_REASONS: readonly CloseReason[] = ["completed", "not_planned", "duplicate"];

export type Resolution = "fixed_in_code" | "paper_corrected" | "not_a_mismatch" | "cannot_reproduce" | "data_available";
export const RESOLUTIONS: readonly Resolution[] = ["fixed_in_code", "paper_corrected", "not_a_mismatch", "cannot_reproduce", "data_available"];
/** A resolution in words ("Closed: fixed in the code"). */
export const RESOLUTION_WORDS: Readonly<Record<Resolution, string>> = {
  fixed_in_code: "fixed in the code",
  paper_corrected: "the paper was corrected",
  not_a_mismatch: "not a mismatch",
  cannot_reproduce: "the failure could not be reproduced",
  data_available: "the data is now available",
};
/** GitHub's reason each resolution closes with (the lists and GitHub's copies read it). */
export const RESOLUTION_REASON: Readonly<Record<Resolution, CloseReason>> = {
  fixed_in_code: "completed",
  paper_corrected: "completed",
  data_available: "completed",
  not_a_mismatch: "not_planned",
  cannot_reproduce: "not_planned",
};
/** The resolutions that fit each type. */
export const RESOLUTIONS_OF: Readonly<Record<ResearchType, readonly Resolution[]>> = {
  code_error: ["fixed_in_code", "paper_corrected"],
  mismatch: ["fixed_in_code", "paper_corrected", "not_a_mismatch"],
  reproduction: ["fixed_in_code", "paper_corrected", "cannot_reproduce", "data_available"],
};

export type Outcome = "failed" | "partially";
export const OUTCOME_WORDS: Readonly<Record<Outcome, string>> = { failed: "not reproduced", partially: "partly reproduced" };

export const LOCK_REASONS = ["off-topic", "too heated", "resolved", "spam"] as const;
export type LockReason = (typeof LOCK_REASONS)[number];
/** Night phase 16: GitHub's seventh reason, "low-quality" (migrations/d1-forge/0010_moderation.sql). */
export const HIDE_REASONS = ["spam", "abuse", "off-topic", "outdated", "duplicate", "resolved", "low-quality"] as const;
export type HideReason = (typeof HIDE_REASONS)[number];

/** Limits (the texts' own are GitHub's). */
export const RESEARCH_BODY_BYTES = 256 * 1024;
export const RESEARCH_LABELS = 10;
export const RESEARCH_PINNED = 3;
export const RESEARCH_COMMENTS = 2500;
export const RESEARCH_EVENTS = 100;
export const LIST_PAPERS = 10;
export const LIST_PER_PAPER = 100;

// ─── references: "research#12", and "fixes research#12" ──────────────────────

export interface ResearchRef {
  id: number;
  /** The closing keyword ("fixes"), or null for a mention. */
  keyword: string | null;
}

/** The research issues a text names: "research#12", with a closing keyword before it ("Fixes
 *  research#12") or mentioned. Code spans and blocks are left out, as GitHub leaves its own. The
 *  form names no platform, and GitHub reads nothing in it (no "owner/name#" before the "#"). */
export function researchRefs(text: string): ResearchRef[] {
  if (typeof text !== "string") return [];
  const plain = text.slice(0, BODY_CHARS * 2).replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const re = /(?:\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved):?\s+)?\bresearch#([1-9][0-9]{0,9})\b/gi;
  const out = new Map<number, ResearchRef>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain)) !== null) {
    const before = plain[m.index - 1];
    if (!m[1] && before && /[A-Za-z0-9_/-]/.test(before)) continue;
    const id = Number(m[2]);
    if (id > 2 ** 31) continue;
    const keyword = m[1] ? m[1].toLowerCase() : null;
    const had = out.get(id);
    if (!had || (!had.keyword && keyword)) out.set(id, { id, keyword });
  }
  return [...out.values()];
}

/** The ids a text closes ("Fixes research#12"). */
export const researchClosing = (text: string): number[] => researchRefs(text).filter((r) => r.keyword).map((r) => r.id);

// ─── texts ───────────────────────────────────────────────────────────────────

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 31;
/** Control characters but the tab and the line feed, and the characters that reorder or hide text. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/;

/** A text as the registry keeps it: line feeds only, no control or bidi character, every email
 *  address hidden (a mention "@login" stays). */
export const clean = (text: string): string => maskEmails(text.replace(/\r\n?/g, "\n").replace(CONTROL, ""));

function readTitle(v: unknown): string | ForgeProblem {
  if (typeof v !== "string" || !v.trim()) return bad("Give the issue a title: one line that says what is wrong.");
  const t = clean(v.trim());
  if (/\n/.test(t) || t.length > 256) return bad("The title is one line of at most 256 characters; the description takes the rest.");
  return t;
}

function readBody(v: unknown, what: string, required = false): string | ForgeProblem {
  if (v === undefined || v === null) return required ? bad(`${what} is empty.`) : "";
  if (typeof v !== "string") return bad(`${what} is not text.`);
  if (v.length > BODY_CHARS) return bad(`${what} is at most ${BODY_CHARS.toLocaleString("en-GB")} characters.`);
  if (required && !v.trim()) return bad(`${what} is empty.`);
  return clean(v);
}

function readLine(v: unknown, what: string, max: number): string | ForgeProblem {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string") return bad(`${what} is not text.`);
  const t = clean(v).trim();
  if (t.length > max) return bad(`${what} is at most ${max} characters.`);
  return t;
}

const isLabel = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 50 && !/[\u0000-\u001f\u007f@]/.test(v) && v.trim() === v;

// ─── what a new issue says ───────────────────────────────────────────────────

export interface Anchor {
  commit: string;
  path: string;
  start: number | null;
  end: number | null;
  paragraph: number | null;
  section: string;
}

export interface Report {
  outcome: Outcome;
  environment: string;
  datasets: string[];
  command: string;
  expected: string;
  observed: string;
  figure: string;
}

export interface OpenParsed {
  paper: string;
  repo: { forge: "github" | "memory"; id: string; path: string } | null;
  codeUrl: string;
  type: ResearchType;
  title: string;
  body: string;
  anchor: Anchor;
  report: Report | null;
  labels: string[];
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO_PATH = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;

function readPath(v: unknown): string | ForgeProblem {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string" || v.length > 500 || v.startsWith("/") || v.split("/").some((s) => !s || s === "." || s === "..") || HAS_CONTROL.test(v)) {
    return bad("The file is a path in the repository: a/b/c.py.");
  }
  return v;
}

export function readAnchor(p: Record<string, unknown>): Anchor | ForgeProblem {
  const commit = p.commit === undefined || p.commit === null || p.commit === "" ? "" : p.commit;
  if (commit !== "" && (typeof commit !== "string" || !OBJECT_ID.test(commit))) return bad("The commit is a full commit id (40 hexadecimal characters).");
  const path = readPath(p.path);
  if (path instanceof ForgeProblem) return path;
  let start: number | null = null;
  let end: number | null = null;
  if (p.lines !== undefined && p.lines !== null) {
    if (!isObject(p.lines) || !isId(p.lines.start) || (p.lines.end !== undefined && !isId(p.lines.end))) return bad("The lines are {start, end}, from line 1.");
    start = p.lines.start;
    end = (p.lines.end as number | undefined) ?? start;
    if (end < start || end - start > 2000) return bad("The lines run from the first to the last, 2,000 at most.");
    if (!path) return bad("Lines belong to a file: name it.");
  }
  if (p.paragraph !== undefined && p.paragraph !== null && !isId(p.paragraph)) return bad("The paragraph is the paper's paragraph number, as the tracing map numbers it.");
  const section = readLine(p.section, "The section's heading", 200);
  if (section instanceof ForgeProblem) return section;
  return { commit: commit as string, path, start, end, paragraph: (p.paragraph as number | undefined) ?? null, section };
}

export function readReport(v: unknown): Report | ForgeProblem {
  if (!isObject(v)) return bad("A reproduction failure carries its report: what was run, where, and what came out.");
  if (v.outcome !== "failed" && v.outcome !== "partially") return bad("The report's outcome is “not reproduced” or “partly reproduced”.");
  const texts: Partial<Record<"environment" | "command" | "expected" | "observed" | "figure", string>> = {};
  for (const [k, max, what] of [["environment", 4000, "The environment"], ["command", 1000, "The command"], ["expected", 4000, "What was expected"], ["observed", 4000, "What came out"], ["figure", 200, "The figure or table"]] as const) {
    const x = v[k] === undefined ? "" : typeof v[k] === "string" ? clean(v[k] as string).trim() : null;
    if (x === null) return bad(`${what} is not text.`);
    if (x.length > max) return bad(`${what} is at most ${max} characters.`);
    texts[k] = x;
  }
  if (!texts.observed) return bad("Say what came out: the number, the figure, the error.");
  const raw = v.datasets ?? [];
  if (!Array.isArray(raw) || raw.length > 10) return bad("At most 10 datasets, each a DOI or a data repository's address.");
  const datasets: string[] = [];
  for (const d of raw) {
    const doi = paperId(d);
    const place = doi ? null : recognize(d, "data");
    const key = doi ?? place?.url ?? null;
    if (!key) return bad(`“${String(d).slice(0, 80)}” is not a DOI or a data repository the registry knows.`);
    if (!datasets.includes(key)) datasets.push(key);
  }
  return { outcome: v.outcome, environment: texts.environment ?? "", datasets, command: texts.command ?? "", expected: texts.expected ?? "", observed: texts.observed, figure: texts.figure ?? "" };
}

function readLabels(v: unknown): string[] | ForgeProblem {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > RESEARCH_LABELS) return bad(`At most ${RESEARCH_LABELS} labels.`);
  const out: string[] = [];
  for (const l of v) {
    if (!isLabel(l)) return bad("A label is one line of at most 50 characters.");
    if (!out.some((x) => x.toLowerCase() === l.toLowerCase())) out.push(l);
  }
  return out;
}

export function validateOpen(payload: unknown): OpenParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The issue is not readable.");
  const p = payload;
  const paper = paperId(p.paper);
  if (!paper) return bad("A research issue is about a paper: name it by its DOI (10.…).");
  if (!RESEARCH_TYPES.includes(p.type as ResearchType)) return bad("A research issue is a code error, a code–paper mismatch or a reproduction failure.");
  const type = p.type as ResearchType;
  let repo: OpenParsed["repo"] = null;
  let codeUrl = "";
  if (p.repo !== undefined && p.repo !== null) {
    const r = p.repo;
    if (!isObject(r) || (r.forge !== "github" && r.forge !== "memory") || typeof r.id !== "string" || !/^[0-9]{1,20}$/.test(r.id) || typeof r.path !== "string" || !REPO_PATH.test(r.path.toLowerCase())) {
      return bad("The repository is named by its forge, its id and its owner/name.");
    }
    repo = { forge: r.forge, id: r.id, path: r.path.toLowerCase() };
  } else {
    const place = recognize(p.code, "code");
    if (!place) return bad("Name the code: a GitHub repository the registry knows, or the code's address elsewhere (Zenodo, OSF, Software Heritage…).");
    codeUrl = place.url;
  }
  const title = readTitle(p.title);
  if (title instanceof ForgeProblem) return title;
  const body = readBody(p.body, "The description");
  if (body instanceof ForgeProblem) return body;
  const anchor = readAnchor(p);
  if (anchor instanceof ForgeProblem) return anchor;
  if (type === "mismatch" && (!anchor.path || anchor.start === null || anchor.paragraph === null)) {
    return bad("A code–paper mismatch names its tracing-map link: the paper's paragraph, and the file and lines of the code.");
  }
  const report = type === "reproduction" ? readReport(p.report) : null;
  if (report instanceof ForgeProblem) return report;
  if (type !== "reproduction" && p.report !== undefined) return bad("Only a reproduction failure carries a report.");
  const labels = readLabels(p.labels);
  if (labels instanceof ForgeProblem) return labels;
  return { paper, repo, codeUrl, type, title, body, anchor, report, labels };
}

// ─── who is writing ──────────────────────────────────────────────────────────

export interface Person {
  id: string;
  author: string;
  via: "github" | "orcid" | "name";
}

/** How a person is named on an issue: their GitHub login, else their ORCID iD, else their display
 *  name (public, masked, no at sign); never an address. */
export function personOf(user: SignedIn["user"]): Person {
  if (user.github_login && LOGIN.test(user.github_login)) return { id: user.id, author: user.github_login, via: "github" };
  if (user.orcid && /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(user.orcid)) return { id: user.id, author: user.orcid, via: "orcid" };
  const name = clean(user.display_name ?? "").replace(/[@＠]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return { id: user.id, author: name || "A reader", via: "name" };
}

// ─── the rows ────────────────────────────────────────────────────────────────

export interface IssueRow {
  id: number;
  paper_id: string;
  forge: string;
  repo_id: string;
  repo_path: string;
  code_url: string;
  type: ResearchType;
  title: string;
  body: string;
  commit_sha: string;
  path: string;
  start_line: number | null;
  end_line: number | null;
  paragraph: number | null;
  section: string;
  report: string;
  labels: string;
  state: "open" | "closed";
  close_reason: "" | CloseReason;
  resolution: "" | Resolution;
  resolution_ref: string;
  locked: number;
  lock_reason: "" | LockReason;
  pinned: number;
  github_number: number | null;
  author_id: string;
  author: string;
  author_via: Person["via"];
  author_role: "" | "verified_author" | "maintainer";
  comments: number;
  events: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export interface CommentRow {
  issue_id: number;
  n: number;
  author_id: string;
  author: string;
  author_via: Person["via"];
  author_role: "" | "verified_author" | "maintainer";
  body: string;
  created_at: number;
  edited_at: number | null;
  deleted: number;
  hidden: "" | HideReason;
}

export interface ResearchEvent {
  /** closed, reopened, renamed, labeled, unlabeled, locked, unlocked, pinned, unpinned, copied,
   *  edited, merged (closed by a pull request). */
  k: string;
  by: string;
  at: number;
  /** What the event names: the reason and resolution, the old title, a label, a pull request. */
  s?: string;
}

export const SUMMARY_COLUMNS =
  "id, paper_id, forge, repo_id, repo_path, code_url, type, title, commit_sha, path, start_line, end_line, paragraph, section, " +
  "json_extract(report, '$.outcome') AS outcome, labels, state, close_reason, resolution, resolution_ref, locked, pinned, github_number, " +
  "author, author_via, author_role, comments, created_at, updated_at, closed_at";

export const issueById = (db: D1Database, id: number) => db.prepare("SELECT * FROM research_issues WHERE id = ?").bind(id);
export const commentsOf = (db: D1Database, id: number) => db.prepare("SELECT * FROM research_comments WHERE issue_id = ? ORDER BY n LIMIT 2500").bind(id);
export const issuesOfPaper = (db: D1Database, paper: string, limit = LIST_PER_PAPER) =>
  db.prepare(`SELECT ${SUMMARY_COLUMNS}, author_id FROM research_issues WHERE paper_id = ? ORDER BY id DESC LIMIT ?`).bind(paper, limit);

/** A new issue (2 rows: the row and its index entry). */
export function insertIssue(db: D1Database, p: OpenParsed, who: Person, role: IssueRow["author_role"], t: number): Write {
  const a = p.anchor;
  return {
    rows: 2,
    stmt: db
      .prepare(
        "INSERT INTO research_issues (paper_id, forge, repo_id, repo_path, code_url, type, title, body, commit_sha, path, start_line, end_line, " +
          "paragraph, section, report, labels, author_id, author, author_via, author_role, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        p.paper, p.repo?.forge ?? "", p.repo?.id ?? "", p.repo?.path ?? "", p.codeUrl, p.type, p.title, p.body, a.commit, a.path, a.start, a.end,
        a.paragraph, a.section, JSON.stringify(p.report ?? {}), JSON.stringify(p.labels), who.id, who.author, who.via, role, Math.floor(t), Math.floor(t),
      ),
  };
}

/** The SQL that appends `n` events to `events` in one assignment (SQLite keeps only the last of two
 *  assignments to one column), keeping about the last RESEARCH_EVENTS: when they would overflow, the
 *  `n` oldest go. */
function appendEvents(n: number): string {
  const trimmed = `CASE WHEN json_array_length(events) > ${RESEARCH_EVENTS - n} THEN json_remove(events${", '$[0]'".repeat(n)}) ELSE events END`;
  return `events = json_insert(${trimmed}${", '$[#]', json(?)".repeat(n)})`;
}

/** A change of an issue (1 row: no indexed column moves), guarded by `where` (the state the page
 *  saw is not assumed: each guard says what must still hold). */
export function updateIssue(db: D1Database, id: number, set: Record<string, string | number | null>, events: ResearchEvent[], t: number, where = ""): Write {
  const cols = Object.keys(set);
  const parts = [...cols.map((c) => `${c} = ?`), "updated_at = ?", ...(events.length ? [appendEvents(events.length)] : [])];
  return {
    rows: 1,
    stmt: db
      .prepare(`UPDATE research_issues SET ${parts.join(", ")} WHERE id = ?${where ? ` AND ${where}` : ""}`)
      .bind(...cols.map((c) => set[c]), Math.floor(t), ...events.map((e) => JSON.stringify(e)), id),
  };
}

/** A new comment and the issue's count (2 rows, in one batch: the comment's number is the count
 *  after it; a locked issue takes one only from its triagers, checked before). */
export function insertComment(db: D1Database, id: number, body: string, who: Person, role: CommentRow["author_role"], t: number): Write[] {
  return [
    {
      rows: 1,
      stmt: db
        .prepare(
          "INSERT INTO research_comments (issue_id, n, author_id, author, author_via, author_role, body, created_at) " +
            "SELECT id, comments + 1, ?, ?, ?, ?, ?, ? FROM research_issues WHERE id = ? AND comments < ?",
        )
        .bind(who.id, who.author, who.via, role, body, Math.floor(t), id, RESEARCH_COMMENTS),
    },
    { rows: 1, stmt: db.prepare("UPDATE research_issues SET comments = comments + 1, updated_at = ? WHERE id = ? AND comments < ?").bind(Math.floor(t), id, RESEARCH_COMMENTS) },
  ];
}

export function updateComment(db: D1Database, id: number, n: number, set: Record<string, string | number | null>): Write {
  const cols = Object.keys(set);
  return { rows: 1, stmt: db.prepare(`UPDATE research_comments SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE issue_id = ? AND n = ?`).bind(...cols.map((c) => set[c]), id, n) };
}

/** Closed by a merged pull request: "fixed in the code", at the merge commit (1 row; nothing when
 *  it was closed meanwhile). */
export function closeByMerge(db: D1Database, id: number, sha: string, pull: number, by: string, t: number): Write {
  return updateIssue(
    db,
    id,
    { state: "closed", close_reason: "completed", resolution: "fixed_in_code", resolution_ref: sha, closed_at: Math.floor(t) },
    [{ k: "merged", by, at: Math.floor(t), s: `#${pull}` }],
    t,
    "state = 'open'",
  );
}

// ─── the views the pages read ────────────────────────────────────────────────

export interface IssueSummary {
  id: number;
  paper: string;
  repo: { forge: string; id: string; path: string } | null;
  code_url: string;
  type: ResearchType;
  title: string;
  state: "open" | "closed";
  close_reason: "" | CloseReason;
  resolution: "" | Resolution;
  resolution_ref: string;
  labels: string[];
  locked: boolean;
  pinned: boolean;
  author: string;
  author_via: Person["via"];
  author_role: IssueRow["author_role"];
  comments: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  anchor: Anchor | null;
  outcome: Outcome | null;
  github_number: number | null;
}

const parseList = (text: unknown): string[] => {
  try {
    const v = JSON.parse(String(text));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

export function summaryOf(r: Omit<IssueRow, "body" | "report" | "events" | "author_id" | "lock_reason"> & { outcome?: unknown; report?: string }): IssueSummary {
  const anchor: Anchor | null =
    r.path || r.paragraph !== null || r.commit_sha ? { commit: r.commit_sha, path: r.path, start: r.start_line, end: r.end_line, paragraph: r.paragraph, section: r.section } : null;
  let outcome = r.outcome;
  if (outcome === undefined && typeof r.report === "string") {
    try {
      outcome = (JSON.parse(r.report) as { outcome?: unknown }).outcome;
    } catch {
      outcome = null;
    }
  }
  return {
    id: r.id,
    paper: r.paper_id,
    repo: r.repo_id ? { forge: r.forge, id: r.repo_id, path: r.repo_path } : null,
    code_url: r.code_url,
    type: r.type,
    title: r.title,
    state: r.state,
    close_reason: r.close_reason,
    resolution: r.resolution,
    resolution_ref: r.resolution_ref,
    labels: parseList(r.labels),
    locked: r.locked === 1,
    pinned: r.pinned === 1,
    author: r.author,
    author_via: r.author_via,
    author_role: r.author_role,
    comments: r.comments,
    created_at: r.created_at,
    updated_at: r.updated_at,
    closed_at: r.closed_at,
    anchor,
    outcome: outcome === "failed" || outcome === "partially" ? outcome : null,
    github_number: r.github_number,
  };
}

export interface IssueView extends IssueSummary {
  body: string;
  report: Report | null;
  lock_reason: "" | LockReason;
  events: ResearchEvent[];
}

export function viewOf(r: IssueRow): IssueView {
  let report: Report | null = null;
  try {
    const x = JSON.parse(r.report) as Partial<Report>;
    if (x && (x.outcome === "failed" || x.outcome === "partially")) report = x as Report;
  } catch {
    report = null;
  }
  let events: ResearchEvent[] = [];
  try {
    const x = JSON.parse(r.events) as unknown;
    if (Array.isArray(x)) events = x.filter((e): e is ResearchEvent => isObject(e) && typeof e.k === "string" && typeof e.at === "number");
  } catch {
    events = [];
  }
  return { ...summaryOf(r), body: r.body, report, lock_reason: r.lock_reason, events };
}

export interface CommentView {
  n: number;
  author: string;
  author_via: Person["via"];
  author_role: CommentRow["author_role"];
  body: string;
  created_at: number;
  edited_at: number | null;
  deleted: boolean;
  hidden: "" | HideReason;
}

export const commentViewOf = (c: CommentRow): CommentView => ({
  n: c.n,
  author: c.author,
  author_via: c.author_via,
  author_role: c.author_role,
  body: c.deleted ? "" : c.body,
  created_at: c.created_at,
  edited_at: c.edited_at,
  deleted: c.deleted === 1,
  hidden: c.hidden,
});

// ─── what a comment and a change say ────────────────────────────────────────

export interface CommentParsed {
  id: number;
  n: number | null;
  body: string | null;
  delete: boolean;
  hide: "" | HideReason | null;
}

export function validateComment(payload: unknown): CommentParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The comment is not readable.");
  if (!isId(payload.id)) return bad("Name the research issue by its number.");
  if (payload.n !== undefined && (!isId(payload.n) || payload.n > RESEARCH_COMMENTS)) return bad("A comment is named by its number in the issue.");
  const n = (payload.n as number | undefined) ?? null;
  const ops = [payload.body !== undefined, payload.delete !== undefined, payload.hide !== undefined].filter(Boolean).length;
  if (ops !== 1) return bad("A comment is written, edited, deleted or hidden: one at a time.");
  if (payload.delete !== undefined) {
    if (payload.delete !== true || n === null) return bad("Deleting names the comment, and only that.");
    return { id: payload.id, n, body: null, delete: true, hide: null };
  }
  if (payload.hide !== undefined) {
    if (n === null || (payload.hide !== "" && !HIDE_REASONS.includes(payload.hide as HideReason))) return bad("A comment is hidden as spam, abuse, off-topic, outdated, a duplicate, resolved or low quality, or shown again.");
    return { id: payload.id, n, body: null, delete: false, hide: payload.hide as "" | HideReason };
  }
  const body = readBody(payload.body, "The comment", true);
  if (body instanceof ForgeProblem) return body;
  return { id: payload.id, n, body, delete: false, hide: null };
}

export interface EditParsed {
  id: number;
  title: string | null;
  body: string | null;
  state: "open" | "closed" | null;
  reason: CloseReason | null;
  resolution: Resolution | null;
  ref: string;
  duplicateOf: number | null;
  labels: { add: string[]; remove: string[] } | null;
  locked: boolean | null;
  lockReason: "" | LockReason;
  pinned: boolean | null;
}

export function validateEdit(payload: unknown): EditParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The change is not readable.");
  const p = payload;
  if (!isId(p.id)) return bad("Name the research issue by its number.");
  const out: EditParsed = { id: p.id, title: null, body: null, state: null, reason: null, resolution: null, ref: "", duplicateOf: null, labels: null, locked: null, lockReason: "", pinned: null };
  if (p.title !== undefined) {
    const t = readTitle(p.title);
    if (t instanceof ForgeProblem) return t;
    out.title = t;
  }
  if (p.body !== undefined) {
    const b = readBody(p.body, "The description");
    if (b instanceof ForgeProblem) return b;
    out.body = b;
  }
  if (p.state !== undefined) {
    if (p.state !== "open" && p.state !== "closed") return bad("A research issue is closed or reopened.");
    out.state = p.state;
  }
  if (p.resolution !== undefined) {
    if (!RESOLUTIONS.includes(p.resolution as Resolution)) return bad("A resolution is fixed in the code, the paper corrected, not a mismatch, not reproduced, or the data now available.");
    if (out.state !== "closed") return bad("A resolution goes with closing the issue.");
    out.resolution = p.resolution as Resolution;
  }
  if (p.reason !== undefined) {
    if (!CLOSE_REASONS.includes(p.reason as CloseReason)) return bad("An issue is closed as completed, not planned, or a duplicate.");
    if (out.state !== "closed") return bad("A reason goes with closing the issue.");
    out.reason = p.reason as CloseReason;
  }
  if (out.resolution && out.reason && RESOLUTION_REASON[out.resolution] !== out.reason) return bad("This resolution does not go with this reason.");
  if (out.state === "closed") out.reason ??= out.resolution ? RESOLUTION_REASON[out.resolution] : "completed";
  if (p.ref !== undefined) {
    const ref = readLine(p.ref, "What settles it (a commit, a pull request, the correction's DOI)", 300);
    if (ref instanceof ForgeProblem) return ref;
    if (!out.resolution) return bad("What settles it goes with a resolution.");
    out.ref = ref;
  }
  if (p.duplicateOf !== undefined) {
    if (!isId(p.duplicateOf) || p.duplicateOf === p.id) return bad("A duplicate names the research issue it repeats, by its number.");
    if (out.reason !== "duplicate") return bad("“Duplicate of” goes with closing the issue as a duplicate.");
    out.duplicateOf = p.duplicateOf;
    out.ref = `research#${p.duplicateOf}`;
  }
  if (p.labels !== undefined) {
    if (!isObject(p.labels)) return bad("The labels to add and to remove are not readable.");
    const add = readLabels(p.labels.add);
    if (add instanceof ForgeProblem) return add;
    const remove = readLabels(p.labels.remove);
    if (remove instanceof ForgeProblem) return remove;
    if (!add.length && !remove.length) return bad("No label to add or remove.");
    out.labels = { add, remove };
  }
  if (p.locked !== undefined) {
    if (typeof p.locked !== "boolean") return bad("The conversation is locked or unlocked.");
    out.locked = p.locked;
    if (p.lockReason !== undefined && p.lockReason !== "") {
      if (!p.locked || !LOCK_REASONS.includes(p.lockReason as LockReason)) return bad("A lock's reason is off-topic, too heated, resolved or spam.");
      out.lockReason = p.lockReason as LockReason;
    }
  }
  if (p.pinned !== undefined) {
    if (typeof p.pinned !== "boolean") return bad("The issue is pinned or unpinned.");
    out.pinned = p.pinned;
  }
  const changes = [out.title, out.body, out.state, out.labels, out.locked, out.pinned].filter((x) => x !== null).length;
  if (!changes) return bad("Nothing to change.");
  return out;
}
