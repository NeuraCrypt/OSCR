// The social pages' pure part (night phase 08, E5; docs/SOCIAL.md): the static shards' addresses, the
// words and addresses of what one stars and follows, the inbox's filters and views, a star list as
// references (BibTeX, RIS), the contribution calendar, the identicon. No request here; the pages'
// scripts are src/scripts/social-*.ts, notifications.ts, stars.ts, profile.ts, feed.ts, explore.ts.

import { h, type El } from "./repo-view.ts";

export const SOCIAL_SHARDS = 64;

/** The shard of a key: the first byte of its SHA-256, mod 64, two digits (oscr/social.py `shard`;
 *  both sides are checked against tests/fixtures/social-shards.json). */
export async function socialShard(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return String(digest[0] % SOCIAL_SHARDS).padStart(2, "0");
}
export const socialUrl = (shard: string): string => `/social/${shard}.json`;
/** The catalogue's papers of an author by ORCID iD, 64 shards built with the site. */
export const authorsUrl = (shard: string): string => `/social/authors/${shard}.json`;
export const EXPLORE_URL = "/social/explore.json";

/** A path of this site, or null: never another site ("//host", "/\\host" and "javascript:" are not
 *  paths here). Every address an answer or a static file gives a page goes through it. */
export function sitePath(u: unknown): string | null {
  return typeof u === "string" && /^\/(?![/\\])[^\s\\]{0,399}$/.test(u) ? u : null;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ORCID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/** A person's page: /u/<GitHub login or ORCID iD>/ (ONE shell, public/_redirects). */
export const personUrl = (handle: string): string => `/u/${encodeURIComponent(ORCID.test(handle.toUpperCase()) ? handle.toUpperCase() : handle.toLowerCase())}/`;
export const isHandle = (s: string): boolean => (LOGIN.test(s) && !s.endsWith("-") && !s.includes("--")) || ORCID.test(s.toUpperCase());

/** The handle a /u/ address names, or null. */
export function parsePersonPath(pathname: string): string | null {
  const m = /^\/u\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  let v: string;
  try {
    v = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (ORCID.test(v.toUpperCase())) return v.toUpperCase();
  return isHandle(v) ? v.toLowerCase() : null;
}

// ─── subjects and targets ────────────────────────────────────────────────────

/** Where a subject's page is: a repository by its path (the registry's name for it), a paper by its
 *  DOI (the lookup finds its page), a topic on Explore. */
export function subjectHref(subject: string, name = ""): string | null {
  if (subject.startsWith("repo:")) return /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(name) ? `/r/${name.toLowerCase()}/` : null;
  if (subject.startsWith("paper:doi:")) return `/lookup/?doi=${encodeURIComponent(subject.slice(10))}`;
  if (subject.startsWith("topic:")) return `/explore/?topic=${encodeURIComponent(subject.slice(6))}`;
  return null;
}

export function subjectWords(subject: string, name = ""): string {
  if (subject.startsWith("repo:")) return name || "a repository";
  if (subject.startsWith("paper:doi:")) return name || `doi:${subject.slice(10)}`;
  if (subject.startsWith("topic:")) return subject.slice(6);
  return subject;
}

export function subjectKind(subject: string): "repository" | "paper" | "topic" | "other" {
  return subject.startsWith("repo:") ? "repository" : subject.startsWith("paper:") ? "paper" : subject.startsWith("topic:") ? "topic" : "other";
}

/** Where a followed target's page is (null: none of this site). */
export function targetHref(target: string, label = ""): string | null {
  const [kind] = target.split(":", 1);
  const rest = target.slice(kind.length + 1);
  switch (kind) {
    case "orcid":
      return personUrl(rest);
    case "github":
      return isHandle(label) ? personUrl(label) : null;
    case "person":
      return isHandle(rest) ? personUrl(rest) : null;
    case "owner":
      return `/search/?type=repositories&q=${encodeURIComponent(`user:${rest.split(":")[1] ?? ""}`)}`;
    case "repo":
    case "paper":
      return subjectHref(target, label);
    case "journal":
      return `/journal/${encodeURIComponent(rest)}/`;
    case "tool":
      return `/tool/${encodeURIComponent(rest)}/`;
    case "dataset":
      return `/dataset/${encodeURIComponent(rest)}/`;
    case "category":
      return /^[a-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(rest) ? `/browse/${rest}/` : null;
    default:
      return null;
  }
}

export function targetWords(target: string, label = ""): string {
  const [kind] = target.split(":", 1);
  const rest = target.slice(kind.length + 1);
  const named = label ? ` ${label}` : "";
  switch (kind) {
    case "orcid":
      return `the author ${label || rest}`;
    case "github":
    case "person":
      return `the person${named || ` ${rest}`}`;
    case "owner":
      return `the organization ${rest.split(":")[1] ?? rest}`;
    case "repo":
      return `the repository${named}`;
    case "paper":
      return `the paper ${label || `doi:${rest.slice(4)}`}`;
    case "thread":
      return `a conversation${named}`;
    default:
      return `the ${kind} ${label || rest}`;
  }
}

export const LEVEL_WORDS: Readonly<Record<string, string>> = {
  all: "All activity",
  participating: "Participating and @mentions",
  ignore: "Ignore",
  custom: "Custom",
};

// ─── the inbox ───────────────────────────────────────────────────────────────

export interface Thread {
  key: string;
  subject: string;
  thread: string;
  words: string;
  title: string;
  url: string;
  repo: string | null;
  paper: string | null;
  latest: { kind: string; words: string; at: number; actor: string };
  count: number;
  reason: string;
  reasonWords: string;
  unread: boolean;
  done: boolean;
  saved: boolean;
  expired?: boolean;
}

export const VIEWS = ["inbox", "unread", "saved", "done", "read"] as const;
export type View = (typeof VIEWS)[number];
export const VIEW_WORDS: Readonly<Record<View, string>> = { inbox: "Inbox", unread: "Unread", saved: "Saved", done: "Done", read: "Read" };

export function inView(t: Thread, view: View): boolean {
  switch (view) {
    case "inbox":
      return !t.done;
    case "unread":
      return !t.done && t.unread;
    case "saved":
      return t.saved;
    case "done":
      return t.done;
    case "read":
      return !t.done && !t.unread;
  }
}

export interface InboxFilter {
  repo: string | null;
  org: string | null;
  author: string | null;
  is: string[];
  reason: string[];
  words: string[];
  unknown: string[];
}

const IS = new Set(["read", "unread", "done", "saved", "issue", "pr", "release", "research", "paper", "repository"]);
const REASONS = new Set(["mention", "author", "participating", "subscribed", "paper", "organization"]);

/** GitHub's inbox filters, and the registry's: repo:owner/name, org:login, author:login,
 *  is:read|unread|done|saved|issue|pr|release|research|paper|repository, reason:<why>, then words. */
export function parseInboxQuery(q: string): InboxFilter {
  const f: InboxFilter = { repo: null, org: null, author: null, is: [], reason: [], words: [], unknown: [] };
  for (const part of q.trim().split(/\s+/).filter(Boolean).slice(0, 20)) {
    const m = /^([a-z]+):(.+)$/i.exec(part);
    if (!m) {
      f.words.push(part.toLowerCase());
      continue;
    }
    const [key, value] = [m[1].toLowerCase(), m[2].toLowerCase()];
    if (key === "repo" && /^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(value)) f.repo = value;
    else if (key === "org" && LOGIN.test(value)) f.org = value;
    else if (key === "author" && LOGIN.test(value)) f.author = value;
    else if (key === "is" && IS.has(value)) f.is.push(value);
    else if (key === "reason" && REASONS.has(value)) f.reason.push(value);
    else f.unknown.push(part);
  }
  return f;
}

export function matchesThread(t: Thread, f: InboxFilter): boolean {
  if (f.repo && t.repo !== f.repo) return false;
  if (f.org && !(t.repo ?? "").startsWith(`${f.org}/`)) return false;
  if (f.author && t.latest.actor.toLowerCase() !== f.author) return false;
  for (const is of f.is) {
    const k = t.thread.split(":")[0];
    const ok =
      is === "read" ? !t.unread : is === "unread" ? t.unread : is === "done" ? t.done : is === "saved" ? t.saved : is === "issue" ? k === "issue" : is === "pr" ? k === "pull" : is === "release" ? k === "release" : is === "research" ? k === "research" : is === "paper" ? !!t.paper : is === "repository" ? !!t.repo : true;
    if (!ok) return false;
  }
  if (f.reason.length && !f.reason.includes(t.reason)) return false;
  const hay = `${t.title} ${t.words} ${t.repo ?? ""} ${t.paper ?? ""} ${t.latest.actor}`.toLowerCase();
  return f.words.every((w) => hay.includes(w));
}

/** Threads under their repository or paper, the groups in the order of their newest thread. */
export function groupThreads(threads: Thread[]): { label: string; threads: Thread[] }[] {
  const groups = new Map<string, Thread[]>();
  for (const t of threads) {
    const label = t.repo ?? (t.paper ? `doi:${t.paper}` : "Saved");
    groups.set(label, [...(groups.get(label) ?? []), t]);
  }
  return [...groups].map(([label, ts]) => ({ label, threads: ts }));
}

// ─── a star list as references ───────────────────────────────────────────────

export interface RefItem {
  subject: string;
  name?: string;
  title?: string;
}

const bibEscape = (s: string): string => s.replace(/[\\{}]/g, "").replace(/[&%$#_]/g, (c) => `\\${c}`);

/** A list's papers and repositories as BibTeX (@article by DOI, @software by address); topics are
 *  not references. */
export function bibtex(items: RefItem[], origin: string): string {
  const out: string[] = [];
  const keys = new Set<string>();
  const keyOf = (base: string) => {
    let k = base.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "ref";
    let n = 1;
    while (keys.has(k)) k = `${k.replace(/_\d+$/, "")}_${++n}`;
    keys.add(k);
    return k;
  };
  for (const it of items) {
    if (it.subject.startsWith("paper:doi:")) {
      const doi = it.subject.slice(10);
      const lines = [`  doi = {${bibEscape(doi)}}`, `  url = {https://doi.org/${doi}}`];
      if (it.title) lines.unshift(`  title = {${bibEscape(it.title)}}`);
      out.push(`@article{${keyOf(`doi_${doi}`)},\n${lines.join(",\n")}\n}`);
    } else if (it.subject.startsWith("repo:") && it.name) {
      out.push(`@software{${keyOf(it.name)},\n  title = {${bibEscape(it.name)}},\n  url = {${origin}/r/${it.name}/},\n  note = {Code repository, in ${bibEscape(new URL(origin).host)}}\n}`);
    }
  }
  return out.join("\n\n") + (out.length ? "\n" : "");
}

/** The same as RIS (JOUR by DOI, COMP for code). */
export function ris(items: RefItem[], origin: string): string {
  const out: string[] = [];
  for (const it of items) {
    if (it.subject.startsWith("paper:doi:")) {
      const doi = it.subject.slice(10);
      out.push(["TY  - JOUR", ...(it.title ? [`TI  - ${it.title.replace(/\s+/g, " ")}`] : []), `DO  - ${doi}`, `UR  - https://doi.org/${doi}`, "ER  - "].join("\r\n"));
    } else if (it.subject.startsWith("repo:") && it.name) {
      out.push(["TY  - COMP", `TI  - ${it.name}`, `UR  - ${origin}/r/${it.name}/`, "ER  - "].join("\r\n"));
    }
  }
  return out.join("\r\n") + (out.length ? "\r\n" : "");
}

// ─── the contribution calendar ───────────────────────────────────────────────

export interface Day {
  day: string;
  n: number;
  level: 0 | 1 | 2 | 3 | 4;
  publications: number;
}

export const levelOf = (n: number): Day["level"] => (n <= 0 ? 0 : n < 2 ? 1 : n < 4 ? 2 : n < 8 ? 3 : 4);

/** A year of days in weeks (Sunday first, GitHub's), the newest week last: each day its count, its
 *  level (0–4) and its publications (the catalogue's papers of the person, by their date). */
export function calendar(counts: Record<string, number>, publications: string[], today: string, days = 365): { weeks: (Day | null)[][]; total: number; published: number } {
  const end = Date.parse(`${today}T00:00:00Z`);
  const pubs = new Map<string, number>();
  for (const d of publications) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) pubs.set(d, (pubs.get(d) ?? 0) + 1);
  const all: Day[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    const n = Math.max(0, Number(counts[day] ?? 0));
    all.push({ day, n, level: levelOf(n), publications: pubs.get(day) ?? 0 });
  }
  const weeks: (Day | null)[][] = [];
  let week: (Day | null)[] = Array.from({ length: new Date(Date.parse(`${all[0].day}T00:00:00Z`)).getUTCDay() }, () => null);
  for (const d of all) {
    week.push(d);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length) weeks.push(week);
  return { weeks, total: all.reduce((s, d) => s + d.n, 0), published: all.reduce((s, d) => s + d.publications, 0) };
}

/** The calendar as a table (science.css `table.calendar`: a cell's level is its class, never a
 *  style), with its words for screen readers in each cell's title. */
export function calendarView(c: ReturnType<typeof calendar>): El {
  const rows: El[] = [];
  for (let wd = 0; wd < 7; wd++) {
    rows.push(
      h(
        "tr",
        null,
        c.weeks.map((w) => {
          const d = w[wd];
          if (!d) return h("td", { class: "none" });
          const words = `${d.day}: ${d.n ? `${d.n} ${d.n === 1 ? "contribution" : "contributions"}` : "no contribution"}${d.publications ? `, ${d.publications} ${d.publications === 1 ? "paper published" : "papers published"}` : ""}`;
          return h("td", { class: `level-${d.level}${d.publications ? " published" : ""}`, title: words }, d.publications ? "•" : "");
        }),
      ),
    );
  }
  return h("table", { class: "calendar", "aria-label": `${c.total} contributions and ${c.published} papers published in the last year` }, h("tbody", null, rows));
}

// ─── the identicon (a picture without an image: 5 × 5 cells from the handle's digest) ─────

export async function identiconCells(handle: string): Promise<boolean[][]> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(handle.toLowerCase())));
  return Array.from({ length: 5 }, (_, r) => {
    const left = [0, 1, 2].map((c) => (d[r * 3 + c] & 1) === 1);
    return [left[0], left[1], left[2], left[1], left[0]];
  });
}

/** The identicon as a table of cells (science.css `table.identicon`: `on` cells in the hue its
 *  class names, one of eight). */
export function identiconView(cells: boolean[][], hue: number): El {
  return h("table", { class: `identicon hue-${hue % 8}`, "aria-hidden": "true" }, h("tbody", null, cells.map((row) => h("tr", null, row.map((on) => h("td", { class: on ? "on" : "" }))))));
}

/** A hue from a handle (one of eight), stable. */
export function hueOf(handle: string): number {
  let n = 0;
  for (const ch of handle.toLowerCase()) n = (n * 31 + ch.charCodeAt(0)) % 997;
  return n % 8;
}
