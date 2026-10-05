// Discussions: the registry's own discussion spaces (night phase 06, E1; docs/DISCUSSIONS.md; D00-6,
// D06-*). This is their pure core — the words, the spaces and their categories, what a new
// discussion, a comment and a change say, the rows as statements, the views the pages read — shared
// by the routes (discussions.ts) and the pages. No request, no database here.
//
// A discussion belongs to a SPACE (D00-6: a space per paper, per repository, per organization):
//   paper:doi:10.…      a paper's space, keyed by its DOI, even when the code is hosted elsewhere
//                       (the Discussion section reserved since phase 04); its verified authors hold
//                       the maintain role;
//   repo:<forge>:<id>   a repository the registry knows; its maintainers hold the maintain role;
//   org:<handle>        an organization (phase 09); its owners and members hold the maintain role.
// A space holds up to 25 categories, each with a format: a plain thread (open), an announcement
// (only the space's maintainers open one), a question (qa: answers and the answered state), or a
// poll. A space is created with its default categories when its first discussion opens.
//
// Public free text (CLAUDE.md): every text is masked for email addresses (maskEmails) and stripped
// of control characters (clean) before it is stored; oscr_forge holds no address. The pages render
// it as view trees, never as HTML.

import type { SignedIn } from "../../account/guard.ts";
import { BODY_CHARS } from "../limits.ts";
import { paperId } from "./papers.ts";
import { clean, personOf, type Person } from "./research-core.ts";
import { ForgeProblem, type D1Database, type Write } from "./types.ts";

export { clean, personOf, type Person };

// ─── the words ───────────────────────────────────────────────────────────────

export type SpaceKind = "paper" | "repo" | "org";
export const SPACE_KINDS: readonly SpaceKind[] = ["paper", "repo", "org"];

export type Format = "open" | "announcement" | "qa" | "poll";
export const FORMATS: readonly Format[] = ["open", "announcement", "qa", "poll"];
export const FORMAT_WORDS: Readonly<Record<Format, string>> = {
  open: "Open discussion",
  announcement: "Announcement",
  qa: "Question and answer",
  poll: "Poll",
};

export type CloseReason = "resolved" | "outdated" | "duplicate" | "off-topic" | "spam";
export const CLOSE_REASONS: readonly CloseReason[] = ["resolved", "outdated", "duplicate", "off-topic", "spam"];

export const LOCK_REASONS = ["off-topic", "too heated", "resolved", "spam"] as const;
export type LockReason = (typeof LOCK_REASONS)[number];

export const HIDE_REASONS = ["spam", "abuse", "off-topic", "outdated", "duplicate", "resolved", "low-quality"] as const;
export type HideReason = (typeof HIDE_REASONS)[number];

/** Limits. */
export const DISCUSSION_BODY_BYTES = 256 * 1024;
/** The comment length limit phase 16 states (65,536 characters), here too. */
export const COMMENT_CHARS = 65_536;
export const DISCUSSION_LABELS = 10;
export const DISCUSSION_COMMENTS = 5_000;
export const DISCUSSION_EVENTS = 100;
export const CATEGORIES_MAX = 25;
export const POLL_OPTIONS_MAX = 10;
export const LIST_PER_SPACE = 100;

// ─── spaces and categories ─────────────────────────────────────────────────────

export interface Space {
  key: string;
  kind: SpaceKind;
  /** For a paper space. */
  paperId: string;
  /** For a repository space. */
  forge: "" | "github" | "memory";
  repoId: string;
  /** For an organization space (its handle, lower case). */
  handle: string;
}

const HANDLE = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** A space as a person names it ("paper:10.…", "repo:github:5", "org:acme"), resolved, or null. */
export function readSpace(value: unknown): Space | null {
  if (typeof value !== "string" || value.length > 260) return null;
  const v = value.trim();
  if (v.startsWith("paper:")) {
    const id = paperId(v.slice(6));
    return id ? { key: `paper:${id}`, kind: "paper", paperId: id, forge: "", repoId: "", handle: "" } : null;
  }
  let m = /^repo:(github|memory):([0-9]{1,20})$/.exec(v);
  if (m) return { key: `repo:${m[1]}:${m[2]}`, kind: "repo", paperId: "", forge: m[1] as "github" | "memory", repoId: m[2], handle: "" };
  m = /^org:([a-z0-9][a-z0-9-]{0,38})$/.exec(v.toLowerCase());
  if (m && HANDLE.test(m[1])) return { key: `org:${m[1]}`, kind: "org", paperId: "", forge: "", repoId: "", handle: m[1] };
  return null;
}

export interface Category {
  slug: string;
  name: string;
  format: Format;
  emoji: string;
  description: string;
}

/** A category slug: one short lower-case word (what the key and the URL hold). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,49}$/;
export const isSlug = (v: unknown): v is string => typeof v === "string" && SLUG.test(v);

/** The default categories a space is created with. */
export const DEFAULT_CATEGORIES: Readonly<Record<SpaceKind, readonly Category[]>> = {
  paper: [
    { slug: "general", name: "General", format: "open", emoji: "💬", description: "Anything about this paper's code." },
    { slug: "q-a", name: "Q&A", format: "qa", emoji: "🙏", description: "Ask the authors and the community." },
    { slug: "reproduction", name: "Reproduction", format: "open", emoji: "🔁", description: "Share a reproduction attempt." },
    { slug: "announcements", name: "Announcements", format: "announcement", emoji: "📣", description: "Updates from the authors." },
  ],
  repo: [
    { slug: "general", name: "General", format: "open", emoji: "💬", description: "Chat about this repository." },
    { slug: "q-a", name: "Q&A", format: "qa", emoji: "🙏", description: "Ask a question." },
    { slug: "ideas", name: "Ideas", format: "open", emoji: "💡", description: "Share ideas for new features." },
    { slug: "announcements", name: "Announcements", format: "announcement", emoji: "📣", description: "Updates from the maintainers." },
  ],
  org: [
    { slug: "general", name: "General", format: "open", emoji: "💬", description: "Talk with the organization." },
    { slug: "q-a", name: "Q&A", format: "qa", emoji: "🙏", description: "Ask a question." },
    { slug: "announcements", name: "Announcements", format: "announcement", emoji: "📣", description: "Organization-wide updates." },
  ],
};

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 31;

function readName(v: unknown, what: string, max: number): string | ForgeProblem {
  if (typeof v !== "string" || !v.trim()) return bad(`${what} is empty.`);
  const t = clean(v.trim());
  if (/\n/.test(t) || t.length > max) return bad(`${what} is one line of at most ${max} characters.`);
  return t;
}

/** One category as a maintainer sets it. */
export function readCategory(v: unknown): Category | ForgeProblem {
  if (!isObject(v)) return bad("A category is not readable.");
  if (!isSlug(v.slug)) return bad("A category's slug is one short lower-case word (a-z, 0-9, -).");
  const name = readName(v.name, "A category's name", 50);
  if (name instanceof ForgeProblem) return name;
  if (!FORMATS.includes(v.format as Format)) return bad("A category's format is open, announcement, qa or poll.");
  const emoji = typeof v.emoji === "string" ? clean(v.emoji).slice(0, 8) : "";
  const description = typeof v.description === "string" ? clean(v.description).replace(/\n/g, " ").trim().slice(0, 200) : "";
  return { slug: v.slug, name, format: v.format as Format, emoji, description };
}

/** A space's categories as JSON gives them, deduplicated by slug, at most 25. */
export function readCategories(v: unknown): Category[] | ForgeProblem {
  if (!Array.isArray(v) || !v.length) return bad("A space has at least one category.");
  if (v.length > CATEGORIES_MAX) return bad(`A space holds ${CATEGORIES_MAX} categories at most.`);
  const out: Category[] = [];
  for (const c of v) {
    const cat = readCategory(c);
    if (cat instanceof ForgeProblem) return cat;
    if (out.some((x) => x.slug === cat.slug)) return bad(`The category “${cat.slug}” is named twice.`);
    out.push(cat);
  }
  return out;
}

export function parseCategories(text: unknown): Category[] {
  try {
    const v = JSON.parse(String(text));
    if (!Array.isArray(v)) return [];
    return v.filter((c): c is Category => isObject(c) && isSlug(c.slug) && typeof c.name === "string" && FORMATS.includes(c.format as Format))
      .map((c) => ({ slug: c.slug, name: c.name, format: c.format, emoji: typeof c.emoji === "string" ? c.emoji : "", description: typeof c.description === "string" ? c.description : "" }));
  } catch {
    return [];
  }
}

// ─── what a new discussion says ─────────────────────────────────────────────────

export interface OpenParsed {
  space: Space;
  category: string;
  title: string;
  body: string;
  /** Poll options when the category is a poll (resolved by the route); here just the raw request. */
  pollOptions: string[];
  closesInDays: number | null;
  labels: string[];
}

const isLabel = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 50 && !/[\u0000-\u001f\u007f@]/.test(v) && v.trim() === v;

function readLabels(v: unknown): string[] | ForgeProblem {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > DISCUSSION_LABELS) return bad(`At most ${DISCUSSION_LABELS} labels.`);
  const out: string[] = [];
  for (const l of v) {
    if (!isLabel(l)) return bad("A label is one line of at most 50 characters.");
    if (!out.some((x) => x.toLowerCase() === l.toLowerCase())) out.push(l);
  }
  return out;
}

function readTitle(v: unknown): string | ForgeProblem {
  if (typeof v !== "string" || !v.trim()) return bad("Give the discussion a title: one line that says what it is about.");
  const t = clean(v.trim());
  if (/\n/.test(t) || t.length > 256) return bad("The title is one line of at most 256 characters; the body takes the rest.");
  return t;
}

function readBody(v: unknown, required = false): string | ForgeProblem {
  if (v === undefined || v === null) return required ? bad("The body is empty.") : "";
  if (typeof v !== "string") return bad("The body is not text.");
  if (v.length > BODY_CHARS) return bad(`The body is at most ${BODY_CHARS.toLocaleString("en-GB")} characters.`);
  if (required && !v.trim()) return bad("The body is empty.");
  return clean(v);
}

function readPollOptions(v: unknown): string[] | ForgeProblem {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > POLL_OPTIONS_MAX) return bad(`A poll has 2 to ${POLL_OPTIONS_MAX} options.`);
  const out: string[] = [];
  for (const o of v) {
    const t = typeof o === "string" ? clean(o).trim() : "";
    if (!t || t.length > 200 || /\n/.test(t)) return bad("A poll option is one line of at most 200 characters.");
    if (out.includes(t)) return bad("A poll option is repeated.");
    out.push(t);
  }
  return out;
}

export function validateOpen(payload: unknown): OpenParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The discussion is not readable.");
  const p = payload;
  const space = readSpace(p.space);
  if (!space) return bad("A discussion belongs to a space: a paper (paper:10.…), a repository (repo:github:…) or an organization (org:…).");
  const category = p.category === undefined || p.category === null || p.category === "" ? "general" : p.category;
  if (!isSlug(category)) return bad("The category is one of the space's, by its slug.");
  const title = readTitle(p.title);
  if (title instanceof ForgeProblem) return title;
  const body = readBody(p.body);
  if (body instanceof ForgeProblem) return body;
  const pollOptions = readPollOptions(p.pollOptions);
  if (pollOptions instanceof ForgeProblem) return pollOptions;
  let closesInDays: number | null = null;
  if (p.closesInDays !== undefined && p.closesInDays !== null) {
    if (!isId(p.closesInDays) || p.closesInDays > 90) return bad("A poll closes in 1 to 90 days, or stays open.");
    closesInDays = p.closesInDays;
  }
  const labels = readLabels(p.labels);
  if (labels instanceof ForgeProblem) return labels;
  return { space, category: category as string, title, body, pollOptions, closesInDays, labels };
}

// ─── a comment and a change ─────────────────────────────────────────────────────

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
  if (!isId(payload.id)) return bad("Name the discussion by its number.");
  if (payload.n !== undefined && (!isId(payload.n) || payload.n > DISCUSSION_COMMENTS)) return bad("A comment is named by its number in the discussion.");
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
  const body = readBody(payload.body, true);
  if (body instanceof ForgeProblem) return body;
  if (typeof body === "string" && body.length > COMMENT_CHARS) return bad(`A comment is at most ${COMMENT_CHARS.toLocaleString("en-GB")} characters.`);
  let replyTo: number | null = null;
  if (n === null && payload.replyTo !== undefined && payload.replyTo !== null) {
    if (!isId(payload.replyTo)) return bad("A reply names the comment it answers, by its number.");
    replyTo = payload.replyTo;
  }
  return { id: payload.id, n, body, replyTo, delete: false, hide: null };
}

export interface EditParsed {
  id: number;
  title: string | null;
  body: string | null;
  category: string | null;
  state: "open" | "closed" | null;
  reason: CloseReason | null;
  /** The comment number to mark as the answer (qa), 0 to clear it, or null for no change. */
  answered: number | null;
  labels: { add: string[]; remove: string[] } | null;
  locked: boolean | null;
  lockReason: "" | LockReason;
  pinned: boolean | null;
  /** Transfer to another space of the same kind, or null. */
  transferTo: Space | null;
}

export function validateEdit(payload: unknown): EditParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The change is not readable.");
  const p = payload;
  if (!isId(p.id)) return bad("Name the discussion by its number.");
  const out: EditParsed = { id: p.id, title: null, body: null, category: null, state: null, reason: null, answered: null, labels: null, locked: null, lockReason: "", pinned: null, transferTo: null };
  if (p.title !== undefined) {
    const t = readTitle(p.title);
    if (t instanceof ForgeProblem) return t;
    out.title = t;
  }
  if (p.body !== undefined) {
    const b = readBody(p.body);
    if (b instanceof ForgeProblem) return b;
    out.body = b;
  }
  if (p.category !== undefined) {
    if (!isSlug(p.category)) return bad("The category is one of the space's, by its slug.");
    out.category = p.category;
  }
  if (p.state !== undefined) {
    if (p.state !== "open" && p.state !== "closed") return bad("A discussion is closed or reopened.");
    out.state = p.state;
  }
  if (p.reason !== undefined) {
    if (!CLOSE_REASONS.includes(p.reason as CloseReason)) return bad("A discussion is closed as resolved, outdated, a duplicate, off-topic or spam.");
    if (out.state !== "closed") return bad("A reason goes with closing the discussion.");
    out.reason = p.reason as CloseReason;
  }
  if (out.state === "closed" && !out.reason) out.reason = "resolved";
  if (p.answered !== undefined) {
    if (p.answered !== 0 && (!isId(p.answered) || p.answered > DISCUSSION_COMMENTS)) return bad("Mark a comment as the answer by its number, or 0 to clear it.");
    out.answered = p.answered as number;
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
    if (typeof p.pinned !== "boolean") return bad("The discussion is pinned or unpinned.");
    out.pinned = p.pinned;
  }
  if (p.transferTo !== undefined && p.transferTo !== null) {
    const to = readSpace(p.transferTo);
    if (!to) return bad("A discussion moves to another space, named like its own.");
    out.transferTo = to;
  }
  const changes = [out.title, out.body, out.category, out.state, out.answered, out.labels, out.locked, out.pinned, out.transferTo].filter((x) => x !== null).length;
  if (!changes) return bad("Nothing to change.");
  return out;
}

export interface VoteParsed {
  /** The discussion. */
  id: number;
  /** A comment's number (upvote a comment), or null for the discussion / its poll. */
  n: number | null;
  /** A poll option's index, or null for an upvote. */
  option: number | null;
  /** Take the vote back. */
  remove: boolean;
}

export function validateVote(payload: unknown): VoteParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The vote is not readable.");
  if (!isId(payload.id)) return bad("Name the discussion by its number.");
  const n = payload.n === undefined || payload.n === null ? null : payload.n;
  if (n !== null && (!isId(n) || n > DISCUSSION_COMMENTS)) return bad("A comment is named by its number.");
  const option = payload.option === undefined || payload.option === null ? null : payload.option;
  if (option !== null && (typeof option !== "number" || !Number.isInteger(option) || option < 0 || option >= POLL_OPTIONS_MAX)) return bad("A poll option is named by its index.");
  if (option !== null && n !== null) return bad("Vote on a poll, or upvote a comment: not both.");
  const remove = payload.remove === true;
  return { id: payload.id, n: n as number | null, option: option as number | null, remove };
}

// ─── the rows ────────────────────────────────────────────────────────────────

export interface DiscussionRow {
  id: number;
  space: string;
  space_kind: SpaceKind;
  paper_id: string;
  forge: string;
  repo_id: string;
  category: string;
  format: Format;
  title: string;
  body: string;
  poll: string;
  labels: string;
  state: "open" | "closed";
  close_reason: "" | CloseReason;
  answered: number | null;
  upvotes: number;
  locked: number;
  lock_reason: "" | LockReason;
  pinned: number;
  hidden: "" | HideReason;
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
  discussion_id: number;
  n: number;
  author_id: string;
  author: string;
  author_via: Person["via"];
  author_role: "" | "verified_author" | "maintainer";
  body: string;
  upvotes: number;
  reply_to: number | null;
  created_at: number;
  edited_at: number | null;
  deleted: number;
  hidden: "" | HideReason;
}

export interface TimelineEvent {
  k: string;
  by: string;
  at: number;
  s?: string;
}

export interface Poll {
  options: { text: string; votes: number }[];
  closes_at: number | null;
  voters: number;
}

export function parsePoll(text: unknown): Poll | null {
  try {
    const v = JSON.parse(String(text)) as Partial<Poll>;
    if (!v || !Array.isArray(v.options) || !v.options.length) return null;
    return {
      options: v.options.map((o) => ({ text: String((o as { text?: unknown }).text ?? ""), votes: Number((o as { votes?: unknown }).votes ?? 0) || 0 })),
      closes_at: typeof v.closes_at === "number" ? v.closes_at : null,
      voters: Number(v.voters ?? 0) || 0,
    };
  } catch {
    return null;
  }
}

// ─── statements ────────────────────────────────────────────────────────────────

export const spaceByKey = (db: D1Database, key: string) => db.prepare("SELECT * FROM discussion_spaces WHERE space = ?").bind(key);
export const discussionById = (db: D1Database, id: number) => db.prepare("SELECT * FROM discussions WHERE id = ?").bind(id);
export const commentsOf = (db: D1Database, id: number) => db.prepare("SELECT * FROM discussion_comments WHERE discussion_id = ? ORDER BY n LIMIT 5000").bind(id);

export const SUMMARY_COLUMNS =
  "id, space, space_kind, paper_id, forge, repo_id, category, format, title, poll, labels, state, close_reason, answered, " +
  "upvotes, locked, pinned, hidden, author, author_via, author_role, comments, created_at, updated_at, closed_at";

export const discussionsOfSpace = (db: D1Database, key: string, limit = LIST_PER_SPACE) =>
  db.prepare(`SELECT ${SUMMARY_COLUMNS}, author_id FROM discussions WHERE space = ? ORDER BY id DESC LIMIT ?`).bind(key, limit);

/** A new or updated space's settings (its categories): 1 row (the key is the table). */
export function upsertSpace(db: D1Database, space: Space, categories: Category[], userId: string, t: number): Write {
  return {
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO discussion_spaces (space, space_kind, categories, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (space) DO UPDATE SET categories = excluded.categories, updated_at = excluded.updated_at",
      )
      .bind(space.key, space.kind, JSON.stringify(categories), userId, Math.floor(t), Math.floor(t)),
  };
}

/** A new discussion (2 rows: the row and its space index entry). */
export function insertDiscussion(
  db: D1Database,
  p: OpenParsed,
  format: Format,
  poll: Poll | null,
  who: Person,
  role: DiscussionRow["author_role"],
  t: number,
): Write {
  const s = p.space;
  return {
    rows: 2,
    stmt: db
      .prepare(
        "INSERT INTO discussions (space, space_kind, paper_id, forge, repo_id, category, format, title, body, poll, labels, " +
          "author_id, author, author_via, author_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        s.key, s.kind, s.paperId, s.forge, s.repoId, p.category, format, p.title, p.body, JSON.stringify(poll ?? {}),
        JSON.stringify(p.labels), who.id, who.author, who.via, role, Math.floor(t), Math.floor(t),
      ),
  };
}

function appendEvents(n: number): string {
  const trimmed = `CASE WHEN json_array_length(events) > ${DISCUSSION_EVENTS - n} THEN json_remove(events${", '$[0]'".repeat(n)}) ELSE events END`;
  return `events = json_insert(${trimmed}${", '$[#]', json(?)".repeat(n)})`;
}

/** A change of a discussion (1 row: no indexed column moves unless `space` changes, 2 then), guarded
 *  by `where` when a transfer must not assume the space it saw. */
export function updateDiscussion(db: D1Database, id: number, set: Record<string, string | number | null>, events: TimelineEvent[], t: number, where = ""): Write {
  const cols = Object.keys(set);
  const parts = [...cols.map((c) => `${c} = ?`), "updated_at = ?", ...(events.length ? [appendEvents(events.length)] : [])];
  const moves = cols.includes("space");
  return {
    rows: moves ? 2 : 1,
    stmt: db
      .prepare(`UPDATE discussions SET ${parts.join(", ")} WHERE id = ?${where ? ` AND ${where}` : ""}`)
      .bind(...cols.map((c) => set[c]), Math.floor(t), ...events.map((e) => JSON.stringify(e)), id),
  };
}

/** A new comment and the discussion's count (2 rows, in one batch). */
export function insertComment(db: D1Database, id: number, body: string, replyTo: number | null, who: Person, role: CommentRow["author_role"], t: number): Write[] {
  return [
    {
      rows: 1,
      stmt: db
        .prepare(
          "INSERT INTO discussion_comments (discussion_id, n, author_id, author, author_via, author_role, body, reply_to, created_at) " +
            "SELECT id, comments + 1, ?, ?, ?, ?, ?, ?, ? FROM discussions WHERE id = ? AND comments < ?",
        )
        .bind(who.id, who.author, who.via, role, body, replyTo, Math.floor(t), id, DISCUSSION_COMMENTS),
    },
    { rows: 1, stmt: db.prepare("UPDATE discussions SET comments = comments + 1, updated_at = ? WHERE id = ? AND comments < ?").bind(Math.floor(t), id, DISCUSSION_COMMENTS) },
  ];
}

export function updateComment(db: D1Database, id: number, n: number, set: Record<string, string | number | null>): Write {
  const cols = Object.keys(set);
  return { rows: 1, stmt: db.prepare(`UPDATE discussion_comments SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE discussion_id = ? AND n = ?`).bind(...cols.map((c) => set[c]), id, n) };
}

/** Record a vote so it is counted once (1 row); fails the batch (and so the count) if it is a repeat. */
export function insertVote(db: D1Database, ref: string, userId: string, choice: number, t: number): Write {
  return { rows: 1, stmt: db.prepare("INSERT INTO discussion_votes (ref, user_id, choice, at) VALUES (?, ?, ?, ?)").bind(ref, userId, choice, Math.floor(t)) };
}

export function deleteVote(db: D1Database, ref: string, userId: string): Write {
  return { rows: 1, stmt: db.prepare("DELETE FROM discussion_votes WHERE ref = ? AND user_id = ?").bind(ref, userId) };
}

export const voteRow = (db: D1Database, ref: string, userId: string) =>
  db.prepare("SELECT ref, user_id, choice FROM discussion_votes WHERE ref = ? AND user_id = ?").bind(ref, userId);

/** Change a discussion's upvotes by +1/-1 (1 row; never below 0). */
export function bumpUpvotes(db: D1Database, id: number, delta: number, t: number): Write {
  return { rows: 1, stmt: db.prepare("UPDATE discussions SET upvotes = max(0, upvotes + ?), updated_at = ? WHERE id = ?").bind(delta, Math.floor(t), id) };
}

/** Change a comment's upvotes by +1/-1 (1 row). */
export function bumpCommentUpvotes(db: D1Database, id: number, n: number, delta: number): Write {
  return { rows: 1, stmt: db.prepare("UPDATE discussion_comments SET upvotes = max(0, upvotes + ?) WHERE discussion_id = ? AND n = ?").bind(delta, id, n) };
}

/** Change a poll's counts: set the poll JSON (the route computes the new counts). 1 row. */
export function setPoll(db: D1Database, id: number, poll: Poll, t: number): Write {
  return { rows: 1, stmt: db.prepare("UPDATE discussions SET poll = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(poll), Math.floor(t), id) };
}

// ─── the views the pages read ─────────────────────────────────────────────────

export interface DiscussionSummary {
  id: number;
  space: string;
  space_kind: SpaceKind;
  category: string;
  format: Format;
  title: string;
  state: "open" | "closed";
  close_reason: "" | CloseReason;
  answered: number | null;
  upvotes: number;
  labels: string[];
  locked: boolean;
  pinned: boolean;
  author: string;
  author_via: Person["via"];
  author_role: DiscussionRow["author_role"];
  comments: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  poll: Poll | null;
}

const parseList = (text: unknown): string[] => {
  try {
    const v = JSON.parse(String(text));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

export function summaryOf(r: Omit<DiscussionRow, "body" | "events" | "author_id" | "lock_reason">): DiscussionSummary {
  return {
    id: r.id,
    space: r.space,
    space_kind: r.space_kind,
    category: r.category,
    format: r.format,
    title: r.title,
    state: r.state,
    close_reason: r.close_reason,
    answered: r.answered,
    upvotes: r.upvotes,
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
    poll: r.format === "poll" ? parsePoll(r.poll) : null,
  };
}

export interface DiscussionView extends DiscussionSummary {
  body: string;
  paper_id: string;
  repo: { forge: string; id: string } | null;
  lock_reason: "" | LockReason;
  hidden: "" | HideReason;
  events: TimelineEvent[];
}

export function viewOf(r: DiscussionRow): DiscussionView {
  let events: TimelineEvent[] = [];
  try {
    const x = JSON.parse(r.events) as unknown;
    if (Array.isArray(x)) events = x.filter((e): e is TimelineEvent => isObject(e) && typeof e.k === "string" && typeof e.at === "number");
  } catch {
    events = [];
  }
  return {
    ...summaryOf(r),
    body: r.body,
    paper_id: r.paper_id,
    repo: r.repo_id ? { forge: r.forge, id: r.repo_id } : null,
    lock_reason: r.lock_reason,
    hidden: r.hidden,
    events,
  };
}

export interface CommentView {
  n: number;
  author: string;
  author_via: Person["via"];
  author_role: CommentRow["author_role"];
  body: string;
  upvotes: number;
  reply_to: number | null;
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
  upvotes: c.upvotes,
  reply_to: c.reply_to,
  created_at: c.created_at,
  edited_at: c.edited_at,
  deleted: c.deleted === 1,
  hidden: c.hidden,
});

/** The reference a vote is kept under: the discussion, a comment, or the poll. */
export const voteRef = (id: number, n: number | null, poll: boolean): string => (poll ? `${id}poll` : n === null ? `${id}` : `${id}#${n}`);
