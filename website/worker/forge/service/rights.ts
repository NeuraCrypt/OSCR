// Data-rights requests (night phase 16, E4; the privacy statement /privacy/, docs/POLICIES.md): a
// person asks for access, portability, rectification, erasure, objection or restriction; the owner
// answers in the site, never by email, within the legal delay (one month, two more for a complex
// request, said). Being signed in is the proof of identity (ORCID, GitHub or Google); a paper's author
// signs in with the ORCID iD the paper names. Self-service export and deletion come with phase 09.
//
//   POST /api/forge/rights           signed in (a suspended account too)  a request, behind Turnstile: 3 rows
//   POST /api/forge/rights/answer    the owner                            the answer: 2 rows
// The person reads the answer on /account/moderation/ (GET /api/forge/moderation/mine); the owner reads
// the open requests in the queue (GET /api/forge/moderation).

import { dailyCaps, globalCap, overCap } from "./gate.ts";
import { readCapped } from "./flow.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import { cleanText, MODERATION_BODY_BYTES, RIGHT_WORDS, RIGHTS_OPEN_MAX, validateRights } from "./moderation-core.ts";
import { isOwner } from "./moderation.ts";
import { actionRow, all, newNonce } from "./store.ts";
import { requireHuman } from "./turnstile.ts";
import { who } from "./who.ts";
import { ForgeProblem, type ForgeRequest } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);

async function readBody(r: ForgeRequest): Promise<Record<string, unknown> | ForgeProblem> {
  if (!(r.request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return bad("The request is not JSON.");
  const text = await readCapped(r.request, MODERATION_BODY_BYTES);
  if (text === null) return new ForgeProblem(413, "too_large", "This request is too large.");
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : bad("The request is not readable.");
  } catch {
    return bad("The request is not readable.");
  }
}

/** A random public name for a request (12 base64url characters). */
function requestId(): string {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_");
}

export async function handleRights(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true, suspendedOk: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = await readBody(r);
  if (body instanceof ForgeProblem) return say(body);
  const p = validateRights(body);
  if (p instanceof ForgeProblem) return say(p);
  const human = await requireHuman(r, p.turnstile);
  if (human) return say(human);
  const open = await all<{ id: string }>(r.db.prepare("SELECT id FROM rights_requests WHERE user_id = ? AND state = 'open' LIMIT ?").bind(s.user.id, RIGHTS_OPEN_MAX + 1));
  if (open.length >= RIGHTS_OPEN_MAX) return say(new ForgeProblem(409, "too_many_requests", `You have ${RIGHTS_OPEN_MAX} requests waiting: the owner answers them first.`));
  const caps = await dailyCaps(r.db, s.user.id, "rights", r.t);
  if (caps.exceeded) return say(overCap(caps.exceeded));
  const quota = await globalCap(r.db, r.t, 3);
  if (quota) return say(quota);
  const id = requestId();
  const t = Math.floor(r.t);
  const insert = r.db.prepare("INSERT INTO rights_requests (user_id, id, at, kind, details) VALUES (?, ?, ?, ?, ?)").bind(s.user.id, id, t, p.right, p.details);
  const action = actionRow(r.db, { userId: s.user.id, t: r.t, nonce: newNonce(), kind: "rights", githubUser: (await linkedGithub(s.db, s.user.id)) ?? "", outcome: "done", rows: 3, subject: "" });
  await r.db.batch([insert, action.stmt]);
  return json({ id, sentence: `Your request for ${RIGHT_WORDS[p.right]} is sent. The owner answers on your page “What of mine is hidden”, within one month.` }, 201, s.cookies);
}

export async function handleRightsAnswer(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  if (!(await isOwner(r, s))) return say(new ForgeProblem(403, "owner_only", "Only the owner answers data-rights requests."));
  const body = await readBody(r);
  if (body instanceof ForgeProblem) return say(body);
  const id = body.id;
  const at = body.at;
  const state = body.state;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{12}$/.test(id) || typeof at !== "number" || !Number.isInteger(at)) return say(bad("Name the request (its id and time, from the queue)."));
  if (state !== "answered" && state !== "refused") return say(bad("A request is answered or refused."));
  const answer = cleanText(body.answer, 2000);
  if (answer.length < 10) return say(bad("Say what was done, or why not: the person reads it on their page."));
  const res = await r.db
    .prepare("UPDATE rights_requests SET state = ?, answer = ?, answered_at = ? WHERE state = 'open' AND at = ? AND id = ?")
    .bind(state, answer, Math.floor(r.t), at, id)
    .run();
  if (!res.meta?.changes) return say(new ForgeProblem(404, "not_found", "No open request of that name."));
  const action = actionRow(r.db, { userId: s.user.id, t: r.t, nonce: newNonce(), kind: "moderate", githubUser: (await linkedGithub(s.db, s.user.id)) ?? "", outcome: "done", rows: 3, subject: "" });
  await action.stmt.run();
  return json({ ok: true }, 200, s.cookies);
}
