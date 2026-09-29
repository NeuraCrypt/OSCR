// Test support: ORCID, GitHub and Google as the Worker sees them, in one fetch handler, with a key
// pair made here to sign the ID tokens. The unit tests install it as `fetch`; the end-to-end run
// serves it over HTTP (mock-server.ts). Like the real providers, it checks the client's secret,
// the redirect URI and the PKCE verifier, and a code works once.
import { base64url, pkceChallenge } from "../../worker/account/crypto.ts";

export type Name = "orcid" | "github" | "google";

export interface Who {
  orcid: { sub: string; name?: string; given_name?: string; family_name?: string };
  github: { id: number; login: string; name?: string | null };
  google: { sub: string; name?: string };
}

export const CLIENTS: Record<Name, { id: string; secret: string }> = {
  orcid: { id: "APP-TESTORCID0000001", secret: "orcid-test-secret" },
  github: { id: "Iv1.testgithubclient", secret: "github-test-secret" },
  google: { id: "test-client.apps.googleusercontent.com", secret: "google-test-secret" },
};

/** An email address the providers offer in their answers: the registry must never keep it. */
export const OFFERED_EMAIL = "someone.private@example.org";

interface Code {
  provider: Name;
  clientId: string;
  redirectUri: string;
  challenge: string | null;
  nonce: string | null;
  who: unknown;
}

export interface Logged {
  method: string;
  url: string;
  form: Record<string, string>;
  authorization: string | null;
}

export class MockProviders {
  base: string;
  who: Who = {
    orcid: { sub: "0000-0000-0000-001X", name: "Ada Fixture" },
    github: { id: 4_242_001, login: "ada-fixture", name: "Ada Fixture" },
    google: { sub: "109876543210987654321" },
  };
  /** The next authorization is refused by the person ("access_denied"). */
  deny = false;
  /** What the ID tokens carry besides the standard claims (a test adds an email claim). */
  extraClaims: Record<string, unknown> = { email: OFFERED_EMAIL, email_verified: true };
  /** Replace the ID token's claims (tests of the verification). */
  tamper: ((claims: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Sign the ID tokens with another key than the published one. */
  signWithOtherKey = false;
  github = {
    publicMembers: new Set<string>(),
    contributors: new Map<string, string[] | number>(),
    commits: new Map<string, number>(),
    fail: 0,
  };
  log: Logged[] = [];
  private codes = new Map<string, Code>();
  private keys: CryptoKeyPair | null = null;
  private other: CryptoKeyPair | null = null;
  kid = "mock-key-1";

  constructor(base = "https://providers.test") {
    this.base = base;
  }

  /** The Worker's environment for these providers. */
  env(): Record<string, string> {
    return {
      ORCID_CLIENT_ID: CLIENTS.orcid.id,
      ORCID_CLIENT_SECRET: CLIENTS.orcid.secret,
      ORCID_ISSUER: `${this.base}/orcid`,
      GITHUB_CLIENT_ID: CLIENTS.github.id,
      GITHUB_CLIENT_SECRET: CLIENTS.github.secret,
      GITHUB_URL: `${this.base}/github`,
      GITHUB_API_URL: `${this.base}/github-api`,
      GOOGLE_CLIENT_ID: CLIENTS.google.id,
      GOOGLE_CLIENT_SECRET: CLIENTS.google.secret,
      GOOGLE_ISSUER: `${this.base}/google`,
    };
  }

  private async keyPair(other = false): Promise<CryptoKeyPair> {
    const make = () =>
      crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      ) as Promise<CryptoKeyPair>;
    if (other) return (this.other ??= await make());
    return (this.keys ??= await make());
  }

  async jwks(): Promise<{ keys: Record<string, unknown>[] }> {
    const jwk = (await crypto.subtle.exportKey("jwk", (await this.keyPair()).publicKey)) as Record<string, unknown>;
    return { keys: [{ kty: "RSA", n: jwk.n, e: jwk.e, kid: this.kid, alg: "RS256", use: "sig" }] };
  }

  /** A JWT signed with the mock's key (or another one). */
  async sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
    const enc = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)));
    const head = enc({ alg: "RS256", typ: "JWT", kid: this.kid, ...header });
    const body = enc(claims);
    const key = (await this.keyPair(this.signWithOtherKey)).privateKey;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${base64url(sig)}`;
  }

  /** A browser's visit to a provider's authorization page: approved at once, or refused. */
  authorize(url: string): string {
    const u = new URL(url);
    const provider = u.pathname.startsWith("/orcid/") ? "orcid" : u.pathname.startsWith("/github/") ? "github" : "google";
    const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
    const state = u.searchParams.get("state") ?? "";
    if (this.deny) {
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("state", state);
      return redirect.toString();
    }
    const code = base64url(crypto.getRandomValues(new Uint8Array(16)));
    this.codes.set(code, {
      provider,
      clientId: u.searchParams.get("client_id") ?? "",
      redirectUri: u.searchParams.get("redirect_uri") ?? "",
      challenge: u.searchParams.get("code_challenge_method") === "S256" ? u.searchParams.get("code_challenge") : null,
      nonce: u.searchParams.get("nonce"),
      who: structuredClone(this.who[provider]),
    });
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", state);
    return redirect.toString();
  }

  /** The providers' servers. */
  async handle(request: Request): Promise<Response> {
    const u = new URL(request.url);
    const form: Record<string, string> = {};
    if (request.method === "POST") new URLSearchParams(await request.text()).forEach((v, k) => (form[k] = v));
    this.log.push({ method: request.method, url: request.url, form, authorization: request.headers.get("Authorization") });
    const path = u.pathname;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (request.method === "GET" && /^\/(orcid\/oauth\/authorize|github\/login\/oauth\/authorize|google\/o\/oauth2\/v2\/auth)$/.test(path)) {
      return new Response(null, { status: 302, headers: { Location: this.authorize(request.url) } });
    }
    // Night phase 10: GitHub Actions' OIDC keys (statuses.ts), signed by the same mock key.
    if (path === "/orcid/oauth/jwks" || path === "/google/oauth2/v3/certs" || path === "/actions/.well-known/jwks") return json(await this.jwks());
    if (request.method === "POST" && (path === "/orcid/oauth/token" || path === "/github/login/oauth/access_token" || path === "/google/token")) {
      const provider: Name = path.startsWith("/orcid/") ? "orcid" : path.startsWith("/github/") ? "github" : "google";
      return this.token(provider, form);
    }
    if (path.startsWith("/github-api/")) return this.githubApi(request, path.slice("/github-api".length), u);
    return json({ error: "not_found" }, 404);
  }

  private async token(provider: Name, form: Record<string, string>): Promise<Response> {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    // GitHub answers a refused code with 200 and an error; the OpenID providers with 400.
    const refuse = (error: string) => (provider === "github" ? json({ error }) : json({ error }, 400));
    const code = this.codes.get(form.code ?? "");
    this.codes.delete(form.code ?? "");
    if (!code || code.provider !== provider) return refuse(provider === "github" ? "bad_verification_code" : "invalid_grant");
    if (form.client_id !== CLIENTS[provider].id || form.client_secret !== CLIENTS[provider].secret) return refuse("invalid_client");
    if (form.redirect_uri !== code.redirectUri) return refuse("redirect_uri_mismatch");
    if (code.challenge !== null && (await pkceChallenge(form.code_verifier ?? "")) !== code.challenge) return refuse("invalid_grant");
    const access = `mock-${provider}-token-${base64url(crypto.getRandomValues(new Uint8Array(12)))}`;
    if (provider === "github") return json({ access_token: access, token_type: "bearer", scope: "" });
    const now = Math.floor(Date.now() / 1000);
    const who = code.who as Record<string, unknown>;
    let claims: Record<string, unknown> = {
      iss: `${this.base}/${provider}`,
      aud: code.clientId,
      sub: who.sub,
      iat: now,
      exp: now + 600,
      auth_time: now,
      nonce: code.nonce,
      ...(provider === "google" ? { azp: code.clientId } : {}),
      ...(who.given_name ? { given_name: who.given_name, family_name: who.family_name } : {}),
      ...(provider === "google" && who.name ? { name: who.name } : {}),
      ...this.extraClaims,
    };
    if (this.tamper) claims = this.tamper(claims);
    const id_token = await this.sign(claims);
    if (provider === "orcid") {
      return json({ access_token: access, token_type: "bearer", expires_in: 631138518, scope: "openid", name: who.name ?? "", orcid: who.sub, id_token });
    }
    return json({ access_token: access, token_type: "Bearer", expires_in: 3599, scope: "openid", id_token });
  }

  private githubApi(request: Request, path: string, u: URL): Response {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const auth = request.headers.get("Authorization") ?? "";
    if (!/^Bearer mock-github-token-/.test(auth)) return json({ message: "Bad credentials" }, 401);
    // The checks fail (GitHub down, rate-limited), not the sign-in's /user.
    if (this.github.fail && path !== "/user") return json({ message: "Server Error" }, this.github.fail);
    if (path === "/user") {
      const w = this.who.github;
      return json({ login: w.login, id: w.id, name: w.name ?? null, email: OFFERED_EMAIL, public_repos: 3 });
    }
    let m = /^\/orgs\/([^/]+)\/public_members\/([^/]+)$/.exec(path);
    if (m) return new Response(null, { status: this.github.publicMembers.has(`${m[1]}/${m[2]}`.toLowerCase()) ? 204 : 404 });
    m = /^\/repos\/([^/]+)\/([^/]+)\/contributors$/.exec(path);
    if (m) {
      const list = this.github.contributors.get(`${m[1]}/${m[2]}`.toLowerCase());
      if (list === undefined) return json({ message: "Not Found" }, 404);
      if (typeof list === "number") return json({ message: "too large" }, list);
      return json(list.map((login, i) => ({ login, id: 1000 + i, contributions: 100 - i })));
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/commits$/.exec(path);
    if (m) {
      const n = this.github.commits.get(`${m[1]}/${m[2]}/${u.searchParams.get("author") ?? ""}`.toLowerCase()) ?? 0;
      return json(Array.from({ length: Math.min(n, Number(u.searchParams.get("per_page") ?? 30)) }, (_, i) => ({ sha: `c${i}` })));
    }
    return json({ message: "Not Found" }, 404);
  }

  /** The GitHub API requests the Worker made (their paths). */
  githubCalls(): string[] {
    return this.log.filter((l) => l.url.includes("/github-api/")).map((l) => new URL(l.url).pathname.slice("/github-api".length));
  }
}
