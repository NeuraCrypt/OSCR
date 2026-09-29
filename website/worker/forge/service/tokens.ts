// The routes of the registry's personal tokens (night phase 10, E1; docs/API.md "Authentication").
// What a token is: tokens-core.ts; how a request of the public API uses one: bearer.ts.
//
//   GET  /api/forge/tokens         signed in  the reader's tokens (never a token, never a digest), the
//                                             scopes in words, the limits
//   POST /api/forge/tokens/write   signed in  {op: "create", name, scopes, days}: a token, answered ONCE
//                                             (3 rows: its row, its index entry, the action row)
//                                             {op: "revoke", id}: the token deleted at once (2 rows + 1)
//
// Made and revoked on the site only, with the session's cookie, the site's Origin and the CSRF token
// (account/guard.ts `signedIn`): a token never makes or lists tokens (the API has no route for it),
// so a leaked token cannot make itself a successor.
// Making one: FORGE_OPEN (gate.ts: until phase 16, only the owner of the registry), the account's
// `automation` cap (50 changes a day), the day's rows, at most 20 tokens an account. Revoking is never
// refused by a cap or by FORGE_OPEN: a person can always cut a token they fear leaked.

import { signedIn } from "../../account/guard.ts";
import { commitAutomation, mayAutomate, readJsonBody } from "./automation.ts";
import { json, problemAnswer } from "./http.ts";
import { actionRow, all, newNonce, statements } from "./store.ts";
import {
  EXPIRY,
  newToken,
  SCOPE_WORDS,
  SCOPES,
  TOKEN_BODY_BYTES,
  tokenDelete,
  tokenInsert,
  tokensOf,
  TOKENS_PER_ACCOUNT,
  tokenView,
  validateToken,
  type TokenRow,
} from "./tokens-core.ts";
import { ForgeProblem, type ForgeRequest } from "./types.ts";
import { linkedGithub } from "./identity.ts";
import { mayWrite } from "./gate.ts";

/** GET /api/forge/tokens: the reader's tokens, the scopes in words, the limits. */
export async function handleTokens(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: false, touch: false });
  if (s instanceof Response) return s;
  const rows = await all<TokenRow>(tokensOf(r.db, s.user.id));
  const github = await linkedGithub(s.db, s.user.id);
  return json(
    {
      tokens: rows.map((row) => tokenView(row, r.t)),
      scopes: SCOPES.map((id) => ({ id, words: SCOPE_WORDS[id] })),
      limits: { tokens: TOKENS_PER_ACCOUNT, days: EXPIRY },
      can: { create: mayWrite(r.env, github) },
    },
    200,
    s.cookies,
  );
}

/** POST /api/forge/tokens/write: make or revoke a token. */
export async function handleTokenWrite(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readJsonBody(r, TOKEN_BODY_BYTES);
  if (body instanceof ForgeProblem) return say(body);
  const op = (body as { op?: unknown } | null)?.op;

  if (op === "revoke") {
    const id = (body as { id?: unknown }).id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(id)) return say(new ForgeProblem(400, "bad_payload", "Which token? Its id is 16 characters."));
    const mine = await all<TokenRow>(tokensOf(r.db, s.user.id));
    if (!mine.some((t) => t.id === id)) return say(new ForgeProblem(404, "not_found", "You hold no token with this id: it may have been revoked already."));
    // Never refused by a cap: the deletion and its action row, in one batch.
    const del = tokenDelete(r.db, s.user.id, id);
    const action = actionRow(r.db, {
      userId: s.user.id,
      t: r.t,
      nonce: newNonce(),
      kind: "token",
      githubUser: (await linkedGithub(s.db, s.user.id)) ?? "",
      outcome: "done",
      rows: 1 + del.rows,
      subject: `token:${id}`,
    });
    await r.db.batch(statements([del, action]));
    return json({ ok: true, revoked: id, written: 1 + del.rows }, 200, s.cookies);
  }

  if (op !== "create") return say(new ForgeProblem(400, "bad_payload", "Say what to do: create or revoke."));
  const p = validateToken(body);
  if (p instanceof ForgeProblem) return say(p);
  const mine = await all<TokenRow>(tokensOf(r.db, s.user.id));
  if (mine.length >= TOKENS_PER_ACCOUNT) {
    return say(new ForgeProblem(409, "too_many_tokens", `An account holds ${TOKENS_PER_ACCOUNT} tokens at most: revoke one you no longer use first.`));
  }
  const made = await newToken();
  const row = {
    digest: made.digest,
    id: made.id,
    user_id: s.user.id,
    name: p.name,
    scopes: p.scopes.join(" "),
    created_at: r.t,
    expires_at: r.t + p.days * 86_400,
  };
  const writes = [tokenInsert(r.db, row)];
  const gate = await mayAutomate(r, s, "token", 3);
  if (gate instanceof ForgeProblem) return say(gate);
  const written = await commitAutomation(r, s, "token", gate.github, writes, `token:${made.id}`);
  // The token itself, this once: the registry keeps only its digest.
  return json({ ok: true, written, token: made.token, ...tokenView({ ...row, last_used_day: null }, r.t) }, 201, s.cookies);
}
