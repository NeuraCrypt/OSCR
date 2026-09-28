// The three ways to sign in, each an OAuth 2.0 authorization code flow with `state` and PKCE:
//
// - ORCID, OpenID Connect, scope `openid`: the ORCID iD is the ID token's `sub`. Sandbox first
//   (https://sandbox.orcid.org, the default), production once the owner switches ORCID_ISSUER.
// - GitHub, OAuth: no scope at all, i.e. public information only; the account is read from
//   GET /user (id, login, name). Its email address is never asked for, read or stored.
// - Google, OpenID Connect, scope `openid` only: no email, no profile. Google then gives no name.
//
// The ID tokens (ORCID, Google) are verified in jwt.ts. The provider's access token is used during
// the callback only (GitHub's /user and the maintainer checks), then dropped: it is never stored.

import { verifyIdToken } from "./jwt.ts";
import type { AccountEnv } from "./types.ts";

export type ProviderName = "orcid" | "github" | "google";
export const PROVIDERS: readonly ProviderName[] = ["orcid", "github", "google"];
export const LABELS: Record<ProviderName, string> = { orcid: "ORCID", github: "GitHub", google: "Google" };

/** Sent to GitHub, which asks every API client for one; it does not name the platform. */
export const USER_AGENT = "code-registry-accounts";

export interface Provider {
  name: ProviderName;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Space-separated scopes; "" asks for none (GitHub: public information only). */
  scope: string;
  pkce: boolean;
  /** OpenID Connect: where the ID token's keys are, and the issuers accepted. */
  oidc?: { issuers: string[]; jwksUri: string };
  /** GitHub's REST API. */
  api?: string;
  /** Where the public page of an identity starts: https://orcid.org/<iD>, https://github.com/<login>. */
  profile?: string;
}

export class ProviderError extends Error {}

/** An address from the environment: https, or http on this machine only (a development mock).
 *  "" when absent, null when unusable. */
function address(value: string | undefined): string | null {
  const v = (value ?? "").trim().replace(/\/+$/, "");
  if (!v) return "";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return u.protocol === "https:" || (u.protocol === "http:" && local) ? v : null;
}

/** The provider, when its client id and secret are set; null otherwise (its sign-in is then
 *  "not set up yet"). */
export function provider(env: AccountEnv, name: string): Provider | null {
  if (name === "orcid") {
    const issuer = address(env.ORCID_ISSUER);
    if (!env.ORCID_CLIENT_ID || !env.ORCID_CLIENT_SECRET || issuer === null) return null;
    const iss = issuer || "https://sandbox.orcid.org";
    return {
      name,
      clientId: env.ORCID_CLIENT_ID,
      clientSecret: env.ORCID_CLIENT_SECRET,
      authorizeUrl: `${iss}/oauth/authorize`,
      tokenUrl: `${iss}/oauth/token`,
      scope: "openid",
      pkce: env.ORCID_PKCE !== "off",
      oidc: { issuers: [iss], jwksUri: `${iss}/oauth/jwks` },
      profile: iss,
    };
  }
  if (name === "github") {
    const web = address(env.GITHUB_URL);
    const api = address(env.GITHUB_API_URL);
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || web === null || api === null) return null;
    const site = web || "https://github.com";
    return {
      name,
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      authorizeUrl: `${site}/login/oauth/authorize`,
      tokenUrl: `${site}/login/oauth/access_token`,
      scope: "",
      pkce: true,
      api: api || "https://api.github.com",
      profile: site,
    };
  }
  if (name === "google") {
    const mock = address(env.GOOGLE_ISSUER);
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || mock === null) return null;
    return {
      name,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      authorizeUrl: mock ? `${mock}/o/oauth2/v2/auth` : "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: mock ? `${mock}/token` : "https://oauth2.googleapis.com/token",
      scope: "openid",
      pkce: true,
      oidc: mock
        ? { issuers: [mock], jwksUri: `${mock}/oauth2/v3/certs` }
        : { issuers: ["https://accounts.google.com", "accounts.google.com"], jwksUri: "https://www.googleapis.com/oauth2/v3/certs" },
    };
  }
  return null;
}

export function configured(env: AccountEnv): ProviderName[] {
  return PROVIDERS.filter((name) => provider(env, name) !== null);
}

export function authorizationUrl(
  p: Provider,
  a: { redirectUri: string; state: string; challenge: string; nonce: string },
): string {
  const u = new URL(p.authorizeUrl);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", a.redirectUri);
  if (p.scope) u.searchParams.set("scope", p.scope);
  u.searchParams.set("state", a.state);
  if (p.pkce) {
    u.searchParams.set("code_challenge", a.challenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  if (p.oidc) u.searchParams.set("nonce", a.nonce);
  return u.toString();
}

export interface Tokens {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  /** ORCID's token answer also carries the iD and the public name. */
  orcid?: string;
  name?: string;
  error?: string;
}

/** The code exchanged for tokens, server to server (the client secret and the PKCE verifier
 *  never pass through the browser). */
export async function exchange(p: Provider, a: { code: string; redirectUri: string; verifier: string }): Promise<Tokens> {
  const body = new URLSearchParams({
    code: a.code,
    redirect_uri: a.redirectUri,
    client_id: p.clientId,
    client_secret: p.clientSecret,
  });
  if (p.oidc) body.set("grant_type", "authorization_code");
  if (p.pkce) body.set("code_verifier", a.verifier);
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body,
  });
  const tokens = (await res.json().catch(() => ({}))) as Tokens;
  // GitHub answers a refused code with 200 and an `error` field.
  if (!res.ok || tokens.error || typeof tokens.access_token !== "string") {
    throw new ProviderError(`${p.name}: the code was refused (${tokens.error ?? res.status})`);
  }
  return tokens;
}

/** A provider's account, as the registry keeps it: the subject (the key), a display name when the
 *  provider gives one, and the public handle (the ORCID iD, the GitHub login; none for Google). */
export interface Person {
  provider: ProviderName;
  subject: string;
  name: string;
  handle: string;
}

/** The person behind the tokens. */
export async function identify(p: Provider, tokens: Tokens, nonce: string, now: number): Promise<Person> {
  if (p.oidc) {
    if (typeof tokens.id_token !== "string") throw new ProviderError(`${p.name}: no ID token`);
    const claims = await verifyIdToken(tokens.id_token, { ...p.oidc, audience: p.clientId, nonce, now });
    if (p.name === "orcid") {
      const id = orcidId(claims.sub);
      if (!id) throw new ProviderError("orcid: the subject is not an ORCID iD");
      if (tokens.orcid !== undefined && orcidId(tokens.orcid) !== id) throw new ProviderError("orcid: the token and the ID token disagree");
      const given = [claims.given_name, claims.family_name].filter((x) => typeof x === "string" && x).join(" ");
      return { provider: "orcid", subject: id, name: cleanName(tokens.name || claims.name || given), handle: id };
    }
    return { provider: "google", subject: claims.sub, name: cleanName(claims.name), handle: "" };
  }
  const res = await githubApi(p, tokens.access_token ?? "", "/user");
  const user = (await res.json().catch(() => ({}))) as { id?: unknown; login?: unknown; name?: unknown };
  if (!res.ok || typeof user.id !== "number" || typeof user.login !== "string" || !GITHUB_LOGIN.test(user.login)) {
    throw new ProviderError(`github: /user answered ${res.status}`);
  }
  // Only id, login and name are read: never the email address the answer may carry.
  return { provider: "github", subject: String(user.id), name: cleanName(user.name || user.login), handle: user.login };
}

/** A GitHub login (letters, digits, hyphens; an underscore in managed enterprise accounts). */
export const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** A GET on GitHub's REST API with the person's token. */
export function githubApi(p: Provider, token: string, path: string): Promise<Response> {
  return fetch(`${p.api}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });
}

/** "0000-0002-1825-0097" from an ORCID iD in any of its forms (with https://orcid.org/, without
 *  dashes); "" when it is not one or its check digit is wrong (ISO 7064 11,2). The same rule as
 *  `orcid` in oscr/entities.py. */
export function orcidId(value: unknown): string {
  if (typeof value !== "string") return "";
  const m = /^\s*(?:https?:\/\/(?:www\.|sandbox\.)?orcid\.org\/)?(\d{4})-?(\d{4})-?(\d{4})-?(\d{3}[\dXx])\s*\/?\s*$/.exec(value);
  if (!m) return "";
  const digits = (m[1] + m[2] + m[3] + m[4]).toUpperCase();
  let total = 0;
  for (const d of digits.slice(0, -1)) total = (total + Number(d)) * 2;
  const check = (12 - (total % 11)) % 11;
  if (digits.slice(-1) !== (check === 10 ? "X" : String(check))) return "";
  return `${m[1]}-${m[2]}-${m[3]}-${m[4].toUpperCase()}`;
}

/** An email address, also written with spaces around the at sign; its domain has a dot (as in
 *  oscr/entities.py, an at sign between two words of prose is not an address). */
const ADDRESS = /[^\s@<>()[\]{},;:]+\s*[@\uff20]\s*[^\s@<>()[\]{},;:.]+(?:\.[^\s@<>()[\]{},;:.]+)+/g;

/** A name as the registry may keep it: no email address (not even a stray at sign), no control
 *  character, one space between words, 100 characters at most. */
export function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(ADDRESS, " ")
    .replace(/[@\uff20]/g, " ")
    .replace(/[(\[{<]\s*[)\]}>]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, 100).join("").trim();
}
