// POST /api/forge/start: the first half of one authorized action (D00-4; the design's §10.2 steps
// 1–3; docs/FORGE.md "One authorized action").
//
// Signed in (account/guard.ts `signedIn`: the site's Origin and the session's CSRF token), a JSON
// body of at most START_BODY_BYTES: {kind, repo, branch, expectedHead, digest, back, install?} — the
// declared action, never its payload (the page keeps it, and posts it to act after GitHub). In
// order:
//   1. the kind is one the registry has (deps.actions in the tests), the declared parameters have
//      their shapes (paths.ts), and the spec's `checkTarget` accepts them;
//   2. a spec that `needsRepo` names a repository the registry knows (1 row read, by key or by
//      repos_path);
//   3. `mayWrite` on the GitHub account linked to the signed-in account (gate.ts, FORGE_OPEN);
//   4. the account's daily caps (gate.ts `dailyCaps`: reads only);
//   5. the flow cookie (flow.ts: the state, the PKCE verifier, the declared action and its digest,
//      the session's hash, the return page; 10 minutes), and `{location}`: GitHub's authorization
//      page (redirect_uri = this site's /forge/authorized/), or the App's installation page when the
//      page asks to install first (the App requests the user's authorization during installation,
//      so the return carries a code as well).
// Nothing is written to D1 `oscr_forge`.

import { pkceChallenge, randomToken } from "../../account/crypto.ts";
import { signedIn } from "../../account/guard.ts";
import { isRefName, OBJECT_ID } from "../paths.ts";
import { FLOW_SECONDS, START_BODY_BYTES } from "./caps.ts";
import { callbackUrl, flowCookie, readCapped, repoTarget, sameOriginPath, type ForgeFlow } from "./flow.ts";
import { closed, dailyCaps, mayWrite, overCap } from "./gate.ts";
import { accountHidden, suspended } from "./hidden.ts";
import { json, problem, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import { first, repoByKey, repoByPath } from "./store.ts";
import { ForgeProblem, isActionKind, type ActionTarget, type D1Database, type ForgeRequest, type RepoRow, type RepoTarget } from "./types.ts";

/** Where a page goes back to when it names no page of its own. */
export const DEFAULT_BACK = "/repositories/";

const HEX64 = /^[0-9a-f]{64}$/;

const bad = (message: string) => new ForgeProblem(400, "bad_request", message);

/** A JSON object's text, parsed, or null. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The repository a target names, when the registry knows it (1 row read: the key, or repos_path). */
export async function loadRepo(db: D1Database, repo: RepoTarget | null): Promise<RepoRow | null> {
  if (!repo) return null;
  if ("id" in repo) return first<RepoRow>(repoByKey(db, repo.forge, repo.id));
  return first<RepoRow>(repoByPath(db, repo.forge, repo.owner, repo.name));
}

/** The answer when the registry does not know the repository a page names. */
export const unknownRepo = () =>
  new ForgeProblem(404, "unknown_repository", "The registry does not know this repository: link it first, from the page “Link a repository”.");

/** The body of start, checked: the declared action, its digest, the return page. */
export function readStart(body: Record<string, unknown>, forge: string): { target: ActionTarget; digest: string; back: string; install: boolean } | ForgeProblem {
  if (!isActionKind(body.kind)) return bad("This is not an action the registry knows.");
  const repo = repoTarget(body.repo, forge);
  if (repo === undefined) return bad("The repository is not named the way the registry names one.");
  const branch = body.branch ?? null;
  if (!(branch === null || isRefName(branch))) return bad("This is not a branch name.");
  const expectedHead = body.expectedHead ?? null;
  if (!(expectedHead === null || (typeof expectedHead === "string" && OBJECT_ID.test(expectedHead)))) {
    return bad("The branch's head is not a full commit id.");
  }
  if (typeof body.digest !== "string" || !HEX64.test(body.digest)) return bad("The action's fingerprint (its SHA-256) is missing.");
  if (body.install !== undefined && typeof body.install !== "boolean") return bad("The installation choice is not true or false.");
  return {
    target: { kind: body.kind, repo, branch: branch as string | null, expectedHead: expectedHead as string | null },
    digest: body.digest,
    back: sameOriginPath(body.back) ?? DEFAULT_BACK,
    install: body.install === true,
  };
}

export async function handleStart(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);

  if (!(r.request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return say(bad("The request is not the declaration of an action."));
  }
  const text = await readCapped(r.request, START_BODY_BYTES);
  if (text === null) return say(new ForgeProblem(413, "too_large", "This request is larger than an action's declaration may be."));
  const body = parseObject(text);
  if (!body) return say(bad("The request is not the declaration of an action."));

  const backend = r.backend();
  const read = readStart(body, backend.forge);
  if (read instanceof ForgeProblem) return say(read);
  const { target, digest, back, install } = read;

  // 1. The kind, and its target.
  const spec = r.actions.get(target.kind);
  if (!spec) return problem(501, "not_built", `This part of the GitHub side (the action ${target.kind}) is not built yet.`, s.cookies);
  if (spec.needsRepo && !target.repo) return say(bad("This action needs the repository it works on."));
  const refused = spec.checkTarget?.(target) ?? null;
  if (refused) return say(refused);

  // 2. A repository the registry knows.
  if (spec.needsRepo && !(await loadRepo(r.db, target.repo))) return say(unknownRepo());

  // 3. Who may write (FORGE_OPEN), on the GitHub account linked to this account; night phase 16: not a
  //    suspended account.
  if (!mayWrite(r.env, await linkedGithub(s.db, s.user.id))) return say(closed());
  const hidden = await accountHidden(r.db, s.user.id);
  if (hidden) return say(suspended(hidden));

  // 4. The daily caps (reads only).
  const caps = await dailyCaps(r.db, s.user.id, target.kind, r.t);
  if (caps.exceeded) return say(overCap(caps.exceeded));

  // 5. The flow, and where the browser goes.
  const auth = backend.auth;
  if (!auth) return problem(501, "unsupported", "This forge has no authorization the registry can ask for.", s.cookies);
  const flow: ForgeFlow = {
    v: 1,
    st: randomToken(32),
    cv: randomToken(32),
    act: { kind: target.kind, forge: backend.forge, repo: target.repo, branch: target.branch, expectedHead: target.expectedHead, digest },
    sid: s.session.idHash,
    rt: back,
    ins: install,
    exp: r.t + FLOW_SECONDS,
  };
  const location = install
    ? auth.installUrl(flow.st)
    : auth.authorizeUrl({ state: flow.st, codeChallenge: await pkceChallenge(flow.cv), redirectUri: callbackUrl(r.url.origin) });
  return json({ location }, 200, [...s.cookies, await flowCookie(r.env.SESSION_KEY as string, flow)]);
}
