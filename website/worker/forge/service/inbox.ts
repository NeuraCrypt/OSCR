// The in-site notifications, the activity feed and a person's activity (night phase 08, E2). In the
// site only: no email is ever sent (the owner's decision D5), no address asked or kept. See
// docs/SOCIAL.md "Notifications".
//
//   GET  /api/forge/social/inbox      signed in  the reader's notifications, computed now (fanned out on read)
//   POST /api/forge/social/notices    signed in  read, unread, done, undone, save, unsave, unsubscribe,
//                                                subscribe (≤ 25 threads: 1 row each), all read (1 row),
//                                                the settings (1 row); the action row
//   GET  /api/forge/social/feed       signed in  what the people, organizations, repositories and papers
//                                                the reader follows did, the last 14 days
//   GET  /api/forge/social/activity   signed in  a person's activity: the contribution calendar (a year),
//                                                the timeline (3 months), the milestones in words
//
// How the inbox is computed (nothing is written per recipient, the plan's decision):
// 1. the reader's follows (their key): watched repositories (all activity, participating and
//    @mentions, custom event types; "ignore" reads nothing), watched papers, organizations (their
//    repositories the registry knows, by the index `repos_path`), followed threads (taken part in, or
//    subscribed; "ignore": unsubscribed). At most INBOX_SUBJECTS subjects, the most recently followed
//    first (the answer says when some are left out);
// 2. each subject's events of the last 3 months (the key's prefix), at most PER_SUBJECT;
// 3. a repository that left the registry (hidden when made private, deleted, gone) drops its events:
//    the inbox never names a private repository;
// 4. the reader's own acts are no notification; a thread unsubscribed is silent; the reason: a
//    mention (the reader's GitHub login in the text), the thread's author, a thread taken part in, a
//    watched repository or paper, an organization;
// 5. grouped by thread (GitHub's unit), the newest first, with the reader's states (read until newer
//    activity, done until newer activity, saved: kept with its words past the 3 months).
// The page filters (repo:, org:, author:, is:, reason:) and switches views (Inbox, Unread, Saved,
// Done, Read) in the browser: one request a view.

import { signedIn, type SignedIn } from "../../account/guard.ts";
import { identityOwner, userById } from "../../account/store.ts";
import { utcDay } from "./caps.ts";
import { EVENT_TYPE_OF, EVENT_WORDS, eventByKey, eventsOf, RETENTION_SECONDS, threadWords, type EventKind, type EventRow } from "./events.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import { mayWrite } from "./gate.ts";
import { maySocial, socialCommit } from "./social.ts";
import { cleanLine, followsOf, followWrite, profileOf, profileView, readTarget, readThreadKey, type FollowRow, type ProfileRow } from "./social-core.ts";
import { readCapped } from "./flow.ts";
import { all, first } from "./store.ts";
import { ForgeProblem, type D1Database, type D1PreparedStatement, type ForgeRequest, type RepoRow, type Write } from "./types.ts";

/** Subjects one inbox reads (watched repositories, papers, organizations' repositories, followed
 *  threads' subjects). */
export const INBOX_SUBJECTS = 60;
/** Events read per subject. */
export const PER_SUBJECT = 30;
/** Threads one inbox answers. */
export const INBOX_THREADS = 300;
/** An organization's repositories the inbox and the feed read. */
export const OWNER_REPOS = 30;
/** Threads one notices request changes (GitHub's bulk triage). */
export const NOTICES_AT_ONCE = 25;
/** The feed: days back, people and subjects read, items answered. */
export const FEED_DAYS = 14;
export const FEED_PEOPLE = 30;
export const FEED_SUBJECTS = 40;
export const FEED_ITEMS = 100;
/** The activity: the calendar's days, the timeline's. */
export const CALENDAR_DAYS = 365;
export const TIMELINE_DAYS = 90;
/** D1 binds at most 100 values a statement: a year of days is read in four ranges. */
const DAYS_PER_QUERY = 92;

export type Reason = "mention" | "author" | "participating" | "subscribed" | "paper" | "organization";
export const REASON_WORDS: Readonly<Record<Reason, string>> = {
  mention: "You were mentioned",
  author: "You opened it",
  participating: "You took part",
  subscribed: "You watch the repository",
  paper: "You watch the paper",
  organization: "You follow its organization",
};
const REASON_RANK: Readonly<Record<Reason, number>> = { mention: 6, author: 5, participating: 4, subscribed: 3, paper: 2, organization: 1 };

interface Source {
  subject: string;
  level: "all" | "participating" | "custom";
  events: string[];
  reason: Reason;
  at: number;
}

interface StateRow {
  thread: string;
  read_at: number | null;
  done_at: number | null;
  saved: number;
  title: string;
  url: string;
  at: number;
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The reader's GitHub id and login, for "mentioned" and "author" (their linked identity). */
async function whoIs(s: SignedIn): Promise<{ github: string; login: string }> {
  return { github: (await linkedGithub(s.db, s.user.id)) ?? "", login: (s.user.github_login ?? "").toLowerCase() };
}

/** The repositories a subject list names, alive in the registry (hidden, deleted and gone ones left
 *  out): by their key, one batch. */
async function aliveRepos(db: D1Database, subjects: string[]): Promise<Map<string, RepoRow>> {
  const keys = subjects.map((s) => /^repo:(github|memory):([0-9]+)$/.exec(s)).filter((m): m is RegExpExecArray => !!m);
  const out = new Map<string, RepoRow>();
  if (!keys.length) return out;
  const results = await db.batch(keys.map((m) => db.prepare("SELECT * FROM repos WHERE forge = ? AND repo_id = ?").bind(m[1], m[2])));
  results.forEach((res, i) => {
    const row = res?.results?.[0] as unknown as RepoRow | undefined;
    if (row && (row.state === "active" || row.state === "archived" || row.state === "pending_deletion") && row.name) out.set(`repo:${keys[i][1]}:${keys[i][2]}`, row);
  });
  return out;
}

/** An organization's (or a person's) repositories the registry knows: the index's prefix. */
function reposOfOwner(db: D1Database, forge: string, login: string): D1PreparedStatement {
  return db
    .prepare("SELECT forge, repo_id FROM repos WHERE forge = ? AND owner_login = ? AND state IN ('active', 'archived') LIMIT ?")
    .bind(forge, login, OWNER_REPOS);
}

/** Many reads in one round trip, their rows. */
async function batchRows<T>(db: D1Database, stmts: D1PreparedStatement[]): Promise<T[][]> {
  if (!stmts.length) return [];
  const out = await db.batch(stmts);
  return out.map((r) => (r?.results ?? []) as unknown as T[]);
}

// ─── the inbox ───────────────────────────────────────────────────────────────

export interface InboxThread {
  key: string;
  subject: string;
  thread: string;
  words: string;
  title: string;
  url: string;
  repo: string | null;
  paper: string | null;
  latest: { kind: EventKind; words: string; at: number; actor: string };
  count: number;
  reason: Reason;
  reasonWords: string;
  unread: boolean;
  done: boolean;
  saved: boolean;
  expired?: boolean;
}

/** The sources the reader's follows name, and their followed threads' levels. */
async function sourcesOf(db: D1Database, follows: FollowRow[]): Promise<{ sources: Map<string, Source>; threads: Map<string, string>; partial: boolean }> {
  const sources = new Map<string, Source>();
  const threads = new Map<string, string>();
  const rank = { all: 3, custom: 2, participating: 1 } as const;
  const add = (src: Source) => {
    const had = sources.get(src.subject);
    if (!had || rank[src.level] > rank[had.level] || (src.level === had.level && src.at > had.at)) sources.set(src.subject, src);
  };
  const owners: FollowRow[] = [];
  for (const f of [...follows].sort((a, b) => b.at - a.at)) {
    if (f.level === "ignore" && !f.target.startsWith("thread:")) continue;
    if (f.target.startsWith("repo:")) add({ subject: f.target, level: f.level === "custom" ? "custom" : f.level === "participating" ? "participating" : "all", events: f.events ? f.events.split(" ") : [], reason: "subscribed", at: f.at });
    else if (f.target.startsWith("paper:")) add({ subject: f.target, level: "all", events: [], reason: "paper", at: f.at });
    else if (f.target.startsWith("owner:")) owners.push(f);
    else if (f.target.startsWith("thread:")) {
      const key = f.target.slice(7);
      threads.set(key, f.level);
      if (f.level !== "ignore") add({ subject: key.slice(0, key.lastIndexOf("#")), level: "participating", events: [], reason: "participating", at: f.at });
    }
  }
  if (owners.length) {
    const rows = await batchRows<{ forge: string; repo_id: string }>(
      db,
      owners.slice(0, 10).map((f) => {
        const [, forge, login] = f.target.split(":");
        return reposOfOwner(db, forge, login);
      }),
    );
    rows.forEach((repos, i) => {
      for (const r of repos) add({ subject: `repo:${r.forge}:${r.repo_id}`, level: "all", events: [], reason: "organization", at: owners[i].at });
    });
  }
  const all = [...sources.values()].sort((a, b) => b.at - a.at);
  const kept = new Map(all.slice(0, INBOX_SUBJECTS).map((s) => [s.subject, s]));
  return { sources: kept, threads, partial: all.length > INBOX_SUBJECTS };
}

/** The reader's inbox, computed now. */
export async function computeInbox(db: D1Database, s: SignedIn, t: number): Promise<{ threads: InboxThread[]; partial: boolean; subjects: number; readBefore: number; settings: Record<string, unknown> }> {
  const me = await whoIs(s);
  const follows = await all<FollowRow>(followsOf(db, s.user.id));
  const { sources, threads: followed, partial } = await sourcesOf(db, follows);
  const since = t - RETENTION_SECONDS;
  const subjects = [...sources.keys()];
  const [eventLists, alive, states, marks] = await Promise.all([
    batchRows<EventRow>(db, subjects.map((subject) => eventsOf(db, subject, since, PER_SUBJECT))),
    aliveRepos(db, subjects),
    all<StateRow>(db.prepare("SELECT thread, read_at, done_at, saved, title, url, at FROM notice_state WHERE user_id = ? LIMIT 5000").bind(s.user.id)),
    first<{ read_before: number; settings: string }>(db.prepare("SELECT read_before, settings FROM notice_marks WHERE user_id = ?").bind(s.user.id)),
  ]);
  const grouped = new Map<string, { events: EventRow[]; reason: Reason }>();
  eventLists.forEach((events, i) => {
    const subject = subjects[i];
    const src = sources.get(subject)!;
    if (subject.startsWith("repo:") && !alive.has(subject)) return;
    for (const e of events) {
      if ((e.actor_user && e.actor_user === s.user.id) || (me.github && e.actor_github === me.github)) continue;
      const key = `${e.subject}#${e.thread}`;
      const level = followed.get(key);
      if (level === "ignore") continue;
      const mentioned = !!me.login && e.mentions.split(" ").includes(me.login);
      const author = e.thread_author === `user:${s.user.id}` || (!!me.github && e.thread_author === `github:${me.github}`);
      let reason: Reason | null = mentioned ? "mention" : author ? "author" : level === "all" ? "participating" : null;
      if (!reason) {
        if (src.level === "all") reason = src.reason;
        else if (src.level === "custom" && src.events.includes(EVENT_TYPE_OF[e.kind])) reason = src.reason;
      }
      // Watching at "participating": only what involves the reader.
      if (!reason) continue;
      const g = grouped.get(key);
      if (!g) grouped.set(key, { events: [e], reason });
      else {
        g.events.push(e);
        if (REASON_RANK[reason] > REASON_RANK[g.reason]) g.reason = reason;
      }
    }
  });
  const stateOf = new Map(states.map((x) => [x.thread, x]));
  const readBefore = Number(marks?.read_before ?? 0);
  const out: InboxThread[] = [];
  for (const [key, g] of grouped) {
    g.events.sort((a, b) => b.at - a.at);
    const latest = g.events[0];
    const st = stateOf.get(key);
    const read = st && st.read_at !== null ? st.read_at >= latest.at : readBefore >= latest.at;
    const done = !!st && st.done_at !== null && st.done_at >= latest.at;
    const repoRow = latest.subject.startsWith("repo:") ? alive.get(latest.subject) : undefined;
    out.push({
      key,
      subject: latest.subject,
      thread: latest.thread,
      words: threadWords(latest.thread),
      title: g.events.find((e) => e.title)?.title ?? "",
      url: latest.url,
      // A repository only while it is alive in the registry; a paper's events never name one.
      repo: repoRow ? `${repoRow.owner_login}/${repoRow.name}` : null,
      paper: latest.subject.startsWith("paper:") ? latest.subject.slice(10) : null,
      latest: { kind: latest.kind, words: EVENT_WORDS[latest.kind], at: latest.at, actor: latest.actor_name },
      count: g.events.length,
      reason: g.reason,
      reasonWords: REASON_WORDS[g.reason],
      unread: !read,
      done,
      saved: st?.saved === 1,
    });
  }
  // Saved threads whose events are past the 3 months: kept, with their words.
  for (const st of states) {
    if (st.saved !== 1 || grouped.has(st.thread)) continue;
    const i = st.thread.lastIndexOf("#");
    const thread = st.thread.slice(i + 1);
    out.push({
      key: st.thread,
      subject: st.thread.slice(0, i),
      thread,
      words: threadWords(thread),
      title: st.title,
      url: st.url || "/",
      repo: null,
      paper: null,
      latest: { kind: "issue_comment", words: "", at: st.at, actor: "" },
      count: 0,
      reason: "subscribed",
      reasonWords: "Saved",
      unread: false,
      done: st.done_at !== null,
      saved: true,
      expired: true,
    });
  }
  out.sort((a, b) => b.latest.at - a.latest.at);
  let settings: Record<string, unknown> = {};
  try {
    const v = JSON.parse(marks?.settings ?? "{}") as unknown;
    if (isObject(v)) settings = v;
  } catch {
    settings = {};
  }
  return { threads: out.slice(0, INBOX_THREADS), partial: partial || out.length > INBOX_THREADS, subjects: subjects.length, readBefore, settings };
}

export async function handleInbox(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: false, touch: false });
  if (s instanceof Response) return s;
  const inbox = await computeInbox(r.db, s, r.t);
  const writes = mayWrite(r.env, await linkedGithub(s.db, s.user.id));
  return json({ ...inbox, retentionDays: RETENTION_SECONDS / 86_400, can: { write: writes } });
}

// ─── the notices' states ─────────────────────────────────────────────────────

const OPS = ["read", "unread", "done", "undone", "save", "unsave", "unsubscribe", "subscribe", "all_read", "settings"] as const;
type Op = (typeof OPS)[number];

interface NoticesParsed {
  op: Op;
  threads: { key: string; title: string; url: string }[];
  settings: Record<string, unknown> | null;
}

function readSettings(v: unknown): Record<string, unknown> | ForgeProblem {
  if (!isObject(v)) return bad("The settings are not readable.");
  const out: Record<string, unknown> = {};
  for (const k of ["participating", "watching", "ownActivity"] as const) {
    if (v[k] !== undefined) {
      if (typeof v[k] !== "boolean") return bad(`“${k}” is yes or no.`);
      out[k] = v[k];
    }
  }
  if (v.filters !== undefined) {
    if (!Array.isArray(v.filters) || v.filters.length > 15) return bad("15 custom filters at most.");
    const filters: { name: string; q: string }[] = [];
    for (const f of v.filters) {
      if (!isObject(f)) return bad("A filter has a name and a query.");
      const name = cleanLine(f.name, 40);
      const q = cleanLine(f.q, 200);
      if (!name || !q) return bad("A filter has a name and a query.");
      filters.push({ name, q });
    }
    out.filters = filters;
  }
  if (v.feedHide !== undefined) {
    if (!Array.isArray(v.feedHide) || v.feedHide.length > 20 || v.feedHide.some((k) => typeof k !== "string" || !/^[a-z_]{1,30}$/.test(k))) return bad("What the feed hides is a list of event kinds.");
    out.feedHide = [...new Set(v.feedHide as string[])];
  }
  return JSON.stringify(out).length <= 4000 ? out : bad("The settings are too long.");
}

export function validateNotices(body: unknown): NoticesParsed | ForgeProblem {
  if (!isObject(body) || !(OPS as readonly unknown[]).includes(body.op)) return bad(`A change of the notifications is one of: ${OPS.join(", ")}.`);
  const op = body.op as Op;
  if (op === "all_read") return { op, threads: [], settings: null };
  if (op === "settings") {
    const settings = readSettings(body.settings);
    return settings instanceof ForgeProblem ? settings : { op, threads: [], settings };
  }
  if (!Array.isArray(body.threads) || !body.threads.length || body.threads.length > NOTICES_AT_ONCE) return bad(`Name 1 to ${NOTICES_AT_ONCE} threads.`);
  const threads: NoticesParsed["threads"] = [];
  for (const x of body.threads) {
    const t: Record<string, unknown> = isObject(x) ? x : { key: x };
    const key = readThreadKey(t.key);
    if (!key) return bad("A thread is named “<subject>#<thread>”, as the inbox gives it.");
    const url = typeof t.url === "string" && t.url.startsWith("/") && !t.url.startsWith("//") && t.url.length <= 300 && !/[\s\\]/.test(t.url) ? t.url : "";
    if (!threads.some((y) => y.key === key)) threads.push({ key, title: cleanLine(t.title, 200), url });
  }
  return { op, threads, settings: null };
}

function stateWrite(db: D1Database, userId: string, key: string, op: Op, x: { title: string; url: string }, t: number): Write {
  const at = Math.floor(t);
  const set: Record<Op, [string, unknown[]]> = {
    read: ["read_at = excluded.read_at", [at, null, 0]],
    unread: ["read_at = excluded.read_at", [0, null, 0]],
    done: ["read_at = excluded.read_at, done_at = excluded.done_at", [at, at, 0]],
    undone: ["done_at = NULL", [null, null, 0]],
    save: ["saved = 1, title = excluded.title, url = excluded.url", [null, null, 1]],
    unsave: ["saved = 0", [null, null, 0]],
    unsubscribe: ["", []],
    subscribe: ["", []],
    all_read: ["", []],
    settings: ["", []],
  };
  const [update, [readAt, doneAt, saved]] = set[op];
  return {
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO notice_state (user_id, thread, read_at, done_at, saved, title, url, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          `ON CONFLICT (user_id, thread) DO UPDATE SET ${update}, at = excluded.at`,
      )
      .bind(userId, key, readAt, doneAt, saved, op === "save" ? x.title : "", op === "save" ? x.url : "", at),
  };
}

export async function handleNotices(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  if (!(r.request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return say(bad("The request is not JSON."));
  const text = await readCapped(r.request, 32 * 1024);
  if (text === null) return say(new ForgeProblem(413, "too_large", "This request is larger than the registry reads (32 KiB)."));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return say(bad("The request is not readable."));
  }
  const p = validateNotices(body);
  if (p instanceof ForgeProblem) return say(p);
  const at = Math.floor(r.t);
  let writes: Write[];
  let subject: string;
  if (p.op === "all_read") {
    writes = [{ rows: 1, stmt: r.db.prepare("INSERT INTO notice_marks (user_id, read_before, settings, at) VALUES (?, ?, '{}', ?) ON CONFLICT (user_id) DO UPDATE SET read_before = excluded.read_before, at = excluded.at").bind(s.user.id, at, at) }];
    subject = "notices:all_read";
  } else if (p.op === "settings") {
    writes = [{ rows: 1, stmt: r.db.prepare("INSERT INTO notice_marks (user_id, read_before, settings, at) VALUES (?, 0, ?, ?) ON CONFLICT (user_id) DO UPDATE SET settings = excluded.settings, at = excluded.at").bind(s.user.id, JSON.stringify(p.settings), at) }];
    subject = "notices:settings";
  } else if (p.op === "unsubscribe" || p.op === "subscribe") {
    writes = p.threads.map((x) => followWrite(r.db, s.user.id, { target: `thread:${x.key}`, level: p.op === "unsubscribe" ? "ignore" : "all", events: [], label: x.title }, r.t));
    subject = p.threads.length === 1 ? `thread:${p.threads[0].key}` : `notices:${p.op}`;
  } else {
    writes = p.threads.map((x) => stateWrite(r.db, s.user.id, x.key, p.op, x, r.t));
    subject = p.threads.length === 1 ? `thread:${p.threads[0].key}` : `notices:${p.op}`;
  }
  const gate = await maySocial(r, s, "notice", 1 + writes.length);
  if (gate instanceof ForgeProblem) return say(gate);
  const written = await socialCommit(r, s, "notice", gate.github, writes, subject);
  return json({ ok: true, op: p.op, written, threads: p.threads.map((x) => x.key) }, 200, s.cookies);
}

// ─── the feed ────────────────────────────────────────────────────────────────

export interface FeedItem {
  at: number;
  kind: string;
  words: string;
  title: string;
  url: string;
  actor: string;
  about: string;
  via: "person" | "repository" | "paper" | "organization";
}

interface ActionLite {
  day: number;
  at: number;
  nonce: string;
  kind: string;
  forge: string;
  repo_id: string;
  subject: string;
}

/** The days' keys of the last `days` days, in lists that fit D1's 100 bound values. */
function dayRanges(t: number, days: number): number[][] {
  const today = utcDay(t);
  const all = Array.from({ length: days }, (_, i) => today - i);
  const out: number[][] = [];
  for (let i = 0; i < all.length; i += DAYS_PER_QUERY) out.push(all.slice(i, i + DAYS_PER_QUERY));
  return out;
}

function actionsOf(db: D1Database, userId: string, days: number[]): D1PreparedStatement {
  return db.prepare(`SELECT day, at, nonce, kind, forge, repo_id, subject FROM actions WHERE day IN (${days.map(() => "?").join(", ")}) AND user_id = ?`).bind(...days, userId);
}

/** What an action of a person says in the feed and on their profile, when it made no event. */
const ACTION_WORDS: Readonly<Record<string, string>> = {
  star: "starred",
  follow: "followed",
  create: "created a repository",
  generate: "created a repository from a template",
  link: "linked a repository to the registry",
  commit: "committed",
  fork: "forked a repository",
  release_create: "made a release",
  software_heritage: "asked Software Heritage to archive a repository",
  research_edit: "changed a research issue",
  package_confirm: "confirmed a package",
};
/** The kinds a person's public activity never shows (their own inbox, profile edits, lists). */
const PRIVATE_KINDS = new Set(["notice", "profile", "star_list", "release_drafts"]);

/** What a subject is, in the registry's words (never a person's label). */
function aboutOf(subject: string, alive: Map<string, RepoRow>): string {
  if (subject.startsWith("repo:")) {
    const r = alive.get(subject);
    return r ? `${r.owner_login}/${r.name}` : "";
  }
  if (subject.startsWith("paper:")) return subject.slice(10);
  if (subject.startsWith("topic:")) return subject.slice(6);
  if (subject.startsWith("orcid:")) return subject.slice(6);
  if (subject.startsWith("owner:")) return subject.split(":")[2] ?? "";
  if (/^(journal|tool|dataset|category):/.test(subject)) return subject.slice(subject.indexOf(":") + 1);
  return "";
}

/** A person's actions made public (their profile not private), with their events. */
async function publicActions(db: D1Database, userId: string, t: number, days: number): Promise<{ action: ActionLite; event: EventRow | null }[]> {
  const lists = await batchRows<ActionLite>(db, dayRanges(t, days).map((d) => actionsOf(db, userId, d)));
  const actions = lists.flat().filter((a) => !PRIVATE_KINDS.has(a.kind) && !a.subject.startsWith("thread:") && !a.subject.startsWith("notices:"));
  actions.sort((a, b) => b.at - a.at);
  const withEvents = actions.filter((a) => a.subject.startsWith("repo:") || a.subject.startsWith("paper:")).slice(0, 100);
  const events = await batchRows<EventRow>(db, withEvents.map((a) => eventByKey(db, a.subject, a.at, a.nonce)));
  const byKey = new Map(withEvents.map((a, i) => [`${a.at}:${a.nonce}`, events[i]?.[0] ?? null]));
  return actions.map((a) => ({ action: a, event: byKey.get(`${a.at}:${a.nonce}`) ?? null }));
}

export async function handleFeed(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: false, touch: false });
  if (s instanceof Response) return s;
  const me = await whoIs(s);
  const follows = (await all<FollowRow>(followsOf(r.db, s.user.id))).filter((f) => f.level !== "ignore").sort((a, b) => b.at - a.at);
  const people = follows.filter((f) => f.target.startsWith("github:") || f.target.startsWith("orcid:")).slice(0, FEED_PEOPLE);
  const since = r.t - FEED_DAYS * 86_400;
  // The people: their accounts (by identity: an author followed by ORCID iD before they had an account
  // is found once they sign in), not private, their actions of the last 14 days.
  const owners = await Promise.all(people.map((f) => identityOwner(s.db, f.target.startsWith("github:") ? "github" : "orcid", f.target.slice(f.target.indexOf(":") + 1))));
  const accounts = [...new Set(owners.filter((x): x is string => !!x && x !== s.user.id))];
  const profiles = await batchRows<ProfileRow>(r.db, accounts.map((id) => profileOf(r.db, id)));
  const open = accounts.filter((_, i) => !profiles[i]?.[0] || profiles[i][0].private !== 1);
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  const subjectsSeen: string[] = [];
  const personal = await Promise.all(open.map((id) => publicActions(r.db, id, r.t, FEED_DAYS)));
  // Their public handles (a GitHub login, else an ORCID iD): the feed names people so, never by id.
  const handles = await Promise.all(open.map(async (id) => {
    const u = await userById(s.db, id);
    return u?.github_login ?? u?.orcid ?? "";
  }));
  // The subjects followed: repositories (watched), papers, organizations' repositories.
  const { sources } = await sourcesOf(
    r.db,
    follows.filter((f) => !f.target.startsWith("thread:")),
  );
  const subjects = [...sources.keys()].slice(0, FEED_SUBJECTS);
  const eventLists = await batchRows<EventRow>(r.db, subjects.map((subject) => eventsOf(r.db, subject, since, 20)));
  for (const list of personal) for (const x of list) subjectsSeen.push(x.action.subject);
  const alive = await aliveRepos(r.db, [...new Set([...subjects, ...subjectsSeen])]);
  const nameOf = (e: EventRow) => e.actor_name || "Someone";
  personal.forEach((list, who) => {
    for (const { action, event } of list) {
      if (action.subject.startsWith("repo:") && !alive.has(action.subject)) continue;
      if (event) {
        const k = `${event.subject}|${event.at}|${event.nonce}`;
        if (seen.has(k)) continue;
        seen.add(k);
        items.push({ at: event.at, kind: event.kind, words: EVENT_WORDS[event.kind], title: event.title, url: event.url, actor: nameOf(event), about: aboutOf(event.subject, alive), via: "person" });
      } else if (ACTION_WORDS[action.kind]) {
        const about = aboutOf(action.subject, alive);
        const url = action.subject.startsWith("repo:") && about ? `/r/${about}/` : action.subject.startsWith("paper:") ? `/lookup/?doi=${encodeURIComponent(about)}` : "";
        items.push({ at: action.at, kind: action.kind, words: ACTION_WORDS[action.kind], title: "", url, actor: handles[who], about, via: "person" });
      }
    }
  });
  eventLists.forEach((list, i) => {
    const src = sources.get(subjects[i])!;
    if (subjects[i].startsWith("repo:") && !alive.has(subjects[i])) return;
    for (const e of list) {
      if ((e.actor_user && e.actor_user === s.user.id) || (me.github && e.actor_github === me.github)) continue;
      const k = `${e.subject}|${e.at}|${e.nonce}`;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({
        at: e.at,
        kind: e.kind,
        words: EVENT_WORDS[e.kind],
        title: e.title,
        url: e.url,
        actor: nameOf(e),
        about: aboutOf(e.subject, alive),
        via: src.reason === "paper" ? "paper" : src.reason === "organization" ? "organization" : "repository",
      });
    }
  });
  items.sort((a, b) => b.at - a.at);
  // What the reader follows (their own), and their settings (what the feed hides): one request a view.
  const marks = await first<{ settings: string }>(r.db.prepare("SELECT settings FROM notice_marks WHERE user_id = ?").bind(s.user.id));
  let settings: Record<string, unknown> = {};
  try {
    const v = JSON.parse(marks?.settings ?? "{}") as unknown;
    if (isObject(v)) settings = v;
  } catch {
    settings = {};
  }
  return json({
    items: items.slice(0, FEED_ITEMS),
    days: FEED_DAYS,
    following: { people: people.length, subjects: subjects.length },
    follows: follows.map((f) => ({ target: f.target, label: f.label, level: f.level })),
    settings,
  });
}

// ─── a person's activity ─────────────────────────────────────────────────────

/** The kinds the contribution calendar counts: what a person made (GitHub counts commits, issues,
 *  pull requests, reviews); stars, follows and notifications are not contributions. */
const NOT_CONTRIBUTIONS = new Set(["star", "star_list", "follow", "notice", "profile", "release_drafts"]);

export async function handleActivity(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: false, touch: false });
  if (s instanceof Response) return s;
  const q = r.url.searchParams;
  let userId: string | null = null;
  if (q.get("me") === "1") userId = s.user.id;
  else if (q.has("github") && /^[0-9]{1,20}$/.test(q.get("github") ?? "")) userId = await identityOwner(s.db, "github", q.get("github")!);
  else if (q.has("orcid")) {
    const target = readTarget(`orcid:${q.get("orcid") ?? ""}`);
    if (!target) return problemAnswer(bad("An ORCID iD is 0000-0000-0000-0000, its check digit right."));
    userId = await identityOwner(s.db, "orcid", target.slice(6));
  } else return problemAnswer(bad("A person is named by ?github=, ?orcid= or ?me=1."));
  if (!userId) return json({ account: false });
  const me = userId === s.user.id;
  const profile = profileView(await first<ProfileRow>(profileOf(r.db, userId)), r.t);
  if (profile.private && !me) return json({ account: true, private: true });
  const acts = await publicActions(r.db, userId, r.t, CALENDAR_DAYS);
  const calendar: Record<string, number> = {};
  for (const { action } of acts) {
    if (NOT_CONTRIBUTIONS.has(action.kind)) continue;
    const day = new Date(action.day * 86_400_000).toISOString().slice(0, 10);
    calendar[day] = (calendar[day] ?? 0) + 1;
  }
  const recent = acts.filter((x) => x.action.at > r.t - TIMELINE_DAYS * 86_400);
  const alive = await aliveRepos(r.db, [...new Set(recent.map((x) => x.action.subject))]);
  const timeline = recent
    .filter((x) => !(x.action.subject.startsWith("repo:") && !alive.has(x.action.subject)))
    .map(({ action, event }) =>
      event
        ? { at: event.at, kind: event.kind, words: EVENT_WORDS[event.kind], title: event.title, url: event.url, about: aboutOf(event.subject, alive) }
        : { at: action.at, kind: action.kind, words: ACTION_WORDS[action.kind] ?? "", title: "", url: action.subject.startsWith("repo:") && alive.get(action.subject) ? `/r/${aboutOf(action.subject, alive)}/` : "", about: aboutOf(action.subject, alive) },
    )
    .filter((x) => x.words)
    .slice(0, 200);
  // Milestones, in words, from what the registry knows (never an achievement badge).
  const [roles, validation] = await Promise.all([
    all<{ scope_id: string; granted_at: number }>(s.db.prepare("SELECT scope_id, granted_at FROM roles WHERE user_id = ? AND role = 'verified_author'").bind(userId)),
    first<{ created_at: number; paper_id: string; proof: string }>(s.db.prepare("SELECT created_at, paper_id, proof FROM validations WHERE user_id = ? AND status = 'deposited' ORDER BY created_at LIMIT 1").bind(userId)),
  ]);
  const earliest = (kinds: string[]) => acts.filter((x) => kinds.includes(x.action.kind)).sort((a, b) => a.action.at - b.action.at)[0]?.action ?? null;
  const milestones: { key: string; words: string; at: number | null }[] = [];
  if (roles.length) {
    const firstRole = [...roles].sort((a, b) => a.granted_at - b.granted_at)[0];
    milestones.push({ key: "paper", words: `Author of ${roles.length} ${roles.length === 1 ? "paper" : "papers"} with code in the registry (the first recognized ${new Date(firstRole.granted_at * 1000).toISOString().slice(0, 10)})`, at: firstRole.granted_at });
  }
  if (validation) milestones.push({ key: "map", words: `First tracing map validated${validation.proof === "orcid-sandbox" ? " (a test, on the sandbox)" : ""}: ${validation.paper_id.replace(/^doi:/, "")}`, at: validation.created_at });
  const linked = earliest(["create", "generate", "link"]);
  if (linked) milestones.push({ key: "repository", words: "Linked code to the registry this year", at: linked.at });
  const archived = earliest(["software_heritage"]);
  if (archived) milestones.push({ key: "archive", words: "Asked Software Heritage to archive code this year", at: archived.at });
  const research = earliest(["research_open"]);
  if (research) milestones.push({ key: "research", words: "Opened a research issue this year", at: research.at });
  return json({ account: true, me, calendar, days: CALENDAR_DAYS, timeline, milestones, reproduction: "A confirmed reproduction by someone else joins the milestones when the registry records reproductions." });
}
