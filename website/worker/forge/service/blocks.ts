// Blocks and interaction limits (night phase 16, E2; docs/MODERATION.md "Blocking", "Interaction
// limits"). The rows are migrations/d1-forge/0010_moderation.sql's; the words, moderation-core.ts.
//
//   GET  /api/forge/blocks          signed in  the reader's blocked people (ref, label, note, date) and
//                                              their account-wide interaction limit
//   POST /api/forge/blocks/write    signed in  block ({target, on: true, note}) or unblock ({ref|target,
//                                              on: false}): 2 rows
//   GET  /api/forge/limits          signed in  a repository's limit (?repo=<forge>:<id>) and whether the
//                                              reader manages it
//   POST /api/forge/limits/write    signed in  set or lift a limit on a repository the reader manages, or
//                                              on every repository they manage: 2 rows
//
// A block is silent: the blocked person is never told, and the refusals they meet say only that they
// cannot take part. What it does (mayInteract below, and the inbox and feed through hidden.ts):
// the blocked person cannot comment on, react to, or open issues or pull requests in the blocker's
// repositories (those they manage in the registry), nor comment on the blocker's research issues, nor
// follow the blocker; the blocker no longer sees their events, mentions included. What it does not do:
// hide what the blocked person already wrote from others (that is a report), nor stop them from reading
// public pages, nor anything on GitHub itself (GitHub's own block is the person's, on GitHub).

import type { SignedIn } from "../../account/guard.ts";
import { identityOwner, userById } from "../../account/store.ts";
import { dailyCaps, globalCap, mayWrite, closed, overCap } from "./gate.ts";
import { readCapped } from "./flow.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import {
  BLOCKS_MAX,
  LIMIT_RANK,
  LIMIT_WORDS,
  MODERATION_BODY_BYTES,
  NEW_ACCOUNT_SECONDS,
  personOfTarget,
  researchOfTarget,
  validateBlock,
  validateLimit,
  type LimitLevel,
} from "./moderation-core.ts";
import { isOwner } from "./moderation.ts";
import { communityRepoKey } from "./papers.ts";
import { issueById } from "./research-core.ts";
import { actionRow, all, first, newNonce, repoByKey, rowsOf, statements } from "./store.ts";
import { who } from "./who.ts";
import { ForgeProblem, type D1Database, type ForgeRequest, type RepoRow, type Write } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);

/** The refusal a blocked person meets: it says they cannot take part, never who blocked them. */
export const BLOCKED_MESSAGE = "You cannot take part in this conversation or this repository.";
export const blockedProblem = () => new ForgeProblem(403, "blocked", BLOCKED_MESSAGE);

/** The authorized actions a block or an interaction limit refuses on a repository: opening, commenting,
 *  reacting, reviewing (GitHub's list of what interaction limits cover). */
export const INTERACTION_KINDS: ReadonlySet<string> = new Set([
  "issue_open", "issue_comment", "issue_react", "pull_open", "pull_comment", "pull_review", "pull_thread",
]);

// ─── reads ───────────────────────────────────────────────────────────────────

/** The people who manage a repository in the registry: who linked or created it, and the account whose
 *  GitHub id owns it (the identities' key). */
export async function managersOf(community: D1Database, repo: Pick<RepoRow, "linked_by" | "owner_id">): Promise<Set<string>> {
  const out = new Set<string>();
  if (repo.linked_by) out.add(repo.linked_by);
  if (repo.owner_id && /^\d{1,20}$/.test(repo.owner_id)) {
    const owner = await identityOwner(community, "github", repo.owner_id);
    if (owner) out.add(owner);
  }
  return out;
}

/** Whether any of `blockers` blocked `actor` (point lookups by the key). */
export async function blockedByAny(db: D1Database, blockers: Iterable<string>, actor: string): Promise<boolean> {
  const list = [...new Set([...blockers].filter((b) => b && b !== actor))].slice(0, 20);
  if (!list.length) return false;
  const row = await first(db.prepare(`SELECT 1 AS x FROM blocks WHERE user_id IN (${list.map(() => "?").join(", ")}) AND blocked = ? LIMIT 1`).bind(...list, actor));
  return !!row;
}

interface LimitRow {
  scope: string;
  level: LimitLevel;
  until: number;
  by_user: string;
  at: number;
}

/** The limit in force on a repository: the stricter of its own and its managers' accounts' (key reads). */
export async function limitOn(db: D1Database, repo: Pick<RepoRow, "forge" | "repo_id">, managers: Set<string>, t: number): Promise<LimitRow | null> {
  const scopes = [`repo:${repo.forge}:${repo.repo_id}`, ...[...managers].slice(0, 5).map((m) => `account:${m}`)];
  const rows = await all<LimitRow>(db.prepare(`SELECT * FROM interaction_limits WHERE scope IN (${scopes.map(() => "?").join(", ")}) AND until > ?`).bind(...scopes, Math.floor(t)));
  return rows.sort((a, b) => LIMIT_RANK[b.level] - LIMIT_RANK[a.level] || b.until - a.until)[0] ?? null;
}

/** Whether the reader is a contributor of the repository in the registry's sense: a verified author of
 *  one of its papers, a maintainer of its code (oscr_community roles, the reader's own rows). */
async function contributes(r: ForgeRequest, s: SignedIn, repo: RepoRow): Promise<boolean> {
  const [roles, papers] = await Promise.all([
    all<{ role: string; scope_kind: string; scope_id: string }>(s.db.prepare("SELECT role, scope_kind, scope_id FROM roles WHERE user_id = ?").bind(s.user.id)),
    all<{ paper_id: string }>(r.db.prepare("SELECT paper_id FROM repo_papers WHERE forge = ? AND repo_id = ?").bind(repo.forge, repo.repo_id)),
  ]);
  const key = repo.name && (repo.forge === "github" || repo.forge === "memory") ? communityRepoKey(repo.forge, repo.owner_login, repo.name) : "";
  const linked = new Set(papers.map((p) => p.paper_id.toLowerCase()));
  return roles.some((x) => (x.role === "verified_author" && x.scope_kind === "paper" && linked.has(x.scope_id.toLowerCase())) || (x.role === "maintainer" && x.scope_kind === "repo" && x.scope_id.toLowerCase() === key));
}

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Whether the reader may interact here: on a repository (its managers' blocks and limits), with the
 *  people in `also` (a research issue's author: their blocks). null: they may. The registry's owner and
 *  the repository's managers always may. */
export async function mayInteract(r: ForgeRequest, s: SignedIn, x: { repo: RepoRow | null; also?: string[] }): Promise<ForgeProblem | null> {
  const managers = x.repo ? await managersOf(s.db, x.repo) : new Set<string>();
  if (managers.has(s.user.id) || (await isOwner(r, s))) return null;
  if (await blockedByAny(r.db, [...managers, ...(x.also ?? [])], s.user.id)) return blockedProblem();
  if (!x.repo) return null;
  const limit = await limitOn(r.db, x.repo, managers, r.t);
  if (!limit) return null;
  const refused = (why: string) => new ForgeProblem(403, "limited", `This repository limits interactions to ${LIMIT_WORDS[limit.level]} until ${dayOf(limit.until)}: ${why}`, { until: limit.until });
  if (limit.level === "managers") return refused("you do not manage it.");
  if (limit.level === "existing_users") return s.user.created_at > Math.floor(r.t) - NEW_ACCOUNT_SECONDS ? refused("your account is newer than that.") : null;
  return (await contributes(r, s, x.repo)) ? null : refused("you are not among them.");
}

// ─── the routes ──────────────────────────────────────────────────────────────

async function readBody(r: ForgeRequest): Promise<unknown | ForgeProblem> {
  if (!(r.request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return bad("The request is not JSON.");
  const text = await readCapped(r.request, MODERATION_BODY_BYTES);
  if (text === null) return new ForgeProblem(413, "too_large", "This request is too large.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return bad("The request is not readable.");
  }
}

/** FORGE_OPEN, the caps and the day's rows for one of these writes. */
async function mayRule(r: ForgeRequest, s: SignedIn, kind: "block" | "limit", rows: number): Promise<ForgeProblem | { github: string }> {
  const github = await linkedGithub(s.db, s.user.id);
  if (!mayWrite(r.env, github)) return closed();
  const caps = await dailyCaps(r.db, s.user.id, kind, r.t);
  if (caps.exceeded) return overCap(caps.exceeded);
  return (await globalCap(r.db, r.t, rows)) ?? { github: github ?? "" };
}

interface BlockRowView {
  ref: string;
  label: string;
  note: string;
  at: number;
}

export async function handleBlocks(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const [blocks, limit] = await Promise.all([
    all<BlockRowView>(r.db.prepare("SELECT ref, label, note, at FROM blocks WHERE user_id = ? ORDER BY at DESC LIMIT ?").bind(s.user.id, BLOCKS_MAX)),
    first<LimitRow>(r.db.prepare("SELECT * FROM interaction_limits WHERE scope = ? AND until > ?").bind(`account:${s.user.id}`, Math.floor(r.t))),
  ]);
  return json({
    blocks,
    limit: limit ? { level: limit.level, words: LIMIT_WORDS[limit.level], until: limit.until } : null,
    can: { write: mayWrite(r.env, await linkedGithub(s.db, s.user.id)) },
  });
}

/** Who a block's target names: a person by their handle, or the author of a research issue or comment. */
async function blockedOf(r: ForgeRequest, s: SignedIn, target: string): Promise<{ id: string; ref: string; label: string; github: string } | ForgeProblem> {
  let userId: string | null = null;
  const person = personOfTarget(target);
  if (person) userId = await identityOwner(s.db, person.provider, person.subject);
  else {
    const ref = researchOfTarget(target);
    if (ref) {
      const row = ref.comment === null
        ? await first<{ author_id: string }>(issueById(r.db, ref.id))
        : await first<{ author_id: string }>(r.db.prepare("SELECT author_id FROM research_comments WHERE issue_id = ? AND n = ?").bind(ref.id, ref.comment));
      userId = row?.author_id ?? null;
    }
  }
  const user = userId ? await userById(s.db, userId) : null;
  if (!user) return new ForgeProblem(404, "not_found", "The registry has no account by that name.");
  const github = (await linkedGithub(s.db, user.id)) ?? "";
  const ref = github ? `github:${github}` : user.orcid ? `orcid:${user.orcid}` : `anon:${newNonce().slice(0, 20)}`;
  const label = (user.github_login ?? user.orcid ?? (user.display_name || "a reader")).replace(/[@＠]/g, " ").slice(0, 100) || "a reader";
  return { id: user.id, ref, label, github };
}

export async function handleBlockWrite(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readBody(r);
  if (body instanceof ForgeProblem) return say(body);
  const ref = (body as { ref?: unknown })?.ref;
  let writes: Write[];
  if ((body as { on?: unknown })?.on === false && typeof ref === "string" && /^(?:github:\d{1,20}|orcid:[\dX-]{19}|anon:[A-Za-z0-9_-]{8,30})$/.test(ref)) {
    writes = [{ rows: 1, stmt: r.db.prepare("DELETE FROM blocks WHERE user_id = ? AND ref = ?").bind(s.user.id, ref) }];
  } else {
    const p = validateBlock(body);
    if (p instanceof ForgeProblem) return say(p);
    const b = await blockedOf(r, s, p.target.target);
    if (b instanceof ForgeProblem) return say(b);
    if (b.id === s.user.id) return say(bad("You cannot block yourself."));
    if (p.on) {
      const count = await all<{ x: number }>(r.db.prepare("SELECT 1 AS x FROM blocks WHERE user_id = ? LIMIT ?").bind(s.user.id, BLOCKS_MAX));
      if (count.length >= BLOCKS_MAX) return say(new ForgeProblem(409, "too_many_blocks", `An account keeps ${BLOCKS_MAX.toLocaleString("en-GB")} blocks at most: unblock someone first.`));
      writes = [{
        rows: 1,
        stmt: r.db
          .prepare("INSERT INTO blocks (user_id, blocked, ref, blocked_github, label, note, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, blocked) DO UPDATE SET note = excluded.note")
          .bind(s.user.id, b.id, b.ref, b.github, b.label, p.note, Math.floor(r.t)),
      }];
    } else writes = [{ rows: 1, stmt: r.db.prepare("DELETE FROM blocks WHERE user_id = ? AND blocked = ?").bind(s.user.id, b.id) }];
  }
  const gate = await mayRule(r, s, "block", 1 + rowsOf(writes));
  if (gate instanceof ForgeProblem) return say(gate);
  // The action row names nothing: a person's activity never shows whom they blocked.
  const action = actionRow(r.db, { userId: s.user.id, t: r.t, nonce: newNonce(), kind: "block", githubUser: gate.github, outcome: "done", rows: 1 + rowsOf(writes), subject: "" });
  await r.db.batch([...statements(writes), action.stmt]);
  return json({ ok: true }, 200, s.cookies);
}

export async function handleLimits(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const m = /^(github|memory):([0-9]{1,20})$/.exec(r.url.searchParams.get("repo") ?? "");
  if (!m) return problemAnswer(bad("Which repository? ?repo=<forge>:<id>."));
  const repo = await first<RepoRow>(repoByKey(r.db, m[1], m[2]));
  if (!repo || !repo.name) return problemAnswer(new ForgeProblem(404, "not_found", "The registry does not know this repository."));
  const managers = await managersOf(s.db, repo);
  const own = await first<LimitRow>(r.db.prepare("SELECT * FROM interaction_limits WHERE scope = ? AND until > ?").bind(`repo:${repo.forge}:${repo.repo_id}`, Math.floor(r.t)));
  const inForce = await limitOn(r.db, repo, managers, r.t);
  const view = (x: LimitRow | null) => (x ? { level: x.level, words: LIMIT_WORDS[x.level], until: x.until, scope: x.scope.startsWith("account:") ? "account" : "repository" } : null);
  return json({ repository: view(own), inForce: view(inForce), can: { manage: managers.has(s.user.id) } });
}

export async function handleLimitWrite(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readBody(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateLimit(body);
  if (p instanceof ForgeProblem) return say(p);
  let scope = `account:${s.user.id}`;
  if (p.scope !== "account") {
    const [, forge, id] = /^repo:(github|memory):([0-9]+)$/.exec(p.scope)!;
    const repo = await first<RepoRow>(repoByKey(r.db, forge, id));
    if (!repo || !repo.name) return say(new ForgeProblem(404, "not_found", "The registry does not know this repository."));
    if (!(await managersOf(s.db, repo)).has(s.user.id)) return say(new ForgeProblem(403, "forbidden", "Only the people who manage a repository in the registry limit its interactions."));
    scope = p.scope;
  }
  const t = Math.floor(r.t);
  const write: Write = p.level === null
    ? { rows: 1, stmt: r.db.prepare("DELETE FROM interaction_limits WHERE scope = ?").bind(scope) }
    : {
        rows: 1,
        stmt: r.db
          .prepare("INSERT INTO interaction_limits (scope, level, until, by_user, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (scope) DO UPDATE SET level = excluded.level, until = excluded.until, by_user = excluded.by_user, at = excluded.at")
          .bind(scope, p.level, t + p.seconds, s.user.id, t),
      };
  const gate = await mayRule(r, s, "limit", 2);
  if (gate instanceof ForgeProblem) return say(gate);
  const repo = /^repo:(github|memory):([0-9]+)$/.exec(scope);
  const action = actionRow(r.db, { userId: s.user.id, t: r.t, nonce: newNonce(), kind: "limit", forge: repo?.[1] ?? "", repoId: repo?.[2] ?? "", githubUser: gate.github, outcome: "done", rows: 2, subject: "" });
  await r.db.batch([write.stmt, action.stmt]);
  return json({ ok: true, until: p.level === null ? null : t + p.seconds }, 200, s.cookies);
}
