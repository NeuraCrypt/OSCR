// Snippets, OSCR's gists (night phase 13; docs/SNIPPETS.md; D00-6, D00-14, D13-*). This is their pure
// core (the words, what a new snippet, a revision, an edit and a comment say, the rows as statements,
// the views the pages read), shared by the authorized actions (act-snippet.ts: create, revise, fork)
// and the native routes (snippets.ts: read, edit, comment, star). No request, no database here.
//
// A snippet's FILES live in a `snippets` repository in the researcher's own GitHub account, one folder
// per snippet, committed as the person (act-snippet.ts). This core turns a create/revise payload into
// the file changes for that commit AND a MANIFEST (path, language, size, lines) for the record. The
// content never reaches D1 or a log (no git text in D1, the row budget): the record holds the manifest
// and points at the revision, and the browser reads the files from GitHub at that pinned commit.
//
// Public free text (CLAUDE.md): every text (the description, a comment) is masked for email addresses
// (clean -> maskEmails) and stripped of control characters before it is stored; oscr_forge holds no
// address. The pages render it as view trees, never as HTML.

import { utf8 } from "../objects.ts";
import { checkPath } from "../paths.ts";
import { GitBackendError } from "../errors.ts";
import type { FileChange } from "../types.ts";
import { clean, personOf, type Person } from "./research-core.ts";
import { ForgeProblem, type D1Database, type Write } from "./types.ts";

export { clean, personOf, type Person };

// ─── the words and the limits ────────────────────────────────────────────────

export type Visibility = "public" | "unlisted";
export const VISIBILITIES: readonly Visibility[] = ["public", "unlisted"];

export const HIDE_REASONS = ["spam", "abuse", "off-topic", "outdated", "duplicate", "resolved", "low-quality"] as const;
export type HideReason = (typeof HIDE_REASONS)[number];

export const TITLE_CHARS = 200;
export const DESCRIPTION_CHARS = 4096;
/** The comment length limit phase 16 states (65,536 characters), here too. */
export const COMMENT_CHARS = 65_536;
export const SECTION_CHARS = 200;
/** Files in one snippet (a commit from the browser holds up to COMMIT_FILES; a snippet is small). */
export const SNIPPET_FILES_MAX = 20;
/** One file's text, in bytes: a snippet is a few lines, not a repository. Larger: make a repository. */
export const SNIPPET_FILE_BYTES = 512 * 1024;
export const SNIPPET_COMMENTS = 5_000;
/** The prior bodies an edited comment keeps (its history). */
export const COMMENT_HISTORY = 20;
export const LIST_LIMIT = 100;
/** The body of a snippet's native POST (edit, comment, star): never a commit's files. */
export const SNIPPET_BODY_BYTES = 256 * 1024;

// ─── languages by extension (no dependency: a small table on the Mac's standard set) ─────────────

const LANGUAGES: Readonly<Record<string, string>> = {
  py: "Python", r: "R", ipynb: "Jupyter Notebook", js: "JavaScript", ts: "TypeScript", tsx: "TypeScript",
  jsx: "JavaScript", c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++", cs: "C#", java: "Java", go: "Go",
  rs: "Rust", rb: "Ruby", php: "PHP", swift: "Swift", kt: "Kotlin", scala: "Scala", jl: "Julia",
  m: "MATLAB", sh: "Shell", bash: "Shell", zsh: "Shell", pl: "Perl", lua: "Lua", sql: "SQL",
  html: "HTML", css: "CSS", xml: "XML", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML",
  md: "Markdown", rst: "reStructuredText", tex: "TeX", f: "Fortran", f90: "Fortran", nf: "Nextflow",
  smk: "Snakemake", snakefile: "Snakemake", csv: "CSV", tsv: "CSV", txt: "Text",
};

/** A file's language from its path (its extension, or the whole name for a few), or "". */
export function languageOf(path: string): string {
  const name = path.toLowerCase().split("/").pop() ?? "";
  if (LANGUAGES[name]) return LANGUAGES[name];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (LANGUAGES[name.slice(dot + 1)] ?? "") : "";
}

// ─── what a new snippet and a revision say ───────────────────────────────────────

/** A file as the form sends it: a path and its text. */
export interface FileInput {
  path: string;
  content: string;
}

/** One file in the record's manifest: never the content. */
export interface FileMeta {
  path: string;
  language: string;
  size: number;
  lines: number;
}

/** A paper passage a snippet is about: a DOI and a Methods paragraph, with lines at the revision.
 *  Shown beside the maps, never a map, never given a DOI (D13-*). */
export interface Passage {
  paperId: string;
  section: string;
  paragraph: number | null;
  startLine: number | null;
  endLine: number | null;
}

export const EMPTY_PASSAGE: Passage = { paperId: "", section: "", paragraph: null, startLine: null, endLine: null };

export interface CreateParsed {
  title: string;
  description: string;
  visibility: Visibility;
  files: FileInput[];
  /** The file changes for the commit (path + content as bytes). */
  changes: FileChange[];
  /** The manifest for the record (no content). */
  manifest: FileMeta[];
  passage: Passage;
  /** A fork copies another snippet's folder: its id, else null. */
  forkedFrom: number | null;
}

export interface ReviseParsed {
  id: number;
  title: string | null;
  description: string | null;
  files: FileInput[];
  changes: FileChange[];
  manifest: FileMeta[];
  passage: Passage | null;
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 31;
const isLine = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 31;

const encoder = new TextEncoder();

function readTitle(v: unknown): string | ForgeProblem {
  if (typeof v !== "string" || !v.trim()) return bad("Give the snippet a title: one line that says what it is.");
  const t = clean(v.trim());
  if (/\n/.test(t) || t.length > TITLE_CHARS) return bad(`The title is one line of at most ${TITLE_CHARS} characters.`);
  return t;
}

function readDescription(v: unknown): string | ForgeProblem {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return bad("The description is not text.");
  const t = clean(v);
  if (t.length > DESCRIPTION_CHARS) return bad(`The description is at most ${DESCRIPTION_CHARS.toLocaleString("en-GB")} characters.`);
  return t;
}

function readVisibility(v: unknown): Visibility | ForgeProblem {
  if (v === undefined || v === null || v === "") return "public";
  if (v !== "public" && v !== "unlisted") return bad("A snippet is public or unlisted.");
  return v;
}

/** The files of a create or a revision: their paths checked, their content held, the manifest built.
 *  `mayBeEmpty` lets a revision send no new file (a metadata-only revision keeps the files). */
function readFiles(raw: unknown, mayBeEmpty = false): { files: FileInput[]; changes: FileChange[]; manifest: FileMeta[] } | ForgeProblem {
  if (!Array.isArray(raw) || (raw.length === 0 && !mayBeEmpty)) return bad("A snippet has at least one file.");
  if (raw.length > SNIPPET_FILES_MAX) return bad(`A snippet holds at most ${SNIPPET_FILES_MAX} files; a repository holds more.`);
  const files: FileInput[] = [];
  const changes: FileChange[] = [];
  const manifest: FileMeta[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    if (!isObject(f) || typeof f.path !== "string" || typeof f.content !== "string") return bad("A file is a path and its content.");
    let path: string;
    try {
      path = checkPath(f.path);
    } catch (e) {
      if (e instanceof GitBackendError) return bad(`The file path “${f.path.slice(0, 120)}” is not one a repository may hold.`);
      throw e;
    }
    if (path.includes("/")) return bad("A snippet's files are flat: a name, not a path with folders.");
    if (seen.has(path.toLowerCase())) return bad(`The file “${path}” appears twice.`);
    seen.add(path.toLowerCase());
    const content = utf8(f.content);
    if (content.byteLength > SNIPPET_FILE_BYTES) return bad(`The file “${path}” is larger than ${(SNIPPET_FILE_BYTES / 1024).toFixed(0)} KiB: make a repository for it.`);
    files.push({ path, content: f.content });
    changes.push({ op: "put", path, content });
    manifest.push({ path, language: languageOf(path), size: content.byteLength, lines: f.content.length ? f.content.replace(/\n$/, "").split("\n").length : 0 });
  }
  return { files, changes, manifest };
}

export function readPassage(v: unknown): Passage | ForgeProblem {
  if (v === undefined || v === null) return { ...EMPTY_PASSAGE };
  if (!isObject(v)) return bad("The paper passage is not readable.");
  const paperId = typeof v.paperId === "string" ? v.paperId.trim().toLowerCase() : "";
  if (!paperId) return { ...EMPTY_PASSAGE };
  if (!/^doi:10\./.test(paperId) || paperId.length > 210) return bad("The paper is named by its DOI (doi:10.…).");
  const section = typeof v.section === "string" ? clean(v.section).replace(/\n/g, " ").trim().slice(0, SECTION_CHARS) : "";
  let paragraph: number | null = null;
  if (v.paragraph !== undefined && v.paragraph !== null) {
    if (!isId(v.paragraph)) return bad("The paragraph is a number.");
    paragraph = v.paragraph;
  }
  let startLine: number | null = null;
  let endLine: number | null = null;
  if (v.startLine !== undefined && v.startLine !== null) {
    if (!isLine(v.startLine)) return bad("The first line is a number.");
    startLine = v.startLine;
  }
  if (v.endLine !== undefined && v.endLine !== null) {
    if (!isLine(v.endLine)) return bad("The last line is a number.");
    endLine = v.endLine;
  }
  if (endLine !== null && startLine === null) return bad("A last line needs a first line.");
  if (endLine !== null && startLine !== null && endLine < startLine) return bad("The last line is before the first.");
  return { paperId, section, paragraph, startLine, endLine };
}

export function validateCreate(payload: unknown): CreateParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The snippet is not readable.");
  const title = readTitle(payload.title);
  if (title instanceof ForgeProblem) return title;
  const description = readDescription(payload.description);
  if (description instanceof ForgeProblem) return description;
  const visibility = readVisibility(payload.visibility);
  if (visibility instanceof ForgeProblem) return visibility;
  const read = readFiles(payload.files);
  if (read instanceof ForgeProblem) return read;
  const passage = readPassage(payload.passage);
  if (passage instanceof ForgeProblem) return passage;
  return { title, description, visibility, files: read.files, changes: read.changes, manifest: read.manifest, passage, forkedFrom: null };
}

export function validateRevise(payload: unknown): ReviseParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The revision is not readable.");
  if (!isId(payload.id)) return bad("Name the snippet by its number.");
  const title = payload.title === undefined ? null : readTitle(payload.title);
  if (title instanceof ForgeProblem) return title;
  const description = payload.description === undefined ? null : readDescription(payload.description);
  if (description instanceof ForgeProblem) return description;
  const read = readFiles(payload.files);
  if (read instanceof ForgeProblem) return read;
  let passage: Passage | null = null;
  if (payload.passage !== undefined) {
    const p = readPassage(payload.passage);
    if (p instanceof ForgeProblem) return p;
    passage = p;
  }
  return { id: payload.id, title, description, files: read.files, changes: read.changes, manifest: read.manifest, passage };
}

// ─── an edit of the record, and a comment ────────────────────────────────────────

export interface EditParsed {
  id: number;
  title: string | null;
  description: string | null;
  /** Only "public" is accepted (unlisted to public, never back: D13-*). */
  makePublic: boolean;
  commentsOff: boolean | null;
  passage: Passage | null;
  /** A triager hides or shows the whole snippet. */
  hide: "" | HideReason | null;
}

export function validateEdit(payload: unknown): EditParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The change is not readable.");
  const p = payload;
  if (!isId(p.id)) return bad("Name the snippet by its number.");
  const out: EditParsed = { id: p.id, title: null, description: null, makePublic: false, commentsOff: null, passage: null, hide: null };
  if (p.title !== undefined) {
    const t = readTitle(p.title);
    if (t instanceof ForgeProblem) return t;
    out.title = t;
  }
  if (p.description !== undefined) {
    const d = readDescription(p.description);
    if (d instanceof ForgeProblem) return d;
    out.description = d;
  }
  if (p.visibility !== undefined && p.visibility !== null) {
    if (p.visibility !== "public") return bad("A snippet is made public; an unlisted snippet cannot be made unlisted again, and a public one stays public.");
    out.makePublic = true;
  }
  if (p.commentsOff !== undefined) {
    if (typeof p.commentsOff !== "boolean") return bad("Comments are turned on or off.");
    out.commentsOff = p.commentsOff;
  }
  if (p.passage !== undefined) {
    const pp = readPassage(p.passage);
    if (pp instanceof ForgeProblem) return pp;
    out.passage = pp;
  }
  if (p.hide !== undefined) {
    if (p.hide !== "" && !HIDE_REASONS.includes(p.hide as HideReason)) return bad("A snippet is hidden as spam, abuse, off-topic, outdated, a duplicate, resolved or low quality, or shown again.");
    out.hide = p.hide as "" | HideReason;
  }
  const changes = [out.title, out.description, out.makePublic || null, out.commentsOff, out.passage, out.hide].filter((x) => x !== null && x !== false).length;
  if (!changes) return bad("Nothing to change.");
  return out;
}

export interface CommentParsed {
  id: number;
  n: number | null;
  body: string | null;
  replyTo: number | null;
  delete: boolean;
  hide: "" | HideReason | null;
}

export function validateComment(payload: unknown): CommentParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The comment is not readable.");
  if (!isId(payload.id)) return bad("Name the snippet by its number.");
  if (payload.n !== undefined && (!isId(payload.n) || payload.n > SNIPPET_COMMENTS)) return bad("A comment is named by its number in the snippet.");
  const n = (payload.n as number | undefined) ?? null;
  const ops = [payload.body !== undefined, payload.delete !== undefined, payload.hide !== undefined].filter(Boolean).length;
  if (ops !== 1) return bad("A comment is written, edited, deleted or hidden: one at a time.");
  if (payload.delete !== undefined) {
    if (payload.delete !== true || n === null) return bad("Deleting names the comment, and only that.");
    return { id: payload.id, n, body: null, replyTo: null, delete: true, hide: null };
  }
  if (payload.hide !== undefined) {
    if (n === null || (payload.hide !== "" && !HIDE_REASONS.includes(payload.hide as HideReason))) return bad("A comment is hidden as spam, abuse, off-topic, outdated, a duplicate, resolved or low quality, or shown again.");
    return { id: payload.id, n, body: null, replyTo: null, delete: false, hide: payload.hide as "" | HideReason };
  }
  if (typeof payload.body !== "string" || !payload.body.trim()) return bad("The comment is empty.");
  const body = clean(payload.body);
  if (body.length > COMMENT_CHARS) return bad(`A comment is at most ${COMMENT_CHARS.toLocaleString("en-GB")} characters.`);
  let replyTo: number | null = null;
  if (n === null && payload.replyTo !== undefined && payload.replyTo !== null) {
    if (!isId(payload.replyTo)) return bad("A reply names the comment it answers, by its number.");
    replyTo = payload.replyTo;
  }
  return { id: payload.id, n, body, replyTo, delete: false, hide: null };
}

// ─── slugs ───────────────────────────────────────────────────────────────────

/** A folder name from a title: lower case, a-z 0-9 and -, at most 48 characters, never empty. */
export function slugify(title: string): string {
  const s = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return s || "snippet";
}

// ─── the rows ────────────────────────────────────────────────────────────────

export interface SnippetRow {
  id: number;
  owner_id: string;
  owner_login: string;
  forge: string;
  repo_id: string;
  folder: string;
  revision: string;
  visibility: Visibility;
  title: string;
  description: string;
  files: string;
  paper_id: string;
  section: string;
  paragraph: number | null;
  start_line: number | null;
  end_line: number | null;
  stars: number;
  comments: number;
  forks: number;
  forked_from: number | null;
  comments_off: number;
  hidden: "" | HideReason;
  author: string;
  author_via: Person["via"];
  author_role: "" | "verified_author" | "maintainer";
  created_at: number;
  updated_at: number;
}

export interface SnippetCommentRow {
  snippet_id: number;
  n: number;
  author_id: string;
  author: string;
  author_via: Person["via"];
  author_role: "" | "verified_author" | "maintainer";
  body: string;
  reply_to: number | null;
  history: string;
  created_at: number;
  edited_at: number | null;
  deleted: number;
  hidden: "" | HideReason;
}

export interface NewSnippet {
  ownerId: string;
  ownerLogin: string;
  forge: string;
  repoId: string;
  folder: string;
  revision: string;
  visibility: Visibility;
  title: string;
  description: string;
  manifest: FileMeta[];
  passage: Passage;
  forkedFrom: number | null;
  who: Person;
  role: SnippetRow["author_role"];
}

/** A new snippet's record (1 row + 2 index entries: the (owner_login, folder) unique auto-index and
 *  the discover index). */
export function insertSnippet(db: D1Database, s: NewSnippet, t: number): Write {
  return {
    rows: 3,
    stmt: db
      .prepare(
        "INSERT INTO snippets (owner_id, owner_login, forge, repo_id, folder, revision, visibility, title, description, files, " +
          "paper_id, section, paragraph, start_line, end_line, forked_from, author, author_via, author_role, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        s.ownerId, s.ownerLogin.toLowerCase(), s.forge, s.repoId, s.folder.toLowerCase(), s.revision, s.visibility, s.title,
        s.description, JSON.stringify(s.manifest), s.passage.paperId, s.passage.section, s.passage.paragraph,
        s.passage.startLine, s.passage.endLine, s.forkedFrom, s.who.author, s.who.via, s.role, Math.floor(t), Math.floor(t),
      ),
  };
}

/** A change of a snippet's record (1 row; 2 when the discover index moves, i.e. `visibility` changes).
 *  Guarded by `where` so a revision only lands on the owner's snippet it saw. */
export function updateSnippet(db: D1Database, id: number, set: Record<string, string | number | null>, t: number, where = ""): Write {
  const cols = Object.keys(set);
  const moves = cols.includes("visibility");
  return {
    rows: moves ? 2 : 1,
    stmt: db
      .prepare(`UPDATE snippets SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?${where ? ` AND ${where}` : ""}`)
      .bind(...cols.map((c) => set[c]), Math.floor(t), id),
  };
}

/** A new comment and the snippet's count (2 rows, in one batch; the insert writes only when the
 *  snippet is under its comment limit). */
export function insertSnippetComment(db: D1Database, id: number, body: string, replyTo: number | null, who: Person, role: SnippetCommentRow["author_role"], t: number): Write[] {
  return [
    {
      rows: 1,
      stmt: db
        .prepare(
          "INSERT INTO snippet_comments (snippet_id, n, author_id, author, author_via, author_role, body, reply_to, created_at) " +
            "SELECT id, comments + 1, ?, ?, ?, ?, ?, ?, ? FROM snippets WHERE id = ? AND comments < ?",
        )
        .bind(who.id, who.author, who.via, role, body, replyTo, Math.floor(t), id, SNIPPET_COMMENTS),
    },
    { rows: 1, stmt: db.prepare("UPDATE snippets SET comments = comments + 1, updated_at = ? WHERE id = ? AND comments < ?").bind(Math.floor(t), id, SNIPPET_COMMENTS) },
  ];
}

export function updateSnippetComment(db: D1Database, id: number, n: number, set: Record<string, string | number | null>): Write {
  const cols = Object.keys(set);
  return { rows: 1, stmt: db.prepare(`UPDATE snippet_comments SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE snippet_id = ? AND n = ?`).bind(...cols.map((c) => set[c]), id, n) };
}

/** A star recorded (1 row); fails the batch (and so the count) if it is a repeat. */
export function insertStar(db: D1Database, id: number, who: Person, t: number): Write {
  return { rows: 1, stmt: db.prepare("INSERT INTO snippet_stars (snippet_id, user_id, starrer, starrer_via, at) VALUES (?, ?, ?, ?, ?)").bind(id, who.id, who.author, who.via, Math.floor(t)) };
}

export function deleteStar(db: D1Database, id: number, userId: string): Write {
  return { rows: 1, stmt: db.prepare("DELETE FROM snippet_stars WHERE snippet_id = ? AND user_id = ?").bind(id, userId) };
}

/** Change a snippet's stars by +1/-1 (1 row; never below 0). */
export function bumpStars(db: D1Database, id: number, delta: number, t: number): Write {
  return { rows: 1, stmt: db.prepare("UPDATE snippets SET stars = max(0, stars + ?), updated_at = ? WHERE id = ?").bind(delta, Math.floor(t), id) };
}

/** Add one to a snippet's forks (1 row; the forked snippet's own record is a separate insert). */
export function bumpForks(db: D1Database, id: number, t: number): Write {
  return { rows: 1, stmt: db.prepare("UPDATE snippets SET forks = forks + 1, updated_at = ? WHERE id = ?").bind(Math.floor(t), id) };
}

// ─── the statements the routes read by ───────────────────────────────────────────

export const snippetById = (db: D1Database, id: number) => db.prepare("SELECT * FROM snippets WHERE id = ?").bind(id);
export const snippetByHandle = (db: D1Database, ownerLogin: string, folder: string) =>
  db.prepare("SELECT * FROM snippets WHERE owner_login = ? AND folder = ?").bind(ownerLogin.toLowerCase(), folder.toLowerCase());
export const snippetCommentsOf = (db: D1Database, id: number) =>
  db.prepare("SELECT * FROM snippet_comments WHERE snippet_id = ? ORDER BY n LIMIT 5000").bind(id);
export const starRow = (db: D1Database, id: number, userId: string) =>
  db.prepare("SELECT snippet_id FROM snippet_stars WHERE snippet_id = ? AND user_id = ?").bind(id, userId);
export const stargazersOf = (db: D1Database, id: number, limit = 100) =>
  db.prepare("SELECT starrer, starrer_via, at FROM snippet_stars WHERE snippet_id = ? ORDER BY at DESC LIMIT ?").bind(id, Math.min(Math.max(limit, 1), 100));

/** A person's snippets (by the (owner_login, folder) unique index's prefix; the page re-sorts by
 *  recency). Keyed by the GitHub login the `snippets` repository is in. */
export const snippetsOfOwner = (db: D1Database, ownerLogin: string, limit = LIST_LIMIT) =>
  db.prepare("SELECT * FROM snippets WHERE owner_login = ? ORDER BY folder LIMIT ?").bind(ownerLogin.toLowerCase(), Math.min(Math.max(limit, 1), LIST_LIMIT));

/** Discover: public snippets, newest first (unlisted are never here: the discover index). The read
 *  then drops the hidden ones. */
export const publicSnippets = (db: D1Database, before: number, limit = LIST_LIMIT) =>
  db.prepare("SELECT * FROM snippets WHERE visibility = 'public' AND id < ? ORDER BY id DESC LIMIT ?").bind(before, Math.min(Math.max(limit, 1), LIST_LIMIT));

// ─── the views the pages read ─────────────────────────────────────────────────

export interface SnippetView {
  id: number;
  owner: string;
  folder: string;
  repo: { forge: string; id: string };
  revision: string;
  visibility: Visibility;
  title: string;
  description: string;
  files: FileMeta[];
  passage: Passage | null;
  stars: number;
  comments: number;
  forks: number;
  forkedFrom: number | null;
  commentsOff: boolean;
  hidden: "" | HideReason;
  author: string;
  author_via: Person["via"];
  author_role: SnippetRow["author_role"];
  created_at: number;
  updated_at: number;
}

export function parseManifest(text: unknown): FileMeta[] {
  try {
    const v = JSON.parse(String(text));
    if (!Array.isArray(v)) return [];
    return v
      .filter((f): f is FileMeta => !!f && typeof f === "object" && typeof (f as FileMeta).path === "string")
      .map((f) => ({ path: String(f.path), language: String(f.language ?? ""), size: Number(f.size) || 0, lines: Number(f.lines) || 0 }));
  } catch {
    return [];
  }
}

export function passageOf(r: Pick<SnippetRow, "paper_id" | "section" | "paragraph" | "start_line" | "end_line">): Passage | null {
  if (!r.paper_id) return null;
  return { paperId: r.paper_id, section: r.section, paragraph: r.paragraph, startLine: r.start_line, endLine: r.end_line };
}

export function viewOf(r: SnippetRow): SnippetView {
  return {
    id: r.id,
    owner: r.owner_login,
    folder: r.folder,
    repo: { forge: r.forge, id: r.repo_id },
    revision: r.revision,
    visibility: r.visibility,
    title: r.title,
    description: r.description,
    files: parseManifest(r.files),
    passage: passageOf(r),
    stars: r.stars,
    comments: r.comments,
    forks: r.forks,
    forkedFrom: r.forked_from,
    commentsOff: r.comments_off === 1,
    hidden: r.hidden,
    author: r.author,
    author_via: r.author_via,
    author_role: r.author_role,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export interface SnippetCommentView {
  n: number;
  author: string;
  author_via: Person["via"];
  author_role: SnippetCommentRow["author_role"];
  body: string;
  reply_to: number | null;
  edits: number;
  created_at: number;
  edited_at: number | null;
  deleted: boolean;
  hidden: "" | HideReason;
}

export function commentViewOf(c: SnippetCommentRow): SnippetCommentView {
  let edits = 0;
  try {
    const v = JSON.parse(c.history);
    edits = Array.isArray(v) ? v.length : 0;
  } catch {
    edits = 0;
  }
  return {
    n: c.n,
    author: c.author,
    author_via: c.author_via,
    author_role: c.author_role,
    body: c.deleted ? "" : c.body,
    reply_to: c.reply_to,
    edits,
    created_at: c.created_at,
    edited_at: c.edited_at,
    deleted: c.deleted === 1,
    hidden: c.hidden,
  };
}

/** A prior body pushed onto a comment's history (the last COMMENT_HISTORY kept), as a JSON string for
 *  the update. */
export function pushHistory(history: string, priorBody: string, at: number): string {
  let list: { at: number; body: string }[] = [];
  try {
    const v = JSON.parse(history);
    if (Array.isArray(v)) list = v.filter((e): e is { at: number; body: string } => !!e && typeof e === "object");
  } catch {
    list = [];
  }
  list.push({ at: Math.floor(at), body: priorBody });
  if (list.length > COMMENT_HISTORY) list = list.slice(list.length - COMMENT_HISTORY);
  return JSON.stringify(list);
}
