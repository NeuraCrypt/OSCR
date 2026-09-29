// The registry's own social layer (night phase 08, E1): what a star, a star list, a follow, a watch
// level and a profile are, checked before anything is read or written, and their rows in D1 oscr_forge
// (migrations/d1-forge/0008_social.sql). The routes are social.ts; the events, the inbox and the feed
// are events.ts and inbox.ts. The contract: docs/SOCIAL.md.
//
// - OSCR never stars, follows or watches on GitHub (the plan's AUP §4): these are the registry's own
//   rows, each a person's own act, signed in, one write at a time.
// - A subject (what a star names): "repo:<forge>:<id>" (the forge's durable id: a rename never loses
//   a star), "paper:doi:10.…" (lower case, as oscr_community names papers), "topic:<name>" (GitHub's
//   topic rules).
// - A target (what a follow names): a person on GitHub ("github:<numeric id>"), a catalogue author
//   by ORCID iD before they have an account ("orcid:<iD>", its check digit verified), an organization
//   or a person's repositories ("owner:<forge>:<login>"), a repository watched ("repo:…", with a
//   level: all activity, participating and @mentions, ignore, or custom event types), a paper by DOI,
//   a journal, a tool, a dataset, a category of the catalogue, or one thread ("thread:<subject>#<thread>").
// - Texts: a label (what the page showed), a profile's fields. Every email address is masked before
//   anything is stored (CLAUDE.md); a profile's addresses are https only, without a user part.
// - What each write costs: its row and the action row (2); unstarring also the list entries it
//   leaves (1 each); deleting a list, its entries (1 each). No index anywhere: every read goes by the
//   person's key.

import { maskEmails } from "../mask.ts";
import { paperId } from "./papers.ts";
import { ForgeProblem, type D1Database, type D1PreparedStatement, type Write } from "./types.ts";

// ─── the caps (per account) ──────────────────────────────────────────────────

/** Stars one account may hold (GitHub has none; the registry's rows are bounded). */
export const STARS_MAX = 3_000;
/** Follows one account may hold, the threads it follows included. */
export const FOLLOWS_MAX = 2_000;
/** Star lists per account (GitHub: 32). */
export const LISTS_MAX = 32;
/** Entries per list. */
export const LIST_ITEMS_MAX = 300;
/** Subjects one state read names (the buttons of one page). */
export const STATE_SUBJECTS = 20;
/** Pinned items on a profile (GitHub: 6). */
export const PINNED_MAX = 6;
/** Links on a profile besides its website (GitHub: 4). */
export const LINKS_MAX = 4;
/** A social request's body. */
export const SOCIAL_BODY_BYTES = 16 * 1024;

// ─── words ───────────────────────────────────────────────────────────────────

export const WATCH_LEVELS = ["all", "participating", "ignore", "custom"] as const;
export type WatchLevel = (typeof WATCH_LEVELS)[number];

/** The event types a custom watch picks (GitHub's: issues, pull requests, releases, discussions,
 *  security alerts; the registry's research issues. Discussions come with phase 06, security
 *  alerts with phase 11). */
export const CUSTOM_EVENTS = ["issues", "pulls", "releases", "research"] as const;
export type CustomEvent = (typeof CUSTOM_EVENTS)[number];

export const LEVEL_WORDS: Readonly<Record<WatchLevel, string>> = {
  all: "All activity",
  participating: "Participating and @mentions",
  ignore: "Ignore",
  custom: "Custom",
};

export const ENTITY_KINDS = ["journal", "tool", "dataset", "category"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export type SubjectKind = "repo" | "paper" | "topic";
export type TargetKind = "github" | "orcid" | "owner" | "repo" | "paper" | EntityKind | "thread";

// ─── subjects and targets ────────────────────────────────────────────────────

const REPO = /^repo:(github|memory):([0-9]{1,20})$/;
const TOPIC = /^topic:([a-z0-9][a-z0-9-]{0,49})$/;
const GITHUB = /^github:([0-9]{1,20})$/;
const ORCID = /^orcid:([0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X])$/;
const OWNER = /^owner:(github|memory):([a-z0-9](?:[a-z0-9-]{0,38}))$/;
const ENTITY = /^(journal|tool|dataset|category):([A-Za-z0-9][A-Za-z0-9._:/-]{0,149})$/;
const THREAD = /^(issue|pull|research|release):([A-Za-z0-9][A-Za-z0-9._/+-]{0,99})$/;

/** Whether an ORCID iD's check digit is right (ISO 7064 11,2, as ORCID computes it). */
export function orcidChecks(id: string): boolean {
  const digits = id.replace(/-/g, "");
  if (!/^[0-9]{15}[0-9X]$/.test(digits)) return false;
  let total = 0;
  for (const c of digits.slice(0, 15)) total = (total + Number(c)) * 2;
  const result = (12 - (total % 11)) % 11;
  return digits[15] === (result === 10 ? "X" : String(result));
}

/** A subject as the registry stores it, or null: a repository by its durable id, a paper by its DOI
 *  (any way a person writes it), a topic. */
export function readSubject(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 260) return null;
  const v = value.trim();
  if (REPO.test(v) || TOPIC.test(v)) return v;
  if (v.toLowerCase().startsWith("paper:")) {
    const id = paperId(v.slice(6));
    return id ? `paper:${id}` : null;
  }
  return null;
}

export function subjectKind(subject: string): SubjectKind {
  return subject.startsWith("repo:") ? "repo" : subject.startsWith("paper:") ? "paper" : "topic";
}

/** A thread's key, "<subject>#<thread>", or null. */
export function readThreadKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 342) return null;
  const i = value.lastIndexOf("#");
  if (i < 0) return null;
  const subject = readSubject(value.slice(0, i));
  if (!subject || subject.startsWith("topic:") || !THREAD.test(value.slice(i + 1))) return null;
  return `${subject}#${value.slice(i + 1)}`;
}

/** A follow's target as the registry stores it, or null. */
export function readTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 350) return null;
  const v = value.trim();
  if (GITHUB.test(v)) return v;
  const orcid = ORCID.exec(v.toUpperCase().replace(/^ORCID:/, "orcid:"));
  if (orcid) return orcidChecks(orcid[1]) ? `orcid:${orcid[1]}` : null;
  const owner = OWNER.exec(v.toLowerCase());
  if (owner && !owner[2].endsWith("-") && !owner[2].includes("--")) return `owner:${owner[1]}:${owner[2]}`;
  const entity = ENTITY.exec(v);
  if (entity && !entity[2].includes("..") && !entity[2].includes("//")) return v;
  if (v.startsWith("thread:")) {
    const key = readThreadKey(v.slice(7));
    return key ? `thread:${key}` : null;
  }
  const subject = readSubject(v);
  return subject && !subject.startsWith("topic:") ? subject : null;
}

export function targetKind(target: string): TargetKind {
  return target.slice(0, target.indexOf(":")) as TargetKind;
}

/** What a follow of this kind may say: a level for a repository (four), a thread (all or ignore). */
const LEVELS_OF: Readonly<Partial<Record<TargetKind, readonly WatchLevel[]>>> = {
  repo: WATCH_LEVELS,
  thread: ["all", "ignore"],
  paper: ["all", "ignore"],
};

// ─── texts ───────────────────────────────────────────────────────────────────

/** A short text as stored: control characters dropped, spaces folded, addresses masked, cut. */
export function cleanLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // deno-lint-ignore no-control-regex
  const line = maskEmails(value.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim());
  return [...line].slice(0, max).join("");
}

/** An https address without a user part, as stored (null: not one). */
export function httpsUrl(value: unknown, max = 200): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > max) return null;
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return null;
  const out = u.toString();
  return out.length <= max && !out.includes("@") ? out : null;
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ─── the payloads ────────────────────────────────────────────────────────────

export interface StarParsed {
  subject: string;
  label: string;
  on: boolean;
}

export function validateStar(body: unknown): StarParsed | ForgeProblem {
  if (!isObject(body)) return bad("The request is not readable.");
  const subject = readSubject(body.subject);
  if (!subject) return bad("A star names a repository (repo:<forge>:<id>), a paper (paper:<DOI>) or a topic (topic:<name>).");
  if (typeof body.on !== "boolean") return bad("Say whether to star (on: true) or unstar (on: false).");
  return { subject, label: cleanLine(body.label, 300), on: body.on };
}

export interface FollowParsed {
  target: string;
  kind: TargetKind;
  level: WatchLevel;
  events: CustomEvent[];
  label: string;
  on: boolean;
}

export function validateFollow(body: unknown): FollowParsed | ForgeProblem {
  if (!isObject(body)) return bad("The request is not readable.");
  const target = readTarget(body.target);
  if (!target) {
    return bad("A follow names a person (github:<id> or an ORCID iD), an organization (owner:<forge>:<login>), a repository, a paper by its DOI, a journal, a tool, a dataset, a category or a thread.");
  }
  if (typeof body.on !== "boolean") return bad("Say whether to follow (on: true) or stop (on: false).");
  const kind = targetKind(target);
  const levels = LEVELS_OF[kind] ?? ["all"];
  const level = body.level === undefined || body.level === null ? "all" : body.level;
  if (typeof level !== "string" || !(levels as readonly string[]).includes(level)) {
    return bad(`This follow's level is one of: ${levels.map((l) => LEVEL_WORDS[l]).join(", ")}.`);
  }
  let events: CustomEvent[] = [];
  if (level === "custom") {
    if (!Array.isArray(body.events) || !body.events.length || body.events.some((e) => !(CUSTOM_EVENTS as readonly unknown[]).includes(e))) {
      return bad(`A custom watch picks some of: ${CUSTOM_EVENTS.join(", ")}.`);
    }
    events = CUSTOM_EVENTS.filter((e) => (body.events as unknown[]).includes(e));
  }
  return { target, kind, level: level as WatchLevel, events, label: cleanLine(body.label, 300), on: body.on };
}

export type ListParsed =
  | { op: "create"; name: string; description: string; public: boolean }
  | { op: "edit"; id: number; name: string | null; description: string | null; public: boolean | null }
  | { op: "delete"; id: number }
  | { op: "add" | "remove"; id: number; subject: string; label: string }
  | { op: "propose"; id: number; propose: boolean };

const isListId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= LISTS_MAX;

export function validateList(body: unknown): ListParsed | ForgeProblem {
  if (!isObject(body)) return bad("The request is not readable.");
  const name = (v: unknown) => cleanLine(v, 32);
  switch (body.op) {
    case "create": {
      const n = name(body.name);
      if (!n) return bad("A list has a name (32 characters at most).");
      return { op: "create", name: n, description: cleanLine(body.description, 160), public: body.public !== false };
    }
    case "edit": {
      if (!isListId(body.id)) return bad("A list is named by its number.");
      const n = body.name === undefined ? null : name(body.name);
      if (n === "") return bad("A list has a name (32 characters at most).");
      if (body.public !== undefined && typeof body.public !== "boolean") return bad("A list is public or private.");
      return {
        op: "edit",
        id: body.id,
        name: n,
        description: body.description === undefined ? null : cleanLine(body.description, 160),
        public: body.public === undefined ? null : (body.public as boolean),
      };
    }
    case "delete":
      return isListId(body.id) ? { op: "delete", id: body.id } : bad("A list is named by its number.");
    case "add":
    case "remove": {
      if (!isListId(body.id)) return bad("A list is named by its number.");
      const subject = readSubject(body.subject);
      if (!subject) return bad("A list holds repositories, papers and topics.");
      return { op: body.op, id: body.id, subject, label: cleanLine(body.label, 300) };
    }
    case "propose":
      if (!isListId(body.id)) return bad("A list is named by its number.");
      return { op: "propose", id: body.id, propose: body.propose !== false };
    default:
      return bad("A list is created, edited, deleted, proposed as a collection, or gains or loses an entry.");
  }
}

export interface ProfileParsed {
  name: string;
  bio: string;
  pronouns: string;
  location: string;
  timezone: string;
  website: string;
  links: string[];
  company: string;
  pinned: string[];
  status: string;
  statusUntil: number | null;
  busy: boolean;
  private: boolean;
  readme: boolean;
}

const TIMEZONE = /^(?:UTC|[A-Z][A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;

export function validateProfile(body: unknown, t: number): ProfileParsed | ForgeProblem {
  if (!isObject(body)) return bad("The request is not readable.");
  const website = body.website ? httpsUrl(body.website) : "";
  if (website === null) return bad("The website is an https address (200 characters at most), without a user name.");
  const links: string[] = [];
  if (body.links !== undefined) {
    if (!Array.isArray(body.links) || body.links.length > LINKS_MAX) return bad(`A profile has ${LINKS_MAX} links at most.`);
    for (const l of body.links) {
      if (l === "" || l === null) continue;
      const u = httpsUrl(l);
      if (!u) return bad(`“${String(l).slice(0, 60)}” is not an https address without a user name.`);
      if (!links.includes(u)) links.push(u);
    }
  }
  const pinned: string[] = [];
  if (body.pinned !== undefined) {
    if (!Array.isArray(body.pinned) || body.pinned.length > PINNED_MAX) return bad(`A profile pins ${PINNED_MAX} items at most.`);
    for (const p of body.pinned) {
      const s = readSubject(p) ?? (typeof p === "string" && /^list:([1-9]|[12][0-9]|3[0-2])$/.test(p) ? p : null);
      if (!s) return bad("A pinned item is a repository, a paper, a topic or one of your lists.");
      if (!pinned.includes(s)) pinned.push(s);
    }
  }
  const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "";
  if (timezone && (timezone.length > 64 || !TIMEZONE.test(timezone))) return bad("The time zone is one of the IANA names (Europe/Paris, America/New_York, UTC).");
  let statusUntil: number | null = null;
  if (body.statusUntil !== undefined && body.statusUntil !== null) {
    const u = body.statusUntil;
    if (typeof u !== "number" || !Number.isInteger(u) || u <= t || u > t + 366 * 86_400) return bad("A status ends within a year.");
    statusUntil = u;
  }
  const flag = (v: unknown, fallback: boolean): boolean | null => (v === undefined ? fallback : typeof v === "boolean" ? v : null);
  const busy = flag(body.busy, false);
  const priv = flag(body.private, false);
  const readme = flag(body.readme, true);
  if (busy === null || priv === null || readme === null) return bad("Busy, private and the profile README are yes or no.");
  const name = cleanLine(typeof body.name === "string" ? body.name.replace(/[@＠]/g, " ") : "", 100);
  return {
    name,
    bio: cleanLine(body.bio, 300),
    pronouns: cleanLine(body.pronouns, 40),
    location: cleanLine(body.location, 100),
    timezone,
    website,
    links,
    company: cleanLine(body.company, 100),
    pinned,
    status: cleanLine(body.status, 80),
    statusUntil,
    busy,
    private: priv,
    readme,
  };
}

// ─── the rows ────────────────────────────────────────────────────────────────

export function starWrite(db: D1Database, userId: string, p: StarParsed, t: number): Write {
  return {
    rows: 1,
    stmt: db.prepare("INSERT OR IGNORE INTO stars (user_id, subject, label, at) VALUES (?, ?, ?, ?)").bind(userId, p.subject, p.label, Math.floor(t)),
  };
}

export function unstarWrites(db: D1Database, userId: string, subject: string, inLists: number): Write[] {
  const writes: Write[] = [{ rows: 1, stmt: db.prepare("DELETE FROM stars WHERE user_id = ? AND subject = ?").bind(userId, subject) }];
  if (inLists > 0) writes.push({ rows: inLists, stmt: db.prepare("DELETE FROM star_list_items WHERE user_id = ? AND subject = ?").bind(userId, subject) });
  return writes;
}

export function followWrite(db: D1Database, userId: string, p: { target: string; level: WatchLevel; events: string[]; label: string; auto?: boolean }, t: number): Write {
  return {
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO follows (user_id, target, level, events, label, auto, at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (user_id, target) DO UPDATE SET level = excluded.level, events = excluded.events, " +
          "label = CASE WHEN excluded.label != '' THEN excluded.label ELSE follows.label END, auto = excluded.auto, at = excluded.at",
      )
      .bind(userId, p.target, p.level, p.events.join(" "), p.label, p.auto ? 1 : 0, Math.floor(t)),
  };
}

/** A thread followed because the person took part in it (an issue opened, a comment): written only
 *  when the person has no word on that thread yet (an unsubscription stays). 1 row at most. */
export function autoFollowWrite(db: D1Database, userId: string, threadKey: string, t: number): Write {
  return {
    rows: 1,
    stmt: db
      .prepare("INSERT OR IGNORE INTO follows (user_id, target, level, events, label, auto, at) VALUES (?, ?, 'all', '', '', 1, ?)")
      .bind(userId, `thread:${threadKey}`, Math.floor(t)),
  };
}

export function unfollowWrite(db: D1Database, userId: string, target: string): Write {
  return { rows: 1, stmt: db.prepare("DELETE FROM follows WHERE user_id = ? AND target = ?").bind(userId, target) };
}

export function listInsert(db: D1Database, userId: string, id: number, p: { name: string; description: string; public: boolean }, t: number): Write {
  return {
    rows: 1,
    stmt: db
      .prepare("INSERT INTO star_lists (user_id, list_id, name, description, public, collection, at) VALUES (?, ?, ?, ?, ?, '', ?)")
      .bind(userId, id, p.name, p.description, p.public ? 1 : 0, Math.floor(t)),
  };
}

export function listUpdate(db: D1Database, userId: string, id: number, set: Record<string, string | number>, t: number): Write {
  const cols = Object.keys(set);
  return {
    rows: 1,
    stmt: db
      .prepare(`UPDATE star_lists SET ${cols.map((c) => `${c} = ?`).join(", ")}, at = ? WHERE user_id = ? AND list_id = ?`)
      .bind(...cols.map((c) => set[c]), Math.floor(t), userId, id),
  };
}

export function listDeleteWrites(db: D1Database, userId: string, id: number, items: number): Write[] {
  const writes: Write[] = [{ rows: 1, stmt: db.prepare("DELETE FROM star_lists WHERE user_id = ? AND list_id = ?").bind(userId, id) }];
  if (items > 0) writes.push({ rows: items, stmt: db.prepare("DELETE FROM star_list_items WHERE user_id = ? AND list_id = ?").bind(userId, id) });
  return writes;
}

export function listItemWrite(db: D1Database, userId: string, id: number, subject: string, on: boolean, t: number): Write {
  return on
    ? { rows: 1, stmt: db.prepare("INSERT OR IGNORE INTO star_list_items (user_id, subject, list_id, at) VALUES (?, ?, ?, ?)").bind(userId, subject, id, Math.floor(t)) }
    : { rows: 1, stmt: db.prepare("DELETE FROM star_list_items WHERE user_id = ? AND subject = ? AND list_id = ?").bind(userId, subject, id) };
}

export function profileWrite(db: D1Database, userId: string, p: ProfileParsed, t: number): Write {
  const values = [
    p.name, p.bio, p.pronouns, p.location, p.timezone, p.website, JSON.stringify(p.links), p.company, JSON.stringify(p.pinned),
    p.status, p.statusUntil, p.busy ? 1 : 0, p.private ? 1 : 0, p.readme ? 1 : 0, Math.floor(t),
  ];
  const cols = ["name", "bio", "pronouns", "location", "timezone", "website", "links", "company", "pinned", "status", "status_until", "busy", "private", "readme", "at"];
  return {
    rows: 1,
    stmt: db
      .prepare(
        `INSERT INTO profiles (user_id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")}) ` +
          `ON CONFLICT (user_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`,
      )
      .bind(userId, ...values),
  };
}

// ─── the reads (every one by the person's key) ───────────────────────────────

export interface StarRow {
  subject: string;
  label: string;
  at: number;
}
export interface ListRow {
  list_id: number;
  name: string;
  description: string;
  public: number;
  collection: string;
  at: number;
}
export interface ItemRow {
  subject: string;
  list_id: number;
  at: number;
}
export interface FollowRow {
  target: string;
  level: WatchLevel;
  events: string;
  label: string;
  auto: number;
  at: number;
}
export interface ProfileRow {
  user_id: string;
  name: string;
  bio: string;
  pronouns: string;
  location: string;
  timezone: string;
  website: string;
  links: string;
  company: string;
  pinned: string;
  status: string;
  status_until: number | null;
  busy: number;
  private: number;
  readme: number;
  at: number;
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

export const starsOf = (db: D1Database, userId: string): D1PreparedStatement =>
  db.prepare("SELECT subject, label, at FROM stars WHERE user_id = ? LIMIT ?").bind(userId, STARS_MAX);
export const starsAmong = (db: D1Database, userId: string, subjects: string[]): D1PreparedStatement =>
  db.prepare(`SELECT subject, label, at FROM stars WHERE user_id = ? AND subject IN (${marks(subjects.length)})`).bind(userId, ...subjects);
export const starCount = (db: D1Database, userId: string): D1PreparedStatement =>
  db.prepare("SELECT count(*) AS n FROM stars WHERE user_id = ?").bind(userId);
export const listsOf = (db: D1Database, userId: string): D1PreparedStatement =>
  db.prepare("SELECT list_id, name, description, public, collection, at FROM star_lists WHERE user_id = ? LIMIT ?").bind(userId, LISTS_MAX);
export const itemsOf = (db: D1Database, userId: string): D1PreparedStatement =>
  db.prepare("SELECT subject, list_id, at FROM star_list_items WHERE user_id = ? LIMIT ?").bind(userId, LISTS_MAX * LIST_ITEMS_MAX);
export const itemsAmong = (db: D1Database, userId: string, subjects: string[]): D1PreparedStatement =>
  db.prepare(`SELECT subject, list_id, at FROM star_list_items WHERE user_id = ? AND subject IN (${marks(subjects.length)})`).bind(userId, ...subjects);
export const followsOf = (db: D1Database, userId: string): D1PreparedStatement =>
  db.prepare("SELECT target, level, events, label, auto, at FROM follows WHERE user_id = ? LIMIT ?").bind(userId, FOLLOWS_MAX);
export const followsAmong = (db: D1Database, userId: string, targets: string[]): D1PreparedStatement =>
  db.prepare(`SELECT target, level, events, label, auto, at FROM follows WHERE user_id = ? AND target IN (${marks(targets.length)})`).bind(userId, ...targets);
export const followCount = (db: D1Database, userId: string): D1PreparedStatement =>
  db.prepare("SELECT count(*) AS n FROM follows WHERE user_id = ?").bind(userId);
export const profileOf = (db: D1Database, userId: string): D1PreparedStatement =>
  db.prepare("SELECT * FROM profiles WHERE user_id = ?").bind(userId);

/** A profile as answered: never the account's id. */
export function profileView(p: ProfileRow | null, t: number): Record<string, unknown> {
  const parse = (s: string | undefined): string[] => {
    try {
      const v = JSON.parse(s ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  if (!p) return { name: "", bio: "", pronouns: "", location: "", timezone: "", website: "", links: [], company: "", pinned: [], status: "", statusUntil: null, busy: false, private: false, readme: true, saved: false };
  const statusLive = !p.status_until || p.status_until > t;
  return {
    name: p.name,
    bio: p.bio,
    pronouns: p.pronouns,
    location: p.location,
    timezone: p.timezone,
    website: p.website,
    links: parse(p.links),
    company: p.company,
    pinned: parse(p.pinned),
    status: statusLive ? p.status : "",
    statusUntil: statusLive ? p.status_until : null,
    busy: statusLive && p.busy === 1,
    private: p.private === 1,
    readme: p.readme === 1,
    saved: true,
  };
}

/** A list as answered, with its entries (the subjects, newest first). */
export function listView(l: ListRow, items: ItemRow[]): Record<string, unknown> {
  const mine = items.filter((i) => i.list_id === l.list_id).sort((a, b) => b.at - a.at);
  return { id: l.list_id, name: l.name, description: l.description, public: l.public === 1, collection: l.collection, at: l.at, items: mine.map((i) => i.subject) };
}

/** The first free list number, or null (32 lists). */
export function freeListId(lists: ListRow[]): number | null {
  const used = new Set(lists.map((l) => l.list_id));
  for (let i = 1; i <= LISTS_MAX; i++) if (!used.has(i)) return i;
  return null;
}
