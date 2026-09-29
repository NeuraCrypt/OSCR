// POST /api/forge/act: the second half of one authorized action (D00-4; the design's §10.2 steps
// 4–6 and §17; docs/FORGE.md "One authorized action").
//
// Signed in (Origin, CSRF). The body is JSON {code, state, payload}: `payload` is the exact text the
// page kept, of at most ACTION_PAYLOAD_BYTES (1 MiB, else 413). The body is read once, capped as it
// streams (never cloned), and the payload's bytes are made once, for its SHA-256. In order:
//   1. the flow cookie opened (flow.ts: the server's, purpose "forge", not expired), its state equal
//      to the one GitHub brought back, its session this one;
//   2. SHA-256(payload) equal to the digest bound at start: the action is the one confirmed;
//   3. the spec's `validate` on the payload (again: nothing reaches GitHub unchecked), and the
//      repository loaded when the spec `needsRepo`;
//   4. the code exchanged (PKCE: the cookie's verifier), then GitHub asked who authorized;
//   5. that GitHub account required to be the signed-in account's (identity.ts: linked now when
//      nobody has it; 409 identity_conflict when another account has);
//   6. `mayWrite` again, on the account GitHub named (gate.ts, FORGE_OPEN), the daily caps again,
//      and the global cap (gate.ts `globalCap`, D01-12);
//   7. `spec.perform` as the person (backend.session({kind: "user", token})), then `spec.check` on
//      GitHub's answer: false, and nothing is recorded (502 mismatch);
//   8. ONE D1 batch: the action row (its `rows` counting itself and the spec's) and the spec's rows.
// Every answer clears the flow cookie: one authorization is one attempt. On every path after the
// exchange, failures included, the token is revoked in ctx.waitUntil (once). The token is never in
// D1, a cookie, a log, an error or the answer: it lives in this function's scope only.
// A `conflict` (the branch moved) answers 409 with offer "new_branch" (http.ts `gitProblem`).
// A refused action writes nothing, not even an action row.
// Phase 07: the steps are `runAction`, which the file route (asset.ts: a release asset streamed as the
// request's body) shares; act itself never carries a file.

import { sameText } from "../../account/crypto.ts";
import { signedIn } from "../../account/guard.ts";
import { readCookie } from "../../account/http.ts";
import { GitBackendError } from "../errors.ts";
import type { ForgeAuth } from "../gitbackend.ts";
import { ACTION_PAYLOAD_BYTES } from "./caps.ts";
import { callbackUrl, clearFlowCookie, FORGE_COOKIE, openForgeFlow, readCapped, type ForgeFlow } from "./flow.ts";
import { closed, dailyCaps, globalCap, mayWrite, overCap } from "./gate.ts";
import { failure, json, problem, problemAnswer, redact } from "./http.ts";
import { requireIdentity } from "./identity.ts";
import { loadRepo, unknownRepo } from "./start.ts";
import { actionEventWrites, eventsOfAction } from "./events.ts";
import { actionRow, first, newNonce, repoByKey, rowsOf, statements } from "./store.ts";
import { ForgeProblem, isProblem, type ActionContext, type ActionTarget, type AnyActionSpec, type ForgeRequest, type RepoRow } from "./types.ts";

/** The largest body read: the payload's text, escaped inside a JSON string (quotes and backslashes
 *  double), plus the code and the state. The payload itself is then held to ACTION_PAYLOAD_BYTES. */
export const ACT_BODY_BYTES = 2 * ACTION_PAYLOAD_BYTES + 4096;
/** The rows the global cap reserves for one action before it is performed: the most an action of
 *  phase 01 writes with one paper (docs/FORGE.md, "Action kinds": create or link, 6). The cap is
 *  asked before GitHub is, so that an action the registry could not record is never done. */
export const ACT_ROWS_RESERVED = 12;

const encoder = new TextEncoder();

const EXPIRED =
  "This authorization has expired, was already used, or was started in another tab or browser: nothing was done. Go back to the page, then start the action again.";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The body of act, checked: {code, state, payload}, the payload a text. */
function readBody(text: string): { code: string; state: string; payload: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const b = value as Record<string, unknown>;
  if (typeof b.code !== "string" || !b.code || b.code.length > 200) return null;
  if (typeof b.state !== "string" || !b.state || b.state.length > 256) return null;
  if (typeof b.payload !== "string") return null;
  return { code: b.code, state: b.state, payload: b.payload };
}

export async function handleAct(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  // Every answer from here ends the flow.
  const cookies = [...s.cookies, clearFlowCookie()];
  const say = (p: ForgeProblem) => problemAnswer(p, cookies);

  if (!(r.request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return say(new ForgeProblem(400, "bad_request", "The request is not the completion of an action."));
  }
  const text = await readCapped(r.request, ACT_BODY_BYTES);
  if (text === null) return say(tooLarge());
  const body = readBody(text);
  if (!body) return say(new ForgeProblem(400, "bad_request", "The request is not the completion of an action."));
  return runAction(r, s, cookies, body);
}

/** What the file route (asset.ts, phase 07) hands to `runAction`: the file streamed, its length. */
export interface Streamed {
  upload: { body: ReadableStream<Uint8Array>; size: number };
  /** The only kind this route completes. */
  kind: AnyActionSpec["kind"];
}

/** Steps 1 to 8 of one authorized action, from its completion ({code, state, payload}); for the file
 *  route, with the file streamed to the spec (ctx.upload). Every answer carries `cookies` (the flow
 *  cleared). */
export async function runAction(
  r: ForgeRequest,
  s: Exclude<Awaited<ReturnType<typeof signedIn>>, Response>,
  cookies: string[],
  body: { code: string; state: string; payload: string },
  streamed?: Streamed,
): Promise<Response> {
  const say = (p: ForgeProblem) => problemAnswer(p, cookies);

  // 1. The flow: this server's, for this state, from this session.
  const flow = await openForgeFlow(r.env.SESSION_KEY as string, readCookie(r.request, FORGE_COOKIE), r.t);
  if (!flow || !sameText(body.state, flow.st) || !sameText(flow.sid, s.session.idHash)) {
    return say(new ForgeProblem(400, "bad_state", EXPIRED));
  }

  // 2. The payload is the one confirmed.
  const bytes = encoder.encode(body.payload);
  if (bytes.byteLength > ACTION_PAYLOAD_BYTES) return say(tooLarge());
  if (!sameText(await sha256Hex(bytes), flow.act.digest)) {
    return say(
      new ForgeProblem(400, "bad_digest", "What this page sent is not the action you confirmed: nothing was done. Go back to the page, then start again."),
    );
  }

  // The file route completes its own kind only; any other action comes through act.
  if (streamed && flow.act.kind !== streamed.kind) return say(new ForgeProblem(400, "bad_request", "This authorization is not for a file: nothing was done."));

  // 3. The spec's checks, before GitHub.
  const spec = r.actions.get(flow.act.kind);
  if (!spec) return problem(501, "not_built", `This part of the GitHub side (the action ${flow.act.kind}) is not built yet.`, cookies);
  let payload: unknown;
  try {
    payload = JSON.parse(body.payload);
  } catch {
    return say(new ForgeProblem(400, "bad_payload", "The action's content is not readable: nothing was done."));
  }
  const parsed = spec.validate(payload);
  if (isProblem(parsed)) return say(parsed);
  const backend = r.backend();
  const auth = backend.auth;
  if (!auth || flow.act.forge !== backend.forge) return say(new ForgeProblem(400, "bad_state", EXPIRED));
  const target: ActionTarget = { kind: flow.act.kind, repo: flow.act.repo, branch: flow.act.branch, expectedHead: flow.act.expectedHead };
  const repo = spec.needsRepo ? await loadRepo(r.db, target.repo) : null;
  if (spec.needsRepo && !repo) return say(unknownRepo());

  // 4. The code, for a token (the only one of this action).
  let token: string;
  try {
    token = (await auth.exchange({ code: body.code, codeVerifier: flow.cv, redirectUri: callbackUrl(r.url.origin) })).token;
  } catch (err) {
    return withCookies(failure(err, r.path, r.t), cookies);
  }
  try {
    return await asThePerson(r, { flow, spec, parsed, target, repo, auth, token, cookies, user: s.user, community: s.db, upload: streamed?.upload });
  } catch (err) {
    return withCookies(failure(err, r.path, r.t), cookies);
  } finally {
    // Every path after the exchange, failures included: revoked once, in the background.
    r.ctx.waitUntil(
      auth.revoke(token).catch((e: unknown) => {
        console.error(`forge ${r.path}: the revocation failed: ${e instanceof GitBackendError ? e.code : "error"}`);
      }),
    );
  }
}

function tooLarge(): ForgeProblem {
  return new ForgeProblem(
    413,
    "too_large",
    "This action is larger than the registry can pass to GitHub (1 MiB): GitHub's own page, or git, can do it.",
  );
}

/** An answer with the flow's cookies added (a failure answered by http.ts `failure`). */
function withCookies(res: Response, cookies: string[]): Response {
  for (const c of cookies) res.headers.append("Set-Cookie", c);
  return res;
}

interface Acting {
  flow: ForgeFlow;
  spec: AnyActionSpec;
  parsed: unknown;
  target: ActionTarget;
  repo: RepoRow | null;
  auth: ForgeAuth;
  token: string;
  cookies: string[];
  user: ActionContext<unknown>["user"];
  community: ActionContext<unknown>["community"];
  upload?: ActionContext<unknown>["upload"];
}

/** Steps 5 to 8, with the person's token. */
async function asThePerson(r: ForgeRequest, a: Acting): Promise<Response> {
  const say = (p: ForgeProblem) => problemAnswer(p, a.cookies);
  const me = await a.auth.whoAmI(a.token);
  const github = { id: String(me.id), login: String(me.login) };

  // 5. The GitHub account is this account's.
  const user = await requireIdentity(a.community, a.user, github, r.t);
  if (isProblem(user)) return say(user);

  // 6. Who may write, and how much.
  if (!mayWrite(r.env, github.id)) return say(closed());
  const caps = await dailyCaps(r.db, user.id, a.flow.act.kind, r.t);
  if (caps.exceeded) return say(overCap(caps.exceeded));
  const full = await globalCap(r.db, r.t, ACT_ROWS_RESERVED);
  if (full) return say(full);

  // 7. The action, as the person; GitHub's answer checked before anything is recorded.
  const backend = r.backend();
  const ctx: ActionContext<unknown> = {
    env: r.env,
    db: r.db,
    community: a.community,
    backend,
    session: backend.session({ kind: "user", token: a.token }),
    github,
    user,
    parsed: a.parsed,
    target: a.target,
    repo: a.repo,
    t: r.t,
    nonce: newNonce(),
    installations: {
      list: (page) => a.auth.installations(a.token, page),
      repositories: (id, page) => a.auth.installationRepositories(a.token, id, page),
    },
    ...(a.upload ? { upload: a.upload } : {}),
  };
  const out = await a.spec.perform(ctx);
  if (!a.spec.check(out.result, a.parsed, ctx)) {
    console.error(`forge ${r.path}: ${a.flow.act.kind}: GitHub's answer does not match the action authorized`);
    return say(
      new ForgeProblem(
        502,
        "mismatch",
        "GitHub's answer does not match the action you authorized, so the registry recorded nothing. Check the repository on GitHub.",
      ),
    );
  }

  // 8. One batch: the action row and the spec's rows. Phase 08: the action's events (events.ts: each
  // written once, whether GitHub's webhook for the same act lands before or after) and the threads the
  // person now takes part in.
  const named = out.repo ?? (a.repo ? { forge: a.repo.forge, repoId: a.repo.repo_id } : null);
  // The repository the registry knows (read by its key when the spec did not need it): its events
  // only while it is alive in the registry, under its path.
  const known = a.repo ?? (named ? await first<RepoRow>(repoByKey(r.db, named.forge, named.repoId)) : null);
  const alive = known && known.name && (known.state === "active" || known.state === "archived") ? known : null;
  const path = alive ? `${alive.owner_login}/${alive.name}` : "";
  const social = eventsOfAction({
    kind: a.flow.act.kind,
    parsed: a.parsed,
    result: out.result,
    repo: named && path ? { forge: named.forge, repoId: named.repoId, path } : null,
    user: { id: user.id, github: github.id, login: github.login },
    t: r.t,
    nonce: ctx.nonce,
  });
  const writes = [...(out.writes ?? []), ...actionEventWrites(r.db, user.id, social, r.t)];
  const action = actionRow(r.db, {
    userId: user.id,
    t: r.t,
    nonce: ctx.nonce,
    kind: a.flow.act.kind,
    forge: named?.forge ?? backend.forge,
    repoId: named?.repoId ?? "",
    githubUser: github.id,
    outcome: out.outcome ?? "done",
    rows: 1 + rowsOf(writes),
    subject: social.events[0]?.subject ?? "",
  });
  try {
    await r.db.batch([action.stmt, ...statements(writes)]);
  } catch (err) {
    console.error(`forge ${r.path}: ${a.flow.act.kind} done on GitHub, not recorded: ${redact(String((err as Error)?.message ?? err)).slice(0, 300)}`);
    return say(
      new ForgeProblem(
        503,
        "not_recorded",
        "GitHub did it, but the registry could not record it at the moment: the repository's page may not show it until the next nightly check.",
      ),
    );
  }
  return json({ result: out.result, sentence: a.spec.describe(a.parsed), outcome: out.outcome ?? "done", back: a.flow.rt }, 200, a.cookies);
}
