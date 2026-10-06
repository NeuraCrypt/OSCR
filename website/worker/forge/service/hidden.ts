// What is hidden (night phase 16): the reads of the `moderation` table (migrations/d1-forge/0010),
// shared by every route that shows something of the GitHub side — the research issues and their
// comments, people's profiles, the inbox, the feed and a person's activity, the repository's layer,
// the outgoing webhooks, the search, the public API — so that hidden content is absent from every
// answer the Worker gives. The Mac drops the same things from the static files (oscr/moderation.py).
//
// Every read goes by the key (kind, ref): a point lookup, or `IN` over at most CHUNK keys, or a
// comment range of one issue ("<n>#…"). Only rows in state 'hidden' count; a restored row is kept for
// the record and the notices.

import { REASON_WORDS, type HiddenKind, type HideReason } from "./moderation-core.ts";
import { all, first } from "./store.ts";
import { ForgeProblem, type D1Database } from "./types.ts";

export interface HiddenRow {
  kind: HiddenKind;
  /** The row's reference (the migration's `ref`): a users.id, "github:5", "3#2"… */
  ref: string;
  target: string;
  label: string;
  state: "hidden" | "restored";
  reason: HideReason;
  notice: string;
  message: string;
  owner_user: string;
  by_whom: "owner" | "moderator" | "registry";
  report_id: number | null;
  appeal: "" | "open" | "accepted" | "rejected";
  appeal_kind: "" | "appeal" | "counter_notice";
  appeal_text: string;
  appeal_at: number | null;
  created_at: number;
  updated_at: number;
}

/** D1 binds at most 100 values a statement. */
const CHUNK = 90;

/** The row of one thing, whatever its state (null: never moderated). */
export function moderationRow(db: D1Database, kind: HiddenKind, key: string): Promise<HiddenRow | null> {
  return first<HiddenRow>(db.prepare("SELECT * FROM moderation WHERE kind = ? AND ref = ?").bind(kind, key));
}

/** The row of one thing when it is hidden now. */
export async function hiddenOne(db: D1Database, kind: HiddenKind, key: string): Promise<HiddenRow | null> {
  const row = await moderationRow(db, kind, key);
  return row && row.state === "hidden" ? row : null;
}

/** The hidden things among these keys of one kind, by key. */
export async function hiddenAmong(db: D1Database, kind: HiddenKind, keys: Iterable<string>): Promise<Map<string, HiddenRow>> {
  const list = [...new Set([...keys].filter((k) => typeof k === "string" && k.length > 0))];
  const out = new Map<string, HiddenRow>();
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const rows = await all<HiddenRow>(
      db.prepare(`SELECT * FROM moderation WHERE kind = ? AND ref IN (${part.map(() => "?").join(", ")}) AND state = 'hidden'`).bind(kind, ...part),
    );
    for (const r of rows) out.set(r.ref, r);
  }
  return out;
}

/** The hidden comments of one research issue, by their number (one key range). */
export async function hiddenCommentsOf(db: D1Database, issueId: number): Promise<Map<number, HiddenRow>> {
  const rows = await all<HiddenRow>(
    db.prepare("SELECT * FROM moderation WHERE kind = 'comment' AND ref >= ? AND ref < ? AND state = 'hidden'").bind(`${issueId}#`, `${issueId}$`),
  );
  return new Map(rows.map((r) => [Number(r.ref.slice(r.ref.indexOf("#") + 1)), r]));
}

/** A hidden account (suspended), by its users.id. */
export const accountHidden = (db: D1Database, userId: string): Promise<HiddenRow | null> => (userId ? hiddenOne(db, "account", userId) : Promise.resolve(null));

/** The accounts and GitHub accounts hidden among an answer's actors (events, comments, issues). */
export async function hiddenActors(db: D1Database, actors: Iterable<{ user?: string; github?: string }>): Promise<{ users: Set<string>; github: Set<string> }> {
  const list = [...actors];
  const [users, github] = await Promise.all([
    hiddenAmong(db, "account", list.map((a) => a.user ?? "")),
    hiddenAmong(db, "github", list.map((a) => a.github ?? "")),
  ]);
  return { users: new Set(users.keys()), github: new Set(github.keys()) };
}

/** What an answer says of a hidden thing: the reason in words, the public notice, since when. Never
 *  who reported it, never the hidden words. */
export function moderationView(row: Pick<HiddenRow, "reason" | "notice" | "created_at" | "appeal">): { reason: HideReason; words: string; notice: string; since: number; appeal: string } {
  return { reason: row.reason, words: REASON_WORDS[row.reason], notice: row.notice, since: row.created_at, appeal: row.appeal };
}

/** The answer to a write from a suspended account (every write but an appeal and a data-rights request). */
export function suspended(row: HiddenRow): ForgeProblem {
  return new ForgeProblem(
    403,
    "suspended",
    `Your account is suspended (${REASON_WORDS[row.reason]}): it cannot write in the registry. Your page “What of mine is hidden” (/account/moderation/) says why, and lets you appeal.`,
    { appeal: "/account/moderation/" },
  );
}

/** What an event names: its subject, its thread, its actor (events.ts EventRow's fields). */
export interface EventLike {
  subject: string;
  thread: string;
  actor_user: string;
  actor_github: string;
}

/** The moderation key of an event's thread, when it is one the owner can hide: a research issue, a
 *  GitHub issue, pull request or release on a repository. */
function threadKey(e: Pick<EventLike, "subject" | "thread">): { kind: HiddenKind; key: string } | null {
  let m = /^research:([1-9][0-9]{0,9})$/.exec(e.thread);
  if (m) return { kind: "research", key: m[1] };
  const repo = /^repo:(github|memory):([0-9]+)$/.exec(e.subject);
  if (!repo) return null;
  m = /^(issue|pull):([1-9][0-9]{0,9})$/.exec(e.thread);
  if (m) return { kind: m[1] as "issue" | "pull", key: `${repo[1]}:${repo[2]}#${m[2]}` };
  m = /^release:(.+)$/s.exec(e.thread);
  return m ? { kind: "release", key: `${repo[1]}:${repo[2]}/${m[1]}` } : null;
}

/** Which of these events an answer must leave out: an actor suspended (their account, or their GitHub
 *  account's events), a repository hidden, a thread hidden. Up to five reads, by key. `blocked` adds the
 *  reader's own blocks (E2): their events leave the reader's inbox and feed. */
export async function hiddenEventFilter(
  db: D1Database,
  events: readonly EventLike[],
  blocked: { users: ReadonlySet<string>; github: ReadonlySet<string> } = { users: new Set(), github: new Set() },
): Promise<(e: EventLike) => boolean> {
  if (!events.length) return () => false;
  const actors = await hiddenActors(db, events.map((e) => ({ user: e.actor_user, github: e.actor_github })));
  const repos = await hiddenAmong(db, "repo", events.map((e) => /^repo:((?:github|memory):[0-9]+)$/.exec(e.subject)?.[1] ?? ""));
  const threads = new Map<HiddenKind, Set<string>>();
  for (const e of events) {
    const k = threadKey(e);
    if (k) threads.set(k.kind, (threads.get(k.kind) ?? new Set()).add(k.key));
  }
  const hiddenThreads = new Set<string>();
  for (const [kind, keys] of threads) for (const key of (await hiddenAmong(db, kind, keys)).keys()) hiddenThreads.add(`${kind}|${key}`);
  return (e) => {
    if (e.actor_user && (actors.users.has(e.actor_user) || blocked.users.has(e.actor_user))) return true;
    if (e.actor_github && (actors.github.has(e.actor_github) || blocked.github.has(e.actor_github))) return true;
    const repo = /^repo:((?:github|memory):[0-9]+)$/.exec(e.subject)?.[1];
    if (repo && repos.has(repo)) return true;
    const k = threadKey(e);
    return !!k && hiddenThreads.has(`${k.kind}|${k.key}`);
  };
}

/** A repository's GitHub issues, pull requests and releases hidden from the registry's pages, as
 *  "issue:3", "pull:7", "release:v1.0" → the reason in words (two key ranges: "<repo>#…", "<repo>/…"). */
export async function hiddenThreadsOf(db: D1Database, forge: string, repoId: string): Promise<Record<string, string>> {
  const ref = `${forge}:${repoId}`;
  const [threads, releases] = await Promise.all([
    all<HiddenRow>(db.prepare("SELECT kind, ref, reason FROM moderation WHERE kind IN ('issue', 'pull') AND ref >= ? AND ref < ? AND state = 'hidden'").bind(`${ref}#`, `${ref}$`)),
    all<HiddenRow>(db.prepare("SELECT kind, ref, reason FROM moderation WHERE kind = 'release' AND ref >= ? AND ref < ? AND state = 'hidden'").bind(`${ref}/`, `${ref}0`)),
  ]);
  const out: Record<string, string> = {};
  for (const r of threads) out[`${r.kind}:${r.ref.slice(ref.length + 1)}`] = REASON_WORDS[r.reason];
  for (const r of releases) out[`release:${r.ref.slice(ref.length + 1)}`] = REASON_WORDS[r.reason];
  return out;
}
