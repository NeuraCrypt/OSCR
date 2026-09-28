// The routes (worker/account/index.ts): what `handleAccount` answers and what it leaves to the rest
// of the Worker; the configuration it needs; its failures; and the small rules it relies on.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { returnPath } from "../../worker/account/http.ts";
import { handleAccount, paperSlug } from "../../worker/account/index.ts";
import { orcidId, provider } from "../../worker/account/providers.ts";
import { repoKey } from "../../worker/account/repo.ts";
import worker from "../../worker/index.ts";
import { ORIGIN, SESSION_KEY, world, type World } from "./browser.ts";

let w: World;
beforeEach(() => {
  w = world();
});
afterEach(() => w.restore());

const req = (path: string, init?: RequestInit) => new Request(new URL(path, ORIGIN), init);

test("any other path is not the accounts' business: null, for the rest of the Worker", async () => {
  for (const path of ["/", "/account/", "/api/search", "/api/accounts", "/api/authx/orcid/start", "/paper/x/"]) {
    assert.equal(await handleAccount(req(path), w.env), null, path);
  }
});

test("the site's Worker (worker/index.ts) hands the accounts' paths to them, and only those", async () => {
  const ctx = { waitUntil() {} };
  const me = await worker.fetch(req("/api/account/me"), w.env, ctx);
  assert.equal(me.status, 200);
  assert.equal(me.headers.get("Cache-Control"), "no-store");
  assert.equal((await me.json()).signed_in, false);
  assert.equal((await worker.fetch(req("/api/auth/orcid/start?return=/account/"), w.env, ctx)).status, 302);
  for (const path of ["/api/account/nothing", "/api/auth/twitter/start", "/api/account"]) {
    const res = await worker.fetch(req(path), w.env, ctx);
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).error.code, "not_found", path);
  }
});

test("unknown routes and providers are 404, wrong methods 405", async () => {
  const status = async (path: string, init?: RequestInit) => (await handleAccount(req(path, init), w.env))?.status;
  assert.equal(await status("/api/account/nothing"), 404);
  assert.equal(await status("/api/account"), 404);
  assert.equal(await status("/api/auth/twitter/start"), 404);
  assert.equal(await status("/api/auth/orcid/elsewhere"), 404);
  assert.equal(await status("/api/auth/orcid/start", { method: "POST" }), 405);
  assert.equal(await status("/api/account/me/"), 200, "a trailing slash is the same route");
});

test("every answer is private: no-store, nosniff, no referrer", async () => {
  for (const path of ["/api/account/me", "/api/auth/orcid/start", "/api/account/nothing"]) {
    const res = (await handleAccount(req(path), w.env)) as Response;
    assert.equal(res.headers.get("Cache-Control"), "no-store", path);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff", path);
    assert.equal(res.headers.get("Referrer-Policy"), "no-referrer", path);
  }
});

test("signed out, /me lists the ways to sign in that are set up", async () => {
  const me = (await (await handleAccount(req("/api/account/me"), w.env))?.json()) as Record<string, unknown>;
  assert.deepEqual(me, {
    signed_in: false,
    available: true,
    providers: ["orcid", "github", "google"].map((name) => ({
      name,
      label: { orcid: "ORCID", github: "GitHub", google: "Google" }[name],
      linked: false,
      start: `/api/auth/${name}/start?return=/account/`,
    })),
  });
});

test("not set up: no database, no server key, or a provider without its secret", async () => {
  const bare = { ...w.env, COMMUNITY: undefined };
  const me = await (await handleAccount(req("/api/account/me"), bare))?.json();
  assert.deepEqual(me, { signed_in: false, available: false, providers: [] });
  const start = (await handleAccount(req("/api/auth/orcid/start"), bare)) as Response;
  assert.equal(start.headers.get("Location"), "/account/?error=unavailable_provider&provider=orcid");
  const post = (await handleAccount(req("/api/account/signout", { method: "POST", headers: { Origin: ORIGIN } }), bare)) as Response;
  assert.equal(post.status, 503);
  const shortKey = (await handleAccount(req("/api/auth/github/start"), { ...w.env, SESSION_KEY: "too-short" })) as Response;
  assert.match(shortKey.headers.get("Location") ?? "", /error=unavailable_provider/);
  const noGoogle = { ...w.env, GOOGLE_CLIENT_SECRET: undefined };
  const list = (await (await handleAccount(req("/api/account/me"), noGoogle))?.json()) as { providers: { name: string }[] };
  assert.deepEqual(list.providers.map((p) => p.name), ["orcid", "github"]);
  assert.match((await handleAccount(req("/api/auth/google/start"), noGoogle))?.headers.get("Location") ?? "", /unavailable_provider/);
});

test("a provider's address must be https, or http on this machine only", () => {
  const env = { ...w.env, SESSION_KEY };
  assert.equal(provider({ ...env, ORCID_ISSUER: "http://orcid.example" }, "orcid"), null);
  assert.equal(provider({ ...env, ORCID_ISSUER: "http://127.0.0.1:9471/orcid" }, "orcid")?.tokenUrl, "http://127.0.0.1:9471/orcid/oauth/token");
  assert.equal(provider({ ...env, ORCID_ISSUER: undefined }, "orcid")?.authorizeUrl, "https://sandbox.orcid.org/oauth/authorize", "sandbox first");
  assert.equal(provider({ ...env, ORCID_ISSUER: "https://orcid.org" }, "orcid")?.oidc?.jwksUri, "https://orcid.org/oauth/jwks");
  const google = provider({ ...env, GOOGLE_ISSUER: undefined }, "google");
  assert.deepEqual(google?.oidc?.issuers, ["https://accounts.google.com", "accounts.google.com"]);
  assert.equal(google?.tokenUrl, "https://oauth2.googleapis.com/token");
  const github = provider({ ...env, GITHUB_URL: undefined, GITHUB_API_URL: undefined }, "github");
  assert.equal(github?.authorizeUrl, "https://github.com/login/oauth/authorize");
  assert.equal(github?.api, "https://api.github.com");
  assert.equal(github?.scope, "");
});

test("the database failing: a clear answer, and the quota said in words", async () => {
  const b = w.browser();
  await b.signIn("orcid");
  w.db.failWith = "D1_ERROR: D1 DB is overloaded. Requests queued for too long.";
  const res = await b.fetch("/api/account/me");
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unavailable");
  w.db.failWith = "D1_ERROR: Your account has exceeded D1's free tier daily row written limit.";
  assert.equal(((await (await b.fetch("/api/account/me")).json()) as { error: { code: string } }).error.code, "quota");
  // A sign-in's callback is a page the browser shows: it goes back to the account page.
  w.db.failWith = undefined;
  const start = await b.fetch("/api/auth/github/start");
  w.db.failWith = "D1_ERROR: D1 DB is overloaded.";
  assert.equal((await b.approve(start.headers.get("Location") ?? "")).search, "?error=unavailable");
});

test("development metrics: the D1 figures of each answer, only when asked", async () => {
  const plain = (await handleAccount(req("/api/account/me"), w.env)) as Response;
  assert.equal(plain.headers.get("X-D1-Queries"), null);
  const measured = (await handleAccount(req("/api/account/me"), { ...w.env, ACCOUNT_DEV_METRICS: "1" })) as Response;
  assert.equal(measured.headers.get("X-D1-Queries"), "0");
  assert.equal(measured.headers.get("X-D1-Rows-Written"), "0");
});

test("the page to come back to", () => {
  assert.equal(returnPath(null), "/account/");
  assert.equal(returnPath("/paper/doi_10.1_x/"), "/paper/doi_10.1_x/");
  for (const bad of ["https://evil.example/", "//evil.example/", "/\\evil.example", "/api/auth/orcid/start", "account/", "/a b/", "/x?y=1"]) {
    assert.equal(returnPath(bad), "/account/", bad);
  }
});

test("a repository typed into the claim form becomes the registry's key", () => {
  const cases: [string, string][] = [
    ["https://github.com/Owner/Repo", "github.com/owner/repo"],
    ["github.com/owner/repo.git", "github.com/owner/repo"],
    ["https://www.github.com/owner/repo/tree/main/analysis?x=1#readme", "github.com/owner/repo"],
    ["git@github.com:Owner/Repo.git", "github.com/owner/repo"],
    ["owner/repo", "github.com/owner/repo"],
    ["https://gitlab.com/Group/Sub/Project/-/tree/main", "gitlab.com/group/sub/project"],
    ["https://gitlab.inria.fr/team/tool.git", "gitlab.inria.fr/team/tool"],
    ["https://codeberg.org/lab/code", "codeberg.org/lab/code"],
    ["https://framagit.org/lab/code/-/blob/x", "framagit.org/lab/code"],
    ["https://github.com/owner", ""],
    ["https://github.com/owner/..", ""],
    ["https://zenodo.org/records/123", ""],
    ["https://example.org/owner/repo", ""],
    ["github.com/owner/repo with spaces", ""],
    ["", ""],
  ];
  for (const [text, key] of cases) assert.equal(repoKey(text), key, text);
});

test("ORCID iDs: the check digit, and the forms they come in", () => {
  assert.equal(orcidId("0000-0002-1825-0097"), "0000-0002-1825-0097");
  assert.equal(orcidId("https://orcid.org/0000-0002-1825-0097"), "0000-0002-1825-0097");
  assert.equal(orcidId("https://sandbox.orcid.org/0000000218250097"), "0000-0002-1825-0097");
  assert.equal(orcidId("0000-0000-0000-001x"), "0000-0000-0000-001X");
  assert.equal(orcidId("0000-0002-1825-0098"), "");
  assert.equal(orcidId("not an iD"), "");
});

test("a paper's page is named as catalog.slug names it", () => {
  assert.equal(paperSlug("doi:10.5555/oscr.fixture.1"), "doi_10.5555_oscr.fixture.1");
  assert.equal(paperSlug("pmcid:PMC1234567"), "pmcid_pmc1234567");
  assert.equal(paperSlug("doi:10.1002/(SICI)1097-0258"), "doi_10.1002_sici_1097-0258");
});
