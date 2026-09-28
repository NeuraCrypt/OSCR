// POST /api/forge/webhook: GitHub's deliveries for the mirror mode (the design's §8, §17; D00-2).
// Not signed in, and not gated by FORGE_OPEN: GitHub is not a person, and a delivery changes only
// what GitHub already made public.
//
// In order:
//   1. GITHUB_APP_WEBHOOK_SECRET set (503 not_configured otherwise);
//   2. the body, at most WEBHOOK_BYTES (1 MiB): a larger one is refused (413) before any hashing,
//      by its Content-Length or while it streams;
//   3. the signature, checked in constant time by the backend's codec (401);
//   4. the delivery, parsed into a forge-neutral event (no email address is ever copied: the codec
//      drops them, and this file reads ids, logins, names, branches and commit ids only);
//   5. already handled (the `deliveries` row of its id, today or the 3 days before)? 200, nothing
//      written;
//   6. every change needs a known installation (`installations`, kept by these deliveries) that
//      covers the repository's account, and a repository the registry knows (by its durable id);
//      anything else is acknowledged and dropped;
//   7. the changes, as conditional statements that write nothing when already made (the head only
//      when the push is newer: `head_at`; the others only when a value differs), in one batch.
//
// Rows (D01-24): at most 2 per delivery. A change of one row is written with its delivery row (the
// log, and the global count of the day: gate.ts). A change of two rows (a rename moves the path's
// index entry; a push to a repository with tracing maps also asks the Mac for a `push` job; a
// privatized repository loses its name) is written without a delivery row: it is idempotent by
// itself. An installation removed writes one row per repository it covered, plus one.
//
// Events: installation (created, deleted, suspend, unsuspend, new_permissions_accepted);
// installation_repositories (added: a known public repository becomes `installed`; removed: it
// falls back to `public`, read every night; private ones dropped, their names never stored); push
// to the default branch (the head; a `push` job when tracing maps point to the repository);
// repository (renamed and transferred: the path follows; archived, unarchived; deleted: `gone`;
// privatized: `hidden`, its name blanked, D00-14; edited: the default branch; publicized, created:
// nothing until a person links it); ping, ref, release, pull_request and the rest: acknowledged,
// nothing stored in phase 01. Refs under refs/pull/ are never mirrored by the registry.

import { GitBackendError } from "../errors.ts";
import type { ForgeEvent, RepoStub } from "../types.ts";
import { WEBHOOK_BYTES } from "./caps.ts";
import { json, problem } from "./http.ts";
import { all, deleteInstallation, deliveryRow, deliverySeen, installationById, repoByKey, rowsOf, statements, tracedCount, updateRepo, upsertInstallation } from "./store.ts";
import type { D1Database, D1PreparedStatement, ForgeRequest, InstallationRow, RepoRow, RepoState, Write } from "./types.ts";

/** Recent jobs a push's job is compared with (a redelivered push asks nothing twice). */
export const PUSH_JOB_TAIL = 50;

/** The body of a delivery, as bytes, capped as it streams; null when it is larger than `max`. */
export async function readBytes(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const acknowledged = (extra: Record<string, unknown> = {}) => json({ ok: true, ...extra });

/** A job for the Mac after a push, unless the same push already asked for one among the recent
 *  jobs (a redelivery): 1 row written, or none. */
function pushJob(db: D1Database, forge: string, repoId: string, sha: string, t: number): Write {
  return {
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO jobs (kind, forge, repo_id, ref, user_id, created_at, not_before) SELECT 'push', ?, ?, ?, '', ?, NULL " +
          "WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE id > (SELECT coalesce(max(id), 0) FROM jobs) - ? AND forge = ? AND repo_id = ? " +
          "AND kind = 'push' AND ref = ?)",
      )
      .bind(forge, repoId, sha, t, PUSH_JOB_TAIL, forge, repoId, sha),
  };
}

/** The repositories of one account an installation covered, falling back to `public` (repos_path's
 *  prefix: the account's own repositories, never a scan). */
function uninstalled(db: D1Database, forge: string, accountLogin: string, installationId: string, t: number): Write {
  return {
    rows: 1,
    stmt: db
      .prepare(
        "UPDATE repos SET mode = 'public', installation_id = NULL, updated_at = ? WHERE forge = ? AND owner_login = ? AND installation_id = ?",
      )
      .bind(t, forge, accountLogin.toLowerCase(), installationId),
  };
}

interface Seen {
  delivered: boolean;
  installation: InstallationRow | null;
  repo: RepoRow | null;
}

/** What the registry already knows for this delivery, in one round trip: the delivery, the
 *  installation, the repository (each by its key). */
async function known(db: D1Database, forge: string, delivery: string, installationId: string | null, repoId: string | null, t: number): Promise<Seen> {
  const reads: D1PreparedStatement[] = [deliverySeen(db, delivery, t)];
  if (installationId) reads.push(installationById(db, forge, installationId));
  if (repoId) reads.push(repoByKey(db, forge, repoId));
  const out = await db.batch(reads);
  let i = 1;
  const installation = installationId ? ((out[i++]?.results?.[0] as unknown as InstallationRow | undefined) ?? null) : null;
  const repo = repoId ? ((out[i++]?.results?.[0] as unknown as RepoRow | undefined) ?? null) : null;
  return { delivered: (out[0]?.results?.length ?? 0) > 0, installation, repo };
}

/** Whether an installation covers a repository's account (the account's id, or its login). */
const covers = (inst: InstallationRow | null, repo: RepoRow, stub: RepoStub): boolean =>
  !!inst && !inst.suspended && (inst.account_id === repo.owner_id || inst.account_login === stub.ref.owner.toLowerCase());

const ALIVE: RepoState[] = ["active", "archived"];

/** The changes one event makes, and whether its delivery row is written with them. */
interface Plan {
  writes: Write[];
  /** Why nothing is written, for the answer (and the logs). */
  dropped?: string;
}

async function plan(r: ForgeRequest, event: ForgeEvent, seen: Seen): Promise<Plan> {
  const db = r.db;
  const forge = r.backend().forge;
  const t = r.t;
  switch (event.kind) {
    case "installation": {
      const i = event.installation;
      if (event.action === "deleted") {
        if (!seen.installation) return { writes: [], dropped: "unknown installation" };
        return { writes: [uninstalled(db, forge, seen.installation.account_login, i.id, t), deleteInstallation(db, forge, i.id)] };
      }
      return {
        writes: [
          upsertInstallation(
            db,
            {
              forge,
              id: i.id,
              accountId: i.account.id,
              accountLogin: i.account.login,
              accountType: i.account.type,
              selection: i.selection,
              suspended: event.action === "suspend" ? true : event.action === "unsuspend" ? false : i.suspended,
            },
            t,
          ),
        ],
      };
    }
    case "installation_repositories": {
      if (!seen.installation || seen.installation.suspended) return { writes: [], dropped: "unknown installation" };
      const inst = seen.installation;
      // Public repositories only: a private one's name is never read further, nor stored.
      const stubs = (event.action === "added" ? event.added : event.removed).filter((s) => s.visibility === "public").slice(0, 100);
      if (!stubs.length) return { writes: [], dropped: "no public repository" };
      const rows = await all<RepoRow>(
        db.prepare(`SELECT * FROM repos WHERE forge = ? AND repo_id IN (${stubs.map(() => "?").join(", ")})`).bind(forge, ...stubs.map((s) => s.key.id)),
      );
      const writes: Write[] = [];
      for (const row of rows) {
        if (row.owner_id !== inst.account_id && row.owner_login !== inst.account_login) continue;
        if (event.action === "added") {
          if (!ALIVE.includes(row.state)) continue;
          writes.push(updateRepo(db, forge, row.repo_id, { mode: "installed", installationId: inst.id }, t, { differs: true, states: ALIVE }));
        } else if (row.installation_id === inst.id) {
          writes.push(updateRepo(db, forge, row.repo_id, { mode: "public", installationId: null }, t, { differs: true }));
        }
      }
      return writes.length ? { writes } : { writes: [], dropped: "no repository the registry knows" };
    }
    case "push": {
      const repo = seen.repo;
      if (!repo) return { writes: [], dropped: "unknown repository" };
      if (!covers(seen.installation, repo, event.repo)) return { writes: [], dropped: "unknown installation" };
      if (event.repo.visibility !== "public" || !ALIVE.includes(repo.state)) return { writes: [], dropped: "not followed" };
      const branch = event.repo.defaultBranch ?? repo.default_branch;
      if (!branch || event.ref !== `refs/heads/${branch}` || event.deleted || /^0+$/.test(event.after)) {
        return { writes: [], dropped: "not the default branch's head" };
      }
      // Older news than the head the registry has: nothing (the statement's guard says the same,
      // for a push that lands between this read and the batch).
      if (repo.head_at !== null && repo.head_at >= event.pushedAt) return { writes: [], dropped: "older news" };
      const head = updateRepo(
        db,
        forge,
        repo.repo_id,
        { head: event.after, headAt: event.pushedAt, ...(branch !== repo.default_branch ? { defaultBranch: branch } : {}) },
        t,
        { headAtBelow: event.pushedAt },
      );
      const traced = (await all<{ paths: number }>(tracedCount(db, forge, repo.repo_id)))[0]?.paths ?? 0;
      return { writes: traced > 0 ? [head, pushJob(db, forge, repo.repo_id, event.after, t)] : [head] };
    }
    case "repository": {
      const repo = seen.repo;
      if (!repo) return { writes: [], dropped: "unknown repository" };
      if (!covers(seen.installation, repo, event.repo)) return { writes: [], dropped: "unknown installation" };
      const id = repo.repo_id;
      switch (event.action) {
        case "renamed":
        case "transferred": {
          if (event.repo.visibility !== "public" || repo.state === "hidden") return { writes: [], dropped: "not followed" };
          return { writes: [updateRepo(db, forge, id, { ownerLogin: event.repo.ref.owner, name: event.repo.ref.name }, t, { differs: true })] };
        }
        case "archived":
          return { writes: [updateRepo(db, forge, id, { state: "archived" }, t, { states: ["active"] })] };
        case "unarchived":
          return { writes: [updateRepo(db, forge, id, { state: "active" }, t, { states: ["archived"] })] };
        case "deleted":
          return { writes: [updateRepo(db, forge, id, { state: "gone" }, t, { states: ["active", "archived", "pending_deletion"] })] };
        case "privatized":
          // Public repositories only (D00-14): it leaves the registry, its name blanked.
          return { writes: [updateRepo(db, forge, id, { state: "hidden", ownerLogin: "", name: "" }, t, { differs: true })] };
        case "edited": {
          const branch = event.repo.defaultBranch;
          if (!branch || branch === repo.default_branch || event.repo.visibility !== "public") return { writes: [], dropped: "nothing followed changed" };
          return { writes: [updateRepo(db, forge, id, { defaultBranch: branch }, t, { differs: true, states: ALIVE })] };
        }
        default:
          // created, publicized: nothing until a person links it.
          return { writes: [], dropped: "nothing to follow" };
      }
    }
    default:
      return { writes: [], dropped: "acknowledged" };
  }
}

/** The installation and the repository an event names (null: none). */
function subjects(event: ForgeEvent): { installation: string | null; repo: string | null } {
  switch (event.kind) {
    case "installation":
    case "installation_repositories":
      return { installation: event.installation.id, repo: null };
    case "push":
    case "repository":
      return { installation: event.installation, repo: event.repo.key.id };
    default:
      return { installation: null, repo: null };
  }
}

export async function handleWebhook(r: ForgeRequest): Promise<Response> {
  const secret = r.env.GITHUB_APP_WEBHOOK_SECRET;
  if (typeof secret !== "string" || !secret.trim()) return problem(503, "not_configured", "The GitHub App's webhooks are not set up yet.");
  const body = await readBytes(r.request, WEBHOOK_BYTES);
  if (body === null) return problem(413, "too_large", "This delivery is larger than the registry reads (1 MiB); its nightly check catches up.");
  const backend = r.backend();
  if (!(await backend.webhooks.verify(r.request.headers, body, secret))) {
    return problem(401, "bad_signature", "This delivery's signature is not the App's.");
  }
  let event: ForgeEvent;
  try {
    event = backend.webhooks.parse(r.request.headers, body);
  } catch (err) {
    if (err instanceof GitBackendError) return problem(400, "bad_delivery", "This delivery could not be read.");
    throw err;
  }
  if (event.kind === "ping" || event.kind === "other" || event.kind === "ref" || event.kind === "release" || event.kind === "pull_request") {
    return acknowledged({ stored: 0 });
  }
  const who = subjects(event);
  const seen = await known(r.db, backend.forge, event.delivery, who.installation, who.repo, r.t);
  if (seen.delivered) return acknowledged({ stored: 0, duplicate: true });
  const p = await plan(r, event, seen);
  if (!p.writes.length) return acknowledged({ stored: 0, dropped: p.dropped });
  const rows = rowsOf(p.writes);
  // A change of one row is logged with its delivery row; a larger one is idempotent by itself.
  const writes = rows <= 1 ? [...p.writes, deliveryRow(r.db, { delivery: event.delivery, t: r.t, event: event.kind, rows: rows + 1 })] : p.writes;
  const out = await r.db.batch(statements(writes));
  const written = out.reduce((n, res) => n + Number((res?.meta as { rows_written?: number } | undefined)?.rows_written ?? 0), 0);
  return acknowledged({ stored: written });
}
