// Commit statuses posted to the registry by outside services (night phase 10, E4; docs/API.md
// "Statuses"): a lab's CI, another forge, a reproduction service says how a commit of a repository the
// registry knows fared, and the registry's pages show it beside the researcher's own CI (read from
// GitHub) and the registry's checks. D1 oscr_forge `statuses`: the latest of each context on each
// commit, 20 contexts a commit at most.
//
//   POST /api/forge/v1/statuses/post       a token with statuses:write   {repo, sha, state, context?, description?, target_url?}
//   POST /api/forge/v1/statuses/actions    GitHub Actions' OIDC token    the same body; no secret in the researcher's repository
//   GET  /api/forge/v1/statuses            a token with repos:read       ?path=<owner>/<name> or ?id=<forge>:<id>, &sha=
//   GET  /api/forge/statuses         signed in (the site's pages)  the same
//
// A status: 2 rows (its row, upserted by its key; the action row, kind `status`). FORGE_OPEN (until phase
// 16, the owner's token; GitHub Actions only on the owner's repositories), the account's `statuses` cap
// (300 a day), the day's rows.
//
// GitHub Actions: the workflow asks GitHub for an OIDC token whose audience is this site's origin
// (`core.getIDToken('<origin>')`, permission `id-token: write`) and sends it as the bearer. The Worker
// checks its RS256 signature against GitHub's published keys (account/jwt.ts, fetched once an hour),
// its issuer, audience, times, and that it comes from a public repository the registry knows: the
// status is then that repository's own, named "GitHub Actions: <workflow>". Its action row's account
// is the repository ("oidc:github:<id>"), so the cap counts per repository.

import { verifySignature, IdTokenError } from "../../account/jwt.ts";
import { type SignedIn } from "../../account/guard.ts";
import { maskEmails } from "../mask.ts";
import { takeRequest } from "./bearer.ts";
import { commitAutomation, mayAutomate, readJsonBody } from "./automation.ts";
import { FORGE_ROWS_PER_DAY } from "./caps.ts";
import { closed, dailyCaps, globalCap, mayWrite, overCap } from "./gate.ts";
import { hiddenActors, hiddenAmong, hiddenOne } from "./hidden.ts";
import { json, problemAnswer } from "./http.ts";
import { parseTarget } from "./read.ts";
import { cleanLine, httpsUrl } from "./social-core.ts";
import { actionRow, all, first, newNonce, repoByKey, repoByPath, statements } from "./store.ts";
import { ForgeProblem, type D1Database, type ForgeRequest, type RepoRow, type Write } from "./types.ts";
import { who } from "./who.ts";
import type { ForgeName } from "../types.ts";

export const STATES = ["error", "failure", "pending", "success"] as const;
export type State = (typeof STATES)[number];
export const CONTEXTS_PER_COMMIT = 20;
export const STATUS_BODY_BYTES = 4 * 1024;
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
/** Seconds of clock difference tolerated with GitHub. */
const SKEW = 120;

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);

export interface StatusRequest {
  repo: string;
  sha: string;
  state: State;
  context: string;
  description: string;
  targetUrl: string;
}

/** A status as posted; a problem in words otherwise. */
export function validateStatus(payload: unknown): StatusRequest | ForgeProblem {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  if (!p) return bad("The request is not readable.");
  if (typeof p.repo !== "string" || !p.repo.trim()) return bad("Which repository? owner/name, or <forge>:<id>.");
  const sha = typeof p.sha === "string" ? p.sha.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return bad("A status is on a commit: its full id (40 hexadecimal characters).");
  if (typeof p.state !== "string" || !(STATES as readonly string[]).includes(p.state)) return bad("A status's state is error, failure, pending or success.");
  const context = p.context === undefined ? "default" : cleanLine(p.context, 100).replace(/[@＠]/g, " ").trim();
  if (!context) return bad("A context names the service and its check (“lab-ci/tests”).");
  const description = p.description === undefined ? "" : cleanLine(p.description, 140).replace(/[@＠]/g, " ");
  let targetUrl = "";
  if (p.target_url !== undefined && p.target_url !== null && p.target_url !== "") {
    const u = httpsUrl(p.target_url, 500);
    if (!u) return bad("A status's target_url is an https address without a user part.");
    targetUrl = u;
  }
  return { repo: p.repo.trim(), sha, state: p.state as State, context, description, targetUrl };
}

/** The repository a status names, as the registry knows it (alive), or null. */
async function knownRepo(db: D1Database, forge: ForgeName, repo: string): Promise<RepoRow | null> {
  const url = new URL("https://x/");
  if (/^(github|memory):/.test(repo)) url.searchParams.set("id", repo);
  else url.searchParams.set("path", repo);
  const target = parseTarget(url, forge);
  if (!target) return null;
  const row = "id" in target ? await first<RepoRow>(repoByKey(db, target.forge, target.id)) : await first<RepoRow>(repoByPath(db, target.forge, target.owner, target.name));
  return row && row.name && (row.state === "active" || row.state === "archived") ? row : null;
}

export interface StatusRow {
  forge: string;
  repo_id: string;
  sha: string;
  context: string;
  state: State;
  description: string;
  target_url: string;
  by_user: string;
  by_name: string;
  via: "token" | "oidc";
  at: number;
}

/** A status, upserted by its key (1 row). */
function statusWrite(db: D1Database, s: StatusRow): Write {
  return {
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO statuses (forge, repo_id, sha, context, state, description, target_url, by_user, by_name, via, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (forge, repo_id, sha, context) DO UPDATE SET state = excluded.state, description = excluded.description, target_url = excluded.target_url, " +
          "by_user = excluded.by_user, by_name = excluded.by_name, via = excluded.via, at = excluded.at",
      )
      .bind(s.forge, s.repo_id, s.sha, s.context, s.state, s.description, s.target_url, s.by_user, maskEmails(s.by_name).replace(/@/g, " ").slice(0, 100), s.via, Math.floor(s.at)),
  };
}

/** A commit's statuses (the key's prefix). */
function statusesOf(db: D1Database, forge: string, repoId: string, sha: string) {
  return db.prepare("SELECT * FROM statuses WHERE forge = ? AND repo_id = ? AND sha = ? ORDER BY context LIMIT ?").bind(forge, repoId, sha, CONTEXTS_PER_COMMIT + 5);
}

/** GitHub's combined state: failure when one failed or erred, pending when one waits, success when all
 *  passed; null when none was posted. */
export function combined(states: readonly State[]): State | null {
  if (!states.length) return null;
  if (states.some((s) => s === "failure" || s === "error")) return "failure";
  if (states.some((s) => s === "pending")) return "pending";
  return "success";
}

const statusView = (s: StatusRow) => ({ context: s.context, state: s.state, description: s.description, target_url: s.target_url || null, by: s.by_name, via: s.via, at: new Date(s.at * 1000).toISOString() });

const serviceForge = (r: ForgeRequest): ForgeName => r.deps.backend?.forge ?? "github";

/** GET /api/forge/statuses and /api/forge/v1/statuses: a commit's statuses, combined. */
export async function handleStatuses(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const sha = (r.url.searchParams.get("sha") ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return problemAnswer(bad("Which commit? ?sha= and its full id."), s.cookies);
  const target = parseTarget(r.url, serviceForge(r));
  if (!target) return problemAnswer(bad("Which repository? ?path=<owner>/<name> or ?id=<forge>:<id>."), s.cookies);
  const repo = await knownRepo(r.db, target.forge, "id" in target ? `${target.forge}:${target.id}` : `${target.owner}/${target.name}`);
  if (!repo) return problemAnswer(new ForgeProblem(404, "not_found", "The registry does not know this repository."), s.cookies);
  const all_ = await all<StatusRow>(statusesOf(r.db, repo.forge, repo.repo_id, sha));
  // Night phase 16: a status hidden by moderation, or posted by a suspended account, is left out; a
  // repository hidden by moderation shows none.
  if (await hiddenOne(r.db, "repo", `${repo.forge}:${repo.repo_id}`)) return problemAnswer(new ForgeProblem(410, "moderated", "This repository is hidden from the registry's pages."), s.cookies);
  const [hiddenStatuses, actors] = await Promise.all([
    hiddenAmong(r.db, "status", all_.map((x) => `${repo.forge}:${repo.repo_id}:${sha}:${x.context}`)),
    hiddenActors(r.db, all_.map((x) => ({ user: x.by_user }))),
  ]);
  const rows = all_.filter((x) => !hiddenStatuses.has(`${repo.forge}:${repo.repo_id}:${sha}:${x.context}`) && !(x.by_user && actors.users.has(x.by_user)));
  return json({ repo: { forge: repo.forge, id: repo.repo_id, path: `${repo.owner_login}/${repo.name}` }, sha, state: combined(rows.map((x) => x.state)), statuses: rows.map(statusView) }, 200, s.cookies);
}

/** The row, and the problem that refuses a new context past the commit's 20. */
async function upsert(r: ForgeRequest, repo: RepoRow, p: StatusRequest, by: { user: string; name: string; via: "token" | "oidc" }): Promise<Write | ForgeProblem> {
  const had = await all<{ context: string }>(statusesOf(r.db, repo.forge, repo.repo_id, p.sha));
  if (!had.some((h) => h.context === p.context) && had.length >= CONTEXTS_PER_COMMIT) {
    return new ForgeProblem(409, "too_many_contexts", `A commit holds ${CONTEXTS_PER_COMMIT} contexts at most: post under one of its contexts.`);
  }
  return statusWrite(r.db, { forge: repo.forge, repo_id: repo.repo_id, sha: p.sha, context: p.context, state: p.state, description: p.description, target_url: p.targetUrl, by_user: by.user, by_name: by.name, via: by.via, at: r.t });
}

/** POST /api/forge/v1/statuses/post: a status posted with a token (statuses:write). */
export async function handleStatusPost(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readJsonBody(r, STATUS_BODY_BYTES);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateStatus(body);
  if (p instanceof ForgeProblem) return say(p);
  const repo = await knownRepo(r.db, serviceForge(r), p.repo);
  if (!repo) return say(new ForgeProblem(404, "not_found", "The registry does not know this repository: statuses go on the repositories it follows."));
  const gate = await mayAutomate(r, s as SignedIn, "status", 2);
  if (gate instanceof ForgeProblem) return say(gate);
  const w = await upsert(r, repo, p, { user: s.user.id, name: s.user.github_login ?? s.user.orcid ?? "", via: "token" });
  if (w instanceof ForgeProblem) return say(w);
  const written = await commitAutomation(r, s as SignedIn, "status", gate.github, [w], `status:${repo.forge}:${repo.repo_id}:${p.sha}`, { forge: repo.forge, repoId: repo.repo_id });
  return json({ ok: true, written, context: p.context, state: p.state }, 201, s.cookies);
}

// ─── GitHub Actions' OIDC token ──────────────────────────────────────────────

export interface ActionsClaims {
  repository_id: string;
  repository_owner_id: string;
  repository: string;
  repository_visibility: string;
  workflow: string;
}

/** The claims of GitHub Actions' OIDC token, once its signature and claims are checked; a problem
 *  otherwise. */
export async function actionsClaims(token: string, o: { issuer: string; audience: string; now: number }): Promise<ActionsClaims | ForgeProblem> {
  const refuse = (why: string) => new ForgeProblem(401, "bad_credentials", `This is not a token GitHub Actions gave this registry: ${why}.`);
  let claims: Record<string, unknown>;
  try {
    // An unknown key makes GitHub's keys fetched again at most once a minute.
    claims = (await verifySignature(token, { jwksUri: `${o.issuer}/.well-known/jwks`, now: o.now, refetchAfter: 60 })) as Record<string, unknown>;
  } catch (e) {
    return refuse(e instanceof IdTokenError ? e.message : "its signature could not be checked");
  }
  if (claims.iss !== o.issuer) return refuse("another issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(o.audience)) return refuse(`its audience is not ${o.audience}`);
  if (typeof claims.exp !== "number" || claims.exp + SKEW < o.now) return refuse("it has expired");
  if (typeof claims.nbf === "number" && claims.nbf - SKEW > o.now) return refuse("it is not valid yet");
  if (typeof claims.iat === "number" && claims.iat - SKEW > o.now) return refuse("it is from the future");
  const id = String(claims.repository_id ?? "");
  const owner = String(claims.repository_owner_id ?? "");
  if (!/^\d{1,20}$/.test(id) || !/^\d{1,20}$/.test(owner)) return refuse("it names no repository");
  return {
    repository_id: id,
    repository_owner_id: owner,
    repository: typeof claims.repository === "string" ? claims.repository : "",
    repository_visibility: typeof claims.repository_visibility === "string" ? claims.repository_visibility : "",
    workflow: typeof claims.workflow === "string" ? claims.workflow : "",
  };
}

/** An issuer's address: https, or http on this machine (a development mock). */
function issuerOf(value: string | undefined): string {
  const v = (value ?? "").trim().replace(/\/+$/, "");
  if (!v) return GITHUB_OIDC_ISSUER;
  try {
    const u = new URL(v);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol === "https:" || (u.protocol === "http:" && local)) return v;
  } catch {
    // Not an address: GitHub's own.
  }
  return GITHUB_OIDC_ISSUER;
}

/** POST /api/forge/v1/statuses/actions: a status posted by GitHub Actions with its OIDC token. */
export async function handleActionsStatus(r: ForgeRequest): Promise<Response> {
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*$/.exec(r.request.headers.get("Authorization") ?? "");
  if (!m) return problemAnswer(new ForgeProblem(401, "requires_authentication", "This route takes GitHub Actions' OIDC token: Authorization: Bearer <the token core.getIDToken gives>."));
  const claims = await actionsClaims(m[1], { issuer: issuerOf(r.env.GITHUB_OIDC_ISSUER), audience: r.url.origin, now: r.t });
  if (claims instanceof ForgeProblem) return problemAnswer(claims);
  const pseudo = `oidc:github:${claims.repository_id}`;
  const rate = takeRequest(pseudo, r.t);
  if (!rate.ok) return problemAnswer(new ForgeProblem(429, "rate_limited", "This repository's workflows have posted too many statuses: please wait.", { retryAfter: rate.retryAfter }));
  if (claims.repository_visibility && claims.repository_visibility !== "public") return problemAnswer(new ForgeProblem(403, "not_public", "The registry follows public repositories only."));
  // FORGE_OPEN: until phase 16, only the owner's own repositories.
  if (!mayWrite(r.env, claims.repository_owner_id)) return problemAnswer(closed());
  const body = await readJsonBody(r, STATUS_BODY_BYTES);
  if (body instanceof ForgeProblem) return problemAnswer(body);
  const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const workflow = cleanLine(claims.workflow, 60) || "workflow";
  const p = validateStatus({ context: `GitHub Actions: ${workflow}`, ...raw, repo: `github:${claims.repository_id}` });
  if (p instanceof ForgeProblem) return problemAnswer(p);
  const repo = await first<RepoRow>(repoByKey(r.db, "github", claims.repository_id));
  if (!repo || !repo.name || !(repo.state === "active" || repo.state === "archived")) {
    return problemAnswer(new ForgeProblem(404, "not_found", "The registry does not follow this repository: link it first."));
  }
  const caps = await dailyCaps(r.db, pseudo, "status", r.t);
  if (caps.exceeded) return problemAnswer(overCap(caps.exceeded));
  const quota = await globalCap(r.db, r.t, Math.min(2, FORGE_ROWS_PER_DAY));
  if (quota) return problemAnswer(quota);
  const w = await upsert(r, repo, p, { user: "", name: `GitHub Actions: ${workflow}`, via: "oidc" });
  if (w instanceof ForgeProblem) return problemAnswer(w);
  const action = actionRow(r.db, { userId: pseudo, t: r.t, nonce: newNonce(), kind: "status", forge: "github", repoId: repo.repo_id, outcome: "done", rows: 2, subject: `status:github:${repo.repo_id}:${p.sha}` });
  await r.db.batch(statements([w, action]));
  return json({ ok: true, written: 2, context: p.context, state: p.state }, 201);
}
