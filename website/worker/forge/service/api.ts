// The registry's public API, version 1 (night phase 10, E2; the reference for its users: docs/API.md and
// the site's /developers/ page; the machine's: /developers/openapi.json). One entry point, `handleApi`,
// which the Worker's entry (worker/index.ts) calls for /api/v1 and /api/v1/*.
//
// What every request goes through, in order:
//   1. OPTIONS: the CORS preflight (any Origin, no credentials), answered here without a token.
//   2. The route (404) and its method (405); the version asked (`X-Api-Version`, a date: 400 when the
//      registry has no such version; none asked is the current one).
//   3. The token (bearer.ts): `Authorization: Bearer oscr_pat_…`, 401 without it or when it is not
//      valid. Only the index (GET /api/v1) answers without one. Cookies are never read here: the
//      request reaches the route without its Cookie header, so a browser's session can never act
//      through the API (it has no CSRF token to check), and CORS can answer every Origin.
//   4. The rate limits of the token (60 a minute, 1,000 a day; 429 with Retry-After), except for
//      GET /api/v1/rate_limit, which never counts; then the owner's optional binding.
//   5. The scope the route needs (403 insufficient_scope, with X-Accepted-Scopes).
//   6. The route: most are the site's own handlers (read.ts, research.ts, social.ts, inbox.ts), which
//      read the person through who.ts: one write path, the same FORGE_OPEN (until phase 16, only the
//      owner's token can write), the same caps, the same rows. Tokens are never made or listed here:
//      that is the site's settings page only (tokens.ts).
//   7. The answer: JSON; an error `{error: {code, message, request_id, documentation_url, …}}`; the
//      headers X-Request-Id, X-Api-Version, X-RateLimit-*, X-Token-Scopes, X-Accepted-Scopes,
//      X-Token-Expires; a GET's ETag (weak, the SHA-256 of the body), and 304 to If-None-Match (a 304
//      does not count against the rate limit); `Link: <…>; rel="next"` on a list with a next page.
//
// What it costs: one Worker request each (the plan's share for the API: ~8,000 a day, §15.6), the rows
// its route reads (by key), and the rows of its writes (the same as the site's). No row is written to
// count requests: the rate limits live in the isolate's memory (bearer.ts).
//
// Like the rest of the Worker, it never names the platform.

import { randomToken, sha256Hex } from "../../account/crypto.ts";
import { handleSearch } from "../../api.ts";
import type { Env } from "../../env.ts";
import { API_RATE, bearer, giveBack, peekRate, rateHeaders, sharedLimit, takeRequest, type Principal, type RateState } from "./bearer.ts";
import { handleHookDeliveries, handleHooks, handleHookWrite } from "./hooks.ts";
import { handleActionsStatus, handleStatuses, handleStatusPost } from "./statuses.ts";
import { handleActivity, handleFeed, handleInbox, handleNotices } from "./inbox.ts";
import { runRoute } from "./index.ts";
import { handleMine, handleRepo } from "./read.ts";
import { handleResearchComment, handleResearchEdit, handleResearchOpen, handleResearchRead } from "./research.ts";
import { handleSocialFollow, handleSocialList, handleSocialMine, handleSocialPerson, handleSocialProfile, handleSocialStar, handleSocialState } from "./social.ts";
import { grants, SCOPES, type Scope } from "./tokens-core.ts";
import { ForgeProblem, type Context, type ForgeDeps, type ForgeRequest, type ForgeServiceEnv, type RouteHandler } from "./types.ts";
import { json } from "./http.ts";

/** The API's versions, by date; the first is the current one. A breaking change adds a new date, and
 *  the old one keeps answering as it did until its end, announced on /developers/#changes. */
export const API_VERSIONS = ["2026-09-29"] as const;
export const API_VERSION = API_VERSIONS[0];
export const API_PREFIX = "/api/v1";

/** A query parameter, in words (the reference and the OpenAPI description). */
export interface ApiParam {
  name: string;
  words: string;
  required?: boolean;
}

export interface ApiRoute {
  method: "GET" | "POST";
  /** What the token must allow (null: any valid token). */
  scope: Scope | null;
  handle: RouteHandler;
  /** In words, for the index and the reference. */
  words: string;
  /** Answered without a registry token: the index, and the route that takes GitHub Actions' own OIDC
   *  token (statuses.ts checks it). */
  tokenless?: boolean;
  /** Needs no database at all (the index). */
  bare?: boolean;
  /** Not counted against the rate limit (GET /rate_limit). */
  uncounted?: boolean;
  /** The query parameter of the next page when the answer's `next` is set (the Link header). */
  cursor?: string;
  /** Its query parameters. */
  params?: ApiParam[];
  /** A POST's JSON body: each field in words ("required" said in the words). */
  body?: Record<string, string>;
}

/** The answer's headers every client may read (CORS). */
export const EXPOSED = [
  "ETag", "Link", "Retry-After", "X-Request-Id", "X-Api-Version", "X-RateLimit-Limit", "X-RateLimit-Remaining",
  "X-RateLimit-Used", "X-RateLimit-Reset", "X-RateLimit-Resource", "X-Token-Scopes", "X-Accepted-Scopes", "X-Token-Expires",
];

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": EXPOSED.join(", "),
};

// ─── the API's own routes ────────────────────────────────────────────────────

const docs = (r: ForgeRequest, anchor = "") => `${r.url.origin}/developers/${anchor ? `#${anchor}` : ""}`;

/** GET /api/v1: what the API is, how to authenticate, its routes. No token needed. */
async function index(r: ForgeRequest): Promise<Response> {
  return json({
    version: API_VERSION,
    versions: API_VERSIONS,
    documentation_url: docs(r),
    openapi_url: `${r.url.origin}/developers/openapi.json`,
    authentication: `Authorization: Bearer <token>; make a token at ${r.url.origin}/settings/tokens/`,
    scopes: SCOPES,
    routes: Object.entries(API_ROUTES).map(([path, route]) => ({ method: route.method, path, scope: route.scope, words: route.words })),
  });
}

const principalOf = (r: ForgeRequest): Principal => r.principal as Principal;

/** GET /api/v1/user: whose token this is (their public handles), what it allows, when it expires. */
async function user(r: ForgeRequest): Promise<Response> {
  const p = principalOf(r);
  return json({
    github: p.user.github_login,
    orcid: p.user.orcid,
    token: { id: p.token.id, scopes: p.token.scopes, expires_at: new Date(p.token.expiresAt * 1000).toISOString() },
  });
}

/** GET /api/v1/rate_limit: the token's use of its limits; never counted itself. */
async function rateLimit(r: ForgeRequest): Promise<Response> {
  const p = principalOf(r);
  const s = peekRate(p.token.id, r.t);
  return json({
    resources: { core: { limit: s.limit, used: s.used, remaining: s.remaining, reset: s.reset }, burst: { limit: API_RATE.perMinute, period_seconds: 60 } },
    rate: { limit: s.limit, used: s.used, remaining: s.remaining, reset: s.reset },
    shared: r.env.API_LIMITER ? "the registry's shared limiter is also asked" : null,
  });
}

/** GET /api/v1/search: the registry's search (papers, repositories, research issues, people, topics),
 *  as the site's /api/search answers it. */
async function search(r: ForgeRequest): Promise<Response> {
  const inner = new URL(r.url);
  inner.pathname = "/api/search";
  return handleSearch(new Request(inner, { headers: { Accept: "application/json" } }), r.env as unknown as Env, r.ctx);
}

/** Every route of version 1, by path. */
export const API_ROUTES: Record<string, ApiRoute> = {
  [API_PREFIX]: { method: "GET", scope: null, handle: index, tokenless: true, bare: true, words: "This index: the version, the routes, how to authenticate." },
  [`${API_PREFIX}/user`]: { method: "GET", scope: null, handle: user, words: "Whose token this is (public handles), its scopes, its expiry." },
  [`${API_PREFIX}/rate_limit`]: { method: "GET", scope: null, handle: rateLimit, uncounted: true, words: "The token's use of its rate limits (never counted)." },
  [`${API_PREFIX}/search`]: {
    method: "GET",
    scope: null,
    handle: search,
    words: "The registry's search, as its search page asks it.",
    params: [
      { name: "q", words: "The words searched (the search page's syntax).", required: true },
      { name: "type", words: "papers (the default), repositories, issues, people or topics." },
      { name: "page", words: "The page of results, from 1." },
    ],
  },
  [`${API_PREFIX}/repos`]: {
    method: "GET",
    scope: "repos:read",
    handle: handleRepo,
    words: "The registry's layer over one repository: its papers, its state, how it is followed, its releases tied to papers.",
    params: [
      { name: "path", words: "owner/name, as on GitHub." },
      { name: "id", words: "<forge>:<id>, the forge's durable id (github:123456): one of path or id." },
    ],
  },
  [`${API_PREFIX}/repos/mine`]: {
    method: "GET",
    scope: "repos:read",
    handle: handleMine,
    cursor: "after",
    words: "Your repositories the registry knows, by name, a page at a time (Link: rel=next).",
    params: [
      { name: "after", words: "The cursor: the `next` of the previous page." },
      { name: "limit", words: "At most 100 a page." },
      { name: "mode", words: "created, installed or public." },
      { name: "template", words: "1: templates only." },
    ],
  },
  [`${API_PREFIX}/research`]: {
    method: "GET",
    scope: "research:read",
    handle: handleResearchRead,
    words: "One research issue with its comments, or the research issues of 1 to 10 papers.",
    params: [
      { name: "id", words: "A research issue's number." },
      { name: "paper", words: "A paper's DOI (repeat it for up to 10 papers)." },
      { name: "repo", words: "<forge>:<id>: only the issues on this repository's code." },
    ],
  },
  [`${API_PREFIX}/research/open`]: {
    method: "POST",
    scope: "research:write",
    handle: handleResearchOpen,
    words: "Open a research issue on a paper and its code (answer 201: its id and its page).",
    body: {
      paper: "The paper's DOI (required).",
      repo: "{forge, id, path}: the repository of the code (or `code`, an address the paper cites).",
      type: "code_error, mismatch or reproduction (required).",
      title: "Its title (required).",
      body: "Its text (Markdown; addresses masked).",
      commit: "The commit it is about.",
      path: "The file it is about.",
      lines: "{start, end}: the lines.",
      paragraph: "The paper's paragraph it is about.",
      report: "A reproduction report (for type reproduction).",
      labels: "Labels, words.",
    },
  },
  [`${API_PREFIX}/research/comment`]: {
    method: "POST",
    scope: "research:write",
    handle: handleResearchComment,
    words: "Comment on a research issue; edit, delete or hide a comment.",
    body: { id: "The research issue's number (required).", n: "The comment's number (to edit, delete or hide one).", body: "The text.", delete: "true: delete the comment n.", hide: "A reason: hide the comment n." },
  },
  [`${API_PREFIX}/research/edit`]: {
    method: "POST",
    scope: "research:write",
    handle: handleResearchEdit,
    words: "Edit a research issue: title, text, close with a resolution, reopen, labels, lock, pin.",
    body: {
      id: "The research issue's number (required).",
      title: "A new title.",
      body: "A new text.",
      state: "open or closed.",
      reason: "Why it is closed: completed, not_planned, duplicate.",
      resolution: "The resolution, in words.",
      duplicateOf: "The research issue it duplicates.",
      labels: "{add, remove}: labels.",
      locked: "true or false.",
      pinned: "true or false.",
    },
  },
  [`${API_PREFIX}/social`]: {
    method: "GET",
    scope: "social:read",
    handle: handleSocialState,
    words: "Your star, lists and follow of up to 20 subjects or targets.",
    params: [{ name: "s", words: "A subject (repo:<forge>:<id>, paper:doi:10.…, topic:<name>) or a target (github:<id>, orcid:<iD>, owner:<forge>:<login>…); repeat it.", required: true }],
  },
  [`${API_PREFIX}/social/mine`]: { method: "GET", scope: "social:read", handle: handleSocialMine, words: "Your stars, lists (private ones included), follows and profile." },
  [`${API_PREFIX}/social/person`]: {
    method: "GET",
    scope: "social:read",
    handle: handleSocialPerson,
    words: "A person's public profile, lists, stars and follows (none from a private profile).",
    params: [
      { name: "github", words: "Their GitHub numeric id." },
      { name: "orcid", words: "Their ORCID iD: one of github or orcid." },
    ],
  },
  [`${API_PREFIX}/social/star`]: {
    method: "POST",
    scope: "social:write",
    handle: handleSocialStar,
    words: "Star or unstar a repository, a paper or a topic.",
    body: { subject: "repo:<forge>:<id>, paper:doi:10.… or topic:<name> (required).", label: "What you call it (your Stars page only).", on: "true to star, false to unstar (required)." },
  },
  [`${API_PREFIX}/social/follow`]: {
    method: "POST",
    scope: "social:write",
    handle: handleSocialFollow,
    words: "Follow a person, an author by ORCID iD, an organization, a paper; watch a repository at a level; or stop.",
    body: { target: "What to follow (required).", label: "What you call it.", level: "all, participating, ignore or custom (a repository).", events: "custom: issues, pulls, releases, research.", on: "true or false (required)." },
  },
  [`${API_PREFIX}/social/list`]: {
    method: "POST",
    scope: "social:write",
    handle: handleSocialList,
    words: "Your star lists: create, edit, delete, add, remove, propose as a collection.",
    body: { op: "create, edit, delete, add, remove or propose (required).", id: "The list's number (1 to 32).", name: "Its name.", description: "Its description.", public: "true or false.", subject: "The subject to add or remove.", propose: "true or false." },
  },
  [`${API_PREFIX}/social/profile`]: {
    method: "POST",
    scope: "social:write",
    handle: handleSocialProfile,
    words: "Change your profile (no address is ever asked for or kept).",
    body: { name: "Your name.", bio: "A few words.", pronouns: "Your pronouns.", company: "Your lab or company.", location: "Where.", timezone: "An IANA time zone.", website: "An https address.", links: "Up to 4 https addresses.", pinned: "Up to 6 subjects or lists.", status: "A status.", statusUntil: "When it ends (Unix seconds).", busy: "true or false.", private: "true: your activity, stars, lists and follows are yours only.", readme: "true: show your profile README." },
  },
  [`${API_PREFIX}/social/feed`]: { method: "GET", scope: "social:read", handle: handleFeed, words: "The last 14 days of what you follow." },
  [`${API_PREFIX}/social/activity`]: {
    method: "GET",
    scope: "social:read",
    handle: handleActivity,
    words: "A person's contribution calendar (a year), timeline (3 months) and milestones.",
    params: [
      { name: "github", words: "Their GitHub numeric id." },
      { name: "orcid", words: "Their ORCID iD." },
      { name: "me", words: "1: your own." },
    ],
  },
  [`${API_PREFIX}/notifications`]: { method: "GET", scope: "notifications:read", handle: handleInbox, words: "Your notifications: the registry's own inbox, computed now (no email is ever sent)." },
  [`${API_PREFIX}/notifications/mark`]: {
    method: "POST",
    scope: "notifications:write",
    handle: handleNotices,
    words: "Mark threads read, unread, done, undone, saved or unsaved; unsubscribe or subscribe; all read; your settings.",
    body: { op: "read, unread, done, undone, save, unsave, unsubscribe, subscribe, all_read or settings (required).", threads: "Up to 25 {key, title, url}.", settings: "Your notification settings (op settings)." },
  },
  [`${API_PREFIX}/hooks`]: { method: "GET", scope: "hooks:read", handle: handleHooks, words: "Your outgoing webhooks, and the events a repository's or a paper's offer." },
  [`${API_PREFIX}/hooks/deliveries`]: {
    method: "GET",
    scope: "hooks:read",
    handle: handleHookDeliveries,
    words: "One webhook's deliveries of the last 7 days: event, status, time, attempts.",
    params: [{ name: "id", words: "The hook's id.", required: true }],
  },
  [`${API_PREFIX}/hooks/write`]: {
    method: "POST",
    scope: "hooks:write",
    handle: handleHookWrite,
    words: "Make a webhook (pinged first; its secret answered once), change its events, pause it, ping it, redeliver a delivery, rotate its secret, delete it.",
    body: {
      op: "create, update, ping, redeliver, rotate or delete (required).",
      subject: "create: repo:<forge>:<id> or paper:doi:10.….",
      url: "create: the https address it posts to.",
      events: "create, update: the events, or \"*\" for all.",
      id: "The hook's id (every op but create).",
      active: "update: false pauses it (a ping makes it active again).",
      guid: "redeliver: the delivery's id.",
    },
  },
  [`${API_PREFIX}/statuses`]: {
    method: "GET",
    scope: "repos:read",
    handle: handleStatuses,
    words: "The statuses posted on a commit of a repository the registry knows, and their combined state.",
    params: [
      { name: "path", words: "owner/name." },
      { name: "id", words: "<forge>:<id>: one of path or id." },
      { name: "sha", words: "The commit's full id.", required: true },
    ],
  },
  [`${API_PREFIX}/statuses/post`]: {
    method: "POST",
    scope: "statuses:write",
    handle: handleStatusPost,
    words: "Post a commit status (a lab's CI, a reproduction service): the latest of each context is kept.",
    body: {
      repo: "owner/name or <forge>:<id> (required).",
      sha: "The commit's full id (required).",
      state: "error, failure, pending or success (required).",
      context: "The service and its check, as “lab-ci/tests” (default: default).",
      description: "A short sentence (140 characters).",
      target_url: "An https page with the details.",
    },
  },
  [`${API_PREFIX}/statuses/actions`]: {
    method: "POST",
    scope: null,
    tokenless: true,
    handle: handleActionsStatus,
    words: "Post a commit status from a GitHub Actions workflow, with GitHub's OIDC token (audience: this site's origin) instead of a registry token: no secret in the repository.",
    body: {
      sha: "The commit's full id (required).",
      state: "error, failure, pending or success (required).",
      context: "Default: “GitHub Actions: <the workflow's name>”.",
      description: "A short sentence (140 characters).",
      target_url: "An https page with the details (the run's page).",
    },
  },
};

// ─── the router ──────────────────────────────────────────────────────────────

export const isApiPath = (pathname: string): boolean => pathname === API_PREFIX || pathname === `${API_PREFIX}/` || pathname.startsWith(`${API_PREFIX}/`);

const noWait: Context = { waitUntil: (p) => void p.catch(() => undefined) };

interface Said {
  requestId: string;
  /** Unix seconds: the request's time (the rate limits). */
  t: number;
  route: ApiRoute | null;
  principal: Principal | null;
  rate: RateState | null;
}

/** An answer in the API's error model. */
function refusal(p: ForgeProblem, origin: string, said: Said, extra: Record<string, string> = {}): Response {
  const res = json({ error: { code: p.code, message: p.message, ...p.extra, request_id: said.requestId, documentation_url: `${origin}/developers/#errors` } }, p.status);
  const retry = p.extra.retryAfter;
  if (typeof retry === "number" && retry > 0) res.headers.set("Retry-After", String(Math.ceil(retry)));
  for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
  return decorate(res, said);
}

/** The headers every answer of the API carries. */
function decorate(res: Response, said: Said): Response {
  const h = res.headers;
  h.delete("Set-Cookie");
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  h.set("X-Request-Id", said.requestId);
  h.set("X-Api-Version", API_VERSION);
  if (said.rate) for (const [k, v] of Object.entries(rateHeaders(said.rate))) h.set(k, v);
  if (said.principal) {
    h.set("X-Token-Scopes", said.principal.token.scopes.join(", "));
    h.set("X-Token-Expires", new Date(said.principal.token.expiresAt * 1000).toISOString());
  }
  if (said.route) h.set("X-Accepted-Scopes", said.route.scope ?? "");
  return res;
}

/** The request as the route sees it: without its cookies (a session never acts through the API). */
function withoutCookies(request: Request): Request {
  if (!request.headers.has("Cookie")) return request;
  const headers = new Headers(request.headers);
  headers.delete("Cookie");
  return new Request(request, { headers });
}

/** The route's answer made the API's: the error model, the ETag and 304, the Link of the next page. */
async function finish(res: Response, request: Request, url: URL, said: Said): Promise<Response> {
  const type = res.headers.get("Content-Type") ?? "";
  if (!type.includes("json")) return decorate(res, said);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const headers = new Headers(res.headers);
  let out = text;
  if (res.status >= 400 && body && typeof body === "object" && (body as { error?: unknown }).error && typeof (body as { error: unknown }).error === "object") {
    const b = body as { error: Record<string, unknown> };
    b.error.request_id = said.requestId;
    b.error.documentation_url = `${url.origin}/developers/#errors`;
    out = JSON.stringify(b);
  }
  const next = body && typeof body === "object" ? (body as { next?: unknown }).next : null;
  if (res.ok && said.route?.cursor && (typeof next === "string" || typeof next === "number") && String(next)) {
    const link = new URL(url);
    link.searchParams.set(said.route.cursor, String(next));
    headers.set("Link", `<${link.toString()}>; rel="next"`);
  }
  const get = request.method === "GET" || request.method === "HEAD";
  if (get && res.status === 200) {
    const etag = `W/"${(await sha256Hex(out)).slice(0, 32)}"`;
    headers.set("ETag", etag);
    const asked = (request.headers.get("If-None-Match") ?? "").split(",").map((s) => s.trim());
    if (asked.includes(etag) || asked.includes(etag.slice(2))) {
      if (said.principal && !said.route?.uncounted) giveBack(said.principal.token.id, said.t);
      const notModified = new Response(null, { status: 304, headers });
      notModified.headers.delete("Content-Type");
      return decorate(notModified, said);
    }
  }
  const final = new Response(request.method === "HEAD" ? null : out, { status: res.status, headers });
  return decorate(final, said);
}

/** The API's answer to `request`, or null when its path is not under /api/v1. */
export async function handleApi(request: Request, env: ForgeServiceEnv | object, ctx: Context = noWait, deps: ForgeDeps = {}): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isApiPath(url.pathname)) return null;
  const path = url.pathname.replace(/\/+$/, "") || API_PREFIX;
  const said: Said = { requestId: randomToken(12), t: deps.now ? deps.now() : Math.floor(Date.now() / 1000), route: null, principal: null, rate: null };
  const origin = url.origin;

  if (request.method === "OPTIONS") {
    const res = new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, If-None-Match, X-Api-Version",
        "Access-Control-Max-Age": "86400",
        "Cache-Control": "no-store",
      },
    });
    return decorate(res, said);
  }
  const route = API_ROUTES[path];
  if (!route) return refusal(new ForgeProblem(404, "not_found", "The API has no such route: GET /api/v1 lists them."), origin, said);
  said.route = route;
  const get = request.method === "GET" || request.method === "HEAD";
  if (route.method === "GET" ? !get : request.method !== "POST") {
    return refusal(new ForgeProblem(405, "method_not_allowed", `Use ${route.method}.`), origin, said, { Allow: route.method === "GET" ? "GET, HEAD" : route.method });
  }
  const version = (request.headers.get("X-Api-Version") ?? "").trim();
  if (version && !(API_VERSIONS as readonly string[]).includes(version)) {
    return refusal(new ForgeProblem(400, "unsupported_version", `The API has no version ${version.slice(0, 20)}: it answers ${API_VERSIONS.join(", ")}.`), origin, said);
  }

  const prepare = async (r: ForgeRequest): Promise<Response | null> => {
    if (route.tokenless) return null;
    const p = await bearer(r.request, r.env, r.t, r.ctx);
    if (p === null) {
      return refusal(new ForgeProblem(401, "requires_authentication", "This route needs a token: Authorization: Bearer <token>. Make one in your settings."), origin, said, {
        "WWW-Authenticate": 'Bearer realm="api"',
      });
    }
    if (p instanceof ForgeProblem) return refusal(p, origin, said, { "WWW-Authenticate": 'Bearer realm="api", error="invalid_token"' });
    said.principal = p;
    if (!route.uncounted) {
      const state = takeRequest(p.token.id, r.t);
      said.rate = state;
      if (!state.ok) {
        const words = state.which === "minute" ? `this token's ${API_RATE.perMinute} requests a minute` : `this token's ${API_RATE.perDay.toLocaleString("en-GB")} requests a day`;
        return refusal(new ForgeProblem(429, "rate_limited", `You have used ${words}: please wait before trying again.`, { retryAfter: state.retryAfter }), origin, said);
      }
      if (!(await sharedLimit(r.env, p.token.id))) {
        return refusal(new ForgeProblem(429, "rate_limited", "The API is busy for this token: please wait a minute before trying again.", { retryAfter: 60 }), origin, said);
      }
    } else said.rate = peekRate(p.token.id, r.t);
    if (route.scope && !grants(p.token.scopes, route.scope)) {
      return refusal(new ForgeProblem(403, "insufficient_scope", `This token may not do this: it needs the scope ${route.scope}. Make a token with it in your settings.`), origin, said);
    }
    r.principal = p;
    return null;
  };

  const inner = withoutCookies(request);
  if (route.bare) {
    // The index needs no database.
    const r = { request: inner, url, path, t: said.t } as unknown as ForgeRequest;
    return finish(await route.handle(r), inner, url, said);
  }
  const res = await runRoute(inner, env, ctx, deps, { url, path, signedIn: false, handle: route.handle, prepare });
  // A refusal of prepare is already the API's; the route's answer is made so.
  if (res.headers.get("X-Request-Id") === said.requestId) return res;
  return finish(res, inner, url, said);
}
