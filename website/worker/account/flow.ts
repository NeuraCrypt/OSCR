// A sign-in in progress. Between the redirect to the provider and its callback, the Worker keeps
// nothing: the flow lives in a short cookie, `__Host-oscr_flow` (10 minutes), signed with the
// server key (HMAC-SHA-256, purpose "flow"), which holds:
//
// - `st`, the `state` sent to the provider: the callback must bring it back, from this browser
//   (the cookie), which stops a forged callback (login CSRF);
// - `cv`, the PKCE verifier: only its SHA-256 went to the provider, the verifier goes with the
//   code's exchange, server to server;
// - `n`, the OpenID Connect nonce, which the ID token must carry;
// - `sid`, the hash of the session this browser had when the flow started: a flow started signed
//   in links the new identity to that account, and only if the same session is still there;
// - `in`, the intent ("signin", or "verify": a maintainer check through GitHub), with `rp`, the
//   repository to check, and `rt`, the page to come back to.

import { base64url, fromBase64url, hmac, hmacCheck, pkceChallenge, randomToken } from "./crypto.ts";
import { setCookie } from "./http.ts";
import { authorizationUrl, type Provider, type ProviderName } from "./providers.ts";

export const FLOW_COOKIE = "__Host-oscr_flow";
export const FLOW_SECONDS = 600;

export type Intent = "signin" | "verify";

export interface Flow {
  v: 1;
  p: ProviderName;
  st: string;
  cv: string;
  n: string;
  in: Intent;
  sid: string;
  rp: string;
  rt: string;
  exp: number;
}

export async function sealFlow(key: string, flow: Flow): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(flow)));
  return `${body}.${await hmac(key, "flow", body)}`;
}

/** The flow of this cookie, when its signature is the server's and it has not expired. */
export async function openFlow(key: string, value: string | null, now: number): Promise<Flow | null> {
  if (!value || value.length > 4096) return null;
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra !== undefined) return null;
  if (!(await hmacCheck(key, "flow", body, signature))) return null;
  let flow: Flow;
  try {
    flow = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as Flow;
  } catch {
    return null;
  }
  if (!flow || flow.v !== 1 || typeof flow.exp !== "number" || flow.exp < now) return null;
  return flow;
}

/** Start a flow: the provider's authorization address, and the cookie that remembers the flow. */
export async function beginFlow(
  key: string,
  p: Provider,
  a: { origin: string; intent: Intent; sid: string; repo: string; back: string; now: number },
): Promise<{ location: string; cookie: string }> {
  const flow: Flow = {
    v: 1,
    p: p.name,
    st: randomToken(32),
    cv: randomToken(32),
    n: randomToken(32),
    in: a.intent,
    sid: a.sid,
    rp: a.repo,
    rt: a.back,
    exp: a.now + FLOW_SECONDS,
  };
  const location = authorizationUrl(p, {
    redirectUri: callbackUrl(a.origin, p.name),
    state: flow.st,
    challenge: await pkceChallenge(flow.cv),
    nonce: flow.n,
  });
  return { location, cookie: setCookie(FLOW_COOKIE, await sealFlow(key, flow), FLOW_SECONDS) };
}

/** Where a provider sends the browser back: https://<site>/api/auth/<provider>/callback. It must
 *  be registered with the provider exactly (docs/ACCOUNTS.md). */
export function callbackUrl(origin: string, name: ProviderName): string {
  return `${origin}/api/auth/${name}/callback`;
}
