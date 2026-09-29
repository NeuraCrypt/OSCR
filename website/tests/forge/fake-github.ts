// A fake GitHub: a fetch handler that answers the endpoints the GitHub adapter calls
// (worker/forge/github/, the design's §11.3) from a MemoryBackend's state, in GitHub's shapes, so
// that the contract (contract.ts) runs on the adapter itself (github-contract.test.ts).
//
// - Hosts: api.github.com (REST and /graphql), uploads.github.com (release assets),
//   raw.githubusercontent.com (anonymous file reads), github.com (the OAuth code exchange).
// - Credentials: "Bearer <token>" is a person of the double, or an installation token this fake
//   minted at POST /app/installations/{id}/access_tokens (with a JWT); none is anonymous.
// - Each REST call becomes the double's own method in a session of that credential; the double's
//   GitBackendErrors become GitHub's statuses and messages (the table of github/http.ts, read
//   backwards). The Git data API (blobs, trees, commits, refs, tag objects) works on the double's
//   object store directly, with GitHub's fast-forward rule.
// - The answers carry `email` fields, as GitHub's do: the adapter must drop them.
// - Webhooks: `payload(event)` writes a ForgeEvent as GitHub would deliver it, for the codec's
//   round trip.
//
// It can also be served over HTTP for `wrangler dev` (FORGE_GITHUB_*_URL), as
// tests/account/mock-server.ts serves the sign-in mocks.

import { GitBackendError } from "../../worker/forge/errors.ts";
import type { GitSession } from "../../worker/forge/gitbackend.ts";
import { base64, fromBase64, utf8 } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";
import { type Flat, ZERO } from "./gitobjects.ts";
import { Call, iso, type MemoryBackend, type MemRepo, type Who } from "./memory.ts";
import { reachable, resolveRev, setBranch, setTag } from "./memory-core.ts";

const API = "api.github.com";

/** The fake's licence templates: name, SPDX id, body with GitHub's placeholders (short texts). */
const LICENSE_BODIES: Record<string, [string, string, string]> = {
  mit: ["MIT License", "MIT", "MIT License\n\nCopyright (c) [year] [fullname]\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction.\n"],
  "apache-2.0": ["Apache License 2.0", "Apache-2.0", "                                 Apache License\n                           Version 2.0, January 2004\n\n   Copyright [yyyy] [name of copyright owner]\n"],
  "bsd-3-clause": ["BSD 3-Clause \"New\" or \"Revised\" License", "BSD-3-Clause", "BSD 3-Clause License\n\nCopyright (c) [year], [fullname]\n"],
  "gpl-3.0": ["GNU General Public License v3.0", "GPL-3.0", "                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n\n    Copyright (C) <year>  <name of author>\n"],
  "cc-by-4.0": ["Creative Commons Attribution 4.0 International", "CC-BY-4.0", "Attribution 4.0 International\n"],
  "cc0-1.0": ["Creative Commons Zero v1.0 Universal", "CC0-1.0", "CC0 1.0 Universal\n"],
};
const CONDUCT_BODY = "# {name}\n\n## Our Pledge\n\nWe pledge to make participation in our community a harassment-free experience for everyone.\n\n## Enforcement\n\nInstances of abusive behavior may be reported to the community leaders responsible for enforcement at [INSERT CONTACT METHOD].\n";
const EMAIL_FIELD = { email: null };

type Json = Record<string, unknown>;
type Handler = (m: RegExpExecArray, x: Exchange) => Promise<Response> | Response;

interface Exchange {
  method: string;
  url: URL;
  headers: Headers;
  body: Uint8Array;
  json: Json;
  who: Who;
  session: GitSession;
}

const dec = (s: string) => decodeURIComponent(s);
const ref = (m: RegExpExecArray): T.RepoRef => ({ forge: "memory", owner: dec(m[1]), name: dec(m[2]) });
const segs = (s: string) => s.split("/").map(dec).join("/");
const num = (id: string | null | undefined) => (id === null || id === undefined ? null : Number(id));

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

function page(url: URL): T.PageRequest {
  const perPage = Number(url.searchParams.get("per_page") ?? "30");
  const p = url.searchParams.get("page");
  return { perPage, cursor: p && p !== "1" ? p : null };
}

/** A page of the double as GitHub's list answer, with its Link header. */
function listed<V>(p: T.Page<V>, url: URL, map: (v: V) => unknown): Response {
  const headers: Record<string, string> = {};
  if (p.next) {
    const next = new URL(url);
    next.searchParams.set("page", p.next);
    headers.Link = `<${next.href}>; rel="next"`;
  }
  return reply(p.items.map(map), 200, headers);
}

// ─── GitHub's shapes ──────────────────────────────────────────────────────

const LEVELS: T.Permission[] = ["none", "read", "triage", "write", "maintain", "admin"];
const atLeast = (p: T.Permission, need: T.Permission) => LEVELS.indexOf(p) >= LEVELS.indexOf(need);

export function userJson(a: T.Actor | null): Json | null {
  if (!a || a.login === null) return null;
  return { login: a.login, id: num(a.id), node_id: `U_${a.id}`, type: "User", ...EMAIL_FIELD };
}

const lite = (r: T.RepoRef | null) => (r ? { name: r.name, full_name: `${r.owner}/${r.name}`, owner: { login: r.owner } } : undefined);

export function repoJson(r: T.RepoInfo): Json {
  const out: Json = {
    id: num(r.key.id),
    node_id: r.nodeId,
    name: r.ref.name,
    full_name: `${r.ref.owner}/${r.ref.name}`,
    owner: { login: r.owner.login, id: num(r.owner.id), type: r.owner.type === "organization" ? "Organization" : "User", ...EMAIL_FIELD },
    private: r.visibility !== "public",
    visibility: r.visibility,
    archived: r.archived,
    disabled: r.disabled,
    is_template: r.isTemplate,
    web_commit_signoff_required: r.signoffRequired,
    default_branch: r.defaultBranch,
    description: r.description || null,
    homepage: r.homepage || null,
    topics: r.topics,
    license: r.licenseSpdx ? { spdx_id: r.licenseSpdx } : null,
    size: r.sizeKb,
    created_at: r.createdAt,
    pushed_at: r.pushedAt,
    has_issues: r.features.issues,
    has_wiki: r.features.wiki,
    allow_auto_merge: r.features.autoMerge,
    delete_branch_on_merge: r.features.deleteBranchOnMerge,
    html_url: `https://github.com/${r.ref.owner}/${r.ref.name}`,
    clone_url: `https://github.com/${r.ref.owner}/${r.ref.name}.git`,
  };
  if (r.parent) out.parent = lite(r.parent);
  if (r.template) out.template_repository = lite(r.template);
  if (r.permission) {
    const p = r.permission;
    out.permissions = { admin: atLeast(p, "admin"), maintain: atLeast(p, "maintain"), push: atLeast(p, "write"), triage: atLeast(p, "triage"), pull: atLeast(p, "read") };
  }
  return out;
}

export function commitJson(c: T.CommitSummary): Json {
  return {
    sha: c.sha,
    commit: {
      author: { name: c.author.name, date: c.authoredAt, ...EMAIL_FIELD },
      committer: { name: c.committer.name, date: c.committedAt, ...EMAIL_FIELD },
      message: c.message,
      tree: { sha: c.tree },
      verification: { verified: c.verified === true },
    },
    author: userJson(c.author),
    committer: userJson(c.committer),
    parents: c.parents.map((sha) => ({ sha })),
  };
}

const fileJson = (f: T.FileChangeSummary): Json => ({
  sha: f.blob ?? ZERO,
  filename: f.path,
  previous_filename: f.previousPath ?? undefined,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  changes: f.additions + f.deletions,
  patch: f.patch ?? undefined,
});

const milestoneJson = (n: number | null) => (n === null ? null : { number: n, title: `#${n}`, state: "open" });

function pullJson(p: T.PullRequest): Json {
  return {
    id: num(p.id),
    node_id: p.nodeId,
    number: p.number,
    title: p.title,
    body: p.body || null,
    state: p.state,
    draft: p.draft,
    merged: p.merged,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommit,
    user: userJson(p.author),
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    closed_at: p.closedAt,
    head: { ref: p.head.ref, sha: p.head.sha, repo: p.head.repo ? lite(p.head.repo) : null },
    base: { ref: p.base.ref, sha: p.base.sha, repo: lite(p.base.repo) },
    mergeable: p.mergeable,
    mergeable_state: p.mergeState,
    requested_reviewers: p.requestedReviewers.map((login) => ({ login })),
    labels: p.labels.map((name) => ({ name })),
    assignees: p.assignees.map((login) => ({ login })),
    milestone: milestoneJson(p.milestone),
    auto_merge: p.autoMerge ? { merge_method: p.autoMerge } : null,
    maintainer_can_modify: p.maintainerCanModify,
    commits: p.counts.commits,
    additions: p.counts.additions,
    deletions: p.counts.deletions,
    changed_files: p.counts.changedFiles,
    comments: p.counts.comments,
    review_comments: 0,
  };
}

function issueJson(i: T.Issue): Json {
  return {
    id: num(i.id),
    node_id: i.nodeId,
    number: i.number,
    title: i.title,
    body: i.body || null,
    state: i.state,
    state_reason: i.stateReason,
    user: userJson(i.author),
    labels: i.labels.map((name) => ({ name, color: "ededed" })),
    assignees: i.assignees.map((login) => ({ login })),
    milestone: milestoneJson(i.milestone),
    locked: i.locked,
    active_lock_reason: i.lockReason,
    comments: i.comments,
    reactions: { total_count: Object.values(i.reactions).reduce((n, x) => n + (x ?? 0), 0), ...i.reactions },
    sub_issues_summary: i.subIssues ? { ...i.subIssues, percent_completed: 0 } : undefined,
    pull_request: i.isPullRequest ? { url: "https://api.github.com/pulls" } : undefined,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    closed_at: i.closedAt,
  };
}

const issueCommentJson = (c: T.IssueComment): Json => ({ id: num(c.id), user: userJson(c.author), body: c.body, created_at: c.createdAt, updated_at: c.updatedAt, reactions: c.reactions });
const reviewJson = (r: T.Review): Json => ({ id: num(r.id), user: userJson(r.author), state: r.state, body: r.body, commit_id: r.commit, submitted_at: r.submittedAt });
const reviewCommentJson = (c: T.ReviewComment): Json => ({
  id: num(c.id),
  pull_request_review_id: num(c.reviewId),
  in_reply_to_id: num(c.inReplyTo) ?? undefined,
  user: userJson(c.author),
  path: c.path,
  line: c.line,
  start_line: c.startLine,
  side: c.side,
  commit_id: c.commit,
  original_commit_id: c.originalCommit,
  body: c.body,
  created_at: c.createdAt,
  updated_at: c.updatedAt,
});
const labelJson = (l: T.Label): Json => ({ name: l.name, color: l.color, description: l.description || null });
const milestoneFull = (m: T.Milestone): Json => ({ number: m.number, title: m.title, description: m.description || null, state: m.state, due_on: m.dueOn, open_issues: m.openIssues, closed_issues: m.closedIssues });
const assetJson = (a: T.ReleaseAsset): Json => ({ id: num(a.id), name: a.name, label: a.label || null, content_type: a.contentType, size: a.size, download_count: a.downloads, browser_download_url: a.downloadUrl, created_at: a.createdAt, uploader: null });
const releaseJson = (r: T.Release): Json => ({
  id: num(r.id),
  tag_name: r.tagName,
  target_commitish: r.target,
  name: r.name,
  body: r.body,
  draft: r.draft,
  prerelease: r.prerelease,
  immutable: r.immutable,
  author: userJson(r.author),
  created_at: r.createdAt,
  published_at: r.publishedAt,
  html_url: r.webUrl,
  assets: r.assets.map(assetJson),
});
const checkRunJson = (c: T.CheckRun): Json => ({
  id: num(c.id),
  name: c.name,
  head_sha: c.headSha,
  status: c.status,
  conclusion: c.conclusion,
  started_at: c.startedAt,
  completed_at: c.completedAt,
  details_url: c.detailsUrl,
  app: c.app ? { slug: c.app } : null,
  output: { title: c.output.title, summary: c.output.summary, annotations_count: c.output.annotations },
});
const installationJson = (i: T.Installation): Json => ({
  id: num(i.id),
  account: { id: num(i.account.id), login: i.account.login, type: i.account.type === "organization" ? "Organization" : "User", ...EMAIL_FIELD },
  repository_selection: i.selection,
  suspended_at: i.suspended ? "2026-09-28T00:00:00Z" : null,
});
const timelineJson = (e: T.TimelineEvent): Json => {
  const out: Json = { event: e.kind === "other" ? "unknown_event" : e.kind, actor: userJson(e.actor), created_at: e.createdAt };
  if (e.kind === "cross-referenced" && e.subject) {
    const [full, n] = e.subject.split("#");
    out.source = { type: "issue", issue: { number: Number(n), repository: { full_name: full } } };
  } else if ((e.kind === "labeled" || e.kind === "unlabeled") && e.subject) out.label = { name: e.subject };
  else if (e.kind === "renamed") out.rename = { to: e.subject };
  else if (e.kind === "milestoned" || e.kind === "demilestoned") out.milestone = { title: e.subject };
  else if (e.kind === "assigned" || e.kind === "unassigned") out.assignee = e.subject ? { login: e.subject } : null;
  else out.commit_id = e.subject;
  return out;
};

const graphCommit = (c: T.CommitSummary): Json => ({
  oid: c.sha,
  committedDate: c.committedAt,
  authoredDate: c.authoredAt,
  message: c.message,
  parents: { nodes: c.parents.map((oid) => ({ oid })) },
  tree: { oid: c.tree },
  author: { name: c.author.name, user: c.author.login ? { login: c.author.login, databaseId: num(c.author.id) } : null },
  committer: { name: c.committer.name, user: c.committer.login ? { login: c.committer.login, databaseId: num(c.committer.id) } : null },
  signature: c.verified === null ? null : { isValid: c.verified },
});

const threadJson = (t: T.ReviewThread): Json => ({
  id: t.id,
  isResolved: t.resolved,
  isOutdated: t.outdated,
  path: t.path,
  line: t.line,
  comments: {
    nodes: t.comments.map((c) => ({
      databaseId: num(c.id),
      path: c.path,
      line: c.line,
      startLine: c.startLine,
      diffSide: c.side,
      body: c.body,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      author: c.author.login ? { login: c.author.login, databaseId: num(c.author.id) } : null,
      commit: { oid: c.commit },
      originalCommit: { oid: c.originalCommit },
      pullRequestReview: c.reviewId ? { databaseId: num(c.reviewId) } : null,
      replyTo: c.inReplyTo ? { databaseId: num(c.inReplyTo) } : null,
    })),
  },
});

/** A double's error as GitHub's answer. */
function failure(e: unknown, now: number): Response {
  if (!(e instanceof GitBackendError)) throw e;
  switch (e.code) {
    case "unauthorized":
      return reply({ message: "Bad credentials" }, 401);
    case "forbidden":
      return reply({ message: "Resource not accessible by integration" }, 403);
    case "archived":
      return reply({ message: "Repository was archived so is read-only." }, 403);
    case "not_found":
      return reply({ message: "Not Found" }, 404);
    case "conflict":
      return reply({ message: e.message }, 409);
    case "not_mergeable":
      return reply({ message: "Pull Request is not mergeable" }, 405);
    case "gone":
      return reply({ message: e.message }, 410);
    case "too_large":
      return reply({ message: e.message }, 413);
    case "rate_limited":
      return reply({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now + (e.retryAfter ?? 60)) });
    case "invalid":
    case "unsupported":
      return reply({ message: "Validation Failed", errors: [{ message: e.message }] }, 422);
    default:
      return reply({ message: "Server Error" }, 502);
  }
}

const GRAPHQL_TYPES: Partial<Record<string, string>> = {
  not_found: "NOT_FOUND",
  forbidden: "FORBIDDEN",
  archived: "FORBIDDEN",
  conflict: "STALE_DATA",
  invalid: "UNPROCESSABLE",
  not_mergeable: "UNPROCESSABLE",
  unsupported: "UNPROCESSABLE",
};

function graphFailure(e: unknown, now: number): Response {
  if (!(e instanceof GitBackendError)) throw e;
  if (e.code === "unauthorized") return reply({ message: "Bad credentials" }, 401);
  if (e.code === "rate_limited") return reply({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }, 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now + (e.retryAfter ?? 60)) });
  return reply({ data: null, errors: [{ type: GRAPHQL_TYPES[e.code] ?? "SERVICE_UNAVAILABLE", message: e.message }] });
}

// ─── the fake ─────────────────────────────────────────────────────────────

export class FakeGitHub {
  readonly double: MemoryBackend;
  readonly client: { id: string; secret: string };
  /** Installation tokens minted here → the installation. */
  readonly minted = new Map<string, string>();
  private routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  private mints = 0;

  constructor(double: MemoryBackend, client: { id: string; secret: string }) {
    this.double = double;
    this.client = client;
    this.api();
  }

  readonly fetch: typeof fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = init.body === undefined || init.body === null ? new Uint8Array(0) : new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
    return this.handle(method, url, headers, body);
  };

  private who(headers: Headers): Who {
    const auth = headers.get("Authorization");
    const m = auth ? /^Bearer (\S+)$/.exec(auth) : null;
    if (!m) return { kind: "anonymous" };
    const installation = this.minted.get(m[1]);
    return installation ? { kind: "installation", installationId: installation } : { kind: "user", token: m[1] };
  }

  private credential(who: Who): T.Credential {
    return who.kind === "anonymous" ? { kind: "anonymous" } : who.kind === "user" ? { kind: "user", token: who.token } : { kind: "installation", installationId: who.installationId };
  }

  async handle(method: string, url: URL, headers: Headers, body: Uint8Array): Promise<Response> {
    const now = this.double.now();
    if (url.host === "github.com") return this.web(method, url, body);
    if (url.host === "raw.githubusercontent.com") return this.raw(url, now);
    const who = this.who(headers);
    let json: Json = {};
    const type = headers.get("Content-Type") ?? "";
    if (body.length && type.startsWith("application/json")) json = JSON.parse(new TextDecoder().decode(body)) as Json;
    const x: Exchange = { method, url, headers, body, json, who, session: this.double.session(this.credential(who)) };
    if (url.host === "uploads.github.com") {
      const m = /^\/repos\/([^/]+)\/([^/]+)\/releases\/(\d+)\/assets$/.exec(url.pathname);
      if (!m || method !== "POST") return reply({ message: "Not Found" }, 404);
      try {
        const a = await x.session.releases.uploadAsset(ref(m), m[3], {
          name: url.searchParams.get("name") ?? "",
          label: url.searchParams.get("label") ?? undefined,
          contentType: headers.get("Content-Type") ?? "application/octet-stream",
          size: body.length,
          body,
        });
        return reply(assetJson(a), 201);
      } catch (e) {
        return failure(e, now);
      }
    }
    if (url.host !== API) return reply({ message: "Not Found" }, 404);
    if (url.pathname === "/graphql" && method === "POST") return this.graphql(x, now);
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      try {
        return await r.handler(m, x);
      } catch (e) {
        return failure(e, now);
      }
    }
    return reply({ message: `Not Found: ${method} ${url.pathname}` }, 404);
  }

  private on(method: string, pattern: RegExp, handler: Handler): void {
    this.routes.push({ method, pattern, handler });
  }

  /** A session's Call on the double, for the Git data API. */
  private call(x: Exchange): Call {
    return new Call(this.double, x.who);
  }

  // github.com: the OAuth code exchange.
  private async web(method: string, url: URL, body: Uint8Array): Promise<Response> {
    if (method !== "POST" || url.pathname !== "/login/oauth/access_token") return reply({ message: "Not Found" }, 404);
    const form = new URLSearchParams(new TextDecoder().decode(body));
    if (form.get("client_id") !== this.client.id || form.get("client_secret") !== this.client.secret) return reply({ error: "incorrect_client_credentials" });
    try {
      const auth = this.double.auth as NonNullable<MemoryBackend["auth"]>;
      const t = await auth.exchange({ code: form.get("code") ?? "", codeVerifier: form.get("code_verifier") ?? "", redirectUri: form.get("redirect_uri") ?? "" });
      return reply({ access_token: t.token, expires_in: 28_800, refresh_token: "ghr_neverUsed", refresh_token_expires_in: 15_811_200, token_type: "bearer", scope: "" });
    } catch {
      return reply({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
    }
  }

  // raw.githubusercontent.com: /{owner}/{name}/{rev}/{path}, anonymous.
  private async raw(url: URL, now: number): Promise<Response> {
    const parts = url.pathname.split("/").slice(1).map(dec);
    if (parts.length < 4) return new Response("404: Not Found", { status: 404 });
    const repo: T.RepoRef = { forge: "memory", owner: parts[0], name: parts[1] };
    const s = this.double.session({ kind: "anonymous" });
    // The revision may hold slashes: the longest prefix that names one.
    for (let cut = parts.length - 1; cut >= 3; cut--) {
      const rev = parts.slice(2, cut).join("/");
      const path = parts.slice(cut).join("/");
      try {
        const f = await s.git.readFile(repo, rev, path, { maxBytes: 2 ** 31 });
        return new Response(f.bytes as BodyInit, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(f.size) } });
      } catch (e) {
        if (e instanceof GitBackendError && e.code === "rate_limited") return new Response("429: Too Many Requests", { status: 429, headers: { "retry-after": String(e.retryAfter ?? 60) } });
        if (!(e instanceof GitBackendError) || (e.code !== "not_found" && e.code !== "invalid")) return failure(e, now);
      }
    }
    return new Response("404: Not Found", { status: 404 });
  }

  // ─── REST ─────────────────────────────────────────────────────────────

  private api(): void {
    const R = "^/repos/([^/]+)/([^/]+)";
    const d = this.double;

    // The App's installation tokens.
    this.on("POST", /^\/app\/installations\/(\d+)\/access_tokens$/, (m, x) => {
      const jwt = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(x.headers.get("Authorization") ?? "");
      if (!jwt || !d.installations.has(m[1])) return reply({ message: "A JSON web token could not be decoded" }, 401);
      const token = `ghs_fake${++this.mints}x${m[1]}`;
      this.minted.set(token, m[1]);
      return reply({ token, expires_at: iso(d.now() + 3600), permissions: x.json.permissions ?? {} }, 201);
    });

    // People and their installations.
    this.on("GET", /^\/user$/, async (_m, x) => {
      const me = await (d.auth as NonNullable<MemoryBackend["auth"]>).whoAmI(x.who.kind === "user" ? x.who.token : "");
      return reply({ login: me.login, id: Number(me.id), type: "User", name: null, ...EMAIL_FIELD });
    });
    // GitHub's licence and code-of-conduct templates (the editor's pickers, night phase 03): short
    // texts with GitHub's own placeholders.
    this.on("GET", /^\/licenses\/([a-z0-9.-]{1,40})$/, (m) => {
      const key = m[1];
      if (!LICENSE_BODIES[key]) return reply({ message: "Not Found" }, 404);
      return reply({ key, name: LICENSE_BODIES[key][0], spdx_id: LICENSE_BODIES[key][1], body: LICENSE_BODIES[key][2] });
    });
    this.on("GET", /^\/codes_of_conduct\/([a-z_]{1,40})$/, (m) => {
      const key = m[1];
      if (!["contributor_covenant", "citizen_code_of_conduct"].includes(key)) return reply({ message: "Not Found" }, 404);
      return reply({ key, name: key === "contributor_covenant" ? "Contributor Covenant" : "Citizen Code of Conduct", body: CONDUCT_BODY.replace("{name}", key === "contributor_covenant" ? "Contributor Covenant" : "Citizen Code of Conduct") });
    });
    // A public account by its login (the editor's co-authors, night phase 03): anyone may ask.
    this.on("GET", /^\/users\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})$/, (m) => {
      const a = d.accountByLogin(m[1]);
      if (!a) return reply({ message: "Not Found" }, 404);
      return reply({ login: a.login, id: Number(a.id), type: a.type === "organization" ? "Organization" : "User", name: null, ...EMAIL_FIELD });
    });
    this.on("GET", /^\/user\/installations$/, async (_m, x) => {
      const p = await (d.auth as NonNullable<MemoryBackend["auth"]>).installations(x.who.kind === "user" ? x.who.token : "", page(x.url));
      return reply({ total_count: p.items.length, installations: p.items.map(installationJson) });
    });
    this.on("GET", /^\/user\/installations\/(\d+)\/repositories$/, async (m, x) => {
      const token = x.who.kind === "user" ? x.who.token : "";
      const p = await (d.auth as NonNullable<MemoryBackend["auth"]>).installationRepositories(token, m[1], page(x.url));
      const s = d.session({ kind: "user", token });
      const repos = await Promise.all(p.items.map((r) => s.repos.getById(r.key)));
      return reply({ total_count: repos.length, repositories: repos.map(repoJson) });
    });
    this.on("DELETE", /^\/applications\/([^/]+)\/token$/, async (m, x) => {
      if (dec(m[1]) !== this.client.id || x.headers.get("Authorization") !== `Basic ${btoa(`${this.client.id}:${this.client.secret}`)}`) return reply({ message: "Not Found" }, 404);
      await (d.auth as NonNullable<MemoryBackend["auth"]>).revoke(String(x.json.access_token ?? ""));
      return reply(null, 204);
    });

    // Repositories.
    this.on("GET", /^\/repositories\/(\d+)$/, async (m, x) => reply(repoJson(await x.session.repos.getById({ forge: "memory", id: m[1] }))));
    this.on("POST", /^\/user\/repos$/, async (_m, x) => {
      const j = x.json;
      const r = await x.session.repos.create({
        name: String(j.name),
        description: j.description as string | undefined,
        homepage: j.homepage as string | undefined,
        visibility: "public",
        autoInit: j.auto_init === true,
        gitignoreTemplate: j.gitignore_template as string | undefined,
        licenseTemplate: j.license_template as string | undefined,
        isTemplate: j.is_template as boolean | undefined,
        features: features(j),
      });
      return reply(repoJson(r), 201);
    });
    this.on("POST", new RegExp(`${R}/generate$`), async (m, x) => {
      const j = x.json;
      const r = await x.session.repos.generate(ref(m), { owner: String(j.owner), name: String(j.name), description: j.description as string | undefined, visibility: "public", includeAllBranches: j.include_all_branches === true });
      return reply(repoJson(r), 201);
    });
    this.on("POST", new RegExp(`${R}/forks$`), async (m, x) => {
      const j = x.json;
      const f = await x.session.repos.fork(ref(m), { organization: j.organization as string | undefined, name: j.name as string | undefined, defaultBranchOnly: j.default_branch_only === true });
      return reply(repoJson(f.repo), 202);
    });
    this.on("PUT", new RegExp(`${R}/topics$`), async (m, x) => reply({ names: await x.session.repos.setTopics(ref(m), (x.json.names as string[]) ?? []) }));
    // Custom autolinks (phase 01): GitHub answers a prefix already there with 422 already_exists.
    const autolinkJson = (a: T.Autolink) => ({ id: Number(a.id), key_prefix: a.keyPrefix, url_template: a.urlTemplate, is_alphanumeric: a.isAlphanumeric });
    this.on("GET", new RegExp(`${R}/autolinks$`), async (m, x) => reply((await x.session.repos.autolinks(ref(m))).map(autolinkJson)));
    this.on("POST", new RegExp(`${R}/autolinks$`), async (m, x) => {
      const j = x.json;
      try {
        const a = await x.session.repos.createAutolink(ref(m), { keyPrefix: String(j.key_prefix), urlTemplate: String(j.url_template), isAlphanumeric: j.is_alphanumeric as boolean | undefined });
        return reply(autolinkJson(a), 201);
      } catch (e) {
        if (e instanceof GitBackendError && e.code === "conflict") {
          return reply({ message: "Validation Failed", errors: [{ resource: "KeyPrefix", code: "already_exists", field: "key_prefix" }] }, 422);
        }
        throw e;
      }
    });
    this.on("DELETE", new RegExp(`${R}/autolinks/(\\d+)$`), async (m, x) => {
      await x.session.repos.deleteAutolink(ref(m), m[3]);
      return new Response(null, { status: 204 });
    });
    this.on("POST", new RegExp(`${R}/transfer$`), async (m, x) => {
      const t = await x.session.repos.transfer(ref(m), { newOwner: String(x.json.new_owner), newName: x.json.new_name as string | undefined });
      return reply(repoJson(t.repo), 202);
    });
    this.on("GET", new RegExp(`${R}/collaborators/([^/]+)/permission$`), async (m, x) => {
      const level = await x.session.repos.permission(ref(m), dec(m[3]));
      const permission = level === "maintain" ? "write" : level === "triage" ? "read" : level;
      return reply({ permission, role_name: level, user: { login: dec(m[3]), ...EMAIL_FIELD } });
    });
    this.on("GET", new RegExp(`${R}/languages$`), async (m, x) => reply(await x.session.repos.languages(ref(m))));
    this.on("GET", new RegExp(`${R}/license$`), async (m, x) => {
      const l = await x.session.repos.license(ref(m));
      return l ? reply({ path: l.path, license: { spdx_id: l.spdx ?? "NOASSERTION" } }) : reply({ message: "Not Found" }, 404);
    });
    this.on("GET", new RegExp(`${R}/readme(?:/(.*))?$`), async (m, x) => {
      const f = await x.session.repos.readme(ref(m), x.url.searchParams.get("ref") ?? undefined, m[3] ? segs(m[3]) : undefined);
      return f ? reply({ path: f.path, sha: f.sha, size: f.size, content: base64(f.bytes), encoding: "base64" }) : reply({ message: "Not Found" }, 404);
    });

    // Branches, tags, refs.
    this.on("POST", new RegExp(`${R}/branches/(.+)/rename$`), async (m, x) => {
      const b = await x.session.git.renameBranch(ref(m), segs(m[3]), String(x.json.new_name));
      return reply({ name: b.name, commit: { sha: b.sha }, protected: b.protected }, 201);
    });
    this.on("GET", new RegExp(`${R}/branches/(.+)$`), async (m, x) => {
      const b = await x.session.git.getBranch(ref(m), segs(m[3]));
      return reply({ name: b.name, commit: { sha: b.sha, commit: { author: { ...EMAIL_FIELD } } }, protected: b.protected });
    });
    this.on("GET", new RegExp(`${R}/branches$`), async (m, x) => listed(await x.session.git.listBranches(ref(m), page(x.url)), x.url, (b) => ({ name: b.name, commit: { sha: b.sha }, protected: b.protected })));
    this.on("GET", new RegExp(`${R}/tags$`), async (m, x) => listed(await x.session.git.listTags(ref(m), page(x.url)), x.url, (t) => ({ name: t.name, commit: { sha: t.sha } })));
    this.on("POST", new RegExp(`${R}/git/refs$`), async (m, x) => this.createRef(ref(m), x));
    this.on("PATCH", new RegExp(`${R}/git/refs/heads/(.+)$`), async (m, x) => this.moveBranch(ref(m), segs(m[3]), x));
    this.on("DELETE", new RegExp(`${R}/git/refs/heads/(.+)$`), async (m, x) => {
      await x.session.git.deleteBranch(ref(m), segs(m[3]));
      return reply(null, 204);
    });
    this.on("DELETE", new RegExp(`${R}/git/refs/tags/(.+)$`), async (m, x) => {
      await x.session.git.deleteTag(ref(m), segs(m[3]));
      return reply(null, 204);
    });
    this.on("POST", new RegExp(`${R}/git/tags$`), async (m, x) => this.tagObject(ref(m), x));
    this.on("POST", new RegExp(`${R}/git/blobs$`), async (m, x) => {
      this.call(x).repo(ref(m), "write");
      const bytes = x.json.encoding === "base64" ? fromBase64(String(x.json.content)) : utf8(String(x.json.content));
      return reply({ sha: await d.store.putBlob(bytes) }, 201);
    });
    this.on("POST", new RegExp(`${R}/git/trees$`), async (m, x) => this.makeTree(ref(m), x));
    this.on("POST", new RegExp(`${R}/git/commits$`), async (m, x) => this.makeCommit(ref(m), x));
    this.on("GET", new RegExp(`${R}/git/commits/([0-9a-f]{40})$`), async (m, x) => {
      const c = this.call(x);
      const r = c.repo(ref(m), "read");
      const commit = d.store.commit(m[3]);
      if (!commit || !reachable(d, r, m[3])) return reply({ message: "Not Found" }, 404);
      return reply({ sha: m[3], tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })), message: commit.message, author: { name: commit.author.name, date: iso(commit.authoredAt), ...EMAIL_FIELD } });
    });
    this.on("GET", new RegExp(`${R}/git/trees/(.+)$`), async (m, x) => this.readTree(ref(m), segs(m[3]), x));

    // Contents.
    this.on("GET", new RegExp(`${R}/contents(?:/(.*))?$`), async (m, x) => this.contents(ref(m), m[3] ? segs(m[3]) : "", x));

    // Commits.
    this.on("GET", new RegExp(`${R}/commits/(.+)/check-runs$`), async (m, x) => {
      const p = await x.session.checks.runs(ref(m), segs(m[3]), page(x.url));
      return reply({ total_count: p.items.length, check_runs: p.items.map(checkRunJson) });
    });
    this.on("GET", new RegExp(`${R}/commits/(.+)/status$`), async (m, x) => {
      const s = await x.session.checks.status(ref(m), segs(m[3]));
      return reply({ state: s.state, statuses: s.statuses.map((y) => ({ context: y.context, state: y.state, description: y.description, target_url: y.targetUrl })) });
    });
    this.on("GET", new RegExp(`${R}/commits/(.+)$`), async (m, x) => {
      const rev = segs(m[3]);
      if ((x.headers.get("Accept") ?? "").includes("vnd.github.sha")) {
        const sha = await x.session.git.resolve(ref(m), rev);
        return new Response(sha, { headers: { "Content-Type": "application/vnd.github.sha" } });
      }
      const c = await x.session.git.commit(ref(m), rev, page(x.url));
      const headers: Record<string, string> = {};
      if (c.files.next) headers.Link = `<https://api.github.com/x?page=${c.files.next}>; rel="next"`;
      return reply({ ...commitJson(c), stats: c.stats, files: c.files.items.map(fileJson) }, 200, headers);
    });
    this.on("GET", new RegExp(`${R}/commits$`), async (m, x) => {
      const q = x.url.searchParams;
      const repo = ref(m);
      const r = this.call(x).repo(repo, "read");
      if (!q.get("sha") && !r.branches.size) return reply({ message: "Git Repository is empty.", status: "409" }, 409);
      const p = await x.session.git.commits(repo, { rev: q.get("sha") ?? undefined, path: q.get("path") ?? undefined, since: q.get("since") ?? undefined, until: q.get("until") ?? undefined, authorLogin: q.get("author") ?? undefined }, page(x.url));
      return listed(p, x.url, commitJson);
    });
    this.on("GET", new RegExp(`${R}/compare/(.+)\\.\\.\\.(.+)$`), async (m, x) => {
      const base = segs(m[3]);
      const head = segs(m[4]);
      if ((x.headers.get("Accept") ?? "").includes("vnd.github.diff")) {
        const text = await x.session.git.diff(ref(m), base, head, { maxBytes: 2 ** 31 });
        return new Response(text, { headers: { "Content-Type": "application/vnd.github.diff" } });
      }
      const c = await x.session.git.compare(ref(m), base, head, { perPage: 100 });
      const files = [...c.files.items];
      for (let next = c.files.next; next && files.length < 300; ) {
        const more = await x.session.git.compare(ref(m), base, head, { perPage: 100, cursor: next });
        files.push(...more.files.items);
        next = more.files.next;
      }
      return reply({ status: c.status, ahead_by: c.aheadBy, behind_by: c.behindBy, merge_base_commit: { sha: c.mergeBase }, commits: c.commits.map(commitJson), files: files.slice(0, 300).map(fileJson) });
    });
    this.on("POST", new RegExp(`${R}/merges$`), async (m, x) => {
      const r = await x.session.git.merge(ref(m), { base: String(x.json.base), head: String(x.json.head), message: x.json.commit_message as string | undefined });
      if (r.status === "up_to_date") return reply(null, 204);
      return reply(commitJson(await x.session.git.commit(ref(m), r.sha)), 201);
    });

    // Code and issue search.
    this.on("GET", /^\/search\/code$/, async (_m, x) => {
      const { repo, rest } = scoped(x.url.searchParams.get("q") ?? "");
      if (!repo) return reply({ message: "Validation Failed" }, 422);
      const p = await x.session.git.search(repo, rest, page(x.url));
      return listedSearch(p, (h) => ({ name: h.path.split("/").pop(), path: h.path, sha: h.sha, text_matches: h.fragments.map((fragment) => ({ fragment })) }));
    });
    this.on("GET", /^\/search\/issues$/, async (_m, x) => {
      const { repo, rest } = scoped(x.url.searchParams.get("q") ?? "");
      if (!repo) return reply({ message: "Validation Failed" }, 422);
      return listedSearch(await x.session.issues.search(repo, rest, page(x.url)), issueJson);
    });

    // Pull requests.
    this.on("GET", new RegExp(`${R}/pulls$`), async (m, x) => {
      const q = x.url.searchParams;
      const p = await x.session.pulls.list(ref(m), { state: (q.get("state") ?? undefined) as T.PullFilter["state"], head: q.get("head") ?? undefined, base: q.get("base") ?? undefined, sort: (q.get("sort") ?? undefined) as T.PullFilter["sort"], direction: (q.get("direction") ?? undefined) as T.PullFilter["direction"] }, page(x.url));
      return listed(p, x.url, pullJson);
    });
    this.on("POST", new RegExp(`${R}/pulls$`), async (m, x) => {
      const j = x.json;
      const p = await x.session.pulls.create(ref(m), { title: String(j.title), body: (j.body as string | undefined) || undefined, head: String(j.head), base: String(j.base), draft: j.draft === true, maintainerCanModify: j.maintainer_can_modify as boolean | undefined });
      return reply(pullJson(p), 201);
    });
    this.on("GET", new RegExp(`${R}/pulls/(\\d+)$`), async (m, x) => reply(pullJson(await x.session.pulls.get(ref(m), Number(m[3])))));
    this.on("PATCH", new RegExp(`${R}/pulls/(\\d+)$`), async (m, x) => {
      const j = x.json;
      return reply(pullJson(await x.session.pulls.update(ref(m), Number(m[3]), { title: j.title as string | undefined, body: j.body as string | undefined, state: j.state as "open" | "closed" | undefined, base: j.base as string | undefined })));
    });
    this.on("GET", new RegExp(`${R}/pulls/(\\d+)/files$`), async (m, x) => listed(await x.session.pulls.files(ref(m), Number(m[3]), page(x.url)), x.url, fileJson));
    this.on("GET", new RegExp(`${R}/pulls/(\\d+)/commits$`), async (m, x) => listed(await x.session.pulls.commits(ref(m), Number(m[3]), page(x.url)), x.url, commitJson));
    this.on("POST", new RegExp(`${R}/pulls/(\\d+)/requested_reviewers$`), async (m, x) => reply(pullJson(await x.session.pulls.requestReviewers(ref(m), Number(m[3]), x.json.reviewers as string[])), 201));
    this.on("DELETE", new RegExp(`${R}/pulls/(\\d+)/requested_reviewers$`), async (m, x) => reply(pullJson(await x.session.pulls.removeReviewers(ref(m), Number(m[3]), x.json.reviewers as string[]))));
    this.on("GET", new RegExp(`${R}/pulls/(\\d+)/reviews$`), async (m, x) => listed(await x.session.pulls.reviews(ref(m), Number(m[3]), page(x.url)), x.url, reviewJson));
    this.on("POST", new RegExp(`${R}/pulls/(\\d+)/reviews$`), async (m, x) => {
      const j = x.json;
      const comments = ((j.comments as Json[] | undefined) ?? []).map((c) => ({
        path: String(c.path),
        line: Number(c.line),
        side: c.side as "LEFT" | "RIGHT" | undefined,
        startLine: c.start_line === undefined ? undefined : Number(c.start_line),
        startSide: c.start_side as "LEFT" | "RIGHT" | undefined,
        body: String(c.body),
      }));
      const r = await x.session.pulls.review(ref(m), Number(m[3]), { event: j.event as T.ReviewEvent, body: j.body as string | undefined, commit: j.commit_id as string | undefined, comments });
      return reply(reviewJson(r));
    });
    this.on("GET", new RegExp(`${R}/pulls/(\\d+)/comments$`), async (m, x) => listed(await x.session.pulls.comments(ref(m), Number(m[3]), page(x.url)), x.url, reviewCommentJson));
    this.on("POST", new RegExp(`${R}/pulls/(\\d+)/comments/(\\d+)/replies$`), async (m, x) => reply(reviewCommentJson(await x.session.pulls.reply(ref(m), Number(m[3]), m[4], String(x.json.body))), 201));
    this.on("PUT", new RegExp(`${R}/pulls/(\\d+)/merge$`), async (m, x) => {
      const j = x.json;
      const r = await x.session.pulls.merge(ref(m), Number(m[3]), { method: j.merge_method as T.MergeMethod, expectedHead: String(j.sha), title: j.commit_title as string | undefined, message: j.commit_message as string | undefined });
      return reply({ sha: r.sha, merged: true, message: "Pull Request successfully merged" });
    });
    this.on("PUT", new RegExp(`${R}/pulls/(\\d+)/update-branch$`), async (m, x) => {
      try {
        await x.session.pulls.updateBranch(ref(m), Number(m[3]), x.json.expected_head_sha as string | undefined);
      } catch (e) {
        if (e instanceof GitBackendError && e.code === "conflict" && /expected head/.test(e.message)) return reply({ message: "expected head sha didn't match current head ref" }, 422);
        throw e;
      }
      return reply({ message: "Updating pull request branch." }, 202);
    });

    // Issues.
    this.on("GET", new RegExp(`${R}/issues$`), async (m, x) => {
      const q = x.url.searchParams;
      const milestone = q.get("milestone");
      const assignee = q.get("assignee");
      const p = await x.session.issues.list(ref(m), {
        state: (q.get("state") ?? undefined) as T.IssueFilter["state"],
        labels: q.get("labels")?.split(","),
        milestone: milestone === null ? undefined : milestone === "*" ? "any" : milestone === "none" ? "none" : Number(milestone),
        assignee: assignee === null ? undefined : assignee === "*" ? "any" : assignee,
        creator: q.get("creator") ?? undefined,
        mentioned: q.get("mentioned") ?? undefined,
        since: q.get("since") ?? undefined,
        sort: (q.get("sort") ?? undefined) as T.IssueFilter["sort"],
        direction: (q.get("direction") ?? undefined) as T.IssueFilter["direction"],
        includePulls: true,
      }, page(x.url));
      return listed(p, x.url, issueJson);
    });
    this.on("POST", new RegExp(`${R}/issues$`), async (m, x) => {
      const j = x.json;
      return reply(issueJson(await x.session.issues.create(ref(m), { title: String(j.title), body: j.body as string | undefined, labels: j.labels as string[] | undefined, assignees: j.assignees as string[] | undefined, milestone: j.milestone as number | undefined })), 201);
    });
    this.on("GET", new RegExp(`${R}/issues/(\\d+)$`), async (m, x) => reply(issueJson(await x.session.issues.get(ref(m), Number(m[3])))));
    this.on("PATCH", new RegExp(`${R}/issues/(\\d+)$`), async (m, x) => {
      const j = x.json;
      const patch: T.IssuePatch = { title: j.title as string | undefined, body: j.body as string | undefined, state: j.state as "open" | "closed" | undefined, stateReason: j.state_reason as T.StateReason | undefined, labels: j.labels as string[] | undefined, assignees: j.assignees as string[] | undefined };
      if ("milestone" in j) patch.milestone = j.milestone as number | null;
      return reply(issueJson(await x.session.issues.update(ref(m), Number(m[3]), patch)));
    });
    this.on("PUT", new RegExp(`${R}/issues/(\\d+)/lock$`), async (m, x) => {
      await x.session.issues.lock(ref(m), Number(m[3]), x.json.lock_reason as T.LockReason | undefined);
      return reply(null, 204);
    });
    this.on("DELETE", new RegExp(`${R}/issues/(\\d+)/lock$`), async (m, x) => {
      await x.session.issues.unlock(ref(m), Number(m[3]));
      return reply(null, 204);
    });
    this.on("GET", new RegExp(`${R}/issues/(\\d+)/comments$`), async (m, x) => listed(await x.session.issues.comments(ref(m), Number(m[3]), page(x.url)), x.url, issueCommentJson));
    this.on("POST", new RegExp(`${R}/issues/(\\d+)/comments$`), async (m, x) => reply(issueCommentJson(await x.session.issues.comment(ref(m), Number(m[3]), String(x.json.body))), 201));
    this.on("PATCH", new RegExp(`${R}/issues/comments/(\\d+)$`), async (m, x) => reply(issueCommentJson(await x.session.issues.editComment(ref(m), m[3], String(x.json.body)))));
    this.on("DELETE", new RegExp(`${R}/issues/comments/(\\d+)$`), async (m, x) => {
      await x.session.issues.deleteComment(ref(m), m[3]);
      return reply(null, 204);
    });
    for (const [kind, prefix] of [["issue", "issues/(\\d+)"], ["comment", "issues/comments/(\\d+)"]] as const) {
      const target = (m: RegExpExecArray) => (kind === "issue" ? { issue: Number(m[3]) } : { comment: m[3] });
      this.on("POST", new RegExp(`${R}/${prefix}/reactions$`), async (m, x) => {
        const content = String(x.json.content) as T.Reaction;
        await x.session.issues.react(ref(m), target(m), content);
        const me = await (d.auth as NonNullable<MemoryBackend["auth"]>).whoAmI(x.who.kind === "user" ? x.who.token : "");
        return reply({ id: reactionId(me.id, content), content, user: { login: me.login, id: Number(me.id) } }, 201);
      });
      this.on("GET", new RegExp(`${R}/${prefix}/reactions$`), async (m, x) => {
        const content = x.url.searchParams.get("content") as T.Reaction | null;
        const who = this.reactors(this.call(x).repo(ref(m), "read"), kind, m[3]);
        const list = who.flatMap(([userId, set]) => [...set].filter((k) => !content || k === content).map((k) => ({ id: reactionId(userId, k), content: k, user: userJson(d.actorOf(userId)) })));
        return reply(list);
      });
      this.on("DELETE", new RegExp(`${R}/${prefix}/reactions/(\\d+)$`), async (m, x) => {
        const [userId, content] = fromReactionId(m[4]);
        const me = x.who.kind === "user" ? d.tokens.get(x.who.token) : undefined;
        if (me !== userId) return reply({ message: "Not Found" }, 404);
        await x.session.issues.unreact(ref(m), target(m), content);
        return reply(null, 204);
      });
    }
    this.on("GET", new RegExp(`${R}/labels$`), async (m, x) => listed(await x.session.issues.labels(ref(m), page(x.url)), x.url, labelJson));
    this.on("POST", new RegExp(`${R}/labels$`), async (m, x) => reply(labelJson(await x.session.issues.createLabel(ref(m), { name: String(x.json.name), color: String(x.json.color), description: String(x.json.description ?? "") })), 201));
    this.on("PATCH", new RegExp(`${R}/labels/(.+)$`), async (m, x) => {
      const j = x.json;
      return reply(labelJson(await x.session.issues.updateLabel(ref(m), dec(m[3]), { name: j.new_name as string | undefined, color: j.color as string | undefined, description: j.description as string | undefined })));
    });
    this.on("DELETE", new RegExp(`${R}/labels/(.+)$`), async (m, x) => {
      await x.session.issues.deleteLabel(ref(m), dec(m[3]));
      return reply(null, 204);
    });
    this.on("GET", new RegExp(`${R}/milestones$`), async (m, x) => listed(await x.session.issues.milestones(ref(m), (x.url.searchParams.get("state") ?? undefined) as "open" | undefined, page(x.url)), x.url, milestoneFull));
    this.on("POST", new RegExp(`${R}/milestones$`), async (m, x) => {
      const j = x.json;
      return reply(milestoneFull(await x.session.issues.createMilestone(ref(m), { title: String(j.title), description: j.description as string | undefined, dueOn: j.due_on as string | undefined, state: j.state as "open" | undefined })), 201);
    });
    this.on("PATCH", new RegExp(`${R}/milestones/(\\d+)$`), async (m, x) => {
      const j = x.json;
      const patch: Partial<T.NewMilestone> = { title: j.title as string | undefined, description: j.description as string | undefined, state: j.state as "open" | undefined };
      if ("due_on" in j) patch.dueOn = j.due_on as string | null;
      return reply(milestoneFull(await x.session.issues.updateMilestone(ref(m), Number(m[3]), patch)));
    });
    this.on("DELETE", new RegExp(`${R}/milestones/(\\d+)$`), async (m, x) => {
      await x.session.issues.deleteMilestone(ref(m), Number(m[3]));
      return reply(null, 204);
    });
    const byId = (repo: T.RepoRef, id: unknown): number => {
      const r = d.find(repo);
      const found = r ? [...r.issues.values()].find((i) => i.id === String(id)) : undefined;
      if (!found) throw new GitBackendError("invalid", "no such issue id");
      return found.number;
    };
    this.on("GET", new RegExp(`${R}/issues/(\\d+)/sub_issues$`), async (m, x) => listed(await x.session.issues.subIssues(ref(m), Number(m[3]), page(x.url)), x.url, issueJson));
    this.on("POST", new RegExp(`${R}/issues/(\\d+)/sub_issues$`), async (m, x) => {
      await x.session.issues.addSubIssue(ref(m), Number(m[3]), byId(ref(m), x.json.sub_issue_id));
      return reply(issueJson(await x.session.issues.get(ref(m), Number(m[3]))), 201);
    });
    this.on("DELETE", new RegExp(`${R}/issues/(\\d+)/sub_issue$`), async (m, x) => {
      await x.session.issues.removeSubIssue(ref(m), Number(m[3]), byId(ref(m), x.json.sub_issue_id));
      return reply(issueJson(await x.session.issues.get(ref(m), Number(m[3]))));
    });
    this.on("GET", new RegExp(`${R}/issues/(\\d+)/dependencies/blocked_by$`), async (m, x) => listed(await x.session.issues.blockedBy(ref(m), Number(m[3]), page(x.url)), x.url, issueJson));
    this.on("POST", new RegExp(`${R}/issues/(\\d+)/dependencies/blocked_by$`), async (m, x) => {
      await x.session.issues.addBlockedBy(ref(m), Number(m[3]), byId(ref(m), x.json.issue_id));
      return reply(issueJson(await x.session.issues.get(ref(m), Number(m[3]))), 201);
    });
    this.on("DELETE", new RegExp(`${R}/issues/(\\d+)/dependencies/blocked_by/(\\d+)$`), async (m, x) => {
      await x.session.issues.removeBlockedBy(ref(m), Number(m[3]), byId(ref(m), m[4]));
      return reply(issueJson(await x.session.issues.get(ref(m), Number(m[3]))));
    });
    this.on("GET", new RegExp(`${R}/issues/(\\d+)/timeline$`), async (m, x) => listed(await x.session.issues.timeline(ref(m), Number(m[3]), page(x.url)), x.url, timelineJson));

    // Releases.
    this.on("GET", new RegExp(`${R}/releases$`), async (m, x) => listed(await x.session.releases.list(ref(m), page(x.url)), x.url, releaseJson));
    this.on("GET", new RegExp(`${R}/releases/latest$`), async (m, x) => {
      const r = await x.session.releases.latest(ref(m));
      return r ? reply(releaseJson(r)) : reply({ message: "Not Found" }, 404);
    });
    this.on("GET", new RegExp(`${R}/releases/tags/(.+)$`), async (m, x) => reply(releaseJson(await x.session.releases.byTag(ref(m), segs(m[3])))));
    this.on("GET", new RegExp(`${R}/releases/(\\d+)$`), async (m, x) => reply(releaseJson(await x.session.releases.get(ref(m), m[3]))));
    this.on("POST", new RegExp(`${R}/releases/generate-notes$`), async (m, x) => {
      const j = x.json;
      return reply(await x.session.releases.generateNotes(ref(m), { tagName: String(j.tag_name), target: j.target_commitish as string | undefined, previousTagName: j.previous_tag_name as string | undefined }));
    });
    this.on("POST", new RegExp(`${R}/releases$`), async (m, x) => {
      const j = x.json;
      const r = await x.session.releases.create(ref(m), { tagName: String(j.tag_name), target: j.target_commitish as string | undefined, name: j.name as string | undefined, body: j.body as string | undefined, draft: j.draft as boolean | undefined, prerelease: j.prerelease as boolean | undefined, makeLatest: j.make_latest === undefined ? undefined : j.make_latest === "true", generateNotes: j.generate_release_notes as boolean | undefined });
      return reply(releaseJson(r), 201);
    });
    this.on("PATCH", new RegExp(`${R}/releases/(\\d+)$`), async (m, x) => {
      const j = x.json;
      const r = await x.session.releases.update(ref(m), m[3], { tagName: j.tag_name as string | undefined, target: j.target_commitish as string | undefined, name: j.name as string | undefined, body: j.body as string | undefined, draft: j.draft as boolean | undefined, prerelease: j.prerelease as boolean | undefined, makeLatest: j.make_latest === undefined ? undefined : j.make_latest === "true" });
      return reply(releaseJson(r));
    });
    this.on("DELETE", new RegExp(`${R}/releases/(\\d+)$`), async (m, x) => {
      await x.session.releases.delete(ref(m), m[3]);
      return reply(null, 204);
    });
    this.on("GET", new RegExp(`${R}/releases/(\\d+)/assets$`), async (m, x) => listed(await x.session.releases.assets(ref(m), m[3], page(x.url)), x.url, assetJson));
    this.on("DELETE", new RegExp(`${R}/releases/assets/(\\d+)$`), async (m, x) => {
      await x.session.releases.deleteAsset(ref(m), m[3]);
      return reply(null, 204);
    });

    // Check runs.
    this.on("POST", new RegExp(`${R}/check-runs$`), async (m, x) => reply(checkRunJson(await x.session.checks.create(ref(m), { headSha: String(x.json.head_sha), ...checkPatch(x.json), name: String(x.json.name) })), 201));
    this.on("PATCH", new RegExp(`${R}/check-runs/(\\d+)$`), async (m, x) => reply(checkRunJson(await x.session.checks.update(ref(m), m[3], checkPatch(x.json)))));

    // A repository itself (after its sub-resources).
    this.on("GET", new RegExp(`${R}$`), async (m, x) => reply(repoJson(await x.session.repos.get(ref(m)))));
    this.on("PATCH", new RegExp(`${R}$`), async (m, x) => {
      const j = x.json;
      const r = await x.session.repos.update(ref(m), { name: j.name as string | undefined, description: j.description as string | undefined, homepage: j.homepage as string | undefined, archived: j.archived as boolean | undefined, defaultBranch: j.default_branch as string | undefined, isTemplate: j.is_template as boolean | undefined, features: features(j) });
      return reply(repoJson(r));
    });
    this.on("DELETE", new RegExp(`${R}$`), async (m, x) => {
      await x.session.repos.delete(ref(m));
      return reply(null, 204);
    });
  }

  private reactors(r: MemRepo, kind: "issue" | "comment", id: string): [string, Set<T.Reaction>][] {
    if (kind === "issue") return [...(r.issues.get(Number(id))?.reactions ?? new Map()).entries()];
    for (const i of r.issues.values()) {
      const c = i.comments.find((x) => x.id === id);
      if (c) return [...c.reactions.entries()];
    }
    return [];
  }

  // ─── the Git data API, on the double's store ───────────────────────────

  private async readTree(repo: T.RepoRef, treeish: string, x: Exchange): Promise<Response> {
    const d = this.double;
    const r = this.call(x).repo(repo, "read");
    let tree = d.store.tree(treeish) ? treeish : null;
    if (!tree) tree = (d.store.commit(resolveRev(d, r, treeish)) as { tree: string }).tree;
    const recursive = x.url.searchParams.has("recursive");
    const entries = d.store.entries(tree, "", recursive);
    const truncated = recursive && entries.length > d.limits.treeEntries;
    return reply({
      sha: tree,
      truncated,
      tree: (truncated ? entries.slice(0, d.limits.treeEntries) : entries).map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha, size: e.size ?? undefined })),
    });
  }

  private async contents(repo: T.RepoRef, path: string, x: Exchange): Promise<Response> {
    const d = this.double;
    const r = this.call(x).repo(repo, "read");
    const rev = x.url.searchParams.get("ref") ?? r.defaultBranch ?? "HEAD";
    const tree = (d.store.commit(resolveRev(d, r, rev)) as { tree: string }).tree;
    const at = d.store.at(tree, path);
    if (!at) return reply({ message: "Not Found" }, 404);
    if (at.mode === "040000") {
      const listing = (d.store.tree(at.sha)?.entries ?? []).map((e) => ({
        name: e.name,
        path: path ? `${path}/${e.name}` : e.name,
        sha: e.sha,
        size: d.store.blob(e.sha)?.bytes.length ?? 0,
        type: e.mode === "040000" ? "dir" : e.mode === "160000" ? "submodule" : e.mode === "120000" ? "symlink" : "file",
        _links: {},
      }));
      return reply(listing);
    }
    const f = await x.session.git.readFile(repo, rev, path, { maxBytes: 2 ** 31 });
    return new Response(f.bytes as BodyInit, { headers: { "Content-Type": "application/vnd.github.raw; charset=utf-8", "Content-Length": String(f.size) } });
  }

  private async tagObject(repo: T.RepoRef, x: Exchange): Promise<Response> {
    const d = this.double;
    const c = this.call(x);
    const r = c.repo(repo, "write");
    const object = String(x.json.object);
    if (!d.store.commit(object) || !reachable(d, r, object)) return reply({ message: "Object does not exist" }, 422);
    const tagger = c.actor();
    const sha = await d.store.putTag({ object, name: String(x.json.tag), tagger, at: d.now(), message: String(x.json.message) });
    return reply({ sha, tag: x.json.tag, message: x.json.message, tagger: { name: tagger.name, date: iso(d.now()), ...EMAIL_FIELD }, object: { sha: object, type: "commit" } }, 201);
  }

  private async createRef(repo: T.RepoRef, x: Exchange): Promise<Response> {
    const d = this.double;
    const c = this.call(x);
    const r = c.repo(repo, "write");
    const name = String(x.json.ref);
    const sha = String(x.json.sha);
    const heads = /^refs\/heads\/(.+)$/.exec(name);
    const tags = /^refs\/tags\/(.+)$/.exec(name);
    if (!heads && !tags) return reply({ message: "Reference name is invalid" }, 422);
    if (heads) {
      if (r.branches.has(heads[1])) return reply({ message: "Reference already exists" }, 422);
      if (!d.store.commit(sha)) return reply({ message: "Object does not exist" }, 422);
      setBranch(c, r, heads[1], sha);
    } else if (tags) {
      if (r.tags.has(tags[1])) return reply({ message: "Reference already exists" }, 422);
      if (!d.store.peel(sha)) return reply({ message: "Object does not exist" }, 422);
      setTag(c, r, tags[1], sha);
    }
    return reply({ ref: name, object: { sha, type: d.store.tag(sha) ? "tag" : "commit" } }, 201);
  }

  private async moveBranch(repo: T.RepoRef, branch: string, x: Exchange): Promise<Response> {
    const d = this.double;
    const c = this.call(x);
    const r = c.repo(repo, "write");
    const current = r.branches.get(branch);
    const sha = String(x.json.sha);
    if (!current) return reply({ message: "Reference does not exist" }, 422);
    if (!d.store.commit(sha)) return reply({ message: "Object does not exist" }, 422);
    if (x.json.force !== true && !d.store.ancestors(sha).has(current)) return reply({ message: "Update is not a fast forward" }, 422);
    setBranch(c, r, branch, sha);
    return reply({ ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
  }

  private async makeTree(repo: T.RepoRef, x: Exchange): Promise<Response> {
    const d = this.double;
    this.call(x).repo(repo, "write");
    const base = x.json.base_tree ? String(x.json.base_tree) : null;
    if (base && !d.store.tree(base)) return reply({ message: "base_tree is not a tree" }, 422);
    const flat: Flat = base ? d.store.flatten(base) : new Map();
    for (const e of (x.json.tree as Json[]) ?? []) {
      const path = String(e.path);
      const mode = String(e.mode) as T.TreeEntry["mode"];
      if (e.sha === null) flat.delete(path);
      else if (typeof e.content === "string") flat.set(path, { mode, sha: await d.store.putBlob(utf8(e.content)) });
      else if (typeof e.sha === "string" && d.store.get(e.sha)) flat.set(path, { mode, sha: e.sha });
      else return reply({ message: "tree.sha is not a blob" }, 422);
    }
    return reply({ sha: await d.store.writeFlat(flat), tree: [] }, 201);
  }

  private async makeCommit(repo: T.RepoRef, x: Exchange): Promise<Response> {
    const d = this.double;
    const c = this.call(x);
    const r = c.repo(repo, "write");
    const tree = String(x.json.tree);
    const parents = ((x.json.parents as string[]) ?? []).map(String);
    if (!d.store.tree(tree)) return reply({ message: "Tree SHA does not exist" }, 422);
    for (const p of parents) if (!d.store.commit(p) || !reachable(d, r, p)) return reply({ message: "Parent SHA does not exist or is not a commit object" }, 422);
    const who = c.actor();
    const sha = await d.store.putCommit({ tree, parents, author: who, committer: who, authoredAt: d.now(), committedAt: d.now(), message: String(x.json.message), verified: false });
    return reply({ sha, tree: { sha: tree }, parents: parents.map((p) => ({ sha: p })), message: x.json.message, author: { name: who.name, ...EMAIL_FIELD } }, 201);
  }

  // ─── GraphQL ──────────────────────────────────────────────────────────

  private findPull(nodeId: unknown): { repo: T.RepoRef; number: number } {
    const d = this.double;
    for (const r of d.repos.values()) {
      if (r.deleted) continue;
      for (const i of r.issues.values()) if (i.nodeId === nodeId && !i.gone) return { repo: d.refOf(r), number: i.number };
    }
    throw new GitBackendError("not_found", "no such node");
  }

  private findRepo(nodeId: unknown): T.RepoRef {
    const d = this.double;
    for (const r of d.repos.values()) if (!r.deleted && r.nodeId === nodeId) return d.refOf(r);
    throw new GitBackendError("not_found", "no such node");
  }

  private findThread(threadId: string): T.RepoRef {
    const d = this.double;
    for (const r of d.repos.values()) if (!r.deleted && r.threads.has(threadId)) return d.refOf(r);
    throw new GitBackendError("not_found", "no such thread");
  }

  private async graphql(x: Exchange, now: number): Promise<Response> {
    const query = String(x.json.query ?? "");
    const v = (x.json.variables ?? {}) as Json;
    const s = x.session;
    try {
      if (query.includes("createCommitOnBranch")) {
        const input = v.input as Json;
        const branch = input.branch as Json;
        const [owner, name] = String(branch.repositoryNameWithOwner).split("/");
        const repo: T.RepoRef = { forge: "memory", owner, name };
        const message = input.message as { headline: string; body?: string };
        const changes = input.fileChanges as { additions?: { path: string; contents: string }[]; deletions?: { path: string }[] };
        const done = await s.git.createCommit(repo, {
          branch: String(branch.branchName),
          expectedHead: String(input.expectedHeadOid),
          changes: [
            ...(changes.additions ?? []).map((a) => ({ op: "put" as const, path: a.path, content: fromBase64(a.contents) })),
            ...(changes.deletions ?? []).map((del) => ({ op: "delete" as const, path: del.path })),
          ],
          message: message.body ? `${message.headline}\n\n${message.body}` : message.headline,
          allowEmpty: true,
        });
        const info = await s.repos.get(repo);
        return reply({ data: { createCommitOnBranch: { commit: { oid: done.sha, tree: { oid: done.tree }, parents: { nodes: done.parents.map((oid) => ({ oid })) } }, ref: { name: done.branch, repository: { databaseId: Number(info.key.id), nameWithOwner: `${info.ref.owner}/${info.ref.name}` } } } } });
      }
      if (query.includes("blame(")) {
        const ranges = await s.git.blame({ forge: "memory", owner: String(v.owner), name: String(v.name) }, String(v.rev), String(v.path));
        return reply({ data: { repository: { object: { blame: { ranges: ranges.map((b) => ({ startingLine: b.startLine, endingLine: b.endLine, commit: graphCommit(b.commit) })) } } } } });
      }
      if (query.includes("reviewThreads(")) {
        const repo: T.RepoRef = { forge: "memory", owner: String(v.owner), name: String(v.name) };
        const p = await s.pulls.threads(repo, Number(v.number), { perPage: Number(v.first), cursor: (v.after as string | null) ?? null });
        return reply({ data: { repository: { pullRequest: { reviewThreads: { nodes: p.items.map(threadJson), pageInfo: { hasNextPage: p.next !== null, endCursor: p.next } } } } } });
      }
      if (query.includes("unresolveReviewThread") || query.includes("resolveReviewThread")) {
        const resolved = !query.includes("unresolveReviewThread");
        const t = await s.pulls.resolveThread(this.findThread(String(v.id)), String(v.id), resolved);
        return reply({ data: { [resolved ? "resolveReviewThread" : "unresolveReviewThread"]: { thread: threadJson(t) } } });
      }
      if (query.includes("markPullRequestReadyForReview") || query.includes("convertPullRequestToDraft")) {
        const draft = query.includes("convertPullRequestToDraft");
        const { repo, number } = this.findPull(v.id);
        const p = await s.pulls.setDraft(repo, number, draft);
        return reply({ data: { [draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview"]: { pullRequest: { isDraft: p.draft } } } });
      }
      if (query.includes("enablePullRequestAutoMerge") || query.includes("disablePullRequestAutoMerge")) {
        const { repo, number } = this.findPull(v.id);
        const enable = query.includes("enablePullRequestAutoMerge");
        if (enable && v.head && (await s.pulls.get(repo, number)).head.sha !== v.head) throw new GitBackendError("conflict", "the head moved");
        const p = await s.pulls.autoMerge(repo, number, enable ? (String(v.method).toLowerCase() as T.MergeMethod) : null);
        const request = p.autoMerge ? { mergeMethod: p.autoMerge.toUpperCase() } : null;
        return reply({ data: { [enable ? "enablePullRequestAutoMerge" : "disablePullRequestAutoMerge"]: { pullRequest: { autoMergeRequest: request } } } });
      }
      if (query.includes("revertPullRequest")) {
        const input = v.input as Json;
        const { repo, number } = this.findPull(input.pullRequestId);
        const p = await s.pulls.revert(repo, number, { title: input.title as string | undefined, body: input.body as string | undefined, draft: input.draft === true });
        return reply({ data: { revertPullRequest: { revertPullRequest: { number: p.number } } } });
      }
      if (query.includes("transferIssue")) {
        const from = this.findPull(v.issue);
        const moved = await s.issues.transfer(from.repo, from.number, this.findRepo(v.repo));
        return reply({ data: { transferIssue: { issue: { number: moved.number } } } });
      }
      if (query.includes("unpinIssue") || query.includes("pinIssue")) {
        const pinned = !query.includes("unpinIssue");
        const { repo, number } = this.findPull(v.id);
        await s.issues.pin(repo, number, pinned);
        return reply({ data: { [pinned ? "pinIssue" : "unpinIssue"]: { issue: { isPinned: pinned } } } });
      }
      return reply({ errors: [{ message: "unknown operation", extensions: { code: "undefinedField" } }] });
    } catch (e) {
      return graphFailure(e, now);
    }
  }

  // ─── webhooks ─────────────────────────────────────────────────────────

  /** The GitHub event name and payload of a ForgeEvent, as GitHub would deliver it. */
  static payload(e: T.ForgeEvent): { event: string; payload: Json } {
    const repository = (r: T.RepoStub, pushedAt?: number): Json => ({
      id: Number(r.key.id),
      name: r.ref.name,
      full_name: `${r.ref.owner}/${r.ref.name}`,
      private: r.visibility !== "public",
      visibility: r.visibility,
      owner: { login: r.ref.owner, name: r.ref.owner, ...EMAIL_FIELD },
      default_branch: r.defaultBranch,
      ...(pushedAt === undefined ? {} : { pushed_at: pushedAt }),
    });
    const sender = (a: T.Actor): Json => ({ login: a.login ?? "ghost", id: a.id === null ? null : Number(a.id), ...EMAIL_FIELD });
    const installation = (id: string | null) => (id === null ? {} : { installation: { id: Number(id), node_id: `I_${id}` } });
    switch (e.kind) {
      case "ping":
        return { event: "ping", payload: { zen: "Keep it logically awesome.", hook_id: 1 } };
      case "installation":
        return { event: "installation", payload: { action: e.action, installation: installationJson(e.installation), sender: sender(e.sender) } };
      case "installation_repositories":
        return {
          event: "installation_repositories",
          payload: {
            action: e.action,
            installation: installationJson(e.installation),
            repositories_added: e.added.map((r) => repository(r)),
            repositories_removed: e.removed.map((r) => repository(r)),
            sender: sender(e.sender),
          },
        };
      case "push":
        return {
          event: "push",
          payload: {
            ref: e.ref,
            before: e.before,
            after: e.after,
            created: e.created,
            deleted: e.deleted,
            forced: e.forced,
            repository: repository(e.repo, e.pushedAt),
            pusher: { name: e.pusher.name, ...EMAIL_FIELD },
            sender: e.pusher.login ? sender(e.pusher) : { login: "someone-else", id: 1 },
            commits: e.commits.map((c) => ({ id: c.sha, added: c.added, removed: c.removed, modified: c.modified, author: { name: e.pusher.name, ...EMAIL_FIELD } })),
            ...installation(e.installation),
          },
        };
      case "repository": {
        const changes: Json = {};
        if (e.previous?.name) changes.repository = { name: { from: e.previous.name } };
        if (e.previous?.owner) changes.owner = { from: { user: { login: e.previous.owner, ...EMAIL_FIELD } } };
        return { event: "repository", payload: { action: e.action, repository: repository(e.repo), sender: sender(e.sender), ...(e.previous ? { changes } : {}), ...installation(e.installation) } };
      }
      case "ref":
        return { event: e.action === "created" ? "create" : "delete", payload: { ref: e.ref, ref_type: e.refType, repository: repository(e.repo), sender: sender(e.sender), ...installation(e.installation) } };
      case "pull_request":
        return {
          event: "pull_request",
          payload: { action: e.action, number: e.number, pull_request: { number: e.number, merged: e.merged, head: { ref: e.head.ref, sha: e.head.sha }, base: { ref: e.base.ref } }, repository: repository(e.repo), sender: sender(e.sender), ...installation(e.installation) },
        };
      case "release":
        return { event: "release", payload: { action: e.action, release: { id: Number(e.releaseId), tag_name: e.tagName }, repository: repository(e.repo), sender: sender(e.sender), ...installation(e.installation) } };
      default:
        return { event: e.event, payload: {} };
    }
  }
}

function features(j: Json): Partial<T.RepoFeatures> | undefined {
  const f: Partial<T.RepoFeatures> = {};
  if (typeof j.has_issues === "boolean") f.issues = j.has_issues;
  if (typeof j.has_wiki === "boolean") f.wiki = j.has_wiki;
  if (typeof j.allow_auto_merge === "boolean") f.autoMerge = j.allow_auto_merge;
  if (typeof j.delete_branch_on_merge === "boolean") f.deleteBranchOnMerge = j.delete_branch_on_merge;
  return Object.keys(f).length ? f : undefined;
}

function checkPatch(j: Json): T.CheckRunPatch {
  const out = j.output as { title: string; summary: string; text?: string; annotations?: Json[] } | undefined;
  return {
    name: j.name as string | undefined,
    status: j.status as T.CheckStatus | undefined,
    conclusion: j.conclusion as T.CheckConclusion | undefined,
    detailsUrl: j.details_url as string | undefined,
    externalId: j.external_id as string | undefined,
    output: out
      ? {
          title: out.title,
          summary: out.summary,
          text: out.text,
          annotations: (out.annotations ?? []).map((a) => ({ path: String(a.path), startLine: Number(a.start_line), endLine: Number(a.end_line), level: a.annotation_level as "notice", title: a.title as string | undefined, message: String(a.message) })),
        }
      : undefined,
  };
}

/** "repo:owner/name" taken out of a search. */
function scoped(q: string): { repo: T.RepoRef | null; rest: string } {
  let repo: T.RepoRef | null = null;
  const rest = q
    .split(/\s+/)
    .filter((w) => {
      const m = /^repo:([^/]+)\/(.+)$/.exec(w);
      if (m) repo = { forge: "memory", owner: m[1], name: m[2] };
      return !m && w;
    })
    .join(" ");
  return { repo, rest };
}

function listedSearch<V>(p: T.Page<V>, map: (v: V) => unknown): Response {
  const headers: Record<string, string> = {};
  if (p.next) headers.Link = `<https://api.github.com/search?page=${p.next}>; rel="next"`;
  return reply({ total_count: p.items.length, incomplete_results: false, items: p.items.map(map) }, 200, headers);
}

const REACTION_KINDS: T.Reaction[] = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"];
const reactionId = (userId: string, r: T.Reaction) => Number(userId) * 10 + REACTION_KINDS.indexOf(r);
const fromReactionId = (id: string): [string, T.Reaction] => [String(Math.floor(Number(id) / 10)), REACTION_KINDS[Number(id) % 10]];
