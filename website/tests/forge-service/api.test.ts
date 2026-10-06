// The public API, version 1 (night phase 10, E2; api.ts, who.ts, openapi.ts): bearer tokens only (a
// session's cookie never acts through it), CORS for any Origin without credentials, dated versions,
// request ids, the error model, scopes, rate limits, ETag and 304, Link pagination; its routes are the
// site's own handlers, so the same FORGE_OPEN, caps and rows apply; the OpenAPI file is the routes'.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { API_ROUTES, API_VERSION, handleApi, isApiPath } from "../../worker/forge/service/api.ts";
import { API_RATE } from "../../worker/forge/service/bearer.ts";
import { openApi } from "../../worker/forge/service/openapi.ts";
import { signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;
const ORIGIN = "https://registry.example";

async function tokenFor(b: ForgeBrowser, scopes: string[], name = "script"): Promise<string> {
  const res = await b.post("/api/forge/tokens/write", { op: "create", name, scopes, days: 30 });
  const made = await body(res);
  assert.equal(res.status, 201, JSON.stringify(made));
  return made.token as string;
}

function call(path: string, o: { token?: string | null; method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(`${ORIGIN}${path}`, { method: o.method ?? (o.body !== undefined ? "POST" : "GET"), headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return handleApi(request, w.env, w.ctx, w.deps) as Promise<Response>;
}

describe("the router", () => {
  test("its paths; the index without a token: the version, the routes, CORS, a request id", async () => {
    assert.ok(isApiPath("/api/forge/v1") && isApiPath("/api/forge/v1/") && isApiPath("/api/forge/v1/user"));
    assert.ok(!isApiPath("/api/forge/v10") && !isApiPath("/api/forge/repo"));
    const res = await call("/api/forge/v1");
    assert.equal(res.status, 200);
    const b = await body(res);
    assert.equal(b.version, API_VERSION);
    assert.equal(b.routes.length, Object.keys(API_ROUTES).length);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(res.headers.get("Access-Control-Allow-Credentials"), null);
    assert.match(res.headers.get("X-Request-Id") ?? "", /^[A-Za-z0-9_-]{16}$/);
    assert.equal(res.headers.get("X-Api-Version"), API_VERSION);
    assert.ok((res.headers.get("ETag") ?? "").startsWith('W/"'));
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });

  test("the preflight: any Origin, the headers a client sends, no credentials, no token needed", async () => {
    const res = await call("/api/forge/v1/social/star", { method: "OPTIONS", headers: { Origin: "https://lab.example", "Access-Control-Request-Method": "POST" } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(res.headers.get("Access-Control-Allow-Headers") ?? "", /Authorization/);
    assert.match(res.headers.get("Access-Control-Allow-Methods") ?? "", /POST/);
    assert.equal(res.headers.get("Access-Control-Allow-Credentials"), null);
  });

  test("the error model: 404, 405, a version it does not have, no token, a bad token", async () => {
    const nf = await body(await call("/api/forge/v1/nothing"));
    assert.equal(nf.error.code, "not_found");
    assert.match(nf.error.request_id, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(nf.error.documentation_url, `${ORIGIN}/developers/#errors`);
    const wrong = await call("/api/forge/v1/user", { method: "POST", body: {} });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("Allow"), "GET, HEAD");
    const v = await call("/api/forge/v1/user", { headers: { "X-Api-Version": "2020-01-01" } });
    assert.equal((await body(v)).error.code, "unsupported_version");
    const none = await call("/api/forge/v1/user");
    assert.equal(none.status, 401);
    assert.equal((await body(none)).error.code, "requires_authentication");
    assert.match(none.headers.get("WWW-Authenticate") ?? "", /^Bearer/);
    const bad = await call("/api/forge/v1/user", { token: `oscr_pat_${"q".repeat(43)}` });
    assert.equal(bad.status, 401);
    assert.equal((await body(bad)).error.code, "bad_credentials");
  });
});

describe("with a token", () => {
  test("/user: the public handles, the scopes, the expiry; the headers; nothing of the account's id", async () => {
    const b = await signIn(w);
    const token = await tokenFor(b, ["repos:read", "social:read"]);
    const res = await call("/api/forge/v1/user", { token });
    assert.equal(res.status, 200);
    const u = await body(res);
    assert.equal(u.github, "ada-fixture");
    assert.deepEqual(u.token.scopes, ["repos:read", "social:read"]);
    assert.equal(res.headers.get("X-Token-Scopes"), "repos:read, social:read");
    assert.equal(res.headers.get("X-RateLimit-Limit"), String(API_RATE.perDay));
    assert.equal(res.headers.get("X-RateLimit-Used"), "1");
    const uid = (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github'").get() as { user_id: string }).user_id;
    assert.ok(!JSON.stringify(u).includes(uid));
    assert.ok(!JSON.stringify(u).includes(token));
  });

  test("a session's cookie never acts through the API: stripped, and the request needs a token", async () => {
    const b = await signIn(w);
    const cookie = [...b.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await call("/api/forge/v1/social/mine", { headers: { Cookie: cookie } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("Set-Cookie"), null);
    const star = await call("/api/forge/v1/social/star", { headers: { Cookie: cookie }, body: { subject: "topic:eeg", on: true } });
    assert.equal(star.status, 401);
    assert.equal(forgeRows(w.forge, "stars").length, 0);
  });

  test("scopes: the route's scope, a write granting its read; refused with the scope said", async () => {
    const b = await signIn(w);
    const token = await tokenFor(b, ["repos:read"]);
    const res = await call("/api/forge/v1/social/mine", { token });
    assert.equal(res.status, 403);
    assert.equal((await body(res)).error.code, "insufficient_scope");
    assert.equal(res.headers.get("X-Accepted-Scopes"), "social:read");
    const writer = await tokenFor(b, ["social:write"], "writer");
    assert.equal((await call("/api/forge/v1/social/mine", { token: writer })).status, 200);
  });

  test("a write through the API: no CSRF, no Origin; the site's own handler, rows and action row", async () => {
    const b = await signIn(w);
    const token = await tokenFor(b, ["social:write"]);
    w.forge.reset();
    const res = await call("/api/forge/v1/social/star", { token, body: { subject: "paper:doi:10.1234/eeg.2026", label: "EEG", on: true } });
    const out = await body(res);
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(out.written, 2);
    // The star and its action row, and the token's last use (its first today: once a day).
    await Promise.all(w.ctx.waited);
    assert.equal(w.forge.totals.written, 3);
    assert.deepEqual(forgeRows(w.forge, "actions").map((a) => a.kind).sort(), ["star", "token"]);
    assert.equal(forgeRows(w.forge, "stars")[0].subject, "paper:doi:10.1234/eeg.2026");
    // A research issue, as the site opens one.
    await seed.repo(w.forge, { forge: "memory", repoId: "11", ownerLogin: "ada-fixture", name: "eeg" }, T0 - 86_400, { papers: [{ paperId: "doi:10.1234/eeg.2026", status: "linked" }] });
    const rt = await tokenFor(b, ["research:write"], "research");
    const opened = await call("/api/forge/v1/research/open", {
      token: rt,
      body: {
        paper: "10.1234/eeg.2026",
        repo: { forge: "memory", id: "11", path: "ada-fixture/eeg" },
        type: "mismatch",
        title: "The filter's order differs from the Methods",
        commit: "a".repeat(40),
        path: "src/filter.py",
        lines: { start: 12, end: 18 },
        paragraph: 14,
      },
    });
    const o = await body(opened);
    assert.equal(opened.status, 201, JSON.stringify(o));
    const read = await body(await call(`/api/forge/v1/research?id=${o.id}`, { token: rt }));
    assert.equal(read.issue.title, "The filter's order differs from the Methods");
  });

  test("FORGE_OPEN: a token made while the forge was open writes nothing once it is closed", async () => {
    const open = forgeWorld({ env: { FORGE_OPEN: "true" } });
    try {
      const bob = await signIn(open, "bob-fixture");
      const res = await bob.post("/api/forge/tokens/write", { op: "create", name: "bob", scopes: ["social:write"] });
      const token = (await body(res)).token as string;
      open.env.FORGE_OPEN = undefined;
      const star = (await handleApi(
        new Request(`${ORIGIN}/api/forge/v1/social/star`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ subject: "topic:eeg", on: true }) }),
        open.env,
        open.ctx,
        open.deps,
      )) as Response;
      assert.equal(star.status, 403);
      assert.equal((await body(star)).error.code, "forge_closed");
      assert.equal(forgeRows(open.forge, "stars").length, 0);
    } finally {
      open.restore();
    }
  });

  test("ETag and 304 (not counted); Link on a list with a next page; HEAD", async () => {
    const b = await signIn(w);
    const token = await tokenFor(b, ["repos:read", "social:read"]);
    const first = await call("/api/forge/v1/social/mine", { token });
    const etag = first.headers.get("ETag") ?? "";
    assert.ok(etag.startsWith('W/"'));
    const used = Number(first.headers.get("X-RateLimit-Used"));
    const again = await call("/api/forge/v1/social/mine", { token, headers: { "If-None-Match": etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), "");
    const after = await call("/api/forge/v1/rate_limit", { token });
    assert.equal((await body(after)).rate.used, used);
    // Two repositories, a page of one: the Link to the next.
    await seed.repo(w.forge, { forge: "memory", repoId: "21", ownerLogin: "ada-fixture", name: "a-one" });
    await seed.repo(w.forge, { forge: "memory", repoId: "22", ownerLogin: "ada-fixture", name: "b-two" });
    const page = await call("/api/forge/v1/repos/mine?limit=1", { token });
    assert.equal(page.status, 200, JSON.stringify(await body(page)));
    const link = page.headers.get("Link") ?? "";
    assert.match(link, /<https:\/\/registry\.example\/api\/forge\/v1\/repos\/mine\?limit=1&after=a-one>; rel="next"/);
    const head = await call("/api/forge/v1/user", { token, method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  test("rate limits: the minute's burst answers 429 with Retry-After; /rate_limit never counts", async () => {
    const b = await signIn(w);
    const token = await tokenFor(b, ["social:read"]);
    for (let i = 0; i < API_RATE.perMinute; i++) assert.equal((await call("/api/forge/v1/user", { token })).status, 200);
    const over = await call("/api/forge/v1/user", { token });
    assert.equal(over.status, 429);
    assert.equal((await body(over)).error.code, "rate_limited");
    assert.ok(Number(over.headers.get("Retry-After")) >= 1);
    const rl = await call("/api/forge/v1/rate_limit", { token });
    assert.equal(rl.status, 200);
    assert.equal((await body(rl)).rate.used, API_RATE.perMinute);
    // A minute later, it answers again.
    w.advance(60);
    assert.equal((await call("/api/forge/v1/user", { token })).status, 200);
  });

  test("the search, through the API: the site's own answer (not set up here: said so)", async () => {
    const b = await signIn(w);
    const token = await tokenFor(b, ["social:read"]);
    const res = await call("/api/forge/v1/search?q=eeg", { token });
    assert.equal((await body(res)).error.code, "not_configured");
    assert.ok(res.headers.get("X-Request-Id"));
  });
});

describe("the OpenAPI description", () => {
  test("the published file is the routes' own", () => {
    const file = JSON.parse(readFileSync(new URL("../../public/developers/openapi.json", import.meta.url), "utf8"));
    assert.deepEqual(file, JSON.parse(JSON.stringify(openApi())), "run: node --experimental-strip-types scripts/openapi.ts");
    for (const [path, route] of Object.entries(API_ROUTES)) {
      const op = file.paths[path][route.method.toLowerCase()];
      assert.equal(op["x-scope"], route.scope, path);
    }
    assert.ok(!JSON.stringify(file).includes("@"));
  });

  test("every route has words, and its body's fields are said", () => {
    for (const [path, route] of Object.entries(API_ROUTES)) {
      assert.ok(route.words.length > 10, path);
      if (route.method === "POST" && path !== "/api/forge/v1") assert.ok(route.body && Object.keys(route.body).length, path);
    }
    assert.ok(T0 > 0);
  });
});
