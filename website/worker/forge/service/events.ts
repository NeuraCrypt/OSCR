// Events (night phase 08, E2): what happened, ONE row each in D1 oscr_forge `events`, keyed by its
// subject (a repository, "repo:<forge>:<id>", or a paper, "paper:doi:10.…"), and fanned out on READ
// (inbox.ts): nothing is written per recipient. See docs/SOCIAL.md "Events".
//
// Where events come from, each written in the same batch as what caused it:
// - the registry's research issues (research.ts): opened, commented, closed, reopened, under the
//   paper's subject;
// - the authorized actions (act.ts): an issue or a pull request opened, commented, reviewed, closed,
//   merged; a release published — only on a repository the App is not installed on (no webhook will
//   come: the App's webhook writes the same event otherwise, and the registry never writes it twice);
//   a repository linked to papers and a release tied to a paper's version, under the paper's subject;
// - the App's webhooks (webhook.ts): GitHub's issues, comments, pull requests and releases on a
//   repository the registry follows, 1 row with the delivery's row (D01-24's 2).
// A person who takes part in a thread through the registry (opens it, comments) follows it (a
// `follows` row "thread:<subject>#<thread>", auto = 1, written once): the inbox's "participating".
//
// What an event holds: a title (masked, 200 characters), a path of this site (the registry shows
// everything; GitHub only as a last resort), the actor (their account's id when they acted in the
// registry — never answered —, their GitHub id and login), the thread's author, the logins the text
// names. Never a text, never an address, never a private repository (the webhook drops them, D00-14,
// and the inbox drops the events of a repository that left the registry).

import { maskEmails } from "../mask.ts";
import type { ForgeEvent } from "../types.ts";
import { mentionsIn } from "../github/webhooks.ts";
import { autoFollowWrite } from "./social-core.ts";
import type { D1Database, D1PreparedStatement, RepoRow, Write } from "./types.ts";

export const EVENT_KINDS = [
  "issue_opened", "issue_closed", "issue_reopened", "issue_comment", "pull_opened", "pull_closed", "pull_merged",
  "pull_reopened", "pull_review", "pull_comment", "release_published", "research_opened", "research_comment",
  "research_closed", "research_reopened", "code_linked", "release_tied",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The kinds a custom watch's event types pick (social-core.ts CUSTOM_EVENTS). */
export const EVENT_TYPE_OF: Readonly<Record<EventKind, "issues" | "pulls" | "releases" | "research">> = {
  issue_opened: "issues",
  issue_closed: "issues",
  issue_reopened: "issues",
  issue_comment: "issues",
  pull_opened: "pulls",
  pull_closed: "pulls",
  pull_merged: "pulls",
  pull_reopened: "pulls",
  pull_review: "pulls",
  pull_comment: "pulls",
  release_published: "releases",
  release_tied: "releases",
  research_opened: "research",
  research_comment: "research",
  research_closed: "research",
  research_reopened: "research",
  code_linked: "research",
};

/** What happened, in words (the inbox and the feed). */
export const EVENT_WORDS: Readonly<Record<EventKind, string>> = {
  issue_opened: "opened the issue",
  issue_closed: "closed the issue",
  issue_reopened: "reopened the issue",
  issue_comment: "commented on the issue",
  pull_opened: "opened the pull request",
  pull_closed: "closed the pull request",
  pull_merged: "merged the pull request",
  pull_reopened: "reopened the pull request",
  pull_review: "reviewed the pull request",
  pull_comment: "commented on the pull request",
  release_published: "published the release",
  release_tied: "tied a release to a version of the paper",
  research_opened: "opened the research issue",
  research_comment: "commented on the research issue",
  research_closed: "closed the research issue",
  research_reopened: "reopened the research issue",
  code_linked: "linked code to the paper",
};

export interface NewEvent {
  subject: string;
  at: number;
  nonce: string;
  kind: EventKind;
  thread: string;
  title: string;
  url: string;
  repoPath?: string;
  paperId?: string;
  actorUser?: string;
  actorGithub?: string;
  actorName?: string;
  threadAuthor?: string;
  mentions?: string[];
}

export interface EventRow {
  subject: string;
  at: number;
  nonce: string;
  kind: EventKind;
  thread: string;
  title: string;
  url: string;
  repo_path: string;
  paper_id: string;
  actor_user: string;
  actor_github: string;
  actor_name: string;
  thread_author: string;
  mentions: string;
}

/** Retention: the inbox and the feed read 3 months back (GitHub's own); saved threads keep their
 *  words in their state row. */
export const RETENTION_SECONDS = 90 * 86_400;

const cut = (s: string | undefined, n: number): string => [...(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ")].slice(0, n).join("");
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const safeUrl = (u: string): string => (u.startsWith("/") && !u.startsWith("//") && u.length <= 300 ? u : "/");

const COLUMNS = "(subject, at, nonce, kind, thread, title, url, repo_path, paper_id, actor_user, actor_github, actor_name, thread_author, mentions)";

function values(e: NewEvent): unknown[] {
  return [
    e.subject,
    Math.floor(e.at),
    e.nonce.slice(0, 120),
    e.kind,
    cut(e.thread, 120),
    cut(maskEmails(e.title), 200),
    safeUrl(e.url),
    cut(e.repoPath, 201).toLowerCase(),
    cut(e.paperId, 210),
    e.actorUser ?? "",
    /^\d{1,20}$/.test(e.actorGithub ?? "") ? e.actorGithub! : "",
    cut(e.actorName, 100).replace(/[@＠]/g, " "),
    cut(e.threadAuthor, 80),
    (e.mentions ?? []).map((m) => m.toLowerCase()).filter((m) => LOGIN.test(m)).slice(0, 10).join(" "),
  ];
}

/** ONE event row (1 row written). Every value is cut to its column's CHECK first (values), so the
 *  insert never fails on a text: a plain INSERT, whose failure would show, not an ignored one. */
export function eventWrite(db: D1Database, e: NewEvent): Write {
  return { rows: 1, stmt: db.prepare(`INSERT INTO events ${COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...values(e)) };
}

/** A research issue's event when its number is the one the same batch just gave (the newest row of
 *  research_issues: its rowid, read inside the batch's transaction), and the author's follow of the
 *  thread. 2 rows. */
export function researchOpenedWrites(db: D1Database, userId: string, e: Omit<NewEvent, "thread" | "url">): Write[] {
  const v = values({ ...e, thread: "research:0", url: "/research/" });
  return [
    {
      rows: 1,
      stmt: db
        .prepare(
          `INSERT INTO events ${COLUMNS} SELECT ?, ?, ?, ?, 'research:' || max(id), ?, '/research/' || max(id), ?, ?, ?, ?, ?, ?, ? FROM research_issues`,
        )
        .bind(v[0], v[1], v[2], v[3], v[5], v[7], v[8], v[9], v[10], v[11], v[12], v[13]),
    },
    {
      rows: 1,
      stmt: db
        .prepare("INSERT OR IGNORE INTO follows (user_id, target, level, events, label, auto, at) SELECT ?, 'thread:' || ? || '#research:' || max(id), 'all', '', '', 1, ? FROM research_issues")
        .bind(userId, e.subject, Math.floor(e.at)),
    },
  ];
}

// ─── events of the authorized actions ────────────────────────────────────────

interface ActionFacts {
  kind: string;
  parsed: unknown;
  result: unknown;
  /** The repository the action named: its key and its path as GitHub serves it. */
  repo: { forge: string; repoId: string; path: string } | null;
  /** Whether the App is installed on it (its webhooks bring GitHub's events). */
  installed: boolean;
  user: { id: string; github: string; login: string };
  t: number;
  nonce: string;
}

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

/** The events an authorized action makes, and the threads the person now takes part in (followed).
 *  A repository's events only when no webhook will bring them (the App is not installed on it). */
export function eventsOfAction(a: ActionFacts): { events: NewEvent[]; threads: string[] } {
  const p = obj(a.parsed);
  const r = obj(a.result);
  const events: NewEvent[] = [];
  const threads: string[] = [];
  const actor = { actorUser: a.user.id, actorGithub: a.user.github, actorName: a.user.login };
  const repo = a.repo;
  const subject = repo ? `repo:${repo.forge}:${repo.repoId}` : "";
  const page = str(r.page) || (repo ? `/r/${repo.path}/` : "/");
  const push = (kind: EventKind, thread: string, extra: Partial<NewEvent> = {}) => {
    if (!repo) return;
    if (!a.installed) events.push({ subject, at: a.t, nonce: a.nonce, kind, thread, title: "", url: page, repoPath: repo.path, ...actor, ...extra });
  };
  const follow = (thread: string) => {
    if (repo) threads.push(`${subject}#${thread}`);
  };
  switch (a.kind) {
    case "issue_open": {
      const n = int(r.number);
      if (!n) break;
      push("issue_opened", `issue:${n}`, { title: str(p.title), threadAuthor: `user:${a.user.id}`, mentions: mentionsIn(p.body) });
      follow(`issue:${n}`);
      break;
    }
    case "issue_comment": {
      const n = int(p.number);
      if (!n || p.comment || p.delete) break;
      push("issue_comment", `issue:${n}`, { mentions: mentionsIn(p.body) });
      follow(`issue:${n}`);
      break;
    }
    case "issue_edit": {
      const numbers = Array.isArray(p.numbers) ? p.numbers : [];
      if (numbers.length !== 1 || (p.state !== "closed" && p.state !== "open")) break;
      push(p.state === "closed" ? "issue_closed" : "issue_reopened", `issue:${numbers[0]}`, { title: str(p.title) });
      break;
    }
    case "pull_open": {
      const n = int(r.number);
      if (!n) break;
      push("pull_opened", `pull:${n}`, { title: str(p.title), threadAuthor: `user:${a.user.id}`, mentions: mentionsIn(p.body) });
      follow(`pull:${n}`);
      break;
    }
    case "pull_comment":
    case "pull_review": {
      const n = int(p.number);
      if (!n) break;
      push(a.kind === "pull_comment" ? "pull_comment" : "pull_review", `pull:${n}`, { mentions: mentionsIn(p.body) });
      follow(`pull:${n}`);
      break;
    }
    case "pull_merge": {
      const n = int(p.number);
      if (n) push("pull_merged", `pull:${n}`, { title: str(p.title) });
      break;
    }
    case "pull_edit": {
      const numbers = Array.isArray(p.numbers) ? p.numbers : [];
      if (numbers.length !== 1 || (p.state !== "closed" && p.state !== "open")) break;
      push(p.state === "closed" ? "pull_closed" : "pull_reopened", `pull:${numbers[0]}`, { title: str(p.title) });
      break;
    }
    case "release_create":
    case "release_edit": {
      const tag = str(r.tag);
      const published = a.kind === "release_create" ? p.draft === false : p.draft === false;
      if (tag && published) push("release_published", `release:${tag}`, { title: str(p.name) || tag });
      const tie = obj(p.paper);
      const doi = str(tie.doi);
      if (tag && doi && repo) {
        const paper = doi.startsWith("doi:") ? doi : `doi:${doi.toLowerCase()}`;
        events.push({ subject: `paper:${paper}`, at: a.t, nonce: `${a.nonce}.tie`, kind: "release_tied", thread: `release:${tag}`, title: `${repo.path} ${tag}`, url: page, repoPath: repo.path, paperId: paper, ...actor });
      }
      break;
    }
    case "create":
    case "generate":
    case "link":
    case "papers": {
      const papers = Array.isArray(r.papers) ? r.papers : Array.isArray(p.add) ? (p.add as unknown[]).map((d) => ({ doi: d })) : [];
      const path = repo?.path ?? (str(r.owner) && str(r.name) ? `${str(r.owner)}/${str(r.name)}`.toLowerCase() : "");
      if (!path) break;
      for (const [i, x] of papers.slice(0, 5).entries()) {
        const d = str(obj(x).doi).toLowerCase();
        const paper = d.startsWith("doi:") ? d : `doi:${d}`;
        if (!/^doi:10\.\d{4,9}\/\S+$/.test(paper)) continue;
        events.push({ subject: `paper:${paper}`, at: a.t, nonce: `${a.nonce}.${i}`, kind: "code_linked", thread: `code:${path}`, title: path, url: `/r/${path}/`, repoPath: path, paperId: paper, ...actor });
      }
      break;
    }
  }
  return { events, threads };
}

/** The writes of an action's events and followed threads (1 row each; a followed thread only once). */
export function actionEventWrites(db: D1Database, userId: string, x: { events: NewEvent[]; threads: string[] }, t: number): Write[] {
  return [...x.events.map((e) => eventWrite(db, e)), ...x.threads.map((k) => autoFollowWrite(db, userId, k, t))];
}

// ─── events of the App's webhooks ────────────────────────────────────────────

/** The event a delivery makes on a repository the registry follows, or null. */
export function eventOfDelivery(event: ForgeEvent, repo: RepoRow, t: number): NewEvent | null {
  const path = `${repo.owner_login}/${repo.name}`;
  const base = { subject: `repo:${repo.forge}:${repo.repo_id}`, at: t, nonce: "", repoPath: path };
  const who = (a: { login: string | null; id: string | null }) => ({ actorGithub: a.id ?? "", actorName: a.login ?? "" });
  const author = (a: { id: string | null } | undefined) => (a?.id ? `github:${a.id}` : "");
  switch (event.kind) {
    case "issues": {
      const kind = ({ opened: "issue_opened", closed: "issue_closed", reopened: "issue_reopened" } as const)[event.action as "opened"];
      if (!kind) return null;
      return { ...base, nonce: `delivery:${event.delivery}`, kind, thread: `issue:${event.number}`, title: event.title, url: `/r/${path}/issues/${event.number}`, threadAuthor: author(event.author), mentions: event.action === "opened" ? event.mentions : [], ...who(event.sender) };
    }
    case "issue_comment": {
      if (event.action !== "created") return null;
      const pull = event.isPull;
      return {
        ...base,
        nonce: `delivery:${event.delivery}`,
        kind: pull ? "pull_comment" : "issue_comment",
        thread: `${pull ? "pull" : "issue"}:${event.number}`,
        title: event.title,
        url: `/r/${path}/${pull ? "pull" : "issues"}/${event.number}`,
        threadAuthor: author(event.author),
        mentions: event.mentions,
        ...who(event.sender),
      };
    }
    case "pull_request": {
      const kind =
        event.action === "opened" ? "pull_opened" : event.action === "reopened" ? "pull_reopened" : event.action === "closed" ? (event.merged ? "pull_merged" : "pull_closed") : null;
      if (!kind) return null;
      return { ...base, nonce: `delivery:${event.delivery}`, kind, thread: `pull:${event.number}`, title: event.title ?? "", url: `/r/${path}/pull/${event.number}`, threadAuthor: author(event.author), mentions: kind === "pull_opened" ? (event.mentions ?? []) : [], ...who(event.sender) };
    }
    case "release": {
      if (event.action !== "published" || event.draft) return null;
      return { ...base, nonce: `delivery:${event.delivery}`, kind: "release_published", thread: `release:${event.tagName}`, title: event.name || event.tagName, url: `/r/${path}/releases/tag/${encodeURIComponent(event.tagName)}`, ...who(event.sender) };
    }
    default:
      return null;
  }
}

// ─── reads ───────────────────────────────────────────────────────────────────

/** A subject's events since `since`, the newest first (the key's prefix: never a scan). */
export function eventsOf(db: D1Database, subject: string, since: number, limit: number): D1PreparedStatement {
  return db.prepare("SELECT * FROM events WHERE subject = ? AND at > ? ORDER BY at DESC LIMIT ?").bind(subject, Math.floor(since), limit);
}

/** One event by its key (a person's activity reads its action rows, then their events). */
export function eventByKey(db: D1Database, subject: string, at: number, nonce: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM events WHERE subject = ? AND at = ? AND nonce = ?").bind(subject, at, nonce);
}

/** A thread in words: "issue #12", "pull request #3", "research issue #7", "release v1.0". */
export function threadWords(thread: string): string {
  const [k, v] = [thread.slice(0, thread.indexOf(":")), thread.slice(thread.indexOf(":") + 1)];
  return k === "issue" ? `issue #${v}` : k === "pull" ? `pull request #${v}` : k === "research" ? `research issue #${v}` : k === "release" ? `release ${v}` : k === "code" ? `the code ${v}` : thread;
}
