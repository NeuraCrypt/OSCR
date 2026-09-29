// The contributions (Phase 6): what a signed-in reader asks of the registry, recorded in D1 for the
// Mac, which polls it (`oscr jobs poll`) and writes the outcome back. One entry point,
// `handleContributions`, which the Worker's entry (worker/index.ts) calls for its paths:
//
//   GET  /api/contributions                    the account page's lists: submissions, edits, validations, requests
//   GET  /api/contributions/paper?id=<paper>   a paper's page: the reader's roles and requests about that paper
//   POST /api/submissions                      {doi, code_urls: [...], note}     a paper and its code
//   POST /api/submissions/<id>/revise          {code_urls: [...], note}          the links corrected
//   POST /api/submissions/<id>/publish                                          the draft published
//   POST /api/claims                           {paper_id, statement, link}       "I am an author of this paper"
//   POST /api/edits                            {paper_id, as, repo, changes, note}   a correction of its links
//   POST /api/validations                      {paper_id, map_digest}            its tracing map validated
//   POST /api/reports                          {paper_id, role, scope, repo, path, reason, details,
//                                              evidence_url, confirm_accurate, confirm_review}
//                                              a removal request (the page /removal/)
//
// Every POST needs the session, its CSRF token and the site's own Origin (account/guard.ts, as the
// accounts'); every answer is JSON, `Cache-Control: no-store`. The contract, the rows each route
// writes and the free plan's budget: docs/CONTRIBUTIONS.md.

import { ASK_AGAIN, maintainerTrusted, mayAskAgain, reportPath } from "../../src/lib/moderation.ts";
import { checkRequest, loadFacts, type PaperFacts } from "../../src/lib/removal.ts";
import { MAX_PENDING, paperSlug } from "../account/index.ts";
import { measured, now, readJson, ready, signedIn, staleCookies, type SignedIn } from "../account/guard.ts";
import { json, problem } from "../account/http.ts";
import { repoKey } from "../account/repo.ts";
import { csrfToken } from "../account/session.ts";
import { hasRole, identitiesOf, pendingClaims, reads, type Role } from "../account/store.ts";
import type { AccountEnv, Context, D1Database } from "../account/types.ts";
import {
  authorClaimJson,
  editJson,
  iso,
  paperId,
  paperUrl,
  reportJson,
  submissionJson,
  validationJson,
} from "./answers.ts";
import { checkDoi, checkLinks, type CheckEnv, type LinkCheck } from "./checks.ts";
import { isKey, normalizeDoi, recognize, type Recognized, type Role as LinkRole } from "./links.ts";
import {
  authorClaimsSince,
  countSince,
  createEdit,
  createReport,
  createSubmission,
  createValidation,
  latestValidation,
  lists,
  MAX_REVISIONS,
  reopenReport,
  mySubmission,
  ofPaper,
  pendingAuthorClaim,
  publishSubmission,
  REVISABLE,
  reportOf,
  reviseSubmission,
  submissionOf,
  updateReport,
  isRepoOfPaper,
  type AuthorClaimRow,
  type EditRow,
  type ReportRow,
  type SubmissionRow,
  type ValidationRow,
} from "./store.ts";
import { asset, type Assets } from "../pages.ts";
import { cleanText, cleanUrl } from "./text.ts";

/** The Worker's environment as the contributions read it: the accounts', the development mock of
 *  the checks, and the site's own files (a removal request names a paper, a repository and a file
 *  that the site's pages show). */
export type ContributionsEnv = AccountEnv & CheckEnv & { ASSETS?: Assets };

/** What one account may ask in a day (24 hours): counted from its rows in D1, which the account
 *  page's indexes read, so a limit costs no write. The Worker's share of D1's writes is 10,000 rows
 *  a day; at 3 rows a request, one account stays under ~200 rows. */
export const LIMITS = { submissions: 10, edits: 20, validations: 10, reports: 10, claims: 10 } as const;
/** Code links of one submission, changes of one edit. */
export const MAX_LINKS = 5;
export const MAX_CHANGES = 10;
const DAY = 86_400;

/** The paths of the contributions. */
const OURS = /^\/api\/(contributions|submissions|claims|edits|validations|reports)(\/|$)/;

/** The contributions' answer to `request`, or null when its path is not theirs. */
export async function handleContributions(request: Request, env: ContributionsEnv | object, _ctx?: Context): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  if (!OURS.test(path)) return null;
  return measured(env as ContributionsEnv, async (e) => {
    try {
      return await route(request, e as ContributionsEnv, url, path);
    } catch (err) {
      return failure(err, path);
    }
  });
}

function failure(err: unknown, path: string): Response {
  const message = String((err as Error)?.message ?? err);
  console.error(`contributions ${path}: ${message.slice(0, 300)}`);
  if (/D1/.test(message) && /exceeded|limit/i.test(message)) {
    return problem(503, "quota", "The registry has used its daily quota. Please try again tomorrow.");
  }
  return problem(503, "unavailable", "The registry is unavailable at the moment. Please try again later.");
}

async function route(request: Request, env: ContributionsEnv, url: URL, path: string): Promise<Response> {
  const t = now();
  const get = request.method === "GET" || request.method === "HEAD";
  const post = request.method === "POST";
  const wrong = (use: string) => problem(405, "method_not_allowed", `Use ${use}.`);
  if (path === "/api/contributions") return get ? mine(request, env, t) : wrong("GET");
  if (path === "/api/contributions/paper") return get ? paperState(request, env, url, t) : wrong("GET");
  const submission = /^\/api\/submissions\/(\d{1,12})\/(revise|publish)$/.exec(path);
  if (submission) {
    if (!post) return wrong("POST");
    return submission[2] === "revise" ? revise(request, env, Number(submission[1]), t) : publish(request, env, Number(submission[1]), t);
  }
  const writes: Record<string, (request: Request, env: ContributionsEnv, t: number) => Promise<Response>> = {
    "/api/submissions": submit,
    "/api/claims": claim,
    "/api/edits": edit,
    "/api/validations": validate,
    "/api/reports": report,
  };
  const write = writes[path];
  if (write) return post ? write(request, env, t) : wrong("POST");
  return problem(404, "not_found", "No such route.");
}

/** The signed-in account behind a POST, and its JSON body (at most `max` bytes). */
async function posted(request: Request, env: ContributionsEnv, t: number, max?: number): Promise<{ s: SignedIn; body: Record<string, unknown> } | Response> {
  const s = await signedIn(request, env, t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const body = await readJson(request, max);
  if (!body) return problem(400, "bad_request", "The form could not be read: reload the page, then try again.", s.cookies);
  return { s, body };
}

const tooMany = (s: SignedIn, what: string, n: number) =>
  problem(429, "too_many", `You have made ${n} ${what} in the last 24 hours, the most one account may: please come back tomorrow.`, s.cookies);

// ---------------------------------------------------------------------------------------------
// Reads.

async function mine(request: Request, env: ContributionsEnv, t: number): Promise<Response> {
  const s = await signedIn(request, env, t, { post: false, touch: true });
  if (s instanceof Response) return s;
  const { db, user } = s;
  const [subs, edits, validations, reports] = await db.batch([
    lists.submissions(db, user.id),
    lists.edits(db, user.id),
    lists.validations(db, user.id),
    lists.reports(db, user.id),
  ]);
  return json(
    {
      submissions: ((subs?.results ?? []) as unknown as SubmissionRow[]).map(submissionJson),
      edits: ((edits?.results ?? []) as unknown as EditRow[]).map(editJson),
      validations: ((validations?.results ?? []) as unknown as ValidationRow[]).map(validationJson),
      reports: ((reports?.results ?? []) as unknown as ReportRow[]).map((r) => reportJson(r)),
      limits: LIMITS,
    },
    200,
    s.cookies,
  );
}

/** A paper's page asks this once, when the browser holds a session (the hint cookie): who reads
 *  it, what they may do there, and what they already asked about it. */
async function paperState(request: Request, env: ContributionsEnv, url: URL, t: number): Promise<Response> {
  const id = paperId(url.searchParams.get("id"));
  if (!id) return problem(400, "bad_paper", "This is not a paper of the registry.");
  if (!ready(env)) return json({ signed_in: false, available: false });
  const s = await signedIn(request, env, t, { post: false, touch: true });
  if (s instanceof Response) {
    if (s.status !== 401) return s;
    return json({ signed_in: false, available: true }, 200, staleCookies(request));
  }
  const { db, user } = s;
  const doi = id.startsWith("doi:") ? id.slice(4) : "";
  const [roles, claimRow, validationRow, reportRow, editRows, submissionRow] = await db.batch([
    reads.roles(db, user.id),
    ofPaper.claim(db, user.id, id),
    ofPaper.validation(db, user.id, id),
    ofPaper.report(db, user.id, id),
    ofPaper.edits(db, user.id, id),
    ofPaper.submission(db, user.id, doi),
  ]);
  const held = (roles?.results ?? []) as unknown as Role[];
  const first = <T>(r: { results?: unknown[] } | undefined): T | null => ((r?.results ?? [])[0] as T | undefined) ?? null;
  const claimed = first<AuthorClaimRow>(claimRow);
  const validation = first<ValidationRow>(validationRow);
  const removal = first<ReportRow>(reportRow);
  const submission = first<SubmissionRow>(submissionRow);
  return json(
    {
      signed_in: true,
      available: true,
      user: { display_name: user.display_name, orcid: user.orcid, github: user.github_login },
      paper: { id, url: paperUrl(id) },
      author: held.some((r) => r.role === "verified_author" && r.scope_kind === "paper" && r.scope_id === id),
      maintains: held.filter((r) => r.role === "maintainer" && r.scope_kind === "repo").map((r) => r.scope_id),
      claim: claimed ? authorClaimJson(claimed) : null,
      validation: validation ? validationJson(validation) : null,
      report: removal ? reportJson(removal) : null,
      edits: ((editRows?.results ?? []) as unknown as EditRow[]).map(editJson),
      submission: submission ? submissionJson(submission) : null,
      csrf: await csrfToken(s.key, s.session.idHash),
    },
    200,
    s.cookies,
  );
}

/** The repositories an account maintains as a maintainer the moderator's rules trust
 *  (lib/moderation.ts, maintainerTrusted): its owner or a public member of its organization on GitHub,
 *  or made one by the owner — not a contributor. One read, of the account's verified maintainer claims
 *  (which keep how GitHub showed it), when it holds a maintainer role. */
async function trustedRepos(db: D1Database, userId: string, roles: Role[]): Promise<Set<string>> {
  const held = roles.filter((x) => x.role === "maintainer" && x.scope_kind === "repo");
  if (!held.length) return new Set();
  const claims =
    (await db
      .prepare("SELECT repo, evidence, decided_by FROM claims WHERE user_id = ? AND kind = 'maintainer' AND status = 'verified'")
      .bind(userId)
      .all<{ repo: string; evidence: string; decided_by: string }>()).results ?? [];
  const how = new Map(
    claims.map((c) => {
      let via = "";
      try {
        via = String((JSON.parse(c.evidence || "{}") as { via?: unknown }).via ?? "");
      } catch {
        via = "";
      }
      return [c.repo, { via, decided: c.decided_by ?? "" }] as const;
    }),
  );
  return new Set(held.filter((m) => maintainerTrusted(how.get(m.scope_id)?.via ?? "", how.get(m.scope_id)?.decided ?? "", m.granted_by ?? "")).map((m) => m.scope_id));
}

// ---------------------------------------------------------------------------------------------
// Links, as a form gives them.

type Typed = { typed: string; link: Recognized | null };

/** The links of a form: recognized (a place the registry knows), one per key. */
function readLinks(value: unknown, role: LinkRole, most: number): { links: Recognized[]; unknown: string[]; count: number } {
  const typed = (Array.isArray(value) ? value : [])
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  const recognized: Typed[] = typed.slice(0, most + 1).map((t) => ({ typed: t, link: recognize(t, role) }));
  const seen = new Set<string>();
  const links: Recognized[] = [];
  for (const r of recognized) {
    if (r.link && !seen.has(r.link.key)) {
      seen.add(r.link.key);
      links.push(r.link);
    }
  }
  return { links, unknown: recognized.filter((r) => !r.link).map((r) => r.typed.slice(0, 300)), count: typed.length };
}

const checkJson = (c: LinkCheck) => ({ url: c.url, key: c.key, outcome: c.outcome, status: c.status });

/** The links that do not answer (404, 410): refused at once. */
function deadLinks(s: SignedIn, checks: LinkCheck[]): Response | null {
  const dead = checks.filter((c) => c.outcome === "missing");
  if (!dead.length) return null;
  return problem(
    422,
    "dead_links",
    `${dead.length === 1 ? "This link does not answer" : "These links do not answer"} (not found): ${dead.map((c) => c.url).join(", ")}.`,
    s.cookies,
  );
}

function unknownPlaces(s: SignedIn, unknown: string[], role: LinkRole): Response {
  return problem(
    400,
    "unknown_place",
    `The registry does not know where ${unknown.length === 1 ? "this link points" : "these links point"}: ${unknown.join(", ")}. ` +
      (role === "code"
        ? "Code links go to a forge (GitHub, GitLab, Codeberg, Bitbucket…) or an archive (Zenodo, OSF, figshare, Code Ocean, Hugging Face)."
        : "Links go to a forge, an archive or a data repository (OpenNeuro, DANDI, a dataset's DOI…)."),
    s.cookies,
  );
}

// ---------------------------------------------------------------------------------------------
// Submissions.

async function submit(request: Request, env: ContributionsEnv, t: number): Promise<Response> {
  const p = await posted(request, env, t);
  if (p instanceof Response) return p;
  const { s, body } = p;
  const { db, user } = s;
  const doi = normalizeDoi(body.doi);
  if (!doi) return problem(400, "bad_doi", "Give the paper's DOI, such as 10.1234/abcd.", s.cookies);
  const { links, unknown, count } = readLinks(body.code_urls, "code", MAX_LINKS);
  if (count === 0) return problem(400, "no_links", "Give at least one link to the authors' code.", s.cookies);
  if (count > MAX_LINKS) return problem(400, "too_many_links", `Give at most ${MAX_LINKS} code links.`, s.cookies);
  if (unknown.length) return unknownPlaces(s, unknown, "code");
  const before = await submissionOf(db, user.id, doi);
  if (before) {
    return json(
      { error: { code: "already_submitted", message: "You have already submitted this paper: see it on your account page." }, submission: submissionJson(before) },
      409,
      s.cookies,
    );
  }
  const n = await countSince(db, "submissions", user.id, t - DAY);
  if (n >= LIMITS.submissions) return tooMany(s, "submissions", n);
  // The checks, all at once: waiting on the network costs no CPU.
  const [doiCheck, checks] = await Promise.all([checkDoi(env, doi), checkLinks(env, links)]);
  if (doiCheck.outcome === "missing") return problem(422, "unknown_doi", `The DOI ${doi} is not registered: check it, then try again.`, s.cookies);
  const dead = deadLinks(s, checks);
  if (dead) return dead;
  const note = cleanText(body.note, 1000);
  const recorded = { doi: doiCheck.outcome, links: checks.map(checkJson), at: t };
  const id = await createSubmission(db, { userId: user.id, doi, codeUrls: links.map((l) => l.url), note, checks: recorded, now: t });
  const row = await mySubmission(db, user.id, id);
  return json({ status: "queued", submission: row ? submissionJson(row) : { id } }, 201, s.cookies);
}

async function revise(request: Request, env: ContributionsEnv, id: number, t: number): Promise<Response> {
  const p = await posted(request, env, t);
  if (p instanceof Response) return p;
  const { s, body } = p;
  const { db, user } = s;
  const before = await mySubmission(db, user.id, id);
  if (!before) return problem(404, "not_found", "No such submission of yours.", s.cookies);
  if (!(REVISABLE as readonly string[]).includes(before.status)) {
    return problem(409, "not_revisable", "This submission cannot be corrected now: wait for its draft.", s.cookies);
  }
  if (before.revisions >= MAX_REVISIONS) {
    return problem(429, "too_many_revisions", `A submission can be corrected ${MAX_REVISIONS} times: submit the paper again later.`, s.cookies);
  }
  const { links, unknown, count } = readLinks(body.code_urls, "code", MAX_LINKS);
  if (count === 0) return problem(400, "no_links", "Give at least one link to the authors' code.", s.cookies);
  if (count > MAX_LINKS) return problem(400, "too_many_links", `Give at most ${MAX_LINKS} code links.`, s.cookies);
  if (unknown.length) return unknownPlaces(s, unknown, "code");
  const checks = await checkLinks(env, links);
  const dead = deadLinks(s, checks);
  if (dead) return dead;
  const note = cleanText(body.note, 1000);
  const recorded = { links: checks.map(checkJson), at: t };
  if (!(await reviseSubmission(db, { id, userId: user.id, codeUrls: links.map((l) => l.url), note, checks: recorded, now: t }))) {
    return problem(409, "not_revisable", "This submission changed meanwhile: reload the page.", s.cookies);
  }
  const row = await mySubmission(db, user.id, id);
  return json({ status: "queued", submission: row ? submissionJson(row) : { id } }, 200, s.cookies);
}

async function publish(request: Request, env: ContributionsEnv, id: number, t: number): Promise<Response> {
  const s = await signedIn(request, env, t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const { db, user } = s;
  const before = await mySubmission(db, user.id, id);
  if (!before) return problem(404, "not_found", "No such submission of yours.", s.cookies);
  if (before.status !== "draft") return problem(409, "not_draft", "Only a draft can be published: wait for it, or reload the page.", s.cookies);
  if (!(await publishSubmission(db, { id, userId: user.id, now: t }))) {
    return problem(409, "not_draft", "This submission changed meanwhile: reload the page.", s.cookies);
  }
  const row = await mySubmission(db, user.id, id);
  return json({ status: row?.status ?? "moderation", submission: row ? submissionJson(row) : { id } }, 200, s.cookies);
}

// ---------------------------------------------------------------------------------------------
// Author claims by hand.

async function claim(request: Request, env: ContributionsEnv, t: number): Promise<Response> {
  const p = await posted(request, env, t);
  if (p instanceof Response) return p;
  const { s, body } = p;
  const { db, user } = s;
  const paper = paperId(body.paper_id);
  if (!paper) return problem(400, "bad_paper", "This is not a paper of the registry.", s.cookies);
  if (await hasRole(db, user.id, "verified_author", "paper", paper)) return json({ status: "verified", already: true }, 200, s.cookies);
  const statement = cleanText(body.statement, 1000);
  if (statement.length < 10) {
    return problem(400, "no_statement", "Say in a few words why you are one of this paper's authors.", s.cookies);
  }
  const link = cleanUrl(body.link);
  if (typeof body.link === "string" && body.link.trim() && !link) {
    return problem(400, "bad_link", "The link must be a web address (https://…).", s.cookies);
  }
  if ((await pendingClaims(db, user.id)) >= MAX_PENDING) {
    return problem(429, "too_many_claims", `You have ${MAX_PENDING} claims waiting: please wait until they are decided.`, s.cookies);
  }
  const n = await authorClaimsSince(db, user.id, t - DAY);
  if (n >= LIMITS.claims) return tooMany(s, "claims", n);
  // Which ORCID the iD is from: the moderator's rules look the claimant's record up there (oscr/moderation.py).
  const evidence = { statement, link, orcid: user.orcid ?? "", github: user.github_login ?? "", orcid_issuer: orcidProof(env) === "orcid" ? "orcid" : "sandbox", at: t };
  const row = await pendingAuthorClaim(db, user.id, paper, evidence, t);
  const answer = { status: row.status, claim: authorClaimJson(row) };
  return json(answer, row.status === "pending" ? 202 : 200, s.cookies);
}

// ---------------------------------------------------------------------------------------------
// Edits.

type Change =
  | { op: "add"; url: string; key: string; role: "code" | "data" }
  | { op: "remove"; repo: string }
  | { op: "role"; repo: string; role: "code" | "data" | "tool" };

async function edit(request: Request, env: ContributionsEnv, t: number): Promise<Response> {
  const p = await posted(request, env, t);
  if (p instanceof Response) return p;
  const { s, body } = p;
  const { db, user } = s;
  const paper = paperId(body.paper_id);
  if (!paper) return problem(400, "bad_paper", "This is not a paper of the registry.", s.cookies);
  // Who may: a verified author of the paper, or a maintainer of one of its code repositories.
  const asMaintainer = body.as === "maintainer";
  const repo = asMaintainer ? repoKey(typeof body.repo === "string" ? body.repo : "") : "";
  if (asMaintainer) {
    if (!repo || !(await hasRole(db, user.id, "maintainer", "repo", repo)) || !(await isRepoOfPaper(db, repo, paper))) {
      return problem(403, "not_allowed", "Only a maintainer of this paper's code may correct its record as such.", s.cookies);
    }
    // A contributor is shown as a maintainer by GitHub's check, but one merged pull request makes one.
    const roles = ((await reads.roles(db, user.id).all<Role>()).results ?? []) as Role[];
    if (!(await trustedRepos(db, user.id, roles)).has(repo)) {
      return problem(
        403,
        "not_allowed",
        "Only the owner of this repository, or a public member of its organization, may correct the paper's record as its maintainer: GitHub shows you as a contributor. The paper's authors can correct it.",
        s.cookies,
      );
    }
  } else if (!(await hasRole(db, user.id, "verified_author", "paper", paper))) {
    return problem(403, "not_author", "Only a verified author of this paper may correct its record.", s.cookies);
  }
  const raw = Array.isArray(body.changes) ? body.changes : [];
  if (raw.length === 0) return problem(400, "no_changes", "Say what to change.", s.cookies);
  if (raw.length > MAX_CHANGES) return problem(400, "too_many_changes", `At most ${MAX_CHANGES} changes at once.`, s.cookies);
  const changes: Change[] = [];
  const toCheck: Recognized[] = [];
  const touched = new Set<string>();
  for (const c of raw as Record<string, unknown>[]) {
    const op = c && typeof c === "object" ? c.op : undefined;
    if (op === "add") {
      const role = c.role === "data" ? "data" : c.role === "code" ? "code" : null;
      if (!role) return problem(400, "bad_change", "A link added is the authors' code or their data.", s.cookies);
      const link = recognize(c.url, role);
      if (!link) return unknownPlaces(s, [String(c.url ?? "").slice(0, 300)], role);
      if (touched.has(link.key)) continue;
      touched.add(link.key);
      changes.push({ op: "add", url: link.url, key: link.key, role });
      toCheck.push(link);
    } else if (op === "remove" || op === "role") {
      if (!isKey(c.repo)) return problem(400, "bad_change", "A change names a link of this record by its key.", s.cookies);
      const key = c.repo.toLowerCase();
      // A maintainer speaks for their own repository.
      if (asMaintainer && key !== repo) {
        return problem(403, "not_allowed", "As a maintainer, you may remove or reclassify your own repository only.", s.cookies);
      }
      if (touched.has(key)) continue;
      touched.add(key);
      if (op === "remove") changes.push({ op, repo: key });
      else {
        const role = c.role === "code" || c.role === "data" || c.role === "tool" ? c.role : null;
        if (!role) return problem(400, "bad_change", "A link is the authors' code, their data, or a tool they used.", s.cookies);
        changes.push({ op, repo: key, role });
      }
    } else {
      return problem(400, "bad_change", "A change adds a link, removes one, or says what a link is.", s.cookies);
    }
  }
  const n = await countSince(db, "edits", user.id, t - DAY);
  if (n >= LIMITS.edits) return tooMany(s, "corrections", n);
  const dead = deadLinks(s, await checkLinks(env, toCheck));
  if (dead) return dead;
  const note = cleanText(body.note, 500);
  const id = await createEdit(db, {
    userId: user.id,
    paperId: paper,
    asRole: asMaintainer ? "maintainer" : "verified_author",
    repo,
    changes,
    note,
    now: t,
  });
  return json(
    {
      status: "queued",
      edit: { id, paper_id: paper, url: paperUrl(paper), as_role: asMaintainer ? "maintainer" : "verified_author", repo, changes, note, status: "queued", created_at: iso(t) },
    },
    202,
    s.cookies,
  );
}

// ---------------------------------------------------------------------------------------------
// Validations.

/** Which ORCID signs the registry's readers in: orcid.org, or its sandbox (the default while the
 *  platform is built, whose iDs are tests). */
export function orcidProof(env: AccountEnv): "orcid" | "orcid-sandbox" {
  return (env.ORCID_ISSUER ?? "").trim().replace(/\/+$/, "") === "https://orcid.org" ? "orcid" : "orcid-sandbox";
}

async function validate(request: Request, env: ContributionsEnv, t: number): Promise<Response> {
  const p = await posted(request, env, t);
  if (p instanceof Response) return p;
  const { s, body } = p;
  const { db, user } = s;
  const paper = paperId(body.paper_id);
  if (!paper) return problem(400, "bad_paper", "This is not a paper of the registry.", s.cookies);
  const digest = typeof body.map_digest === "string" ? body.map_digest.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(digest)) return problem(400, "bad_map", "The map could not be read: reload the page, then try again.", s.cookies);
  // The proof is the ORCID iD of the identity linked to the account (the one it signed in with).
  const orcid = (await identitiesOf(db, user.id)).find((i) => i.provider === "orcid")?.subject ?? "";
  if (!orcid) return problem(409, "no_orcid", "Link your ORCID iD first: a map is validated with it.", s.cookies);
  if (!(await hasRole(db, user.id, "verified_author", "paper", paper))) {
    return problem(403, "not_author", "Only a verified author of this paper may validate its map.", s.cookies);
  }
  const latest = await latestValidation(db, user.id, paper);
  if (latest?.status === "queued") {
    return json({ error: { code: "already_queued", message: "Your validation of this map is on its way." }, validation: validationJson(latest) }, 409, s.cookies);
  }
  if (latest?.status === "deposited" && latest.map_digest === digest) {
    return json({ error: { code: "already_validated", message: "You have already validated this map." }, validation: validationJson(latest) }, 409, s.cookies);
  }
  const n = await countSince(db, "validations", user.id, t - DAY);
  if (n >= LIMITS.validations) return tooMany(s, "validations", n);
  const proof = orcidProof(env);
  const id = await createValidation(db, { userId: user.id, paperId: paper, orcid, proof, digest, now: t });
  return json(
    {
      status: "queued",
      validation: { id, paper_id: paper, url: paperUrl(paper), orcid, proof, map_digest: digest, status: "queued", created_at: iso(t) },
    },
    202,
    s.cookies,
  );
}

// ---------------------------------------------------------------------------------------------
// Removal requests (the page /removal/).

/** A removal request's body: a justification of 2,000 characters, four bytes each at worst, and a
 *  file's path. */
const REPORT_BODY = 16_384;

/** The facts of a paper as the site shows them (src/lib/removal.ts): the top of its static page,
 *  else its record rendered on demand, through the assets (free: no request counted, no D1 row).
 *  undefined when the Worker has no assets (a misconfiguration: said as unavailable). */
async function factsOf(env: ContributionsEnv, request: Request, paper: string, slug: string): Promise<PaperFacts | null | undefined> {
  const assets = env.ASSETS;
  if (!assets) return undefined;
  const url = new URL(request.url);
  const facts = await loadFacts((path) => asset(assets, url, path), slug, "page-first");
  return facts && facts.id === paper ? facts : null;
}

async function report(request: Request, env: ContributionsEnv, t: number): Promise<Response> {
  const p = await posted(request, env, t, REPORT_BODY);
  if (p instanceof Response) return p;
  const { s, body } = p;
  const { db, user } = s;
  const paper = paperId(body.paper_id);
  if (!paper) return problem(400, "bad_paper", "This is not a paper of the registry.", s.cookies);
  const facts = await factsOf(env, request, paper, paperSlug(paper));
  if (facts === undefined) return problem(503, "unavailable", "The registry is unavailable at the moment. Please try again later.", s.cookies);
  if (facts === null) {
    return problem(404, "unknown_paper", "The registry has no page for this paper: there is nothing of it to remove.", s.cookies);
  }
  const checked = checkRequest(body, facts);
  if (!checked.ok) return json({ error: { code: checked.code, message: checked.message, field: checked.field } }, checked.status, s.cookies);
  const r = checked.request;
  const before = await reportOf(db, user.id, paper);
  // The account's roles (one read): a verified author of the paper, a maintainer of the code the
  // request names. With them, what the moderator's rules will do (lib/moderation.ts).
  const roles = ((await reads.roles(db, user.id).all<Role>()).results ?? []) as Role[];
  const isAuthor = roles.some((x) => x.role === "verified_author" && x.scope_kind === "paper" && x.scope_id === paper);
  const named = r.scope === "scripts" ? facts.repos.map((x) => x.repo) : r.repo ? [r.repo] : [];
  const trusted = await trustedRepos(db, user.id, roles);
  const maintainer = named.some((x) => trusted.has(x));
  const path = reportPath(r.scope, r.reason, isAuthor, maintainer);
  if (before && before.status !== "open" && !(before.status === "rejected" && mayAskAgain(path))) {
    return json(
      { error: { code: "already_decided", message: before.status === "rejected" ? ASK_AGAIN : "Your request about this record has been accepted." }, report: reportJson(before) },
      409,
      s.cookies,
    );
  }
  // An author's request is verified when the account is a verified author of the paper (its ORCID
  // iD among the paper's authors, Phase 5; or the owner's or the rules' decision).
  const authorVerified = r.role === "author" && isAuthor;
  const fields = {
    reason: r.reason,
    details: cleanText(r.details, 2000),
    role: r.role,
    authorVerified,
    scope: r.scope,
    repo: r.repo,
    path: r.path,
    evidenceUrl: r.evidence_url,
  };
  if (before?.status === "open") {
    if (!(await updateReport(db, { id: before.id, userId: user.id, ...fields, now: t }))) {
      return problem(409, "already_decided", "Your request about this record has been decided meanwhile: reload the page.", s.cookies);
    }
    const row = (await reportOf(db, user.id, paper)) ?? before;
    return json({ status: "open", updated: true, report: reportJson(row, path) }, 200, s.cookies);
  }
  // A new request, or a refused one asked again in a way the rules decide at once: the day's limit.
  const n = await countSince(db, "reports", user.id, t - DAY);
  if (n >= LIMITS.reports) return tooMany(s, "requests", n);
  if (before) {
    if (!(await reopenReport(db, { id: before.id, userId: user.id, ...fields, now: t }))) {
      return problem(409, "already_decided", "Your request about this record changed meanwhile: reload the page.", s.cookies);
    }
    const row = (await reportOf(db, user.id, paper)) ?? before;
    return json({ status: "open", reopened: true, report: reportJson(row, path) }, 202, s.cookies);
  }
  await createReport(db, { userId: user.id, paperId: paper, ...fields, now: t });
  const row = await reportOf(db, user.id, paper);
  return json({ status: "open", report: row ? reportJson(row, path) : null }, 202, s.cookies);
}
