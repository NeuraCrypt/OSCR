// The forge service's two reads, for a signed-in reader (element E6 of phase 01; docs/FORGE.md):
//
// GET /api/forge/repo?id=<forge>:<repo_id> or ?path=<owner>/<name>
//   OSCR's live layer for one repository (budget R6: about 10 rows read, none written):
//   - the mode and the status line's facts: created or installed (GitHub's webhooks bring its
//     pushes: the last push seen is `head_at`), or public without the App (read only, the Mac
//     polls it: last seen `updated_at`), each said in one sentence;
//   - the state: active, archived, pending_deletion (with `delete_after`, and whether the reader
//     may start the restore), deleted, gone;
//   - the papers it is attached to (DOI, status, and the paper's page and title from the reader's
//     own `paper_orcid` facts when known: a lookup of paper_orcid by paper alone would read the
//     whole table, so the others come from the static layer's shard, as for a signed-out reader);
//   - the reader's roles on the layer: `verified_author` (of a linked paper, oscr_community roles),
//     `maintainer` (the maintainer role on the repository, or the Mac's `repo_owner` fact naming
//     the reader's GitHub login), `owner` (the repository is in the reader's GitHub account),
//     `linked_by` (the reader linked or created it through the registry);
//   - how many tracing maps and traced paths point to it (the number the deletion page shows);
//   - the jobs the Mac has not answered yet, among the table's last JOBS_TAIL rows (store.ts
//     pendingJobsOf: jobs has no index by repository, so an older unanswered job is not listed);
//   - phase 07: its releases tied to a paper's version (release_papers, the key's prefix: at most 500),
//     what the Mac answered for its releases (the map versioned, Software Heritage, Zenodo), among
//     the same tail of jobs (store.ts recentJobsOf), and its packages (repo_packages, the key's prefix).
//   What D1 bills: the rows it scans, not the rows it returns. The seeded example returns ≤ 12;
//   the scanned rows are 1 (+1 by path) + the papers + the traced paths + 2 × (at most JOBS_TAIL + 1)
//   jobs + the releases' ties
//   + the reader's few community rows: ≤ ~70 on a busy repository, 350,000 a day at the design's
//   5,000 signed-in views, inside D1's free 5 million reads a day.
//   A hidden repository (made private on GitHub, D00-14) answers 404 like an unknown one, and its
//   name never appears; a private one was never stored.
//
// GET /api/forge/mine[?mode=created|installed|public|mirror][&template=true|false][&after=<name>][&limit=n]
//   "Your repositories": the repositories OSCR knows in the reader's own GitHub account (the login
//   of the GitHub identity linked to the account), by the prefix (forge, owner_login) of repos_path,
//   paged by name (`after` is the cursor, `next` the following page's), with the number of papers
//   of each (D01-13: not by linked_by, which has no index). GitHub's `mirror:` and `template:`
//   qualifiers become the filters `mode` (mirror = installed or public) and `template`. The first
//   page also carries the account's pending deletions with their dates (they come first on the
//   page), the per-account caps of the last 24 hours, and whether the GitHub side is open to the
//   reader (FORGE_OPEN, D01-1).
//
// Both read only: the session is not touched (no write), every statement goes by a key or by
// repos_path (never a scan: tests/forge-service/read.test.ts checks the query plans of both
// databases), and every answer is `Cache-Control: no-store` (http.ts). Signed out: 401 with the
// stale cookies cleared (account/guard.ts).

import { signedIn } from "../../account/guard.ts";
import type { User } from "../../account/store.ts";
import { SEGMENT } from "../paths.ts";
import type { ForgeName } from "../types.ts";
import { PER_ACCOUNT_DAY } from "./caps.ts";
import { dailyCaps, mayWrite } from "./gate.ts";
import { json, problem } from "./http.ts";
import { packagesOfRepo } from "./act-packages.ts";
import { all, first, papersOf, pendingJobsOf, recentJobsOf, releasePapersOf, repoByKey, repoByPath, reposOfOwner, tracedCount, type ReleasePaperRow } from "./store.ts";
import type { D1Database, D1PreparedStatement, ForgeRequest, PaperStatus, RepoMode, RepoRow, RepoState } from "./types.ts";

// ─── the answers' shapes ─────────────────────────────────────────────────────

/** A role of the reader on OSCR's layer over a repository. */
export type LayerRole = "verified_author" | "maintainer" | "owner" | "linked_by";

export interface LayerPaper {
  /** "10.1234/abcd". */
  doi: string;
  status: PaperStatus;
  /** The paper's page (/paper/<slug>/) and title, when the reader's facts know them. */
  slug: string | null;
  title: string | null;
  /** When it was attached (Unix seconds). */
  at: number;
}

export interface PendingJob {
  id: number;
  kind: string;
  ref: string;
  createdAt: number;
  notBefore: number | null;
}

/** GET /api/forge/repo's answer: a superset of src/lib/forge.ts ShellLayer (the shell reads it as
 *  the signed-in layer). Owner and name are OSCR's, in lower case; the pages show GitHub's case. */
export interface RepoLayerAnswer {
  forge: ForgeName;
  id: string;
  owner: string;
  name: string;
  /** The repository's page on the registry: /r/<owner>/<name>/. */
  url: string;
  mode: RepoMode;
  template: boolean;
  defaultBranch: string | null;
  head: string | null;
  /** When the forge says the default branch was last pushed, as OSCR saw it. */
  headAt: number | null;
  /** When OSCR's row last changed (a webhook, the Mac's polling, an action). */
  lastSeen: number;
  status: { webhooks: boolean; polled: boolean; sentence: string };
  state: RepoState;
  deleteAfter: number | null;
  /** The state in words, or null when active. */
  stateSentence: string | null;
  /** Whether the reader may start the restore of a pending deletion (E4's `restore`; GitHub still
   *  decides at the action whether their account may). */
  restore: boolean;
  papers: LayerPaper[];
  roles: LayerRole[];
  /** The DOIs of the linked papers the reader is a verified author of. */
  authorOf: string[];
  /** Tracing maps (papers) and traced paths pointing to the repository. */
  maps: number;
  paths: number;
  jobs: PendingJob[];
  /** Phase 04 (D04-*): the linked papers' verified authors who signed in with GitHub, by their
   *  GitHub login — the reviewers a pull request's page suggests. Answered only to a reader who
   *  manages the repository or authored one of its papers; empty for anyone else. */
  reviewers: { login: string; papers: string[] }[];
  /** Phase 07: the releases tied to a version of a paper, live (the static layer has them as of last
   *  night, with the tracing maps the Mac versioned and the real Zenodo's DOIs). Never who tied. */
  releaseTies: { tag: string; paper: string; version: string; label: string; status: PaperStatus; commit: string | null; shown: string | null }[];
  /** Phase 07: what the Mac answered for the releases (the map versioned, Software Heritage, Zenodo),
   *  the newest first, among the jobs table's last rows. Its words, never who asked. */
  answered: { kind: string; ref: string; paper: string; outcome: string; message: string; doneAt: number }[];
  /** Phase 07: the packages a person who may push confirmed or declined (repo_packages); never who. */
  packages: { registry: string; name: string; status: string; version: string; source: string }[];
}

export interface MineItem {
  forge: ForgeName;
  id: string;
  owner: string;
  name: string;
  url: string;
  mode: RepoMode;
  state: RepoState;
  template: boolean;
  papers: number;
  headAt: number | null;
  lastSeen: number;
  deleteAfter: number | null;
}

export interface MineAnswer {
  /** The reader's GitHub login, or null: no GitHub identity linked (nothing is listed). */
  github: string | null;
  filters: { mode: MineMode | null; template: boolean | null };
  repositories: MineItem[];
  /** The cursor of the next page (`?after=`), or null. */
  next: string | null;
  /** First page only: the account's repositories waiting for deletion, the nearest first. */
  pending?: MineItem[];
  /** First page only: the per-account caps of the last 24 hours. */
  caps?: { limits: typeof PER_ACCOUNT_DAY; used: Record<keyof typeof PER_ACCOUNT_DAY, number> };
  /** First page only: whether the reader's GitHub account may start actions (FORGE_OPEN). */
  open?: boolean;
  /** A sentence for the page when there is nothing to list for a reason. */
  sentence?: string;
}

export type MineMode = RepoMode | "mirror";
const MINE_MODES: readonly MineMode[] = ["created", "installed", "public", "mirror"];

/** A page of "Your repositories": 30 by default, 50 at most (reposOfOwner reads one more to know
 *  whether a next page exists, and caps its own limit at 100). */
export const MINE_PAGE = 30;
export const MINE_PAGE_MAX = 50;
/** The pending deletions listed on the first page. */
export const MINE_PENDING_MAX = 20;
/** The jobs' tail read for a repository's pending jobs (store.ts pendingJobsOf). */
export const JOBS_TAIL = 50;

// ─── shared ──────────────────────────────────────────────────────────────────

const FORGES: readonly ForgeName[] = ["github", "memory"];

/** The host of the Mac's repository keys in oscr_community (roles' scope_id, repo_owner.repo):
 *  "github.com/<owner>/<name>". The test double ("memory") stands for GitHub in the tests' world,
 *  where a GitHub sign-in and the double's GitHub are the same person; no production row has it. */
const COMMUNITY_HOST: Readonly<Record<ForgeName, string>> = { github: "github.com", memory: "github.com" };

const NOT_FOUND = "The registry does not know this repository, or it is not public.";

/** The forge the service works with: GitHub, or the backend the tests inject. The backend itself
 *  is not built (a read makes no request to the forge). */
const serviceForge = (r: ForgeRequest): ForgeName => r.deps.backend?.forge ?? "github";

const day = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

const repoUrl = (row: RepoRow): string => `/r/${encodeURIComponent(row.owner_login)}/${encodeURIComponent(row.name)}/`;

/** The signed-in reader, reading only (the session is not slid: 0 rows written). */
async function reader(r: ForgeRequest): Promise<{ user: User; community: D1Database } | Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: false, touch: false });
  if (s instanceof Response) return s;
  return { user: s.user, community: s.db };
}

// ─── the status line and the state, in words ─────────────────────────────────

/** How OSCR follows the repository: GitHub's webhooks (the App installed on it: `installed`, or a
 *  `created` one with an installation), or the Mac's nightly polling (public, without the App). */
export function statusLine(row: Pick<RepoRow, "mode" | "installation_id" | "head_at" | "updated_at">): RepoLayerAnswer["status"] {
  const webhooks = row.mode === "installed" || (row.mode === "created" && row.installation_id !== null);
  const pushed = row.head_at !== null ? ` Last push seen: ${day(row.head_at)}.` : " No push seen yet.";
  if (webhooks) {
    const how =
      row.mode === "created"
        ? "Created through the registry, with its App installed: GitHub sends the registry its pushes as they happen."
        : "Linked, with the registry's App installed: GitHub sends the registry its pushes as they happen.";
    return { webhooks: true, polled: false, sentence: how + pushed };
  }
  const how =
    row.mode === "created"
      ? "Created through the registry, without its App: the registry's computer reads it every night."
      : "Linked, public and without the registry's App: read only, the registry's computer reads it every night.";
  return { webhooks: false, polled: true, sentence: `${how}${pushed} Last seen: ${day(row.updated_at)}.` };
}

/** The state in words, or null when active. */
export function stateSentence(row: Pick<RepoRow, "state" | "delete_after">): string | null {
  switch (row.state) {
    case "archived":
      return "Archived on GitHub: read only.";
    case "pending_deletion":
      return row.delete_after !== null
        ? `Asked for deletion: it leaves the registry after ${day(row.delete_after)}, and can be restored until then.`
        : "Asked for deletion: it can be restored for now.";
    case "deleted":
      return "Deleted by its owner. GitHub keeps a deleted repository restorable for 90 days from its own settings.";
    case "gone":
      return "No longer on GitHub: it was deleted, renamed out of reach, or made private outside the registry.";
    default:
      return null;
  }
}

// ─── GET /api/forge/repo ─────────────────────────────────────────────────────

type Target = { forge: ForgeName; id: string } | { forge: ForgeName; owner: string; name: string };

/** The repository a query names: ?id=<forge>:<repo_id> or ?path=<owner>/<name>, exactly one. */
export function parseTarget(url: URL, forge: ForgeName): Target | null {
  const id = url.searchParams.get("id");
  const path = url.searchParams.get("path");
  if ((id === null) === (path === null)) return null;
  if (id !== null) {
    const m = /^(github|memory):([A-Za-z0-9_.-]{1,100})$/.exec(id);
    if (!m || !(FORGES as readonly string[]).includes(m[1])) return null;
    return { forge: m[1] as ForgeName, id: m[2] };
  }
  const parts = (path as string).replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!SEGMENT.test(owner) || !SEGMENT.test(name) || /\.git$/i.test(name)) return null;
  return { forge, owner, name };
}

interface CommunityRow {
  role: "verified_author" | "maintainer" | "repo_owner";
  value: string;
  slug: string | null;
  title: string | null;
}

/** The reader's roles on one repository and the facts of the linked papers they authored, in ONE
 *  statement of oscr_community, every part by its key: their verified_author roles among the
 *  linked papers (with slug and title from their own paper_orcid facts), their maintainer role on
 *  the repository, and the Mac's repo_owner fact. */
function communityFacts(community: D1Database, user: User, repoKey: string, paperIds: string[]): D1PreparedStatement {
  const parts: string[] = [];
  const values: unknown[] = [];
  if (paperIds.length) {
    parts.push(
      "SELECT 'verified_author' AS role, r.scope_id AS value, p.slug AS slug, p.title AS title FROM roles r " +
        "LEFT JOIN paper_orcid p ON p.orcid = ? AND p.paper_id = r.scope_id " +
        `WHERE r.user_id = ? AND r.role = 'verified_author' AND r.scope_kind = 'paper' AND r.scope_id IN (${paperIds.map(() => "?").join(", ")})`,
    );
    values.push(user.orcid ?? "", user.id, ...paperIds);
  }
  parts.push(
    "SELECT 'maintainer' AS role, scope_id AS value, NULL AS slug, NULL AS title FROM roles " +
      "WHERE user_id = ? AND role = 'maintainer' AND scope_kind = 'repo' AND scope_id = ?",
  );
  values.push(user.id, repoKey);
  parts.push("SELECT 'repo_owner' AS role, owner AS value, NULL AS slug, NULL AS title FROM repo_owner WHERE repo = ?");
  values.push(repoKey);
  return community.prepare(parts.join(" UNION ALL ")).bind(...values);
}

/** Verified authors read at most for the suggested reviewers. */
export const REVIEWERS_MAX = 30;

/** The verified authors of these papers with a GitHub login, by the roles' index (roles_scope,
 *  migrations/d1-community/0003) and the users' key: never a scan. */
function authorsOf(community: D1Database, paperIds: string[]): D1PreparedStatement {
  return community
    .prepare(
      "SELECT u.github_login AS login, r.scope_id AS paper FROM roles r JOIN users u ON u.id = r.user_id " +
        `WHERE r.scope_kind = 'paper' AND r.scope_id IN (${paperIds.map(() => "?").join(", ")}) AND r.role = 'verified_author' ` +
        `AND u.github_login IS NOT NULL AND u.github_login != '' LIMIT ${REVIEWERS_MAX}`,
    )
    .bind(...paperIds);
}

/** OSCR's layer over one repository, as the reader sees it. Reads: the repository (1 row), its
 *  papers, the traced count (1), the pending jobs, the reader's roles and facts. */
export async function repoLayer(db: D1Database, community: D1Database, user: User, row: RepoRow, t: number): Promise<RepoLayerAnswer> {
  const [papersRes, tracedRes, jobsRes, tiesRes, answeredRes, packagesRes] = await db.batch([
    papersOf(db, row.forge, row.repo_id),
    tracedCount(db, row.forge, row.repo_id),
    pendingJobsOf(db, row.forge, row.repo_id, JOBS_TAIL),
    releasePapersOf(db, row.forge, row.repo_id),
    recentJobsOf(db, row.forge, row.repo_id, ["release", "deposit", "archive"], JOBS_TAIL),
    packagesOfRepo(db, row.forge, row.repo_id),
  ]);
  const ties = (tiesRes?.results ?? []) as unknown as ReleasePaperRow[];
  const answered = ((answeredRes?.results ?? []) as { kind: string; ref: string; paper_id: string; done_at: number | null; outcome: string; message: string }[]).filter((j) => j.done_at !== null);
  const paperRows = (papersRes?.results ?? []) as { paper_id: string; status: PaperStatus; at: number }[];
  const traced = ((tracedRes?.results ?? [])[0] ?? { paths: 0, maps: 0 }) as { paths: number; maps: number };
  const jobRows = (jobsRes?.results ?? []) as { id: number; kind: string; ref: string; created_at: number; not_before: number | null }[];

  const repoKey = `${COMMUNITY_HOST[row.forge]}/${row.owner_login}/${row.name}`;
  const facts = await all<CommunityRow>(communityFacts(community, user, repoKey, paperRows.map((p) => p.paper_id)));
  const authored = new Map(facts.filter((f) => f.role === "verified_author").map((f) => [f.value, f]));
  const login = (user.github_login ?? "").toLowerCase();
  const maintainer =
    facts.some((f) => f.role === "maintainer") || (login !== "" && facts.some((f) => f.role === "repo_owner" && f.value.toLowerCase() === login));

  const roles: LayerRole[] = [];
  if (authored.size) roles.push("verified_author");
  if (maintainer) roles.push("maintainer");
  if (login !== "" && row.owner_login === login) roles.push("owner");
  if (row.linked_by === user.id) roles.push("linked_by");

  const papers: LayerPaper[] = paperRows.map((p) => {
    const f = authored.get(p.paper_id);
    return { doi: p.paper_id.slice(4), status: p.status, slug: f?.slug || null, title: f?.title || null, at: Number(p.at) };
  });
  const may = roles.some((role) => role === "maintainer" || role === "owner" || role === "linked_by");
  // The paper's verified authors as reviewers: to the people who manage the code or wrote a paper.
  const reviewers = new Map<string, { login: string; papers: string[] }>();
  if ((may || authored.size) && paperRows.length) {
    for (const a of await all<{ login: string; paper: string }>(authorsOf(community, paperRows.map((p) => p.paper_id)))) {
      const e = reviewers.get(a.login.toLowerCase()) ?? { login: a.login, papers: [] };
      e.papers.push(a.paper.replace(/^doi:/, ""));
      reviewers.set(a.login.toLowerCase(), e);
    }
  }

  return {
    forge: row.forge,
    id: row.repo_id,
    owner: row.owner_login,
    name: row.name,
    url: repoUrl(row),
    mode: row.mode,
    template: Number(row.template) === 1,
    defaultBranch: row.default_branch,
    head: row.head,
    headAt: row.head_at,
    lastSeen: row.updated_at,
    status: statusLine(row),
    state: row.state,
    deleteAfter: row.delete_after,
    stateSentence: stateSentence(row),
    restore: row.state === "pending_deletion" && may,
    papers,
    roles,
    authorOf: papers.filter((p) => authored.has(`doi:${p.doi}`)).map((p) => p.doi),
    maps: Number(traced.maps ?? 0),
    paths: Number(traced.paths ?? 0),
    jobs: jobRows.map((j) => ({ id: Number(j.id), kind: j.kind, ref: j.ref, createdAt: Number(j.created_at), notBefore: j.not_before })),
    reviewers: [...reviewers.values()],
    releaseTies: ties.map((t) => ({ tag: t.tag, paper: t.paper_id.replace(/^doi:/, ""), version: t.version, label: t.label, status: t.status, commit: t.commit_sha || null, shown: t.map_digest || null })),
    answered: answered.map((j) => ({ kind: j.kind, ref: j.ref, paper: (j.paper_id ?? "").replace(/^doi:/, ""), outcome: j.outcome, message: j.message, doneAt: Number(j.done_at) })),
    packages: ((packagesRes?.results ?? []) as { registry: string; name: string; status: string; version: string; source: string }[]).map((p) => ({ registry: p.registry, name: p.name, status: p.status, version: p.version, source: p.source })),
  };
}

export async function handleRepo(r: ForgeRequest): Promise<Response> {
  const who = await reader(r);
  if (who instanceof Response) return who;
  const target = parseTarget(r.url, serviceForge(r));
  if (!target) return problem(400, "invalid", "Name one repository: ?id=<forge>:<id> or ?path=<owner>/<name>.");
  const row =
    "id" in target
      ? await first<RepoRow>(repoByKey(r.db, target.forge, target.id))
      : await first<RepoRow>(repoByPath(r.db, target.forge, target.owner, target.name));
  // A hidden repository is answered exactly as an unknown one: nothing of it goes out.
  if (!row || row.state === "hidden") return problem(404, "not_found", NOT_FOUND);
  return json(await repoLayer(r.db, who.community, who.user, row, r.t));
}

// ─── GET /api/forge/mine ─────────────────────────────────────────────────────

/** The filters and the page a query asks for, or a sentence saying what is wrong. */
export function parseMine(url: URL): { mode: MineMode | null; template: boolean | null; after: string; limit: number } | string {
  const q = url.searchParams;
  const mode = q.get("mode") || null;
  if (mode !== null && !(MINE_MODES as readonly string[]).includes(mode)) return "The mode is one of created, installed, public or mirror.";
  const templateText = q.get("template") || null;
  if (templateText !== null && templateText !== "true" && templateText !== "false") return "The template filter is true or false.";
  const after = (q.get("after") ?? "").toLowerCase();
  if (after !== "" && !SEGMENT.test(after)) return "The page cursor is not one this list gave.";
  const limitText = q.get("limit");
  let limit = MINE_PAGE;
  if (limitText !== null && limitText !== "") {
    if (!/^\d{1,3}$/.test(limitText) || Number(limitText) < 1) return `The page size is a number from 1 to ${MINE_PAGE_MAX}.`;
    limit = Math.min(Number(limitText), MINE_PAGE_MAX);
  }
  return { mode: mode as MineMode | null, template: templateText === null ? null : templateText === "true", after, limit };
}

/** The account's repositories waiting for deletion, the nearest end of grace first (repos_path's
 *  prefix, then the state: rows read are the account's repositories). */
function pendingOfOwner(db: D1Database, forge: ForgeName, login: string): D1PreparedStatement {
  return db
    .prepare(
      "SELECT * FROM repos WHERE forge = ? AND owner_login = ? AND state = 'pending_deletion' ORDER BY delete_after, name LIMIT ?",
    )
    .bind(forge, login.toLowerCase(), MINE_PENDING_MAX);
}

/** The number of papers of each listed repository: one statement, by the key's prefix of each. */
function paperCounts(db: D1Database, forge: ForgeName, ids: string[]): D1PreparedStatement {
  return db
    .prepare(
      `SELECT repo_id, count(*) AS n FROM repo_papers WHERE forge = ? AND repo_id IN (${ids.map(() => "?").join(", ")}) GROUP BY repo_id`,
    )
    .bind(forge, ...ids);
}

function item(row: RepoRow, papers: number): MineItem {
  return {
    forge: row.forge,
    id: row.repo_id,
    owner: row.owner_login,
    name: row.name,
    url: repoUrl(row),
    mode: row.mode,
    state: row.state,
    template: Number(row.template) === 1,
    papers,
    headAt: row.head_at,
    lastSeen: row.updated_at,
    deleteAfter: row.delete_after,
  };
}

/** One page of the account's repositories by name, after `after`. `mirror` reads the installed
 *  and the public ones (two ranges of the same prefix) and merges them by name. */
async function pageOf(
  db: D1Database,
  forge: ForgeName,
  login: string,
  q: { mode: MineMode | null; template: boolean | null; after: string; limit: number },
): Promise<{ rows: RepoRow[]; next: string | null }> {
  const opts = { after: q.after, limit: q.limit + 1, ...(q.template === null ? {} : { template: q.template }) };
  const modes: (RepoMode | undefined)[] = q.mode === "mirror" ? ["installed", "public"] : [q.mode ?? undefined];
  const lists = await Promise.all(modes.map((mode) => all<RepoRow>(reposOfOwner(db, forge, login, mode ? { ...opts, mode } : opts))));
  const merged = lists.flat().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rows = merged.slice(0, q.limit);
  return { rows, next: merged.length > q.limit ? rows[rows.length - 1].name : null };
}

export async function handleMine(r: ForgeRequest): Promise<Response> {
  const who = await reader(r);
  if (who instanceof Response) return who;
  const q = parseMine(r.url);
  if (typeof q === "string") return problem(400, "invalid", q);
  const filters = { mode: q.mode, template: q.template };
  const login = who.user.github_login;
  if (!login) {
    const answer: MineAnswer = {
      github: null,
      filters,
      repositories: [],
      next: null,
      sentence: "Your repositories are the ones in your GitHub account: link your GitHub account from your account page to see them here.",
    };
    return json(answer);
  }
  const forge = serviceForge(r);
  const firstPage = q.after === "";
  const [page, pending] = await Promise.all([
    pageOf(r.db, forge, login, q),
    firstPage ? all<RepoRow>(pendingOfOwner(r.db, forge, login)) : Promise.resolve([] as RepoRow[]),
  ]);
  const ids = [...new Set([...page.rows, ...pending].map((row) => row.repo_id))];
  const counts = new Map<string, number>();
  if (ids.length) {
    for (const c of await all<{ repo_id: string; n: number }>(paperCounts(r.db, forge, ids))) counts.set(c.repo_id, Number(c.n));
  }
  const answer: MineAnswer = {
    github: login,
    filters,
    repositories: page.rows.map((row) => item(row, counts.get(row.repo_id) ?? 0)),
    next: page.next,
  };
  if (firstPage) {
    answer.pending = pending.map((row) => item(row, counts.get(row.repo_id) ?? 0));
    const caps = await dailyCaps(r.db, who.user.id, "link", r.t);
    answer.caps = { limits: caps.limits, used: caps.used };
    answer.open = await openTo(r, who.community, who.user.id);
  }
  return json(answer);
}

/** Whether the reader's linked GitHub account may start actions (gate.ts mayWrite): FORGE_OPEN, or
 *  the owner's id. The GitHub identity is read by identities_user only when the gate is not open. */
async function openTo(r: ForgeRequest, community: D1Database, userId: string): Promise<boolean> {
  if ((r.env.FORGE_OPEN ?? "").trim() === "true") return true;
  const identity = await first<{ subject: string }>(
    community.prepare("SELECT subject FROM identities WHERE user_id = ? AND provider = 'github'").bind(userId),
  );
  return mayWrite(r.env, identity?.subject ?? null);
}
