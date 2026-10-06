// Private vulnerability reporting (night phase 11, E5; docs/SECURITY_QUALITY.md).
//
// A reporter tells a repository's maintainers of a vulnerability in private: a form opens an advisory
// (state triage), a private thread lets the maintainers and the reporter discuss, the maintainers add
// collaborators and credits, draft the advisory, publish it (with a CVE a numbering authority issues,
// which stays the researcher's step) or withdraw it.
//
// PRIVATE by construction: these rows are never put in a public output, the static layer, the search,
// a feed or a webhook (the Mac never reads them). A read is refused to anyone but the reporter, a
// collaborator named on the advisory, and a person who manages the repository, until it is published.
// Every write is gated by FORGE_OPEN (owner only until the GitHub side opens) and counts in the
// `advisory` cap. The texts are masked for addresses; the handles carry no at sign.

import { who } from "./who.ts";
import { type SignedIn } from "../../account/guard.ts";
import { json, problemAnswer } from "./http.ts";
import { readCapped } from "./flow.ts";
import { closed, dailyCaps, globalCap, mayWrite, overCap } from "./gate.ts";
import { FORGE_ROWS_PER_DAY } from "./caps.ts";
import { actionRow, all, first, newNonce, repoByKey, repoByPath, type Write } from "./store.ts";
import { managersOf } from "./blocks.ts";
import { NOT_FOUND, parseTarget, serviceForge } from "./read.ts";
import { maskEmails } from "../mask.ts";
import { ForgeProblem, type ForgeRequest, type RepoRow } from "./types.ts";
import type { SecurityRowKind } from "./types.ts";

const BODY_BYTES = 32 * 1024;
const SEVERITIES = new Set(["critical", "high", "moderate", "low", "unknown"]);

interface AdvisoryRow {
  ref: string;
  state: string;
  severity: string;
  title: string;
  summary: string;
  cve: string;
  affected: string;
  reporter_id: string;
  reporter: string;
  collaborators: string;
  credits: string;
  posts: number;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}

interface PostRow { n: number; body: string; author: string; author_id: string; at: number }

function randHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function handle(user: SignedIn["user"]): string {
  return (user.github_login ?? user.orcid ?? "someone").replace(/@/g, "");
}

function parseJsonArray(text: string): string[] {
  try {
    const p = JSON.parse(text);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Who may see an advisory: its reporter, a collaborator, a manager of the repository; a published
 *  one, any signed-in reader of the repository. */
async function mayRead(s: SignedIn, repo: RepoRow, adv: AdvisoryRow): Promise<boolean> {
  if (adv.state === "published") return true;
  if (adv.reporter_id === s.user.id) return true;
  if (parseJsonArray(adv.collaborators).includes(s.user.id)) return true;
  return (await managersOf(s.db, repo)).has(s.user.id);
}

function manages(s: SignedIn, repo: RepoRow): Promise<boolean> {
  return managersOf(s.db, repo).then((m) => m.has(s.user.id));
}

function view(adv: AdvisoryRow, posts: PostRow[] | null): Record<string, unknown> {
  return {
    ref: adv.ref, state: adv.state, severity: adv.severity, title: adv.title, summary: adv.summary,
    cve: adv.cve, affected: adv.affected, reporter: adv.reporter,
    collaborators: parseJsonArray(adv.collaborators).length, credits: safeCredits(adv.credits),
    posts: adv.posts, createdAt: adv.created_at, updatedAt: adv.updated_at, publishedAt: adv.published_at,
    thread: posts ? posts.map((p) => ({ n: p.n, body: p.body, author: p.author, at: p.at })) : undefined,
  };
}

function safeCredits(text: string): { handle: string; kind: string }[] {
  try {
    const p = JSON.parse(text);
    return Array.isArray(p) ? p.filter((c) => c && typeof c.handle === "string").map((c) => ({ handle: String(c.handle).replace(/@/g, ""), kind: String(c.kind ?? "reporter") })) : [];
  } catch {
    return [];
  }
}

async function loadRepo(r: ForgeRequest): Promise<RepoRow | ForgeProblem> {
  const target = parseTarget(r.url, serviceForge(r));
  if (!target) return new ForgeProblem(400, "invalid", "Name one repository: ?id=<forge>:<id> or ?path=<owner>/<name>.");
  const row = "id" in target
    ? await first<RepoRow>(repoByKey(r.db, target.forge, target.id))
    : await first<RepoRow>(repoByPath(r.db, target.forge, target.owner, target.name));
  if (!row || row.state === "hidden") return new ForgeProblem(404, "not_found", NOT_FOUND);
  return row;
}

async function gate(r: ForgeRequest, s: SignedIn, kind: SecurityRowKind, rows: number): Promise<ForgeProblem | { github: string }> {
  const { linkedGithub } = await import("./identity.ts");
  const github = await linkedGithub(s.db, s.user.id);
  if (!mayWrite(r.env, github)) return closed();
  const caps = await dailyCaps(r.db, s.user.id, kind, r.t);
  if (caps.exceeded) return overCap(caps.exceeded);
  return (await globalCap(r.db, r.t, Math.min(rows, FORGE_ROWS_PER_DAY))) ?? { github: github ?? "" };
}

function logRow(r: ForgeRequest, s: SignedIn, kind: SecurityRowKind, github: string, repo: RepoRow, rows: number, ref: string): Write {
  return { rows: 1, stmt: actionRow(r.db, { userId: s.user.id, t: r.t, nonce: newNonce(), kind, forge: repo.forge, repoId: repo.repo_id, githubUser: github, outcome: "done", rows, subject: `advisory:${repo.forge}:${repo.repo_id}:${ref}` }).stmt };
}

// ─── GET /api/forge/advisory ─────────────────────────────────────────────────

export async function handleAdvisoryRead(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const repo = await loadRepo(r);
  if (repo instanceof ForgeProblem) return say(repo);
  const ref = r.url.searchParams.get("ref");
  if (ref) {
    const adv = await first<AdvisoryRow>(r.db.prepare("SELECT * FROM advisories WHERE forge = ? AND repo_id = ? AND ref = ?").bind(repo.forge, repo.repo_id, ref));
    if (!adv) return say(new ForgeProblem(404, "not_found", "The registry does not know this advisory."));
    if (!(await mayRead(s, repo, adv))) return say(new ForgeProblem(403, "forbidden", "This vulnerability report is private to its reporter and the repository's maintainers."));
    const posts = await all<PostRow>(r.db.prepare("SELECT n, body, author, author_id, at FROM advisory_posts WHERE forge = ? AND repo_id = ? AND ref = ? ORDER BY n").bind(repo.forge, repo.repo_id, ref));
    return json({ advisory: view(adv, posts) }, 200, s.cookies);
  }
  // The list: the ones this reader may see (published to all; private ones to those concerned).
  const rows = await all<AdvisoryRow>(r.db.prepare("SELECT * FROM advisories WHERE forge = ? AND repo_id = ? ORDER BY created_at DESC").bind(repo.forge, repo.repo_id));
  const visible: Record<string, unknown>[] = [];
  const managed = (await managersOf(s.db, repo)).has(s.user.id);
  for (const adv of rows) {
    if (adv.state === "published" || adv.reporter_id === s.user.id || managed || parseJsonArray(adv.collaborators).includes(s.user.id)) {
      visible.push(view(adv, null));
    }
  }
  return json({ advisories: visible, mayManage: managed }, 200, s.cookies);
}

// ─── POST /api/forge/advisory/open ───────────────────────────────────────────

export async function handleAdvisoryOpen(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const repo = await loadRepo(r);
  if (repo instanceof ForgeProblem) return say(repo);
  const text = await readCapped(r.request, BODY_BYTES);
  if (text === null) return say(new ForgeProblem(413, "too_large", "This request is larger than the registry reads."));
  let body: Record<string, unknown>;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { return say(new ForgeProblem(400, "invalid", "The request is not readable.")); }
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 256) : "";
  if (!title) return say(new ForgeProblem(400, "invalid", "A title is required."));
  const severity = typeof body.severity === "string" && SEVERITIES.has(body.severity) ? body.severity : "unknown";
  const summary = maskEmails(typeof body.summary === "string" ? body.summary : "").slice(0, 16384);
  const affected = maskEmails(typeof body.affected === "string" ? body.affected : "").slice(0, 2000);
  const g = await gate(r, s, "advisory_open", 2);
  if (g instanceof ForgeProblem) return say(g);
  const ref = randHex(16);
  const t = Math.floor(r.t);
  const insert: Write = {
    rows: 1,
    stmt: r.db.prepare("INSERT INTO advisories (forge, repo_id, ref, state, severity, title, summary, affected, reporter_id, reporter, created_at, updated_at) VALUES (?, ?, ?, 'triage', ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(repo.forge, repo.repo_id, ref, severity, maskEmails(title), summary, affected, s.user.id, handle(s.user), t, t),
  };
  await r.db.batch([insert.stmt, logRow(r, s, "advisory_open", g.github, repo, 2, ref).stmt]);
  return json({ ok: true, ref, written: 2 }, 201, s.cookies);
}

// ─── POST /api/forge/advisory/post ───────────────────────────────────────────

export async function handleAdvisoryPost(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const repo = await loadRepo(r);
  if (repo instanceof ForgeProblem) return say(repo);
  const text = await readCapped(r.request, BODY_BYTES);
  if (text === null) return say(new ForgeProblem(413, "too_large", "This request is larger than the registry reads."));
  let body: Record<string, unknown>;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { return say(new ForgeProblem(400, "invalid", "The request is not readable.")); }
  const ref = typeof body.ref === "string" ? body.ref : "";
  const message = maskEmails(typeof body.body === "string" ? body.body.trim() : "").slice(0, 16384);
  if (!message) return say(new ForgeProblem(400, "invalid", "A message is required."));
  const adv = await first<AdvisoryRow>(r.db.prepare("SELECT * FROM advisories WHERE forge = ? AND repo_id = ? AND ref = ?").bind(repo.forge, repo.repo_id, ref));
  if (!adv) return say(new ForgeProblem(404, "not_found", "The registry does not know this advisory."));
  if (!(await mayRead(s, repo, adv)) || adv.state === "published" && !(await manages(s, repo))) {
    return say(new ForgeProblem(403, "forbidden", "Only the reporter and the repository's maintainers post in a private report."));
  }
  const g = await gate(r, s, "advisory_post", 2);
  if (g instanceof ForgeProblem) return say(g);
  const n = adv.posts + 1;
  const t = Math.floor(r.t);
  const writes: Write[] = [
    { rows: 1, stmt: r.db.prepare("INSERT INTO advisory_posts (forge, repo_id, ref, n, body, author_id, author, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(repo.forge, repo.repo_id, ref, n, message, s.user.id, handle(s.user), t) },
    { rows: 1, stmt: r.db.prepare("UPDATE advisories SET posts = ?, updated_at = ? WHERE forge = ? AND repo_id = ? AND ref = ?").bind(n, t, repo.forge, repo.repo_id, ref) },
  ];
  await r.db.batch([...writes.map((w) => w.stmt), logRow(r, s, "advisory_post", g.github, repo, 3, ref).stmt]);
  return json({ ok: true, n, written: 3 }, 201, s.cookies);
}

// ─── POST /api/forge/advisory/edit ───────────────────────────────────────────

export async function handleAdvisoryEdit(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const repo = await loadRepo(r);
  if (repo instanceof ForgeProblem) return say(repo);
  const text = await readCapped(r.request, BODY_BYTES);
  if (text === null) return say(new ForgeProblem(413, "too_large", "This request is larger than the registry reads."));
  let body: Record<string, unknown>;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { return say(new ForgeProblem(400, "invalid", "The request is not readable.")); }
  const ref = typeof body.ref === "string" ? body.ref : "";
  const op = body.op;
  if (op !== "update" && op !== "publish" && op !== "withdraw" && op !== "collaborator" && op !== "credit") {
    return say(new ForgeProblem(400, "invalid", "The action is update, publish, withdraw, collaborator or credit."));
  }
  const adv = await first<AdvisoryRow>(r.db.prepare("SELECT * FROM advisories WHERE forge = ? AND repo_id = ? AND ref = ?").bind(repo.forge, repo.repo_id, ref));
  if (!adv) return say(new ForgeProblem(404, "not_found", "The registry does not know this advisory."));
  // The maintainers steer an advisory (draft, publish, withdraw, collaborators, credits).
  if (!(await manages(s, repo))) return say(new ForgeProblem(403, "forbidden", "Only the repository's maintainers steer a vulnerability report."));
  const t = Math.floor(r.t);
  let stmt;
  if (op === "publish") {
    stmt = r.db.prepare("UPDATE advisories SET state = 'published', published_at = ?, updated_at = ? WHERE forge = ? AND repo_id = ? AND ref = ?").bind(t, t, repo.forge, repo.repo_id, ref);
  } else if (op === "withdraw") {
    stmt = r.db.prepare("UPDATE advisories SET state = 'withdrawn', updated_at = ? WHERE forge = ? AND repo_id = ? AND ref = ?").bind(t, repo.forge, repo.repo_id, ref);
  } else if (op === "collaborator") {
    const list = parseJsonArray(adv.collaborators);
    const id = typeof body.user === "string" ? body.user : "";
    if (!id) return say(new ForgeProblem(400, "invalid", "Name the collaborator by their account id."));
    const next = body.remove ? list.filter((x) => x !== id) : [...new Set([...list, id])].slice(0, 50);
    stmt = r.db.prepare("UPDATE advisories SET collaborators = ?, updated_at = ? WHERE forge = ? AND repo_id = ? AND ref = ?").bind(JSON.stringify(next).slice(0, 2000), t, repo.forge, repo.repo_id, ref);
  } else if (op === "credit") {
    const credits = safeCredits(adv.credits);
    const who2 = typeof body.handle === "string" ? body.handle.replace(/@/g, "").slice(0, 100) : "";
    if (!who2) return say(new ForgeProblem(400, "invalid", "Name the person credited."));
    credits.push({ handle: who2, kind: typeof body.kind === "string" ? body.kind.slice(0, 40) : "reporter" });
    stmt = r.db.prepare("UPDATE advisories SET credits = ?, updated_at = ? WHERE forge = ? AND repo_id = ? AND ref = ?").bind(JSON.stringify(credits.slice(0, 20)).slice(0, 2000), t, repo.forge, repo.repo_id, ref);
  } else {
    const severity = typeof body.severity === "string" && SEVERITIES.has(body.severity) ? body.severity : adv.severity;
    const title = maskEmails(typeof body.title === "string" && body.title.trim() ? body.title.trim() : adv.title).slice(0, 256);
    const summary = maskEmails(typeof body.summary === "string" ? body.summary : adv.summary).slice(0, 16384);
    const cve = typeof body.cve === "string" ? body.cve.slice(0, 100) : adv.cve;
    const affected = maskEmails(typeof body.affected === "string" ? body.affected : adv.affected).slice(0, 2000);
    const state = adv.state === "triage" ? "draft" : adv.state;
    stmt = r.db.prepare("UPDATE advisories SET state = ?, severity = ?, title = ?, summary = ?, cve = ?, affected = ?, updated_at = ? WHERE forge = ? AND repo_id = ? AND ref = ?").bind(state, severity, title, summary, cve, affected, t, repo.forge, repo.repo_id, ref);
  }
  const g = await gate(r, s, "advisory_edit", 2);
  if (g instanceof ForgeProblem) return say(g);
  await r.db.batch([stmt, logRow(r, s, "advisory_edit", g.github, repo, 2, ref).stmt]);
  return json({ ok: true, op, written: 2 }, 200, s.cookies);
}
