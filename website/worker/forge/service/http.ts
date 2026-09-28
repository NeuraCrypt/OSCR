// The forge service's answers: JSON, never cached (`Cache-Control: no-store`: every answer depends
// on the reader or changes the registry), with the accounts' headers (account/http.ts: nosniff,
// no-referrer, noindex). A failure is `{ error: { code, message, … } }`, the shape of every route of
// the Worker, the message in plain words for people.
//
// GitBackend's errors (../errors.ts) become answers here, one sentence per code. The sentence is
// fixed: a forge's own message never reaches the page as it is, and the detail kept for a wrong
// request (`invalid`) goes through `redact` first, like everything logged. No token ever appears
// in an answer or a log.

import { json } from "../../account/http.ts";
import { GitBackendError, STATUS, type GitErrorCode } from "../errors.ts";
import { untilNextDay } from "./caps.ts";
import { ForgeProblem } from "./types.ts";

export { json };

/** A token-shaped text, a credential header, a code or state in a query: replaced by "[…]".
 *  GitHub's token prefixes (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_), a bearer header, a JWT, the
 *  test double's tokens (memtok_), and any run of 32 or more base64url or hex characters. */
export function redact(text: string): string {
  return String(text)
    .replace(/\b(?:gh[pousr]_|github_pat_|memtok_)[A-Za-z0-9_]+/g, "[…]")
    .replace(/\b(Bearer|token|Basic)\s+[^\s,;]+/gi, "$1 […]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[…]")
    .replace(/([?&](?:code|state|access_token|refresh_token|client_secret)=)[^&\s]+/gi, "$1[…]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[…]");
}

/** A problem's answer, with its extra fields (retryAfter, fallbackUrl, offer, cap…) and, for a
 *  retry, the Retry-After header. */
export function problemAnswer(p: ForgeProblem, cookies: string[] = []): Response {
  const res = json({ error: { code: p.code, message: p.message, ...p.extra } }, p.status, cookies);
  const retry = p.extra.retryAfter;
  if (typeof retry === "number" && Number.isFinite(retry) && retry > 0) res.headers.set("Retry-After", String(Math.ceil(retry)));
  return res;
}

/** An answer in the shape of the others: `{ error: { code, message } }`. */
export function problem(status: number, code: string, message: string, cookies: string[] = [], extra: Record<string, unknown> = {}): Response {
  return problemAnswer(new ForgeProblem(status, code, message, extra), cookies);
}

/** 405, naming the method the route takes. */
export function wrongMethod(use: string): Response {
  const res = problem(405, "method_not_allowed", `Use ${use}.`);
  res.headers.set("Allow", use === "GET" ? "GET, HEAD" : use);
  return res;
}

/** What a stub answers until its element is built: 501 not_built. */
export function notBuilt(what: string): Response {
  return problem(501, "not_built", `This part of the GitHub side (${what}) is not built yet.`);
}

/** Each code of GitBackend's errors, in words (the Worker never names the platform: "the registry"). */
export const GIT_MESSAGES: Readonly<Record<GitErrorCode, string>> = {
  invalid: "GitHub cannot take this request as it is",
  unauthorized: "GitHub did not accept the authorization: please start the action again.",
  forbidden: "GitHub says your account may not do this on this repository.",
  not_found:
    "GitHub does not show this repository or this item: it may have been renamed, deleted or made private.",
  conflict: "The repository changed in the meantime (a branch moved, or the name is taken): reload the page, then try again.",
  not_mergeable: "GitHub will not merge this as asked: its page says why.",
  archived: "This repository is archived on GitHub: unarchive it first.",
  gone: "This repository is no longer available on GitHub.",
  too_large: "This is over a size limit, GitHub's or the registry's: GitHub's own page or git can do it.",
  rate_limited: "GitHub asks to wait before trying again.",
  unsupported: "This cannot be done from the registry: GitHub's own page can.",
  unavailable: "GitHub did not answer. Please try again in a few minutes.",
};

const SECRET_PARAMS = new Set(["code", "state", "token", "access_token", "refresh_token", "client_secret"]);

/** Whether a forge page's address may go to the page: https (or http on this machine, a
 *  development mock), no credentials, no code, state or token in its query, no token-shaped text. */
export function safeUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local)) || u.username || u.password) return false;
  for (const key of u.searchParams.keys()) if (SECRET_PARAMS.has(key.toLowerCase())) return false;
  return !/\b(?:gh[pousr]_|github_pat_|memtok_)[A-Za-z0-9_]+/.test(value);
}

/** A GitBackendError as a problem: STATUS[code], the sentence of its code (a wrong request keeps
 *  its detail, redacted), when to retry, and the forge's own page that can do it. */
export function gitProblem(e: GitBackendError): ForgeProblem {
  const extra: Record<string, unknown> = {};
  let message = GIT_MESSAGES[e.code] ?? GIT_MESSAGES.unavailable;
  if (e.code === "invalid") {
    const detail = redact(e.message).replace(/[.\s]+$/, "").slice(0, 200);
    message = detail ? `${message}: ${detail}.` : `${message}.`;
  }
  if (e.code === "rate_limited" && e.retryAfter !== null) {
    const minutes = Math.max(1, Math.ceil(e.retryAfter / 60));
    message = `GitHub asks to wait about ${minutes} ${minutes === 1 ? "minute" : "minutes"} before trying again.`;
  }
  if (e.retryAfter !== null) extra.retryAfter = e.retryAfter;
  if (e.fallbackUrl !== null && safeUrl(e.fallbackUrl)) extra.fallbackUrl = e.fallbackUrl;
  if (e.code === "conflict") extra.offer = "new_branch";
  return new ForgeProblem(STATUS[e.code] ?? 503, e.code, message, extra);
}

/** Whether a failure is D1's daily quota (the search's and the contributions' test). */
export function isD1Quota(err: unknown): boolean {
  const message = String((err as Error)?.message ?? err);
  return /D1/.test(message) && /exceeded|limit/i.test(message);
}

/** The answer to anything a route did not answer itself: a problem as it is, a GitBackendError in
 *  words, D1's quota (503 quota, until the next UTC day), or 503 unavailable. Logged redacted. */
export function failure(err: unknown, path: string, t = Math.floor(Date.now() / 1000)): Response {
  if (err instanceof ForgeProblem) return problemAnswer(err);
  if (err instanceof GitBackendError) {
    console.error(`forge ${path}: ${err.code}: ${redact(err.message).slice(0, 300)}`);
    return problemAnswer(gitProblem(err));
  }
  const message = String((err as Error)?.message ?? err);
  console.error(`forge ${path}: ${redact(message).slice(0, 300)}`);
  if (isD1Quota(err)) {
    return problem(503, "quota", "The registry has used its daily quota. Please try again tomorrow.", [], { retryAfter: untilNextDay(t) });
  }
  return problem(503, "unavailable", "The registry is unavailable at the moment. Please try again later.");
}
