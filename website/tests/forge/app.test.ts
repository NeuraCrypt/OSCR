// The GitHub App's plumbing (worker/forge/github/app.ts, auth.ts): the JWT signed with GitHub's
// PKCS#1 key wrapped into PKCS#8 for WebCrypto, installation tokens minted and cached in memory,
// and a person's authorization of one action (exchange, who, revocation, installations).
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, it } from "node:test";
import { GitBackendError } from "../../worker/forge/errors.ts";
import { appJwt, derLength, pemToPkcs8, TOKEN_MARGIN } from "../../worker/forge/github/app.ts";
import { githubBackend } from "../../worker/forge/github/index.ts";
import type * as T from "../../worker/forge/types.ts";
import { emailKeys, ghRepo, ghUser, json, MockFetch } from "./github-mock.ts";

const { privateKey: PKCS1, publicKey: PUBLIC } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const NOW = 1_790_596_800;
const CLIENT = { id: "Iv23liTESTCLIENT", secret: "test-secret-not-real" };
const REPO: T.RepoRef = { forge: "github", owner: "ada", name: "compendium" };

const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function checkJwt(jwt: string, now: number): Record<string, unknown> {
  const [h, c, sig] = jwt.split(".");
  assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${c}`), createPublicKey(PUBLIC), fromB64url(sig)), "signed by the App's key");
  assert.deepEqual(JSON.parse(fromB64url(h).toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(fromB64url(c).toString()) as Record<string, unknown>;
  assert.equal(claims.iat, now - 60);
  assert.equal(claims.exp, now + 540);
  return claims;
}

describe("the GitHub App's JWT", () => {
  it("writes DER lengths as the usual rule says", () => {
    assert.deepEqual([...derLength(5)], [5]);
    assert.deepEqual([...derLength(127)], [127]);
    assert.deepEqual([...derLength(128)], [0x81, 128]);
    assert.deepEqual([...derLength(300)], [0x82, 1, 44]);
    assert.deepEqual([...derLength(70_000)], [0x83, 1, 17, 112]);
  });

  it("wraps GitHub's PKCS#1 key into the PKCS#8 WebCrypto imports, byte for byte", () => {
    const expected = createPrivateKey(PKCS1).export({ type: "pkcs8", format: "der" });
    assert.deepEqual(Buffer.from(pemToPkcs8(PKCS1)), expected);
    const pkcs8Pem = createPrivateKey(PKCS1).export({ type: "pkcs8", format: "pem" }) as string;
    assert.deepEqual(Buffer.from(pemToPkcs8(pkcs8Pem)), expected);
    assert.deepEqual(Buffer.from(pemToPkcs8(PKCS1.replace(/\n/g, "\\n"))), expected, "a PEM pasted on one line");
    for (const bad of ["", "not a key", "-----BEGIN RSA PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----"]) {
      assert.throws(() => pemToPkcs8(bad), (e: unknown) => e instanceof GitBackendError && e.code === "unsupported" && !e.message.includes("BEGIN"));
    }
  });

  it("signs a JWT the App's public key verifies, valid 10 minutes at most", async () => {
    const jwt = await appJwt({ issuer: CLIENT.id, privateKey: PKCS1, now: NOW });
    const claims = checkJwt(jwt, NOW);
    assert.equal(claims.iss, CLIENT.id);
    assert.ok((claims.exp as number) - (claims.iat as number) <= 600);
  });
});

describe("installation tokens", () => {
  it("are minted with the JWT, narrowed to the repository and the act, cached, and minted again near expiry", async () => {
    let now = NOW;
    const mock = new MockFetch();
    let minted = 0;
    mock.on("POST", "/app/installations/777/access_tokens", () => {
      minted++;
      return json({ token: `ghs_minted${minted}xxxxxxxxxxxxxxxxxxxxxxxx`, expires_at: new Date((now + 3600) * 1000).toISOString(), permissions: {} }, 201);
    });
    mock.on("GET", "/repos/ada/compendium", json(ghRepo()));
    mock.on("POST", "/repos/ada/compendium/check-runs", json({ id: 1, name: "x", head_sha: "a".repeat(40), status: "queued", conclusion: null, output: {} }, 201));
    const cache = new Map<string, { token: string; exp: number }>();
    const backend = githubBackend({ clientId: CLIENT.id, clientSecret: CLIENT.secret, privateKey: PKCS1 }, { fetch: mock.fetch, now: () => now, tokenCache: cache });
    const s = backend.session({ kind: "installation", installationId: "777" });
    await s.repos.get(REPO);
    await s.repos.get(REPO);
    assert.equal(minted, 1, "the second read hits the cache");
    const mint = mock.calls[0];
    assert.match(mint.headers.get("Authorization") ?? "", /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    checkJwt((mint.headers.get("Authorization") ?? "").slice(7), NOW);
    assert.deepEqual(JSON.parse(mint.body), { repositories: ["compendium"], permissions: { metadata: "read", contents: "read", pull_requests: "read", issues: "read", checks: "read" } });
    assert.equal(mock.calls[1].headers.get("Authorization"), "Bearer ghs_minted1xxxxxxxxxxxxxxxxxxxxxxxx");
    await s.checks.create(REPO, { name: "Tracing map", headSha: "a".repeat(40) });
    assert.equal(minted, 2, "a check run needs checks: write");
    assert.deepEqual(JSON.parse(mock.calls.at(-2)?.body ?? "{}").permissions, { metadata: "read", checks: "write" });
    now += 3600 - TOKEN_MARGIN + 1;
    await s.repos.get(REPO);
    assert.equal(minted, 3, "minted again 5 minutes before expiry");
    assert.deepEqual(s.cost(), { requests: 7, writes: 1, graphql: 0, mints: 3 });
    assert.equal(cache.size, 2);
    for (const { token } of cache.values()) assert.match(token, /^ghs_minted/);
  });

  it("are minted once for requests that start together", async () => {
    const mock = new MockFetch();
    let minted = 0;
    mock.on("POST", "/app/installations/777/access_tokens", async () => {
      minted++;
      await new Promise((r) => setTimeout(r, 5));
      return json({ token: "ghs_sharedxxxxxxxxxxxxxxxxxxxxxxxxxxx", expires_at: new Date((NOW + 3600) * 1000).toISOString() }, 201);
    });
    mock.on("GET", "/repos/ada/compendium/languages", json({ Python: 1 }));
    const backend = githubBackend({ clientId: CLIENT.id, clientSecret: CLIENT.secret, privateKey: PKCS1 }, { fetch: mock.fetch, now: () => NOW, tokenCache: new Map() });
    const s = backend.session({ kind: "installation", installationId: "777" });
    await Promise.all(Array.from({ length: 5 }, () => s.repos.languages(REPO)));
    assert.equal(minted, 1);
    assert.equal(s.cost().mints, 1);
  });

  it("are never minted without the App's key", () => {
    const backend = githubBackend({ clientId: CLIENT.id, clientSecret: CLIENT.secret }, { fetch: new MockFetch().fetch });
    assert.throws(() => backend.session({ kind: "installation", installationId: "777" }), (e: unknown) => e instanceof GitBackendError && e.code === "unsupported");
  });
});

describe("a person's authorization of one action", () => {
  const setup = () => {
    const mock = new MockFetch();
    const backend = githubBackend({ clientId: CLIENT.id, clientSecret: CLIENT.secret, appSlug: "code-registry" }, { fetch: mock.fetch, now: () => NOW });
    assert.ok(backend.auth);
    return { mock, auth: backend.auth as NonNullable<typeof backend.auth> };
  };
  const verifier = "v".repeat(43);
  const redirectUri = "https://oscr.example/forge/authorized/";

  it("sends the person to GitHub with the state and the PKCE challenge, and no scope", () => {
    const { auth } = setup();
    const u = new URL(auth.authorizeUrl({ state: "s".repeat(43), codeChallenge: "c".repeat(43), redirectUri }));
    assert.equal(u.origin + u.pathname, "https://github.com/login/oauth/authorize");
    assert.deepEqual(Object.fromEntries(u.searchParams), { client_id: CLIENT.id, redirect_uri: redirectUri, state: "s".repeat(43), code_challenge: "c".repeat(43), code_challenge_method: "S256" });
    for (const bad of ["http://oscr.example/cb", "javascript:alert(1)", "https://oscr.example/cb#frag"]) {
      assert.throws(() => auth.authorizeUrl({ state: "s".repeat(43), codeChallenge: "c".repeat(43), redirectUri: bad }), (e: unknown) => e instanceof GitBackendError && e.code === "invalid", bad);
    }
    auth.authorizeUrl({ state: "s".repeat(43), codeChallenge: "c".repeat(43), redirectUri: "http://localhost:8787/forge/authorized/" });
    assert.equal(auth.installUrl("s".repeat(43)), `https://github.com/apps/code-registry/installations/new?state=${"s".repeat(43)}`);
  });

  it("exchanges the code server to server, and drops the refresh token", async () => {
    const { mock, auth } = setup();
    mock.on("POST", "/login/oauth/access_token", json({ access_token: "ghu_personToken0123456789abcdef", expires_in: 28_800, refresh_token: "ghr_neverKept", refresh_token_expires_in: 15_811_200, token_type: "bearer", scope: "" }));
    const token = await auth.exchange({ code: "code-from-github", codeVerifier: verifier, redirectUri });
    assert.deepEqual(token, { token: "ghu_personToken0123456789abcdef", expiresAt: NOW + 28_800 });
    const call = mock.last();
    assert.equal(call.url.href, "https://github.com/login/oauth/access_token");
    assert.equal(call.headers.get("Accept"), "application/json");
    assert.equal(call.headers.get("Content-Type"), "application/x-www-form-urlencoded");
    assert.equal(call.headers.get("Authorization"), null);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(call.body)), { client_id: CLIENT.id, client_secret: CLIENT.secret, code: "code-from-github", redirect_uri: redirectUri, code_verifier: verifier });
  });

  it("refuses a code GitHub refuses (200 with an error field)", async () => {
    const { mock, auth } = setup();
    mock.on("POST", "/login/oauth/access_token", json({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }));
    await assert.rejects(auth.exchange({ code: "stale", codeVerifier: verifier, redirectUri }), (e: unknown) => e instanceof GitBackendError && e.code === "unauthorized");
  });

  it("reads who the token is: the id and the login only", async () => {
    const { mock, auth } = setup();
    mock.on("GET", "/user", json({ ...ghUser("ada", 101), name: "Ada Lovelace", email: "ada@example.org" }));
    const me = await auth.whoAmI("ghu_personToken0123456789abcdef");
    assert.deepEqual(me, { id: "101", login: "ada" });
    assert.equal(mock.last().headers.get("Authorization"), "Bearer ghu_personToken0123456789abcdef");
  });

  it("revokes the token after its action, with the App's own credentials", async () => {
    const { mock, auth } = setup();
    mock.on("DELETE", `/applications/${CLIENT.id}/token`, json(null, 204), 1);
    mock.on("DELETE", `/applications/${CLIENT.id}/token`, json({ message: "Not Found" }, 404), 1);
    await auth.revoke("ghu_personToken0123456789abcdef");
    const call = mock.last();
    assert.equal(call.headers.get("Authorization"), `Basic ${btoa(`${CLIENT.id}:${CLIENT.secret}`)}`);
    assert.deepEqual(JSON.parse(call.body), { access_token: "ghu_personToken0123456789abcdef" });
    await auth.revoke("ghu_personToken0123456789abcdef");
  });

  it("lists the installations a person sees, and their repositories with the person's permission", async () => {
    const { mock, auth } = setup();
    mock.on("GET", "/user/installations", json({ total_count: 1, installations: [{ id: 777, account: { login: "ada-lab", id: 909, type: "Organization" }, repository_selection: "all", suspended_at: null }] }));
    mock.on("GET", "/user/installations/777/repositories", json({ total_count: 2, repositories: [ghRepo({ owner: "ada-lab", permissions: { admin: true, push: true, pull: true } }), ghRepo({ owner: "ada-lab", name: "private-data", id: 5009, private: true, permissions: { admin: false, push: false, pull: true } })] }));
    const installs = await auth.installations("ghu_personToken0123456789abcdef");
    assert.deepEqual(installs.items, [{ id: "777", account: { id: "909", login: "ada-lab", type: "organization" }, selection: "all", suspended: false }]);
    const repos = await auth.installationRepositories("ghu_personToken0123456789abcdef", "777");
    assert.deepEqual(repos.items.map((r) => [r.ref.name, r.visibility, r.permission]), [["compendium", "public", "admin"], ["private-data", "private", "read"]]);
    assert.deepEqual(emailKeys(repos), []);
    await assert.rejects(auth.installationRepositories("ghu_personToken0123456789abcdef", "../x"), (e: unknown) => e instanceof GitBackendError && e.code === "invalid");
  });
});
