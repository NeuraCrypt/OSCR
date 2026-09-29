// Commit statuses posted by outside services (night phase 10, E4; statuses.ts): with a token
// (statuses:write) or GitHub Actions' OIDC token (checked: signature, issuer, audience, times, a public
// repository the registry knows); the latest of each context, 20 a commit; 2 rows; FORGE_OPEN; the
// combined state; read by the site's pages and the API.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { forgetKeys } from "../../worker/account/jwt.ts";
import { handleApi } from "../../worker/forge/service/api.ts";
import { combined, CONTEXTS_PER_COMMIT, validateStatus } from "../../worker/forge/service/statuses.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import { signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { forgeWorld, seed, T0, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;
const ORIGIN = "https://registry.example";
const SHA = "c".repeat(40);

let w: ForgeWorld;
beforeEach(async () => {
  forgetKeys();
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } });
  w.env.GITHUB_OIDC_ISSUER = `${w.mock.base}/actions`;
  await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada-fixture", name: "eeg" });
  // GitHub Actions' statuses are GitHub's: a repository of forge github, owned by Ada.
  await seed.repo(w.forge, { forge: "github", repoId: "555", ownerId: w.ada.user.id, ownerLogin: "ada-fixture", name: "eeg-gh" });
  w.forge.reset();
});
afterEach(() => w.restore());

function api(path: string, o: { token?: string; bearer?: string; payload?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`;
  if (o.payload !== undefined) headers["Content-Type"] = "application/json";
  return handleApi(new Request(`${ORIGIN}${path}`, { method: o.payload === undefined ? "GET" : "POST", headers, body: o.payload === undefined ? undefined : JSON.stringify(o.payload) }), w.env, w.ctx, w.deps) as Promise<Response>;
}

async function token(scopes: string[]): Promise<string> {
  const b = await signIn(w);
  return (await body(await b.post("/api/forge/tokens/write", { op: "create", name: "lab ci", scopes }))).token;
}

describe("the pure parts", () => {
  test("a status: a full commit id, a state, a context and words without addresses, an https page", () => {
    const ok = validateStatus({ repo: "ada-fixture/eeg", sha: SHA.toUpperCase(), state: "success", context: "lab-ci/tests", description: "12 passed; ada@example.org", target_url: "https://ci.lab.example/run/1" });
    assert.ok(!isProblem(ok));
    if (!isProblem(ok)) {
      assert.equal(ok.sha, SHA);
      assert.ok(!ok.description.includes("@"));
    }
    for (const bad of [{ repo: "x/y", sha: "abc", state: "success" }, { repo: "x/y", sha: SHA, state: "passed" }, { repo: "x/y", sha: SHA, state: "success", target_url: "http://ci.example" }, { sha: SHA, state: "success" }]) {
      assert.ok(isProblem(validateStatus(bad)), JSON.stringify(bad));
    }
    assert.equal(combined([]), null);
    assert.equal(combined(["success", "pending"]), "pending");
    assert.equal(combined(["success", "error"]), "failure");
    assert.equal(combined(["success"]), "success");
  });
});

describe("with a token", () => {
  test("post, update its context, read the combined state; 2 rows; the poster named by their public handle", async () => {
    const t = await token(["statuses:write", "repos:read"]);
    w.forge.reset();
    const posted = await api("/api/v1/statuses/post", { token: t, payload: { repo: "ada-fixture/eeg", sha: SHA, state: "pending", context: "lab-ci/tests" } });
    assert.equal(posted.status, 201, JSON.stringify(await body(posted)));
    await Promise.all(w.ctx.waited);
    assert.equal((await body(posted)).written, 2);
    await api("/api/v1/statuses/post", { token: t, payload: { repo: "memory:101", sha: SHA, state: "success", context: "lab-ci/tests", description: "12 passed" } });
    await api("/api/v1/statuses/post", { token: t, payload: { repo: "ada-fixture/eeg", sha: SHA, state: "failure", context: "repro/figure-2" } });
    assert.equal(forgeRows(w.forge, "statuses").length, 2);
    const read = await body(await api(`/api/v1/statuses?path=ada-fixture/eeg&sha=${SHA}`, { token: t }));
    assert.equal(read.state, "failure");
    assert.deepEqual(read.statuses.map((s: Json) => [s.context, s.state, s.by, s.via]), [["lab-ci/tests", "success", "ada-fixture", "token"], ["repro/figure-2", "failure", "ada-fixture", "token"]]);
    const uid = (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github'").get() as { user_id: string }).user_id;
    assert.ok(!JSON.stringify(read).includes(uid));
    // The site's pages read the same, signed in.
    const b = await signIn(w);
    assert.equal((await body(await b.fetch(`/api/forge/statuses?path=ada-fixture/eeg&sha=${SHA}`))).statuses.length, 2);
    assert.deepEqual(w.forge.scans, []);
  });

  test("refused: an unknown repository, the 21st context, the scope, FORGE_OPEN", async () => {
    const t = await token(["statuses:write"]);
    assert.equal((await api("/api/v1/statuses/post", { token: t, payload: { repo: "nobody/nothing", sha: SHA, state: "success" } })).status, 404);
    for (let i = 0; i < CONTEXTS_PER_COMMIT; i++) {
      assert.equal((await api("/api/v1/statuses/post", { token: t, payload: { repo: "ada-fixture/eeg", sha: SHA, state: "success", context: `c${i}` } })).status, 201);
    }
    assert.equal((await body(await api("/api/v1/statuses/post", { token: t, payload: { repo: "ada-fixture/eeg", sha: SHA, state: "success", context: "one-more" } }))).error.code, "too_many_contexts");
    assert.equal((await api(`/api/v1/statuses?path=ada-fixture/eeg&sha=${SHA}`, { token: t })).status, 403, "reading needs repos:read");
    w.env.FORGE_OWNER_GITHUB_ID = undefined;
    assert.equal((await body(await api("/api/v1/statuses/post", { token: t, payload: { repo: "ada-fixture/eeg", sha: SHA, state: "success", context: "c0" } }))).error.code, "forge_closed");
  });
});

describe("GitHub Actions' OIDC token", () => {
  const claims = (extra: Json = {}) => ({
    iss: `${w.mock.base}/actions`,
    aud: ORIGIN,
    sub: "repo:ada-fixture/eeg-gh:ref:refs/heads/main",
    exp: T0 + 300,
    iat: T0 - 10,
    nbf: T0 - 10,
    repository: "ada-fixture/eeg-gh",
    repository_id: "555",
    repository_owner_id: w.ada.user.id,
    repository_visibility: "public",
    workflow: "Tests",
    ...extra,
  });

  test("a workflow posts with GitHub's token: no secret; the repository's own status, 2 rows, its action row the repository's", async () => {
    const jwt = await w.mock.sign(claims());
    w.forge.reset();
    const res = await api("/api/v1/statuses/actions", { bearer: jwt, payload: { sha: SHA, state: "success", target_url: "https://github.com/ada-fixture/eeg-gh/actions/runs/1" } });
    assert.equal(res.status, 201, JSON.stringify(await body(res)));
    assert.equal(w.forge.totals.written, 2);
    const [row] = forgeRows(w.forge, "statuses");
    assert.deepEqual([row.context, row.via, row.by_name, row.by_user, row.repo_id], ["GitHub Actions: Tests", "oidc", "GitHub Actions: Tests", "", "555"]);
    assert.equal(forgeRows(w.forge, "actions")[0].user_id, "oidc:github:555");
  });

  test("refused: another audience, another issuer, expired, a forged signature, a private or unknown repository, FORGE_OPEN", async () => {
    const post = async (c: Json, other = false) => {
      w.mock.signWithOtherKey = other;
      const jwt = await w.mock.sign(claims(c));
      w.mock.signWithOtherKey = false;
      return api("/api/v1/statuses/actions", { bearer: jwt, payload: { sha: SHA, state: "success" } });
    };
    assert.equal((await post({ aud: "https://elsewhere.example" })).status, 401);
    assert.equal((await post({ iss: "https://token.actions.githubusercontent.com" })).status, 401);
    assert.equal((await post({ exp: T0 - 1000 })).status, 401);
    assert.equal((await post({}, true)).status, 401);
    assert.equal((await post({ repository_visibility: "private" })).status, 403);
    assert.equal((await post({ repository_id: "999" })).status, 404);
    assert.equal((await body(await post({ repository_owner_id: "12345" }))).error.code, "forge_closed");
    assert.equal((await api("/api/v1/statuses/actions", { bearer: "not.a.jwt", payload: { sha: SHA, state: "success" } })).status, 401);
    assert.equal(forgeRows(w.forge, "statuses").length, 0);
  });
});
