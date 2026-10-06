// The forge service (night phase 01): the GitHub side's dynamic routes, above GitBackend. One entry
// point, `handleForge`, which the Worker's entry (worker/index.ts) calls for /api/forge/*:
//
//   POST /api/forge/start     signed in   the first half of one authorized action → {location}   start.ts (E1)
//   POST /api/forge/act       signed in   its second half: {code, state, payload} → the result     act.ts (E1)
//   POST /api/forge/asset     signed in   phase 07: the second half of asset_upload, the file as the    asset.ts
//                                         body (≤ 25 MiB, streamed, never parsed)
//   POST /api/forge/webhook   GitHub      a delivery of the mirror mode (HMAC, ≤ 1 MiB)             webhook.ts (E3)
//   GET  /api/forge/repo      signed in   OSCR's layer for one repository (?id= or ?path=)         read.ts (E6)
//   GET  /api/forge/mine      signed in   "Your repositories"                                       read.ts (E6)
//   GET  /api/forge/research          signed in   research issues: one (?id=), or a paper's      research.ts (phase 05)
//   POST /api/forge/research/open     signed in   a new research issue (3 rows)                   research.ts
//   POST /api/forge/research/comment  signed in   a comment; its edit, deletion or hiding         research.ts
//   POST /api/forge/research/edit     signed in   title, text, close with a resolution, reopen,   research.ts
//                                                 labels, lock, pin
//   GET  /api/forge/discussions       signed in   a discussion (?id=), or a space (?space=)       discussions.ts (night phase 06)
//   POST /api/forge/discussions/open  signed in   a new discussion (3 rows, 4 for a new space)    discussions.ts
//   POST /api/forge/discussions/comment signed in a comment; its edit, deletion or hiding         discussions.ts
//   POST /api/forge/discussions/vote  signed in   an upvote or a poll vote, or either taken back  discussions.ts
//   POST /api/forge/discussions/edit  signed in   title, body, category, answered, labels, lock,  discussions.ts
//                                                 pin, close, reopen, transfer
//   GET  /api/forge/projects          signed in   a project (?id=), or an owner's (?owner=)       projects.ts (night phase 06)
//   POST /api/forge/projects/create   signed in   a new project with its built-in fields           projects.ts
//   POST /api/forge/projects/edit     signed in   title, description, state, views                 projects.ts
//   POST /api/forge/projects/field    signed in   a field created, changed or deleted              projects.ts
//   POST /api/forge/projects/item     signed in   an item added, changed, archived or removed      projects.ts
//   GET  /api/forge/social            signed in   phase 08: the reader's star, lists, follow of   social.ts
//                                                 ≤ 20 subjects (the buttons)
//   GET  /api/forge/social/mine       signed in   the reader's stars, lists, follows, profile     social.ts
//   GET  /api/forge/social/person     signed in   a person's public profile                       social.ts
//   POST /api/forge/social/star|follow|list|profile   signed in   the social writes (2 rows each) social.ts
//   GET  /api/forge/social/inbox      signed in   the in-site notifications, computed on read     inbox.ts
//   POST /api/forge/social/notices    signed in   read, done, saved, unsubscribed, all read       inbox.ts
//   GET  /api/forge/social/feed       signed in   the activity feed of what the reader follows    inbox.ts
//   GET  /api/forge/social/activity   signed in   a person's calendar, timeline and milestones    inbox.ts
//   GET  /api/forge/tokens            signed in   phase 10: the reader's personal tokens           tokens.ts
//   POST /api/forge/tokens/write      signed in   make one (answered once) or revoke one           tokens.ts
//   GET  /api/forge/device            signed in   phase 14: what a command line's sign-in asks       device.ts
//   POST /api/forge/device/decide     signed in   approve it (the terminal's code typed) or refuse   device.ts
//   GET  /api/forge/hooks             signed in   phase 10: the reader's outgoing webhooks          hooks.ts
//   GET  /api/forge/hooks/deliveries  signed in   one hook's deliveries of the last 7 days          hooks.ts
//   POST /api/forge/hooks/write       signed in   make (pinged), change, ping, redeliver, rotate,   hooks.ts
//                                                 delete a webhook
//   GET  /api/forge/statuses          signed in   phase 10: a commit's statuses posted by outside   statuses.ts
//                                                 services (the API posts them: api.ts)
//   POST /api/forge/report            anyone      phase 16: a report, with or without an account,     moderation.ts
//                                                 behind Turnstile
//   GET  /api/forge/moderation        the owner   the moderation queue; ?target= one thing's state      moderation.ts
//   POST /api/forge/moderation/decide the owner   dismiss, hide, restore, answer an appeal             moderation.ts
//   POST /api/forge/appeal            signed in   an appeal or a counter-notice (Turnstile)            moderation.ts
//   GET  /api/forge/moderation/mine   signed in   what of the reader's is hidden; their requests        moderation.ts
//   GET  /api/forge/blocks            signed in   the reader's blocks and account-wide limit           blocks.ts
//   POST /api/forge/blocks/write      signed in   block, unblock (silent)                              blocks.ts
//   GET  /api/forge/limits            signed in   a repository's interaction limit                     blocks.ts
//   POST /api/forge/limits/write      signed in   set or lift an interaction limit                     blocks.ts
//   POST /api/forge/rights            signed in   a data-rights request (Turnstile)                    rights.ts
//   POST /api/forge/rights/answer     the owner   its answer, read on the person's page                rights.ts
//
// What every route gets here, in order: its path (another is 404), its method (405), the FORGE
// binding (503 not_configured without it), and for the signed-in routes the accounts (COMMUNITY and
// SESSION_KEY: 503 not_configured without them). Then the route's handler; whatever it throws
// becomes an answer in words (http.ts `failure`: D1's quota is 503 quota). Every answer is JSON,
// `Cache-Control: no-store`. The contract: docs/FORGE.md.
//
// Who may write is gate.ts (FORGE_OPEN, D01-1); what an action is, types.ts and actions.ts; OSCR's
// rows, store.ts. The repository pages themselves are static (/r/*, D00-5): signed out, a reader
// asks this Worker nothing.

import { measured, now, ready } from "../../account/guard.ts";
import { counted } from "../../account/metrics.ts";
import type { AccountEnv } from "../../account/types.ts";
import type { GitBackend } from "../gitbackend.ts";
import { handleAct } from "./act.ts";
import { handleAsset } from "./asset.ts";
import { ACTIONS } from "./actions.ts";
import { forgeBackend } from "./backend.ts";
import { failure, problem, wrongMethod } from "./http.ts";
import { handleMine, handleRepo } from "./read.ts";
import { handleResearchComment, handleResearchEdit, handleResearchOpen, handleResearchRead } from "./research.ts";
import { handleDiscussionComment, handleDiscussionEdit, handleDiscussionOpen, handleDiscussionsRead, handleDiscussionVote } from "./discussions.ts";
import { handleProjectCreate, handleProjectEdit, handleProjectField, handleProjectItem, handleProjectsRead } from "./projects.ts";
import { handleSnippetComment, handleSnippetEdit, handleSnippetsRead, handleSnippetStar } from "./snippets.ts";
import { handleActivity, handleFeed, handleInbox, handleNotices } from "./inbox.ts";
import { handleSocialFollow, handleSocialList, handleSocialMine, handleSocialPerson, handleSocialProfile, handleSocialStar, handleSocialState } from "./social.ts";
import { handleStart } from "./start.ts";
import { handleTokens, handleTokenWrite } from "./tokens.ts";
import { handleDeviceDecide, handleDeviceRead } from "./device.ts";
import { handleHookDeliveries, handleHooks, handleHookWrite } from "./hooks.ts";
import { handleStatuses } from "./statuses.ts";
import { handleSecurity, handleTriage } from "./security.ts";
import { handleStats } from "./statistics.ts";
import { handleTraffic } from "./traffic.ts";
import { handleAdvisoryEdit, handleAdvisoryOpen, handleAdvisoryPost, handleAdvisoryRead } from "./advisory.ts";
import { handleAppeal, handleModerationMine, handleModerationRead, handleModerationWrite, handleReport } from "./moderation.ts";
import { handleBlocks, handleBlockWrite, handleLimits, handleLimitWrite } from "./blocks.ts";
import { handleRights, handleRightsAnswer } from "./rights.ts";
import { handleOrgCreate, handleOrgRead, handleOrgsMine, handleOrgUpdate } from "./organizations.ts";
import { handleMembersWrite, handleTeamsWrite } from "./members.ts";
import { handleAuditRead, handleOrgSecurity } from "./audit.ts";
import { handleAccountSecurity, handleIdentitiesWrite, handleSessionsWrite } from "./account-security.ts";
import { handlePasskeyWrite } from "./webauthn.ts";
import type { Context, D1Database, ForgeDeps, ForgeRequest, ForgeServiceEnv, RouteHandler } from "./types.ts";
import { handleWebhook } from "./webhook.ts";

export type { ForgeDeps, ForgeServiceEnv } from "./types.ts";

interface Route {
  method: "GET" | "POST";
  /** A signed-in reader's route: the accounts must be set up. */
  signedIn: boolean;
  handle: RouteHandler;
}

/** The routes, by path (without a final "/"). */
export const FORGE_ROUTES: Readonly<Record<string, Route>> = {
  "/api/forge/start": { method: "POST", signedIn: true, handle: (r) => handleStart(r) },
  "/api/forge/act": { method: "POST", signedIn: true, handle: (r) => handleAct(r) },
  "/api/forge/asset": { method: "POST", signedIn: true, handle: (r) => handleAsset(r) },
  "/api/forge/webhook": { method: "POST", signedIn: false, handle: (r) => handleWebhook(r) },
  "/api/forge/repo": { method: "GET", signedIn: true, handle: (r) => handleRepo(r) },
  "/api/forge/mine": { method: "GET", signedIn: true, handle: (r) => handleMine(r) },
  "/api/forge/research": { method: "GET", signedIn: true, handle: (r) => handleResearchRead(r) },
  "/api/forge/research/open": { method: "POST", signedIn: true, handle: (r) => handleResearchOpen(r) },
  "/api/forge/research/comment": { method: "POST", signedIn: true, handle: (r) => handleResearchComment(r) },
  "/api/forge/research/edit": { method: "POST", signedIn: true, handle: (r) => handleResearchEdit(r) },
  // Night phase 06: discussions, OSCR's own objects (discussions.ts).
  "/api/forge/discussions": { method: "GET", signedIn: true, handle: (r) => handleDiscussionsRead(r) },
  "/api/forge/discussions/open": { method: "POST", signedIn: true, handle: (r) => handleDiscussionOpen(r) },
  "/api/forge/discussions/comment": { method: "POST", signedIn: true, handle: (r) => handleDiscussionComment(r) },
  "/api/forge/discussions/vote": { method: "POST", signedIn: true, handle: (r) => handleDiscussionVote(r) },
  "/api/forge/discussions/edit": { method: "POST", signedIn: true, handle: (r) => handleDiscussionEdit(r) },
  // Night phase 06: projects, OSCR's own planning boards (projects.ts).
  "/api/forge/projects": { method: "GET", signedIn: true, handle: (r) => handleProjectsRead(r) },
  "/api/forge/projects/create": { method: "POST", signedIn: true, handle: (r) => handleProjectCreate(r) },
  "/api/forge/projects/edit": { method: "POST", signedIn: true, handle: (r) => handleProjectEdit(r) },
  "/api/forge/projects/field": { method: "POST", signedIn: true, handle: (r) => handleProjectField(r) },
  "/api/forge/projects/item": { method: "POST", signedIn: true, handle: (r) => handleProjectItem(r) },
  // Night phase 13: snippets, OSCR's gists (snippets.ts). The files are authorized commits (start/act,
  // kinds snippet_create, snippet_revise, snippet_fork); these are the record's native writes.
  "/api/forge/snippets": { method: "GET", signedIn: true, handle: (r) => handleSnippetsRead(r) },
  "/api/forge/snippets/edit": { method: "POST", signedIn: true, handle: (r) => handleSnippetEdit(r) },
  "/api/forge/snippets/comment": { method: "POST", signedIn: true, handle: (r) => handleSnippetComment(r) },
  "/api/forge/snippets/star": { method: "POST", signedIn: true, handle: (r) => handleSnippetStar(r) },
  "/api/forge/social": { method: "GET", signedIn: true, handle: (r) => handleSocialState(r) },
  "/api/forge/social/mine": { method: "GET", signedIn: true, handle: (r) => handleSocialMine(r) },
  "/api/forge/social/person": { method: "GET", signedIn: true, handle: (r) => handleSocialPerson(r) },
  "/api/forge/social/star": { method: "POST", signedIn: true, handle: (r) => handleSocialStar(r) },
  "/api/forge/social/follow": { method: "POST", signedIn: true, handle: (r) => handleSocialFollow(r) },
  "/api/forge/social/list": { method: "POST", signedIn: true, handle: (r) => handleSocialList(r) },
  "/api/forge/social/profile": { method: "POST", signedIn: true, handle: (r) => handleSocialProfile(r) },
  "/api/forge/social/inbox": { method: "GET", signedIn: true, handle: (r) => handleInbox(r) },
  "/api/forge/social/notices": { method: "POST", signedIn: true, handle: (r) => handleNotices(r) },
  "/api/forge/social/feed": { method: "GET", signedIn: true, handle: (r) => handleFeed(r) },
  "/api/forge/social/activity": { method: "GET", signedIn: true, handle: (r) => handleActivity(r) },
  // Phase 10: the registry's personal tokens, for its public API (tokens.ts; the API: api.ts).
  "/api/forge/tokens": { method: "GET", signedIn: true, handle: (r) => handleTokens(r) },
  "/api/forge/tokens/write": { method: "POST", signedIn: true, handle: (r) => handleTokenWrite(r) },
  // Night phase 14: the command line's sign-in, approved on /device/ (device.ts).
  "/api/forge/device": { method: "GET", signedIn: true, handle: (r) => handleDeviceRead(r) },
  "/api/forge/device/decide": { method: "POST", signedIn: true, handle: (r) => handleDeviceDecide(r) },
  // Phase 10: outgoing webhooks (hooks.ts), the same on the API.
  "/api/forge/hooks": { method: "GET", signedIn: true, handle: (r) => handleHooks(r) },
  "/api/forge/hooks/deliveries": { method: "GET", signedIn: true, handle: (r) => handleHookDeliveries(r) },
  "/api/forge/hooks/write": { method: "POST", signedIn: true, handle: (r) => handleHookWrite(r) },
  // Phase 10: the statuses outside services posted on a commit (statuses.ts; posted through the API).
  "/api/forge/statuses": { method: "GET", signedIn: true, handle: (r) => handleStatuses(r) },
  // Phase 12: repository statistics the registry alone has (statistics.ts), the Mac's facts: "Used
  // by", the research marks, the star history. GitHub's charts are read in the browser (0 requests).
  "/api/forge/stats": { method: "GET", signedIn: true, handle: (r) => handleStats(r) },
  // Phase 12: privacy-respecting traffic (traffic.ts), aggregate only, shown to maintainers only.
  "/api/forge/traffic": { method: "GET", signedIn: true, handle: (r) => handleTraffic(r) },
  // Phase 11: the security and quality layer of a repository (security.ts), the Mac's facts.
  "/api/forge/security": { method: "GET", signedIn: true, handle: (r) => handleSecurity(r) },
  "/api/forge/security/triage": { method: "POST", signedIn: true, handle: (r) => handleTriage(r) },
  // Phase 11: private vulnerability reporting (advisory.ts), private by construction.
  "/api/forge/advisory": { method: "GET", signedIn: true, handle: (r) => handleAdvisoryRead(r) },
  "/api/forge/advisory/open": { method: "POST", signedIn: true, handle: (r) => handleAdvisoryOpen(r) },
  "/api/forge/advisory/post": { method: "POST", signedIn: true, handle: (r) => handleAdvisoryPost(r) },
  "/api/forge/advisory/edit": { method: "POST", signedIn: true, handle: (r) => handleAdvisoryEdit(r) },
  // Phase 16: reports (with or without an account), the owner's queue and decisions, appeals.
  "/api/forge/report": { method: "POST", signedIn: false, handle: (r) => handleReport(r) },
  "/api/forge/moderation": { method: "GET", signedIn: true, handle: (r) => handleModerationRead(r) },
  "/api/forge/moderation/decide": { method: "POST", signedIn: true, handle: (r) => handleModerationWrite(r) },
  "/api/forge/moderation/mine": { method: "GET", signedIn: true, handle: (r) => handleModerationMine(r) },
  "/api/forge/appeal": { method: "POST", signedIn: true, handle: (r) => handleAppeal(r) },
  // Phase 16: blocks and interaction limits.
  "/api/forge/blocks": { method: "GET", signedIn: true, handle: (r) => handleBlocks(r) },
  "/api/forge/blocks/write": { method: "POST", signedIn: true, handle: (r) => handleBlockWrite(r) },
  "/api/forge/limits": { method: "GET", signedIn: true, handle: (r) => handleLimits(r) },
  "/api/forge/limits/write": { method: "POST", signedIn: true, handle: (r) => handleLimitWrite(r) },
  // Phase 16: data-rights requests, answered in the site.
  "/api/forge/rights": { method: "POST", signedIn: true, handle: (r) => handleRights(r) },
  "/api/forge/rights/answer": { method: "POST", signedIn: true, handle: (r) => handleRightsAnswer(r) },
  // Phase 09: organizations, teams, roles, the audit log, and account security.
  "/api/forge/orgs": { method: "GET", signedIn: true, handle: (r) => handleOrgsMine(r) },
  "/api/forge/org": { method: "GET", signedIn: true, handle: (r) => handleOrgRead(r) },
  "/api/forge/org/create": { method: "POST", signedIn: true, handle: (r) => handleOrgCreate(r) },
  "/api/forge/org/update": { method: "POST", signedIn: true, handle: (r) => handleOrgUpdate(r) },
  "/api/forge/org/members": { method: "POST", signedIn: true, handle: (r) => handleMembersWrite(r) },
  "/api/forge/org/teams": { method: "POST", signedIn: true, handle: (r) => handleTeamsWrite(r) },
  "/api/forge/org/audit": { method: "GET", signedIn: true, handle: (r) => handleAuditRead(r) },
  "/api/forge/org/security": { method: "GET", signedIn: true, handle: (r) => handleOrgSecurity(r) },
  "/api/forge/account/security": { method: "GET", signedIn: true, handle: (r) => handleAccountSecurity(r) },
  "/api/forge/account/sessions": { method: "POST", signedIn: true, handle: (r) => handleSessionsWrite(r) },
  "/api/forge/account/identities": { method: "POST", signedIn: true, handle: (r) => handleIdentitiesWrite(r) },
  "/api/forge/account/passkey": { method: "POST", signedIn: true, handle: (r) => handlePasskeyWrite(r) },
};

const PREFIX = "/api/forge/";

/** Whether the forge service answers this path. */
export const isForgePath = (pathname: string): boolean => pathname.startsWith(PREFIX);

const noWait: Context = { waitUntil: (p) => void p.catch(() => undefined) };

/** The forge service's answer to `request`, or null when its path is not under /api/forge/. */
export async function handleForge(
  request: Request,
  env: ForgeServiceEnv | object,
  ctx: Context = noWait,
  deps: ForgeDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isForgePath(url.pathname)) return null;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const route = FORGE_ROUTES[path];
  if (!route) return problem(404, "not_found", "No such route.");
  const get = request.method === "GET" || request.method === "HEAD";
  if (route.method === "GET" ? !get : request.method !== "POST") return wrongMethod(route.method);
  return runRoute(request, env, ctx, deps, { url, path, signedIn: route.signedIn, handle: route.handle });
}

/** One route of the forge service, once its path and method are known (handleForge, and phase 10's
 *  public API, api.ts): the FORGE binding (503 not_configured without it), for a signed-in route the
 *  accounts (COMMUNITY and SESSION_KEY), then `prepare` (the API's token, scope and rate limit: an
 *  answer ends it there) and the handler; whatever it throws becomes an answer in words. */
export async function runRoute(
  request: Request,
  env: ForgeServiceEnv | object,
  ctx: Context,
  deps: ForgeDeps,
  o: { url: URL; path: string; signedIn: boolean; handle: RouteHandler; prepare?: (r: ForgeRequest) => Promise<Response | null> },
): Promise<Response> {
  const { url, path } = o;
  const e = env as ForgeServiceEnv;
  const forgeDb: D1Database | undefined = e.FORGE;
  if (!forgeDb) return problem(503, "not_configured", "The GitHub side is not set up yet.");
  if (o.signedIn && !ready(e as AccountEnv)) return problem(503, "not_configured", "Accounts are not set up yet.");
  const t = deps.now ? deps.now() : now();

  // Development only (ACCOUNT_DEV_METRICS=1): D1's figures for both databases in the answer.
  const metrics = e.ACCOUNT_DEV_METRICS === "1" ? counted(forgeDb) : null;
  const run = async (accountEnv: AccountEnv): Promise<Response> => {
    const full = { ...(accountEnv as ForgeServiceEnv), FORGE: metrics ? metrics.db : forgeDb };
    let backend: GitBackend | null = null;
    const r: ForgeRequest = {
      request,
      url,
      path,
      env: full,
      db: full.FORGE,
      ctx,
      t,
      backend: () => (backend ??= forgeBackend(full, deps)),
      actions: deps.actions ?? ACTIONS,
      deps,
    };
    try {
      const early = o.prepare ? await o.prepare(r) : null;
      if (early) return early;
      return await o.handle(r);
    } catch (err) {
      return failure(err, path, t);
    }
  };
  const res = await measured(e, run);
  if (metrics) {
    res.headers.set("X-D1-Forge-Queries", String(metrics.totals.queries));
    res.headers.set("X-D1-Forge-Rows-Read", String(metrics.totals.read));
    res.headers.set("X-D1-Forge-Rows-Written", String(metrics.totals.written));
  }
  return res;
}
