// OSCR's layer in D1 `oscr_forge` (migrations/d1-forge/0001_forge.sql), as statements.
//
// Reads are prepared statements; writes are `Write`s (the statement and the rows D1 bills for it,
// index entries included), never executed here: act.ts sends an action's writes in ONE batch with
// its action row, after the forge's answer was checked, and webhook.ts a delivery's with its
// delivery row. `rows` is the most a statement writes (a guarded update may write none).
//
// Every read goes by key or by the one index (`repos_path`), never a scan (the tests' fake D1
// records the query plans: tests/forge-service/d1.ts). Owner logins and names are stored in lower
// case; the pages show GitHub's own case, read from GitHub.

import { randomToken } from "../../account/crypto.ts";
import { REDELIVERY_DAYS, utcDay } from "./caps.ts";
import type {
  RowKind,
  D1Database,
  D1PreparedStatement,
  JobKind,
  Outcome,
  PaperStatus,
  RepoMode,
  RepoRow,
  RepoState,
  Write,
} from "./types.ts";

const FORGES = new Set(["github", "memory"]);

function forgeOf(forge: string): string {
  if (!FORGES.has(forge)) throw new TypeError(`not a forge of oscr_forge: ${forge}`);
  return forge;
}

const lower = (s: string): string => s.toLowerCase();

/** An action's nonce: 16 random base64url characters (its row's key with the day, user and time). */
export function newNonce(): string {
  return randomToken(12);
}

/** The first row of a read, or null. */
export async function first<T>(stmt: D1PreparedStatement): Promise<T | null> {
  return ((await stmt.all<T>()).results[0] as T | undefined) ?? null;
}

/** Every row of a read. */
export async function all<T>(stmt: D1PreparedStatement): Promise<T[]> {
  return (await stmt.all<T>()).results;
}

/** The statements of writes, for a batch. */
export const statements = (writes: Write[]): D1PreparedStatement[] => writes.map((w) => w.stmt);

/** The rows D1 bills for writes. */
export const rowsOf = (writes: Write[]): number => writes.reduce((n, w) => n + w.rows, 0);

// ─── repositories ────────────────────────────────────────────────────────────

/** A repository by the forge's durable id (the key: 1 row read). */
export function repoByKey(db: D1Database, forge: string, repoId: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM repos WHERE forge = ? AND repo_id = ?").bind(forgeOf(forge), repoId);
}

/** A repository by its path, in any letter case (repos_path: 1 row read). A hidden repository has
 *  no path any more, so it is never found this way. */
export function repoByPath(db: D1Database, forge: string, owner: string, name: string): D1PreparedStatement {
  return db
    .prepare("SELECT * FROM repos WHERE forge = ? AND owner_login = ? AND name = ? AND state != 'hidden'")
    .bind(forgeOf(forge), lower(owner), lower(name));
}

/** The repositories OSCR knows in one account (repos_path's prefix), by name, after `after`: "Your
 *  repositories" for the reader's own GitHub login, an organization's page, an installation's
 *  account. Hidden ones are never listed. Rows read: the account's repositories up to `limit`. */
export function reposOfOwner(
  db: D1Database,
  forge: string,
  ownerLogin: string,
  opts: { after?: string; limit?: number; mode?: RepoMode; template?: boolean } = {},
): D1PreparedStatement {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 30), 1), 100);
  const where = ["forge = ?", "owner_login = ?", "name > ?", "state != 'hidden'"];
  const values: unknown[] = [forgeOf(forge), lower(ownerLogin), lower(opts.after ?? "")];
  if (opts.mode) {
    where.push("mode = ?");
    values.push(opts.mode);
  }
  if (opts.template !== undefined) {
    where.push("template = ?");
    values.push(opts.template ? 1 : 0);
  }
  return db
    .prepare(`SELECT * FROM repos WHERE ${where.join(" AND ")} ORDER BY name LIMIT ?`)
    .bind(...values, limit);
}

export interface NewRepo {
  forge: string;
  repoId: string;
  ownerId: string;
  ownerLogin: string;
  name: string;
  mode: RepoMode;
  installationId?: string | null;
  defaultBranch?: string | null;
  head?: string | null;
  headAt?: number | null;
  template?: boolean;
  linkedBy: string;
}

/** A repository OSCR now knows: its row and its repos_path entry (2 rows written). */
export function insertRepo(db: D1Database, r: NewRepo, t: number): Write {
  return {
    rows: 2,
    stmt: db
      .prepare(
        "INSERT INTO repos (forge, repo_id, owner_id, owner_login, name, mode, installation_id, default_branch, head, head_at, " +
          "template, state, delete_after, linked_by, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)",
      )
      .bind(
        forgeOf(r.forge),
        r.repoId,
        r.ownerId,
        lower(r.ownerLogin),
        lower(r.name),
        r.mode,
        r.mode === "public" ? null : (r.installationId ?? null),
        r.defaultBranch ?? null,
        r.head ?? null,
        r.headAt ?? null,
        r.template ? 1 : 0,
        r.linkedBy,
        t,
        t,
      ),
  };
}

/** What may change in a repository's row. */
export interface RepoPatch {
  ownerId?: string;
  ownerLogin?: string;
  name?: string;
  mode?: RepoMode;
  installationId?: string | null;
  defaultBranch?: string | null;
  head?: string | null;
  headAt?: number | null;
  template?: boolean;
  state?: RepoState;
  deleteAfter?: number | null;
}

const PATCH_COLUMNS: Record<keyof RepoPatch, string> = {
  ownerId: "owner_id",
  ownerLogin: "owner_login",
  name: "name",
  mode: "mode",
  installationId: "installation_id",
  defaultBranch: "default_branch",
  head: "head",
  headAt: "head_at",
  template: "template",
  state: "state",
  deleteAfter: "delete_after",
};

/** A change of a repository's row (1 row written; 2 when its path changes: the index entry moves).
 *  Guards make it conditional, in the same statement:
 *  - `headAtBelow`: only when the head seen is older (a webhook's older news is ignored);
 *  - `states`: only from these states (a restore only from pending_deletion);
 *  - `differs`: only when one of the columns set holds another value (a webhook redelivered, or a
 *    change already made, writes nothing). */
export function updateRepo(
  db: D1Database,
  forge: string,
  repoId: string,
  patch: RepoPatch,
  t: number,
  guard: { headAtBelow?: number; states?: RepoState[]; differs?: boolean } = {},
): Write {
  const sets: string[] = [];
  const values: unknown[] = [];
  const compared: { column: string; value: unknown }[] = [];
  for (const [key, value] of Object.entries(patch) as [keyof RepoPatch, unknown][]) {
    if (value === undefined) continue;
    const column = PATCH_COLUMNS[key];
    if (!column) throw new TypeError(`not a column of repos: ${String(key)}`);
    sets.push(`${column} = ?`);
    const bound = key === "ownerLogin" || key === "name" ? lower(String(value)) : key === "template" ? (value ? 1 : 0) : value;
    values.push(bound);
    compared.push({ column, value: bound });
  }
  if (!sets.length) throw new TypeError("an update of repos changes nothing");
  sets.push("updated_at = ?");
  values.push(t);
  const where = ["forge = ?", "repo_id = ?"];
  values.push(forgeOf(forge), repoId);
  if (guard.headAtBelow !== undefined) {
    where.push("(head_at IS NULL OR head_at < ?)");
    values.push(guard.headAtBelow);
  }
  if (guard.states?.length) {
    where.push(`state IN (${guard.states.map(() => "?").join(", ")})`);
    values.push(...guard.states);
  }
  if (guard.differs) {
    where.push(`(${compared.map((c) => `${c.column} IS NOT ?`).join(" OR ")})`);
    values.push(...compared.map((c) => c.value));
  }
  const moves = patch.ownerLogin !== undefined || patch.name !== undefined;
  return { rows: moves ? 2 : 1, stmt: db.prepare(`UPDATE repos SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`).bind(...values) };
}

// ─── papers ──────────────────────────────────────────────────────────────────

/** The papers a repository is attached to (the key's prefix). */
export function papersOf(db: D1Database, forge: string, repoId: string): D1PreparedStatement {
  return db
    .prepare("SELECT paper_id, status, by_user, at FROM repo_papers WHERE forge = ? AND repo_id = ? ORDER BY paper_id")
    .bind(forgeOf(forge), repoId);
}

/** Papers attached to a repository (1 row written each); attaching one again updates its status. */
export function linkPapers(
  db: D1Database,
  forge: string,
  repoId: string,
  papers: { paperId: string; status: PaperStatus }[],
  byUser: string,
  t: number,
): Write[] {
  return papers.map((p) => ({
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO repo_papers (forge, repo_id, paper_id, status, by_user, at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (forge, repo_id, paper_id) DO UPDATE SET status = excluded.status, by_user = excluded.by_user, at = excluded.at",
      )
      .bind(forgeOf(forge), repoId, lower(p.paperId), p.status, byUser, t),
  }));
}

/** A paper detached from a repository (1 row written). */
export function unlinkPaper(db: D1Database, forge: string, repoId: string, paperId: string): Write {
  return {
    rows: 1,
    stmt: db.prepare("DELETE FROM repo_papers WHERE forge = ? AND repo_id = ? AND paper_id = ?").bind(forgeOf(forge), repoId, lower(paperId)),
  };
}

/** How many paths and maps (papers) point to a repository: what its deletion page shows (the key's
 *  prefix of traced_paths). Answers { paths, maps }. */
export function tracedCount(db: D1Database, forge: string, repoId: string): D1PreparedStatement {
  return db
    .prepare("SELECT count(*) AS paths, count(DISTINCT paper_id) AS maps FROM traced_paths WHERE forge = ? AND repo_id = ?")
    .bind(forgeOf(forge), repoId);
}

// ─── installations ───────────────────────────────────────────────────────────

export function installationById(db: D1Database, forge: string, id: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM installations WHERE forge = ? AND id = ?").bind(forgeOf(forge), id);
}

/** An installation as its latest webhook says (1 row written). */
export function upsertInstallation(
  db: D1Database,
  i: { forge: string; id: string; accountId: string; accountLogin: string; accountType: "user" | "organization"; selection: "all" | "selected"; suspended: boolean },
  t: number,
): Write {
  return {
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO installations (forge, id, account_id, account_login, account_type, selection, suspended, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (forge, id) DO UPDATE SET account_id = excluded.account_id, " +
          "account_login = excluded.account_login, account_type = excluded.account_type, selection = excluded.selection, " +
          "suspended = excluded.suspended, updated_at = excluded.updated_at",
      )
      .bind(forgeOf(i.forge), i.id, i.accountId, lower(i.accountLogin), i.accountType, i.selection, i.suspended ? 1 : 0, t),
  };
}

/** An installation removed from its account (1 row written). Its repositories are found by the
 *  account's prefix of repos_path (reposOfOwner) and fall back to mode 'public'. */
export function deleteInstallation(db: D1Database, forge: string, id: string): Write {
  return { rows: 1, stmt: db.prepare("DELETE FROM installations WHERE forge = ? AND id = ?").bind(forgeOf(forge), id) };
}

// ─── jobs for the Mac ────────────────────────────────────────────────────────

/** A job for the Mac (1 row written). */
export function insertJob(
  db: D1Database,
  job: {
    kind: JobKind;
    forge: string;
    repoId: string;
    ref?: string;
    userId?: string;
    notBefore?: number | null;
    paperId?: string;
    /** A deposit's: the ORCID the author signed in with (phase 07). */
    proof?: "orcid" | "orcid-sandbox";
  },
  t: number,
): Write {
  if (job.kind === "delete_due" && (job.notBefore === undefined || job.notBefore === null)) throw new TypeError("a delete_due job needs not_before");
  if ((job.kind === "release" || job.kind === "deposit") && (!job.ref || !job.paperId)) throw new TypeError(`a ${job.kind} job needs its tag and its paper`);
  if ((job.kind === "deposit") !== Boolean(job.proof)) throw new TypeError("a deposit job, and only it, says which ORCID the author signed in with");
  return {
    rows: 1,
    stmt: db
      .prepare("INSERT INTO jobs (kind, forge, repo_id, ref, user_id, created_at, not_before, paper_id, proof) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(job.kind, forgeOf(job.forge), job.repoId, job.ref ?? "", job.userId ?? "", t, job.notBefore ?? null, job.paperId ?? "", job.proof ?? ""),
  };
}

// ─── releases tied to a paper's version (phase 07) ───────────────────────────

/** A release tied to a version of a paper (migrations/d1-forge/0006_releases.sql). */
export interface ReleasePaperRow {
  forge: string;
  repo_id: string;
  tag: string;
  paper_id: string;
  release_id: string;
  repo_path: string;
  version: string;
  label: string;
  commit_sha: string;
  map_digest: string;
  status: PaperStatus;
  by_user: string;
  at: number;
}

/** A repository's ties, by the key's prefix (no index), in the order of their tags. */
export function releasePapersOf(db: D1Database, forge: string, repoId: string, tag?: string): D1PreparedStatement {
  if (tag === undefined) {
    return db.prepare("SELECT * FROM release_papers WHERE forge = ? AND repo_id = ? ORDER BY tag, paper_id LIMIT 500").bind(forgeOf(forge), repoId);
  }
  return db.prepare("SELECT * FROM release_papers WHERE forge = ? AND repo_id = ? AND tag = ? ORDER BY paper_id").bind(forgeOf(forge), repoId, tag);
}

/** A release tied to a paper's version, or the tie changed (1 row: the table is its key). */
export function upsertReleasePaper(
  db: D1Database,
  r: { forge: string; repoId: string; tag: string; paperId: string; releaseId: string; repoPath: string; version: string; label: string; commit: string; mapDigest: string; status: PaperStatus; userId: string },
  t: number,
): Write {
  return {
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO release_papers (forge, repo_id, tag, paper_id, release_id, repo_path, version, label, commit_sha, map_digest, status, by_user, at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (forge, repo_id, tag, paper_id) DO UPDATE SET release_id = excluded.release_id, " +
          "repo_path = excluded.repo_path, version = excluded.version, label = excluded.label, commit_sha = excluded.commit_sha, " +
          "map_digest = excluded.map_digest, status = excluded.status, by_user = excluded.by_user, at = excluded.at",
      )
      .bind(forgeOf(r.forge), r.repoId, r.tag, r.paperId, r.releaseId, lower(r.repoPath), r.version, r.label, r.commit, r.mapDigest, r.status, r.userId, Math.floor(t)),
  };
}

/** A tie undone (1 row). */
export function deleteReleasePaper(db: D1Database, forge: string, repoId: string, tag: string, paperId: string): Write {
  return {
    rows: 1,
    stmt: db.prepare("DELETE FROM release_papers WHERE forge = ? AND repo_id = ? AND tag = ? AND paper_id = ?").bind(forgeOf(forge), repoId, tag, paperId),
  };
}

/** The jobs of a repository the Mac has not answered yet, among the table's last `tail` rows (a
 *  bounded tail of the rowid: the Mac answers within minutes, so older ones are done). */
export function pendingJobsOf(db: D1Database, forge: string, repoId: string, tail = 50): D1PreparedStatement {
  return db
    .prepare(
      "SELECT id, kind, ref, created_at, not_before FROM jobs WHERE id > (SELECT coalesce(max(id), 0) FROM jobs) - ? " +
        "AND forge = ? AND repo_id = ? AND done_at IS NULL ORDER BY id",
    )
    .bind(Math.max(1, Math.floor(tail)), forgeOf(forge), repoId);
}

/** A repository's jobs of these kinds among the table's last `tail` rows, answered or not, the newest
 *  first (phase 07: the release page says what the Mac did, in its own words). */
export function recentJobsOf(db: D1Database, forge: string, repoId: string, kinds: readonly JobKind[], tail = 50): D1PreparedStatement {
  return db
    .prepare(
      "SELECT id, kind, ref, paper_id, created_at, done_at, outcome, message FROM jobs WHERE id > (SELECT coalesce(max(id), 0) FROM jobs) - ? " +
        `AND forge = ? AND repo_id = ? AND kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY id DESC`,
    )
    .bind(Math.max(1, Math.floor(tail)), forgeOf(forge), repoId, ...kinds);
}

// ─── the logs: actions and deliveries ────────────────────────────────────────

/** The row of an authorized action (1 row written): the audit, and what the daily caps count.
 *  `rows` is every row the action wrote, this one included. */
export function actionRow(
  db: D1Database,
  a: { userId: string; t: number; nonce: string; kind: RowKind; forge?: string; repoId?: string; githubUser?: string; outcome: Outcome; rows: number; subject?: string },
): Write {
  return {
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO actions (day, user_id, at, nonce, kind, forge, repo_id, github_user, outcome, rows, subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(utcDay(a.t), a.userId, Math.floor(a.t), a.nonce, a.kind, a.forge ?? "", a.repoId ?? "", a.githubUser ?? "", a.outcome, a.rows, (a.subject ?? "").slice(0, 342)),
  };
}

/** The row of a webhook delivery handled (1 row written); `rows` counts it with its changes. */
export function deliveryRow(db: D1Database, d: { delivery: string; t: number; event: string; rows: number }): Write {
  return {
    rows: 1,
    stmt: db
      .prepare("INSERT INTO deliveries (day, delivery, at, event, rows) VALUES (?, ?, ?, ?, ?)")
      .bind(utcDay(d.t), d.delivery, Math.floor(d.t), d.event.slice(0, 40), d.rows),
  };
}

/** Whether a delivery was already handled: (day, delivery) for today and the redelivery window's
 *  days before (4 key probes). Answers a row when it was. */
export function deliverySeen(db: D1Database, delivery: string, t: number): D1PreparedStatement {
  const today = utcDay(t);
  const days = Array.from({ length: REDELIVERY_DAYS + 1 }, (_, i) => today - i);
  return db
    .prepare(`SELECT day, at FROM deliveries WHERE day IN (${days.map(() => "?").join(", ")}) AND delivery = ? LIMIT 1`)
    .bind(...days, delivery);
}

// ─── phase 11: security and quality facts (the Mac writes them; the service reads them) ──────────

/** A repository's dependency graph (repo_deps), by the key's prefix (forge, repo_id): a key range,
 *  never a scan. Both snapshots (default and cited), ordered for the view. */
export function depsOf(db: D1Database, forge: string, repoId: string): D1PreparedStatement {
  return db
    .prepare("SELECT snapshot, ecosystem, name, version, req, scope, direct, pinned, sources, commit_sha FROM repo_deps "
      + "WHERE forge = ? AND repo_id = ? ORDER BY snapshot, ecosystem, name")
    .bind(forgeOf(forge), repoId);
}

/** A repository's security alerts (security_alerts), by the key's prefix (forge, repo_id): a key
 *  range, never a scan. OSV, secret and SARIF alerts together, the worst severity first. */
export function alertsOf(db: D1Database, forge: string, repoId: string): D1PreparedStatement {
  return db
    .prepare("SELECT kind, ref, severity, summary, detail, ecosystem, package, version, advisory, path, line, dev_scope, commit_sha, source, found_at "
      + "FROM security_alerts WHERE forge = ? AND repo_id = ? ORDER BY kind, ref")
    .bind(forgeOf(forge), repoId);
}

/** A repository's alert triage (the human decisions), by the key's prefix: a key range. */
export function triageOf(db: D1Database, forge: string, repoId: string): D1PreparedStatement {
  return db
    .prepare("SELECT kind, ref, state, reason, assignee, note, labels FROM alert_triage WHERE forge = ? AND repo_id = ?")
    .bind(forgeOf(forge), repoId);
}

/** One alert's finding row (to check it exists before triaging it: the key, 1 row). */
export function alertByRef(db: D1Database, forge: string, repoId: string, kind: string, ref: string): D1PreparedStatement {
  return db.prepare("SELECT kind, ref FROM security_alerts WHERE forge = ? AND repo_id = ? AND kind = ? AND ref = ?")
    .bind(forgeOf(forge), repoId, kind, ref);
}

/** Set a human decision on an alert (upsert by its key). */
export function triageWrite(
  db: D1Database,
  t: { forge: string; repoId: string; kind: string; ref: string; state: string; reason: string; assignee: string; note: string; labels: string[]; byUser: string; at: number },
): Write {
  return {
    rows: 1,
    stmt: db
      .prepare("INSERT INTO alert_triage (forge, repo_id, kind, ref, state, reason, assignee, note, labels, by_user, updated_at) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (forge, repo_id, kind, ref) DO UPDATE SET "
        + "state = excluded.state, reason = excluded.reason, assignee = excluded.assignee, note = excluded.note, labels = excluded.labels, by_user = excluded.by_user, updated_at = excluded.updated_at")
      .bind(forgeOf(t.forge), t.repoId, t.kind, t.ref, t.state, t.reason, t.assignee.slice(0, 100), t.note.slice(0, 2000), JSON.stringify(t.labels).slice(0, 300), t.byUser, Math.floor(t.at)),
  };
}

export type { RepoRow };
