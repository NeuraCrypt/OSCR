// The command line's sign-in (night phase 14; device-core.ts says how it works; docs/API.md "The
// command line's sign-in"; D14-2). Six routes:
//
//   GET  /api/v1/cli               no token   what the command line needs: the GitHub App's public
//                                             client id (its own GitHub sign-in asks GitHub directly),
//                                             the device flow's routes, the scopes
//   POST /api/v1/device/code       no token   a code: {scopes, days?, name?} → device_code, user_code,
//                                             verification_uri, expires_in (900), interval (5). No row.
//   POST /api/v1/device/token      no token   the command line's poll: {device_code} → 400
//                                             authorization_pending | slow_down | access_denied |
//                                             expired_token | invalid_grant, or 200 with the token, once
//   POST /api/v1/token/revoke      a token    the token revokes itself (`oscr auth logout`): never refused
//                                             by a cap or FORGE_OPEN
//   GET  /api/forge/device         signed in  the approval page: what a sealed request asks, its state
//   POST /api/forge/device/decide  signed in  {request, code, decision: approve | deny, turnstile}: the
//                                             person's decision (cookie, Origin, CSRF: account/guard.ts)
//
// Approving is making a token: the same rules as the settings page (tokens.ts): FORGE_OPEN (until the
// content rules, only the owner), the human check when it is set up, a suspended account makes none, 20
// tokens an account, the `automation` cap (50 a day) and the day's rows. Refusing is never refused.
// Rows: an approval 2 (the grant, its action row), a refusal 2, the collection 4 (the grant marked, the
// token and its index entry, the action row); a code and a poll write nothing.
//
// Like the rest of the Worker, it never names the platform.

import { signedIn } from "../../account/guard.ts";
import { userById } from "../../account/store.ts";
import { randomToken, sameText } from "../../account/crypto.ts";
import { commitAutomation, mayAutomate, readJsonBody } from "./automation.ts";
import type { Principal } from "./bearer.ts";
import {
  DEVICE_BODY_BYTES,
  DEVICE_SECONDS,
  deviceSeconds,
  grantCollect,
  grantInsert,
  grantKey,
  grantOf,
  openDevice,
  openRequest,
  POLL_SECONDS,
  sealDevice,
  sealRequest,
  takeCode,
  takePoll,
  tooManyWrong,
  typedCode,
  userCode,
  validateAsk,
  wrongCode,
  type DeviceRequest,
  type GrantRow,
} from "./device-core.ts";
import { globalCap, mayWrite } from "./gate.ts";
import { accountHidden, suspended } from "./hidden.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import { actionRow, all, first, newNonce, statements } from "./store.ts";
import { EXPIRY, newToken, SCOPE_WORDS, SCOPES, tokenDelete, tokenInsert, tokensOf, TOKENS_PER_ACCOUNT, type TokenRow } from "./tokens-core.ts";
import { requireHuman, turnstileReady } from "./turnstile.ts";
import { ForgeProblem, type ForgeRequest } from "./types.ts";

const iso = (t: number) => new Date(t * 1000).toISOString();

function key(r: ForgeRequest): string | ForgeProblem {
  return typeof r.env.SESSION_KEY === "string" && r.env.SESSION_KEY ? r.env.SESSION_KEY : new ForgeProblem(503, "not_configured", "Accounts are not set up yet.");
}

/** GET /api/v1/cli: what the command line needs to know of this registry. */
export async function handleCli(r: ForgeRequest): Promise<Response> {
  const clientId = typeof r.env.GITHUB_APP_CLIENT_ID === "string" && r.env.GITHUB_APP_CLIENT_ID.trim() ? r.env.GITHUB_APP_CLIENT_ID.trim() : null;
  return json({
    github: { client_id: clientId },
    device: { code: "/api/v1/device/code", token: "/api/v1/device/token", verification: "/device/", expires_in: DEVICE_SECONDS, interval: POLL_SECONDS },
    scopes: SCOPES,
    days: EXPIRY,
  });
}

/** POST /api/v1/device/code: a code and the approval page's address. Nothing is written. */
export async function handleDeviceCode(r: ForgeRequest): Promise<Response> {
  const k = key(r);
  if (k instanceof ForgeProblem) return problemAnswer(k);
  if (!takeCode(r.request.headers.get("CF-Connecting-IP") ?? "", r.t)) {
    return problemAnswer(new ForgeProblem(429, "rate_limited", "Too many sign-in codes asked from this address: wait a minute.", { retryAfter: 60 - (r.t % 60) }));
  }
  const body = await readJsonBody(r, DEVICE_BODY_BYTES);
  if (body instanceof ForgeProblem) return problemAnswer(body);
  const ask = validateAsk(body);
  if (ask instanceof ForgeProblem) return problemAnswer(ask);
  const life = deviceSeconds(r.env);
  const req: DeviceRequest = { nonce: randomToken(16), exp: r.t + life, ...ask };
  return json({
    device_code: await sealDevice(k, req),
    user_code: await userCode(k, req.nonce),
    verification_uri: `${r.url.origin}/device/?r=${await sealRequest(k, req)}`,
    expires_in: life,
    interval: POLL_SECONDS,
    scopes: ask.scopes,
    days: ask.days,
  });
}

const grantProblem = (code: string, message: string, extra: Record<string, unknown> = {}) => new ForgeProblem(400, code, message, extra);

/** POST /api/v1/device/token: the command line's poll; the token once approved, made now. */
export async function handleDeviceToken(r: ForgeRequest): Promise<Response> {
  const k = key(r);
  if (k instanceof ForgeProblem) return problemAnswer(k);
  const body = await readJsonBody(r, DEVICE_BODY_BYTES);
  if (body instanceof ForgeProblem) return problemAnswer(body);
  const code = await openDevice(k, (body as { device_code?: unknown } | null)?.device_code);
  if (!code) return problemAnswer(grantProblem("invalid_grant", "This is not a device code of the registry."));
  if (code.exp <= r.t) return problemAnswer(grantProblem("expired_token", "This code expired (a code lives 15 minutes): start the sign-in again."));
  if (!takePoll(code.nonce, r.t)) {
    return problemAnswer(grantProblem("slow_down", `Poll at most every ${POLL_SECONDS} seconds.`, { interval: POLL_SECONDS * 2 }));
  }
  const gk = await grantKey(code);
  const grant = await first<GrantRow>(grantOf(r.db, gk));
  if (!grant) return problemAnswer(grantProblem("authorization_pending", "Not approved yet: the person has not decided."));
  if (grant.state === "denied") return problemAnswer(grantProblem("access_denied", "The sign-in was refused."));
  if (grant.state === "collected") return problemAnswer(grantProblem("expired_token", "This code was used already: a code opens one token."));
  // Approved: the token is made now, for the person who approved, if they still may.
  const community = r.env.COMMUNITY;
  const user = community ? await userById(community, grant.user_id) : null;
  if (!user || !community) return problemAnswer(grantProblem("access_denied", "The account that approved is gone."));
  const hidden = await accountHidden(r.db, user.id);
  if (hidden) return problemAnswer(suspended(hidden));
  if (!mayWrite(r.env, await linkedGithub(community, user.id))) {
    return problemAnswer(new ForgeProblem(403, "closed", "Making tokens opens with the registry's content rules: until then, only its owner can make one."));
  }
  const mine = await all<TokenRow>(tokensOf(r.db, user.id));
  if (mine.length >= TOKENS_PER_ACCOUNT) {
    return problemAnswer(new ForgeProblem(409, "too_many_tokens", `An account holds ${TOKENS_PER_ACCOUNT} tokens at most: revoke one you no longer use first (your settings, Personal tokens).`));
  }
  const cap = await globalCap(r.db, r.t, 4);
  if (cap) return problemAnswer(cap);
  const taken = await grantCollect(r.db, gk, r.t).run();
  if (!taken.meta?.changes) return problemAnswer(grantProblem("expired_token", "This code was used already: a code opens one token."));
  const made = await newToken();
  const row = { digest: made.digest, id: made.id, user_id: user.id, name: grant.name, scopes: grant.scopes, created_at: r.t, expires_at: r.t + grant.days * 86_400 };
  const insert = tokenInsert(r.db, row);
  const action = actionRow(r.db, {
    userId: user.id,
    t: r.t,
    nonce: newNonce(),
    kind: "token",
    githubUser: (await linkedGithub(community, user.id)) ?? "",
    outcome: "done",
    rows: 2 + insert.rows,
    subject: `token:${made.id}`,
  });
  await r.db.batch(statements([insert, action]));
  return json({ access_token: made.token, token_type: "bearer", id: made.id, scopes: grant.scopes.split(" "), expires_at: iso(row.expires_at) });
}

/** POST /api/v1/token/revoke: the token that makes the call is deleted at once. */
export async function handleSelfRevoke(r: ForgeRequest): Promise<Response> {
  const p = r.principal as Principal;
  const del = tokenDelete(r.db, p.user.id, p.token.id);
  const action = actionRow(r.db, {
    userId: p.user.id,
    t: r.t,
    nonce: newNonce(),
    kind: "token",
    githubUser: (await linkedGithub(p.db, p.user.id)) ?? "",
    outcome: "done",
    rows: 1 + del.rows,
    subject: `token:${p.token.id}`,
  });
  await r.db.batch(statements([del, action]));
  return json({ ok: true, revoked: p.token.id });
}

// ─── the approval page's routes ──────────────────────────────────────────────

const unreadable = () =>
  new ForgeProblem(400, "bad_request", "This address is not a sign-in request of the registry (it may be cut): open the one your terminal printed, whole.");
const expired = () => new ForgeProblem(410, "expired", "This sign-in request expired (15 minutes): run the sign-in again in your terminal.");

/** GET /api/forge/device?r=…: what the request asks, and whether it was decided. */
export async function handleDeviceRead(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: false, touch: false });
  if (s instanceof Response) return s;
  const req = await openRequest(s.key, r.url.searchParams.get("r"));
  if (!req) return problemAnswer(unreadable(), s.cookies);
  const grant = await first<GrantRow>(grantOf(r.db, await grantKey(req)));
  const hidden = await accountHidden(r.db, s.user.id);
  const github = await linkedGithub(s.db, s.user.id);
  return json(
    {
      name: req.name,
      scopes: req.scopes.map((id) => ({ id, words: SCOPE_WORDS[id] })),
      days: req.days,
      requested_at: iso(req.exp - deviceSeconds(r.env)),
      expires_at: iso(req.exp),
      expired: req.exp <= r.t,
      state: grant ? (grant.user_id === s.user.id ? grant.state : "decided") : "pending",
      account: { github: s.user.github_login, orcid: s.user.orcid },
      can: { approve: mayWrite(r.env, github) && !hidden },
      human: turnstileReady(r.env),
    },
    200,
    s.cookies,
  );
}

/** POST /api/forge/device/decide: approve (the typed code must be the terminal's) or refuse. */
export async function handleDeviceDecide(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readJsonBody(r, DEVICE_BODY_BYTES);
  if (body instanceof ForgeProblem) return say(body);
  const b = (body ?? {}) as { request?: unknown; code?: unknown; decision?: unknown; turnstile?: unknown };
  const req = await openRequest(s.key, b.request);
  if (!req) return say(unreadable());
  if (req.exp <= r.t) return say(expired());
  if (b.decision !== "approve" && b.decision !== "deny") return say(new ForgeProblem(400, "bad_payload", "Approve or refuse."));
  const gk = await grantKey(req);
  const before = await first<GrantRow>(grantOf(r.db, gk));
  if (before) return say(new ForgeProblem(409, "decided", "This sign-in was decided already: run the sign-in again in your terminal for another."));
  const github = (await linkedGithub(s.db, s.user.id)) ?? "";
  const grant = {
    ...gk,
    user_id: s.user.id,
    scopes: req.scopes.join(" "),
    days: req.days,
    name: req.name,
    decided_at: r.t,
    expires_at: req.exp,
  };

  if (b.decision === "deny") {
    // Never refused by a cap or FORGE_OPEN: a person can always say no.
    const w = grantInsert(r.db, { ...grant, state: "denied" });
    const action = actionRow(r.db, { userId: s.user.id, t: r.t, nonce: newNonce(), kind: "token", githubUser: github, outcome: "done", rows: 1 + w.rows, subject: "device:denied" });
    await r.db.batch(statements([w, action]));
    return json({ ok: true, state: "denied" }, 200, s.cookies);
  }

  if (tooManyWrong(req.nonce)) return say(new ForgeProblem(429, "too_many_codes", "Too many wrong codes for this request: run the sign-in again in your terminal."));
  const expected = await userCode(s.key, req.nonce);
  if (!sameText(typedCode(b.code), expected)) {
    wrongCode(req.nonce);
    return say(new ForgeProblem(400, "wrong_code", "This is not the code your terminal shows. Type the 8 letters it printed (for example BCDF-GHJK); if your terminal shows none, do not approve."));
  }
  const hidden = await accountHidden(r.db, s.user.id);
  if (hidden) return say(suspended(hidden));
  const human = await requireHuman(r, b.turnstile);
  if (human) return say(human);
  const mine = await all<TokenRow>(tokensOf(r.db, s.user.id));
  if (mine.length >= TOKENS_PER_ACCOUNT) {
    return say(new ForgeProblem(409, "too_many_tokens", `An account holds ${TOKENS_PER_ACCOUNT} tokens at most: revoke one you no longer use first.`));
  }
  const gate = await mayAutomate(r, s, "token", 2 + 4);
  if (gate instanceof ForgeProblem) return say(gate);
  await commitAutomation(r, s, "token", gate.github, [grantInsert(r.db, { ...grant, state: "approved" })], "device:approved");
  return json({ ok: true, state: "approved" }, 200, s.cookies);
}
