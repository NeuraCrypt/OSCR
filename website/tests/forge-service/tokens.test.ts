// The registry's personal tokens (night phase 10, E1; tokens-core.ts, tokens.ts, bearer.ts): made on
// the site (cookie, Origin, CSRF, FORGE_OPEN, caps), answered once, kept as a SHA-256 only, scoped,
// expiring, revocable at once, listed with their last use; a request of the API that carries one is
// found by its digest, refused when revoked, expired or malformed, and rate-limited per token.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import { API_RATE, bearer, giveBack, peekRate, rateHeaders, sharedLimit, takeRequest, tokenOf, type Principal } from "../../worker/forge/service/bearer.ts";
import { PER_ACCOUNT_DAY } from "../../worker/forge/service/caps.ts";
import { redact } from "../../worker/forge/service/http.ts";
import { EXPIRY, grants, SCOPES, TOKEN_SHAPE, TOKENS_PER_ACCOUNT, validateToken } from "../../worker/forge/service/tokens-core.ts";
import { ForgeProblem, isProblem, type D1Database, type ForgeServiceEnv } from "../../worker/forge/service/types.ts";
import { signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { forgeWorld, seed, T0, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function userId(): Promise<string> {
  const subject = String(w.mock.who.github.id);
  return (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(subject) as { user_id: string }).user_id;
}

const make = (b: Awaited<ReturnType<typeof signIn>>, extra: Json = {}) =>
  b.post("/api/forge/tokens/write", { op: "create", name: "Lab CI", scopes: ["repos:read", "statuses:write"], days: 30, ...extra });

function apiRequest(token: string | null, header?: string): Request {
  const headers: Record<string, string> = {};
  if (header !== undefined) headers.Authorization = header;
  else if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://registry.example/api/forge/v1/user", { headers });
}

const env = () => w.env as ForgeServiceEnv & { FORGE: D1Database };

describe("the pure parts", () => {
  test("a token's shape; scopes, a write granting the read of its area", () => {
    assert.ok(TOKEN_SHAPE.test(`oscr_pat_${"a".repeat(43)}`));
    for (const bad of [`oscr_pat_${"a".repeat(42)}`, `ghp_${"a".repeat(43)}`, `oscr_pat_${"a".repeat(42)}!`]) assert.ok(!TOKEN_SHAPE.test(bad), bad);
    assert.ok(grants(["research:write"], "research:read"));
    assert.ok(grants(["repos:read"], "repos:read"));
    assert.ok(!grants(["research:read"], "research:write"));
    assert.ok(!grants(["social:write"], "research:read"));
    assert.ok(!grants(["statuses:write"], "repos:read"));
  });

  test("a request: a name, known scopes, a life of 1 to 366 days (30 by default), addresses masked", () => {
    const ok = validateToken({ name: "Notebook of ada@example.org", scopes: ["social:write", "repos:read", "repos:read"] });
    assert.ok(!isProblem(ok));
    if (!isProblem(ok)) {
      assert.equal(ok.days, EXPIRY.default);
      assert.deepEqual(ok.scopes, ["repos:read", "social:write"]);
      assert.ok(!ok.name.includes("@"));
    }
    for (const bad of [{ name: "", scopes: ["repos:read"] }, { name: "x", scopes: [] }, { name: "x", scopes: ["admin"] }, { name: "x", scopes: ["repos:read"], days: 0 }, { name: "x", scopes: ["repos:read"], days: 367 }, { name: "x", scopes: ["repos:read"], days: 1.5 }, null, []]) {
      assert.ok(isProblem(validateToken(bad)), JSON.stringify(bad));
    }
    assert.equal(SCOPES.length, 11);
  });

  test("the logs never keep a token: redact knows the prefix", () => {
    const token = `oscr_pat_${"Ab-_".repeat(10)}xyz`;
    assert.ok(!redact(`Authorization failed for ${token}`).includes("oscr_pat_A"));
  });

  test("the header: Bearer or token, the right shape, else a problem before any hashing", () => {
    const token = `oscr_pat_${"x".repeat(43)}`;
    assert.equal(tokenOf(apiRequest(token)), token);
    assert.equal(tokenOf(apiRequest(null, `token ${token}`)), token);
    assert.equal(tokenOf(apiRequest(null)), null);
    for (const h of ["Bearer", `Basic ${token}`, "Bearer ghp_abc", `Bearer ${token} extra`]) assert.ok(tokenOf(apiRequest(null, h)) instanceof ForgeProblem, h);
  });

  test("rate limits per token: 60 a minute, 1,000 a day, headers; a 304 given back; peek never counts", () => {
    const windows = new Map();
    let t = T0;
    for (let i = 0; i < API_RATE.perMinute; i++) assert.ok(takeRequest("tok", t, windows).ok);
    const burst = takeRequest("tok", t, windows);
    assert.equal(burst.ok, false);
    assert.equal(burst.which, "minute");
    assert.ok(burst.retryAfter! >= 1 && burst.retryAfter! <= 60);
    giveBack("tok", t, windows);
    assert.ok(takeRequest("tok", t, windows).ok);
    // Another token is counted apart.
    assert.ok(takeRequest("other", t, windows).ok);
    // The day's total, over minutes.
    let used = API_RATE.perMinute;
    while (used < API_RATE.perDay) {
      t += 60;
      for (let i = 0; i < API_RATE.perMinute && used < API_RATE.perDay; i++, used++) assert.ok(takeRequest("tok", t, windows).ok);
    }
    t += 60;
    const day = takeRequest("tok", t, windows);
    assert.equal(day.which, "day");
    assert.equal(day.remaining, 0);
    const h = rateHeaders(peekRate("tok", t, windows));
    assert.equal(h["X-RateLimit-Limit"], String(API_RATE.perDay));
    assert.equal(h["X-RateLimit-Remaining"], "0");
    // The next UTC day starts again.
    assert.ok(takeRequest("tok", t + 86_400, windows).ok);
  });

  test("the owner's rate-limiting binding is asked when bound; its failure never shuts the API", async () => {
    assert.equal(await sharedLimit({} as ForgeServiceEnv, "k"), true);
    assert.equal(await sharedLimit({ API_LIMITER: { limit: async () => ({ success: false }) } } as ForgeServiceEnv, "k"), false);
    assert.equal(await sharedLimit({ API_LIMITER: { limit: async () => { throw new Error("down"); } } } as ForgeServiceEnv, "k"), true);
  });
});

describe("the site's routes", () => {
  test("make a token: answered once, only its SHA-256 kept, 3 rows; listed without it", async () => {
    const b = await signIn(w);
    w.forge.reset();
    const res = await make(b);
    const made = await body(res);
    assert.equal(res.status, 201, JSON.stringify(made));
    assert.ok(TOKEN_SHAPE.test(made.token));
    assert.equal(made.written, 3);
    assert.equal(w.forge.totals.written, 3);
    assert.deepEqual(made.scopes, ["repos:read", "statuses:write"]);
    const [row] = forgeRows(w.forge, "api_tokens");
    assert.equal(row.digest, sha(made.token));
    assert.ok(!JSON.stringify(forgeRows(w.forge, "api_tokens")).includes(made.token));
    assert.equal(row.expires_at, T0 + 30 * 86_400);
    const [action] = forgeRows(w.forge, "actions");
    assert.equal(action.kind, "token");
    assert.equal(action.subject, `token:${made.id}`);
    assert.equal(action.rows, 3);
    assert.deepEqual(w.forge.scans, []);
    // The list: no token, no digest, no account id.
    const list = await body(await b.fetch("/api/forge/tokens"));
    assert.equal(list.tokens.length, 1);
    const text = JSON.stringify(list);
    assert.ok(!text.includes(made.token) && !text.includes(row.digest as string) && !text.includes(await userId()));
    assert.equal(list.tokens[0].last_used, null);
    assert.equal(list.can.create, true);
    assert.equal(list.scopes.length, SCOPES.length);
  });

  test("Origin, CSRF, sign-in, FORGE_OPEN: a token is the owner's until phase 16", async () => {
    const b = await signIn(w);
    assert.equal((await b.post("/api/forge/tokens/write", { op: "create", name: "x", scopes: ["repos:read"] }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await b.post("/api/forge/tokens/write", { op: "create", name: "x", scopes: ["repos:read"] }, { csrf: "nope" })).status, 403);
    const anon = w.browser();
    assert.equal((await anon.fetch("/api/forge/tokens")).status, 401);
    // Bob is not the owner: refused, nothing written.
    const bob = await signIn(w, "bob-fixture");
    w.forge.reset();
    const refused = await make(bob);
    assert.equal(refused.status, 403);
    assert.equal((await body(refused)).error.code, "forge_closed");
    assert.equal(w.forge.totals.written, 0);
    assert.equal((await body(await bob.fetch("/api/forge/tokens"))).can.create, false);
  });

  test("revoke: at once, 3 rows, never refused by a cap; unknown ids said", async () => {
    const b = await signIn(w);
    const made = await body(await make(b));
    w.forge.reset();
    const res = await b.post("/api/forge/tokens/write", { op: "revoke", id: made.id });
    assert.equal(res.status, 200);
    assert.equal((await body(res)).written, 3);
    assert.equal(forgeRows(w.forge, "api_tokens").length, 0);
    assert.equal((await b.post("/api/forge/tokens/write", { op: "revoke", id: made.id })).status, 404);
    assert.equal((await b.post("/api/forge/tokens/write", { op: "revoke", id: "../x" })).status, 400);
    // A revoked token no longer opens anything.
    assert.equal(((await bearer(apiRequest(made.token), env(), w.clock.t, w.ctx)) as ForgeProblem).code, "bad_credentials");
  });

  test("caps: 20 tokens an account; 50 changes a day", async () => {
    const b = await signIn(w);
    const uid = await userId();
    for (let i = 0; i < TOKENS_PER_ACCOUNT; i++) assert.equal((await make(b, { name: `t${i}` })).status, 201);
    const over = await make(b);
    assert.equal(over.status, 409);
    assert.equal((await body(over)).error.code, "too_many_tokens");
    // The day's cap, from the action rows.
    const w2 = forgeWorld();
    const b2 = await signIn(w2);
    const uid2 = (w2.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github'").get() as { user_id: string }).user_id;
    for (let i = 0; i < PER_ACCOUNT_DAY.automation; i++) await seed.action(w2.forge, { userId: uid2, kind: "token" as never, t: T0 - 10 - i });
    const capped = await b2.post("/api/forge/tokens/write", { op: "create", name: "x", scopes: ["repos:read"] });
    assert.equal(capped.status, 429);
    assert.equal((await body(capped)).error.cap, "automation");
    w2.restore();
    assert.ok(uid);
  });
});

describe("a request that carries a token", () => {
  test("found by its digest: the person, the scopes, the expiry; its last use once a day", async () => {
    const b = await signIn(w);
    const made = await body(await make(b));
    w.forge.reset();
    const p = (await bearer(apiRequest(made.token), env(), w.clock.t, w.ctx)) as Principal;
    assert.ok(!isProblem(p) && p !== null);
    assert.equal(p.user.id, await userId());
    assert.deepEqual(p.token.scopes, ["repos:read", "statuses:write"]);
    assert.equal(p.token.id, made.id);
    assert.deepEqual(p.cookies, []);
    await Promise.all(w.ctx.waited);
    assert.equal(w.forge.totals.written, 1);
    assert.equal(forgeRows(w.forge, "api_tokens")[0].last_used_day, Math.floor(w.clock.t / 86_400));
    // The same day: nothing more written.
    w.forge.reset();
    w.ctx.waited.length = 0;
    await bearer(apiRequest(made.token), env(), w.clock.t + 60, w.ctx);
    await Promise.all(w.ctx.waited);
    assert.equal(w.forge.totals.written, 0);
    assert.equal((await body(await b.fetch("/api/forge/tokens"))).tokens[0].last_used, new Date(w.clock.t * 1000).toISOString().slice(0, 10));
    assert.deepEqual(w.forge.scans, []);
  });

  test("refused: none, malformed, unknown, expired, an account gone", async () => {
    const b = await signIn(w);
    const made = await body(await make(b, { days: 1 }));
    assert.equal(await bearer(apiRequest(null), env(), w.clock.t, w.ctx), null);
    assert.equal(((await bearer(apiRequest(null, "Bearer nope"), env(), w.clock.t, w.ctx)) as ForgeProblem).status, 401);
    assert.equal(((await bearer(apiRequest(`oscr_pat_${"z".repeat(43)}`), env(), w.clock.t, w.ctx)) as ForgeProblem).code, "bad_credentials");
    const expired = (await bearer(apiRequest(made.token), env(), w.clock.t + 86_400, w.ctx)) as ForgeProblem;
    assert.equal(expired.code, "token_expired");
    // The account deleted: its token opens nothing.
    const again = await body(await make(b, { name: "second" }));
    w.db.sqlite.prepare("DELETE FROM users").run();
    assert.equal(((await bearer(apiRequest(again.token), env(), w.clock.t, w.ctx)) as ForgeProblem).code, "bad_credentials");
  });
});
