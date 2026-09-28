// The accounts (Phase 5): sign-in with ORCID, GitHub and Google, sessions, roles, and the
// verification of authors and maintainers. One entry point, `handleAccount`, which the Worker's
// entry (worker/index.ts) calls first: it answers /api/auth/* and /api/account/*, and returns
// null for any other path.
//
//   GET  /api/auth/{orcid|github|google}/start?return=/account/   302 to the provider
//   GET  /api/auth/{orcid|github|google}/callback                 302 back to the page
//   GET  /api/account/me                                          the account, or {signed_in: false}
//   POST /api/account/signout                                     the session deleted
//   POST /api/account/authorship                                  the author verification, again
//   POST /api/account/maintainer   {"repo": "…"}                  verified, pending, or a GitHub check
//
// Every POST needs the session, its CSRF token (header X-CSRF-Token, from /api/account/me) and the
// site's own Origin. The contract, the D1 writes of each route and the owner's setup:
// docs/ACCOUNTS.md.

import { sameText } from "./crypto.ts";
import { beginFlow, callbackUrl, FLOW_COOKIE, openFlow, type Flow } from "./flow.ts";
import { MAX_BODY, measured, now, readJson, ready, signedIn, staleCookies } from "./guard.ts";
import { clearCookie, json, problem, readCookie, redirect, returnPath, withQuery } from "./http.ts";
import { configured, exchange, identify, LABELS, provider, PROVIDERS, type Person, type Provider, type ProviderName } from "./providers.ts";
import { repoKey, repoUrl } from "./repo.ts";
import {
  agentHint,
  closeSession,
  csrfToken,
  hintCookie,
  loadSession,
  openSession,
  SESSION_COOKIE,
  sessionCookie,
  sessionHash,
  sessionValue,
  type Session,
} from "./session.ts";
import {
  AccountError,
  createUser,
  grantMaintainer,
  hasRole,
  identitiesOf,
  identityOwner,
  linkIdentity,
  pendingClaims,
  pendingMaintainer,
  reads,
  refreshUser,
  repoOwner,
  syncAuthorRoles,
  userById,
  type Claim,
  type Identity,
  type PaperFact,
  type Role,
  type User,
} from "./store.ts";
import type { AccountEnv, Context, D1Database } from "./types.ts";
import { checkMaintainer, GithubUnavailable } from "./verify.ts";

export type { AccountEnv } from "./types.ts";

/** Claims a user may have waiting for a moderator at once. */
export const MAX_PENDING = 20;

/** The accounts' answer to `request`, or null when its path is not theirs. `env` is the Worker's
 *  whole environment: the accounts read their own bindings from it (AccountEnv). */
export async function handleAccount(request: Request, env: AccountEnv | object, _ctx?: Context): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  if (!/^\/api\/(auth|account)(\/|$)/.test(path)) return null;
  return measured(env as AccountEnv, async (e) => {
    try {
      return await route(request, e, url, path);
    } catch (err) {
      return failure(err, path);
    }
  });
}

async function route(request: Request, env: AccountEnv, url: URL, path: string): Promise<Response> {
  const t = now();
  const auth = /^\/api\/auth\/([a-z]+)\/(start|callback)$/.exec(path);
  if (auth) {
    if (!(PROVIDERS as readonly string[]).includes(auth[1])) return problem(404, "not_found", "No such way to sign in.");
    if (request.method !== "GET") return problem(405, "method_not_allowed", "Sign-in pages answer GET only.");
    const name = auth[1] as ProviderName;
    return auth[2] === "start" ? start(request, env, name, url, t) : callback(request, env, name, url, t);
  }
  const post = request.method === "POST";
  switch (path) {
    case "/api/account/me":
      return request.method === "GET" ? me(request, env, t) : problem(405, "method_not_allowed", "Use GET.");
    case "/api/account/signout":
      return post ? signout(request, env, t) : problem(405, "method_not_allowed", "Use POST.");
    case "/api/account/authorship":
      return post ? authorship(request, env, t) : problem(405, "method_not_allowed", "Use POST.");
    case "/api/account/maintainer":
      return post ? maintainer(request, env, url, t) : problem(405, "method_not_allowed", "Use POST.");
  }
  return problem(404, "not_found", "No such route.");
}

function failure(err: unknown, path: string): Response {
  const message = String((err as Error)?.message ?? err);
  console.error(`accounts ${path}: ${message.slice(0, 300)}`);
  const quota = /D1/.test(message) && /exceeded|limit/i.test(message);
  if (path.startsWith("/api/auth/")) return redirect(withQuery("/account/", { error: quota ? "quota" : "unavailable" }), [clearCookie(FLOW_COOKIE)]);
  return quota
    ? problem(503, "quota", "The registry has used its daily quota. Please try again tomorrow.")
    : problem(503, "unavailable", "The accounts are unavailable at the moment. Please try again later.");
}

// ---------------------------------------------------------------------------------------------
// Sign-in.

async function start(request: Request, env: AccountEnv, name: ProviderName, url: URL, t: number): Promise<Response> {
  const back = returnPath(url.searchParams.get("return"));
  const p = provider(env, name);
  if (!ready(env) || !p) return redirect(withQuery(back, { error: "unavailable_provider", provider: name }));
  // A flow started signed in links the new identity to this account (flow.ts, `sid`).
  const value = sessionValue(request);
  const sid = value ? await sessionHash(value) : "";
  const { location, cookie } = await beginFlow(env.SESSION_KEY, p, { origin: url.origin, intent: "signin", sid, repo: "", back, now: t });
  return redirect(location, [cookie]);
}

async function callback(request: Request, env: AccountEnv, name: ProviderName, url: URL, t: number): Promise<Response> {
  const clear = clearCookie(FLOW_COOKIE);
  if (!ready(env)) return redirect(withQuery("/account/", { error: "unavailable_provider", provider: name }), [clear]);
  const db = env.COMMUNITY;
  const flow = await openFlow(env.SESSION_KEY, readCookie(request, FLOW_COOKIE), t);
  const back = flow?.rt ?? "/account/";
  const fail = (code: string) => redirect(withQuery(back, { error: code, provider: name }), [clear]);
  // The state must come back to the browser that started this flow (login CSRF).
  if (!flow || flow.p !== name || !sameText(url.searchParams.get("state") ?? "", flow.st)) return fail("expired");
  const refused = url.searchParams.get("error");
  if (refused) return fail(refused === "access_denied" ? "denied" : "provider_error");
  const code = url.searchParams.get("code") ?? "";
  const p = provider(env, name);
  if (!p) return fail("unavailable_provider");
  if (!code || code.length > 2048) return fail("provider_error");

  let person: Person;
  let accessToken: string;
  try {
    const tokens = await exchange(p, { code, redirectUri: callbackUrl(url.origin, name), verifier: flow.cv });
    person = await identify(p, tokens, flow.n, t);
    accessToken = tokens.access_token ?? "";
  } catch (e) {
    console.warn(`accounts: ${name}: sign-in refused: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return fail("provider_error");
  }

  const value = sessionValue(request);
  const hash = value ? await sessionHash(value) : null;
  const current = hash ? await loadSession(db, hash, t) : null;
  // Linked only when this very session started the flow.
  const bound = current !== null && flow.sid !== "" && sameText(flow.sid, current.idHash);

  if (flow.in === "verify") {
    if (!current || !bound || p.name !== "github") return fail("session_changed");
    return verifyMaintainer(db, p, current, person, accessToken, flow, back, t, clear);
  }

  let user: User;
  let outcome: "signed_in" | "linked";
  try {
    if (current && bound) {
      const mine = await userById(db, current.userId);
      if (!mine) return fail("expired");
      user = await linkIdentity(db, mine, person, t);
      outcome = "linked";
    } else {
      const owner = await identityOwner(db, person.provider, person.subject);
      const existing = owner ? await userById(db, owner) : null;
      user = existing ? await refreshUser(db, existing, person) : await createUser(db, person, t);
      outcome = "signed_in";
    }
  } catch (e) {
    if (e instanceof AccountError) return fail(e.code);
    throw e;
  }
  const cookies = [clear];
  if (outcome === "signed_in") {
    // A new session id at every sign-in; the browser's previous session, if any, is deleted.
    cookies.push(sessionCookie(await openSession(db, user.id, t, agentHint(request.headers.get("User-Agent")), hash)), hintCookie(true));
  }
  // Author verification, on every sign-in of an account with an ORCID iD.
  if (user.orcid) await syncAuthorRoles(db, user.id, user.orcid, t);
  return redirect(withQuery(back, { [outcome]: name }), cookies);
}

/** The callback of a maintainer check: the GitHub account is the account's own (linked on the
 *  way if it was not yet), then checked against the repository (verify.ts). */
async function verifyMaintainer(
  db: D1Database,
  p: Provider,
  current: Session,
  person: Person,
  token: string,
  flow: Flow,
  back: string,
  t: number,
  clear: string,
): Promise<Response> {
  const fail = (code: string) => redirect(withQuery(back, { error: code, provider: "github" }), [clear]);
  const done = (outcome: string) => redirect(withQuery(back, { maintainer: outcome, repo: flow.rp }), [clear]);
  const mine = await userById(db, current.userId);
  if (!mine) return fail("expired");
  const linked = (await identitiesOf(db, mine.id)).find((i) => i.provider === "github");
  if (linked && linked.subject !== person.subject) return fail("other_github_account");
  try {
    await linkIdentity(db, mine, person, t);
  } catch (e) {
    if (e instanceof AccountError) return fail(e.code);
    throw e;
  }
  const facts = await repoOwner(db, flow.rp);
  if (!facts || facts.host !== "github.com") return fail("unknown_repo");
  let check;
  try {
    check = await checkMaintainer(p, token, { login: person.handle, owner: facts.owner, name: flow.rp.split("/")[2] ?? "" });
  } catch (e) {
    if (e instanceof GithubUnavailable) {
      console.warn(`accounts: maintainer check: ${e.message}`);
      return done("unavailable");
    }
    throw e;
  }
  const evidence = { login: person.handle, github_id: person.subject, via: check.via, checked: check.checked, at: t };
  if (check.verified) {
    await grantMaintainer(db, mine.id, flow.rp, evidence, t);
    return done("verified");
  }
  const claim = await pendingMaintainer(db, mine.id, flow.rp, evidence, t);
  return done(claim.status);
}

// ---------------------------------------------------------------------------------------------
// The account.

const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString() : null);

/** The page of a paper: the slug the Mac pushed, else the same rule as catalog.slug. */
export function paperSlug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}

function paperJson(p: PaperFact) {
  return {
    id: p.paper_id,
    doi: p.paper_id.startsWith("doi:") ? p.paper_id.slice(4) : "",
    title: p.title ?? "",
    url: `/paper/${p.slug || paperSlug(p.paper_id)}/`,
  };
}

function providerList(env: AccountEnv, linked: Set<string>) {
  return configured(env).map((name) => ({
    name,
    label: LABELS[name],
    linked: linked.has(name),
    start: `/api/auth/${name}/start?return=/account/`,
  }));
}

async function me(request: Request, env: AccountEnv, t: number): Promise<Response> {
  if (!ready(env)) return json({ signed_in: false, available: false, providers: [] });
  const s = await signedIn(request, env, t, { post: false, touch: true });
  if (s instanceof Response) {
    if (s.status !== 401) return s;
    return json({ signed_in: false, available: true, providers: providerList(env, new Set()) }, 200, staleCookies(request));
  }
  const { db, user } = s;
  const [ids, roles, papers, claims] = await db.batch([
    reads.identities(db, user.id),
    reads.roles(db, user.id),
    reads.papers(db, user.id, user.orcid),
    reads.claims(db, user.id),
  ]);
  const identities = (ids?.results ?? []) as unknown as Identity[];
  const orcidSite = provider(env, "orcid")?.profile ?? "https://orcid.org";
  const githubSite = provider(env, "github")?.profile ?? "https://github.com";
  const held = (roles?.results ?? []) as unknown as Role[];
  return json(
    {
      signed_in: true,
      available: true,
      user: { display_name: user.display_name, created_at: iso(user.created_at) },
      handles: { orcid: user.orcid, github: user.github_login },
      identities: identities.map((i) => {
        const handle = i.provider === "orcid" ? i.subject : i.provider === "github" ? (user.github_login ?? "") : "";
        const url = i.provider === "orcid" ? `${orcidSite}/${handle}` : i.provider === "github" && handle ? `${githubSite}/${handle}` : "";
        return { provider: i.provider, label: LABELS[i.provider], handle, url, linked_at: iso(i.linked_at) };
      }),
      providers: providerList(env, new Set(identities.map((i) => i.provider))),
      roles: [
        { role: "member", scope_kind: "", scope_id: "", automatic: true, granted_at: iso(user.created_at) },
        ...held.map((r) => ({ role: r.role, scope_kind: r.scope_kind, scope_id: r.scope_id, automatic: r.granted_by === "system", granted_at: iso(r.granted_at) })),
      ],
      papers: ((papers?.results ?? []) as unknown as PaperFact[]).map(paperJson),
      repositories: held.filter((r) => r.role === "maintainer").map((r) => ({ repo: r.scope_id, url: repoUrl(r.scope_id) })),
      claims: ((claims?.results ?? []) as unknown as Claim[]).map((c) => {
        let via = null;
        try {
          via = (JSON.parse(c.evidence) as { via?: string | null }).via ?? null;
        } catch {
          // an evidence that is not JSON cannot be stored (CHECK json_valid)
        }
        return {
          id: c.id,
          kind: c.kind,
          paper_id: c.paper_id,
          repo: c.repo,
          url: c.paper_id ? `/paper/${paperSlug(c.paper_id)}/` : repoUrl(c.repo),
          status: c.status,
          via,
          message: c.message ?? "",
          created_at: iso(c.created_at),
          decided_at: iso(c.decided_at),
        };
      }),
      csrf: await csrfToken(s.key, s.session.idHash),
    },
    200,
    s.cookies,
  );
}

async function signout(request: Request, env: AccountEnv, t: number): Promise<Response> {
  const s = await signedIn(request, env, t, { post: true, touch: false });
  if (s instanceof Response) return s;
  await closeSession(s.db, s.session.idHash);
  return json({ signed_in: false }, 200, [clearCookie(SESSION_COOKIE), hintCookie(false)]);
}

async function authorship(request: Request, env: AccountEnv, t: number): Promise<Response> {
  const s = await signedIn(request, env, t, { post: true, touch: true });
  if (s instanceof Response) return s;
  if (!s.user.orcid) {
    return problem(409, "no_orcid", "Link your ORCID iD first: the verification looks for it among the papers' authors.", s.cookies);
  }
  const { granted, revoked } = await syncAuthorRoles(s.db, s.user.id, s.user.orcid, t);
  const papers = (await reads.papers(s.db, s.user.id, s.user.orcid).all<PaperFact>()).results;
  return json({ granted, revoked, papers: papers.map(paperJson) }, 200, s.cookies);
}

async function maintainer(request: Request, env: AccountEnv, url: URL, t: number): Promise<Response> {
  const s = await signedIn(request, env, t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const { db, user } = s;
  const body = await readJson(request, MAX_BODY);
  const repo = repoKey(typeof body?.repo === "string" ? body.repo : "");
  if (!repo) {
    return problem(400, "bad_repo", "Give the address of the repository, such as https://github.com/owner/name.", s.cookies);
  }
  const facts = await repoOwner(db, repo);
  if (!facts) return problem(404, "unknown_repo", "This repository is not the code of a paper in the registry.", s.cookies);
  if (await hasRole(db, user.id, "maintainer", "repo", repo)) return json({ status: "verified", repo, already: true }, 200, s.cookies);
  if ((await pendingClaims(db, user.id)) >= MAX_PENDING) {
    return problem(429, "too_many_claims", `You have ${MAX_PENDING} claims waiting for a moderator: please wait for them.`, s.cookies);
  }
  if (facts.host !== "github.com") {
    // Only GitHub can be checked automatically: the claim waits for a moderator.
    const claim = await pendingMaintainer(db, user.id, repo, { reason: "not_github", host: facts.host, at: t }, t);
    return json({ status: claim.status, repo, claim: claim.id }, claim.status === "pending" ? 202 : 200, s.cookies);
  }
  const p = provider(env, "github");
  if (!p) return problem(503, "unavailable_provider", "The GitHub check is not set up yet.", s.cookies);
  // The check needs a fresh GitHub token, which the registry never keeps: one round trip through
  // GitHub (immediate once the application is authorized), then the callback decides.
  const { location, cookie } = await beginFlow(s.key, p, { origin: url.origin, intent: "verify", sid: s.session.idHash, repo, back: "/account/", now: t });
  return json({ status: "redirect", url: location }, 200, [...s.cookies, cookie]);
}
