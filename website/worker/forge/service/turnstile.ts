// Turnstile, Cloudflare's free human check (night phase 16, E1 and E3): every public write form of the
// GitHub side sends the widget's token, and the Worker verifies it here, server-side, before anything
// is written — one subrequest to Cloudflare's `siteverify` per protected POST (docs/MODERATION.md
// "Turnstile"; developers.cloudflare.com/turnstile/get-started/server-side-validation/).
//
// - The secret key is a Cloudflare secret, `TURNSTILE_SECRET_KEY`, set by the owner with
//   tools/setup_cloudflare.sh; the site key is public and goes into the pages at build time
//   (`TURNSTILE_SITE_KEY`, website/.env or the environment of `npm run deploy`). Neither is ever in
//   wrangler.toml or in the repository.
// - Without the secret, a protected form is refused (503 not_configured), never let through: the
//   switch FORGE_OPEN opens nothing while Turnstile is not set up (gate.ts `rulesReady`).
// - A token is checked once (Cloudflare refuses it a second time) and holds 2 KiB at most; the
//   reader's IP address is not sent (Cloudflare sees it anyway, and the registry keeps none).
// - Tests use Cloudflare's documented test keys only (the secret 1x…AA always passes, 2x…AA always
//   fails), against a local stand-in of `siteverify`: `TURNSTILE_VERIFY_URL`, a development-only
//   variable accepted on this machine only (http://127.0.0.1, http://localhost), never in wrangler.toml.

import type { ForgeRequest, ForgeServiceEnv } from "./types.ts";
import { ForgeProblem } from "./types.ts";

export const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** How long the Worker waits for Cloudflare's answer. */
const WAIT_MS = 5_000;

/** Cloudflare's documented test secret keys (tests only): always passes, always fails. */
export const TEST_SECRET_PASS = "1x0000000000000000000000000000000AA";
export const TEST_SECRET_FAIL = "2x0000000000000000000000000000000AA";
/** And the test site keys the pages would render with (always passes, always blocks). */
export const TEST_SITE_PASS = "1x00000000000000000000AA";
export const TEST_SITE_FAIL = "2x00000000000000000000AB";

/** Whether the human check is set up (its secret is there). */
export const turnstileReady = (env: ForgeServiceEnv): boolean => typeof env.TURNSTILE_SECRET_KEY === "string" && env.TURNSTILE_SECRET_KEY.trim().length >= 20;

/** Where `siteverify` is: Cloudflare's, or (development only) a stand-in on this machine. */
export function verifyUrl(env: ForgeServiceEnv): string {
  const local = (env.TURNSTILE_VERIFY_URL ?? "").trim();
  if (local && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?\/[^\s]*$/.test(local)) return local;
  return SITEVERIFY;
}

export const NOT_SET_UP = "The registry's human check (Turnstile) is not set up yet, so this form cannot be sent: please come back later.";
export const FAILED = "The human check did not pass: please tick it again, then send.";

/** null when the token passes; otherwise the problem to answer. `fetcher` is the tests' stand-in. */
export async function checkTurnstile(env: ForgeServiceEnv, token: string, fetcher: typeof fetch = fetch): Promise<ForgeProblem | null> {
  if (!turnstileReady(env)) return new ForgeProblem(503, "not_configured", NOT_SET_UP);
  if (!token || token.length > 2048) return new ForgeProblem(403, "human_check", FAILED);
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY!.trim(), response: token });
  let ok = false;
  try {
    const res = await fetcher(verifyUrl(env), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(WAIT_MS),
      redirect: "manual",
    });
    if (res.ok) {
      const body = (await res.json()) as { success?: unknown };
      ok = body?.success === true;
    }
  } catch {
    return new ForgeProblem(503, "human_check_unavailable", "The human check could not be verified just now: please try again in a moment.");
  }
  return ok ? null : new ForgeProblem(403, "human_check", FAILED);
}

/** The human check of a public write form of the site (research issues and comments, profiles, star
 *  lists, tokens, webhooks, data-rights requests): null when it passes. A request of the public API
 *  carries a token instead (made behind this check) and is not asked. While Turnstile is not set up,
 *  only the owner can reach a write (gate.ts `forgeOpen`), and is not asked either. */
export async function requireHuman(r: ForgeRequest, token: unknown): Promise<ForgeProblem | null> {
  if (r.principal || !turnstileReady(r.env)) return null;
  return checkTurnstile(r.env, typeof token === "string" ? token : "", r.deps.turnstileFetch);
}
