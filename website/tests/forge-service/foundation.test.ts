// The forge service's foundation (night phase 01, worker/forge/service/): which paths are its own,
// the checks every route gets before its handler (method, FORGE, the accounts), the stubs, the gate
// (FORGE_OPEN), the daily caps counted from the rows, the answers in words (no token ever), OSCR's
// rows as statements (store.ts, as D1 bills them, never a scan), the registry of action kinds, and
// the Worker's bundle, which imports nothing from website/tests/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ORIGIN } from "../account/browser.ts";
import { GIT_ERROR_CODES, GitBackendError, STATUS } from "../../worker/forge/errors.ts";
import { ACTIONS, REGISTERED_IN, registry } from "../../worker/forge/service/actions.ts";
import { forgeBackend } from "../../worker/forge/service/backend.ts";
import { ACTION_PAYLOAD_BYTES, CAP_OF, FORGE_ROWS_PER_DAY, GRACE_SECONDS, PER_ACCOUNT_DAY, untilNextDay, utcDay, WEBHOOK_BYTES } from "../../worker/forge/service/caps.ts";
import { closed, CLOSED_MESSAGE, dailyCaps, globalCap, globalRowsToday, mayWrite, overCap } from "../../worker/forge/service/gate.ts";
import { failure, gitProblem, GIT_MESSAGES, problemAnswer, redact, safeUrl } from "../../worker/forge/service/http.ts";
import { FORGE_ROUTES, handleForge } from "../../worker/forge/service/index.ts";
import * as store from "../../worker/forge/service/store.ts";
import { ACTION_KINDS, ForgeProblem, isActionKind, JOB_KINDS, REPO_MODES, REPO_STATES, ROW_KINDS, type AnyActionSpec } from "../../worker/forge/service/types.ts";
import { WEBHOOK_MAX_BYTES } from "../../worker/forge/github/webhooks.ts";
import worker from "../../worker/index.ts";
import { FORGE_SCHEMA, fakeForgeD1, forgeCounts, forgeRows, type FakeForgeD1 } from "./d1.ts";
import { forgeWorld, seed, T0, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
const body = async (res: Response): Promise<Record<string, any>> => (await res.json()) as Record<string, unknown>;
const req = (path: string, init?: RequestInit) => new Request(new URL(path, ORIGIN), init);
const ROUTES = Object.keys(FORGE_ROUTES);
/** The routes whose element is not built yet: their stub answers 501 not_built. Each element that
 *  builds a route takes it out of this list (all built: E1 start and act, E3 the webhook, E6 the reads). */
const STUBS: ReadonlySet<string> = new Set<string>([]);

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld();
});
afterEach(() => w.restore());

describe("the routes", () => {
  test("the Worker hands /api/forge/* to the forge service, and nothing else", async () => {
    const ctx = { waitUntil() {} };
    // Each route of the service answers (a stub: 501; a built route: the service's own answer to a
    // bare request), with the headers of the Worker's personal answers.
    for (const path of ROUTES) {
      const route = FORGE_ROUTES[path];
      const init: RequestInit = route.method === "POST" ? { method: "POST", headers: { Origin: ORIGIN } } : {};
      const res = await worker.fetch(req(path, init), w.env, ctx);
      const own = (await handleForge(req(path, init), w.env, ctx)) as Response;
      assert.equal(res.status, own.status, path);
      assert.notEqual(res.status, 404, path);
      if (STUBS.has(path)) {
        assert.equal(res.status, 501, path);
        assert.equal((await body(res)).error.code, "not_built", path);
      }
      assert.equal(res.headers.get("Cache-Control"), "no-store", path);
      assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff", path);
      // With or without the final "/".
      assert.equal((await worker.fetch(req(`${path}/`, init), w.env, ctx)).status, res.status, `${path}/`);
    }
    // An unknown path under /api/forge/ is the service's own 404, not cached.
    const unknown = await worker.fetch(req("/api/forge/other"), w.env, ctx);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.get("Cache-Control"), "no-store");
    for (const path of ["/api/forge", "/api/forgery/start", "/api/forge-start", "/r/ada/eeg/", "/forge/authorized/"]) {
      assert.equal(await handleForge(req(path), w.env), null, path);
      if (path.startsWith("/api/")) assert.equal((await worker.fetch(req(path), w.env, ctx)).status, 404, path);
    }
    // The other routes are unchanged: the search (no database here), the accounts, the contributions.
    const search = await worker.fetch(req("/api/search?q=eeg"), w.env, ctx);
    assert.equal(search.status, 503);
    assert.equal((await body(search)).error.code, "not_configured");
    assert.equal((await body(await worker.fetch(req("/api/account/me"), w.env, ctx))).signed_in, false);
    assert.equal((await worker.fetch(req("/api/contributions"), w.env, ctx)).status, 401);
    for (const path of ["/api/search", "/api/account/me", "/api/contributions", "/api/submissions"]) {
      assert.equal(await handleForge(req(path), w.env), null, path);
    }
  });

  test("each route takes its own method, and says which (405)", async () => {
    for (const [path, route] of Object.entries(FORGE_ROUTES)) {
      const wrong = route.method === "POST" ? ["GET", "PUT", "DELETE", "HEAD"] : ["POST", "PUT", "PATCH", "DELETE"];
      for (const method of wrong) {
        const res = (await handleForge(req(path, { method }), w.env, w.ctx, w.deps)) as Response;
        assert.equal(res.status, 405, `${method} ${path}`);
        assert.equal(res.headers.get("Allow"), route.method === "GET" ? "GET, HEAD" : "POST", path);
        if (method !== "HEAD") assert.equal((await body(res)).error.code, "method_not_allowed");
      }
    }
    // HEAD reads like GET.
    for (const path of ["/api/forge/repo", "/api/forge/mine"]) {
      const head = (await handleForge(req(path, { method: "HEAD" }), w.env, w.ctx, w.deps)) as Response;
      const get = (await handleForge(req(path), w.env, w.ctx, w.deps)) as Response;
      assert.notEqual(head.status, 405, path);
      assert.equal(head.status, get.status, path);
    }
  });

  test("not set up: 503 not_configured without FORGE, and without the accounts for the signed-in routes", async () => {
    const say = async (env: object, path: string) => {
      const route = FORGE_ROUTES[path];
      const res = (await handleForge(req(path, { method: route.method }), env, w.ctx, w.deps)) as Response;
      return { status: res.status, code: (await body(res)).error.code as string };
    };
    for (const path of ROUTES) {
      assert.deepEqual(await say({ ...w.env, FORGE: undefined }, path), { status: 503, code: "not_configured" }, path);
      const signedIn = FORGE_ROUTES[path].signedIn;
      for (const env of [{ ...w.env, SESSION_KEY: undefined }, { ...w.env, SESSION_KEY: "too short" }, { ...w.env, COMMUNITY: undefined }]) {
        // The webhook needs no account: GitHub is not signed in (its answer is the one with them).
        assert.deepEqual(await say(env, path), signedIn ? { status: 503, code: "not_configured" } : await say(w.env, path), path);
      }
    }
    assert.ok(Object.values(forgeCounts(w.forge)).every((n) => n === 0));
  });

  test("the stubs answer 501 not_built until their elements are built, and write nothing", async () => {
    const b = w.browser();
    await b.signIn("github");
    for (const path of STUBS) {
      const route = FORGE_ROUTES[path];
      const res = route.method === "POST" ? await b.post(path, { kind: "edit" }) : await b.fetch(path);
      assert.equal(res.status, 501, path);
      const e = (await body(res)).error;
      assert.equal(e.code, "not_built");
      assert.match(e.message, /not built yet/);
    }
    assert.equal(w.forge.totals.written, 0);
  });

  test("the world: a GitHub sign-in and the double's GitHub are the same person", async () => {
    const b = w.browser();
    await b.signIn("github");
    const me = await b.me();
    assert.equal(me.signed_in, true);
    const github = w.db.sqlite.prepare("SELECT subject FROM identities WHERE provider = 'github'").get() as { subject: string };
    assert.equal(github.subject, w.ada.user.id);
    assert.equal(w.env.FORGE_OWNER_GITHUB_ID, w.ada.user.id);
    assert.ok(mayWrite(w.env, github.subject));
    // The double runs on the world's clock.
    assert.equal(w.backend.now(), T0);
    w.advance(60);
    assert.equal(w.backend.now(), T0 + 60);
  });

  test("the database failing: D1's quota said apart, in words", async () => {
    const quota = failure(new Error("D1_ERROR: Your account has exceeded D1's free tier daily row written limit."), "/api/forge/act", T0);
    assert.equal(quota.status, 503);
    assert.equal((await body(quota)).error.code, "quota");
    assert.equal(quota.headers.get("Retry-After"), String(untilNextDay(T0)));
    const other = failure(new Error("D1_ERROR: D1 DB is overloaded."), "/api/forge/act");
    assert.equal((await body(other)).error.code, "unavailable");
    const refused = failure(new ForgeProblem(409, "identity_conflict", "This GitHub account is linked to another account."), "/api/forge/act");
    assert.equal(refused.status, 409);
    assert.equal((await body(refused)).error.code, "identity_conflict");
  });

  test("development metrics: D1's figures of both databases, only when asked", async () => {
    const res = (await handleForge(req("/api/forge/mine"), { ...w.env, ACCOUNT_DEV_METRICS: "1" }, w.ctx, w.deps)) as Response;
    assert.equal(res.headers.get("X-D1-Forge-Rows-Written"), "0");
    assert.equal(res.headers.get("X-D1-Forge-Queries"), "0");
    const plain = (await handleForge(req("/api/forge/mine"), w.env, w.ctx, w.deps)) as Response;
    assert.equal(plain.headers.get("X-D1-Forge-Rows-Written"), null);
  });
});

describe("the gate", () => {
  test("FORGE_OPEN: closed by default, the owner only with FORGE_OWNER_GITHUB_ID, everyone with FORGE_OPEN=true", () => {
    for (const id of ["1", "4242001", null, undefined, ""]) assert.equal(mayWrite({}, id), false, String(id));
    const owner = { FORGE_OWNER_GITHUB_ID: "4242001" };
    assert.equal(mayWrite(owner, "4242001"), true);
    assert.equal(mayWrite(owner, 4_242_001), true);
    assert.equal(mayWrite(owner, "4242002"), false);
    assert.equal(mayWrite(owner, null), false);
    assert.equal(mayWrite({ FORGE_OWNER_GITHUB_ID: " 4242001 " }, "4242001"), true);
    // An owner id that is not a number closes the gate to everyone.
    for (const bad of ["", "ada-fixture", "42 42", "*"]) assert.equal(mayWrite({ FORGE_OWNER_GITHUB_ID: bad }, bad), false, bad);
    for (const open of ["true", " true "]) assert.equal(mayWrite({ FORGE_OPEN: open }, "7"), true, open);
    for (const notOpen of ["1", "TRUE", "yes", "false", ""]) assert.equal(mayWrite({ FORGE_OPEN: notOpen }, "7"), false, notOpen);
    assert.equal(mayWrite({ FORGE_OPEN: "false", FORGE_OWNER_GITHUB_ID: "7" }, "7"), true);
    const p = closed();
    assert.equal(p.status, 403);
    assert.equal(p.code, "forge_closed");
    assert.match(p.message, /^The GitHub side opens to the public with its content rules/);
    assert.equal(p.message, CLOSED_MESSAGE);
  });

  test("the daily caps: an account's last 24 hours, counted from its rows, and nothing written", async () => {
    const t = T0; // 12:00 UTC
    const db = w.forge;
    // Ada: 9 creations and 19 links within 24 hours (some yesterday), plus older ones that no longer count.
    for (let i = 0; i < 5; i++) await seed.action(db, { userId: "u_ada", kind: "create", t: t - 3_600 * i });
    for (let i = 0; i < 4; i++) await seed.action(db, { userId: "u_ada", kind: "generate", t: t - 86_400 + 60 + i });
    for (let i = 0; i < 19; i++) await seed.action(db, { userId: "u_ada", kind: "link", t: t - 10_000 - i });
    for (let i = 0; i < 30; i++) await seed.action(db, { userId: "u_ada", kind: "create", t: t - 86_400 - 1 - i });
    await seed.action(db, { userId: "u_ben", kind: "create", t });
    db.reset();
    let caps = await dailyCaps(db, "u_ada", "create", t);
    assert.deepEqual(caps.used, { actions: 28, creations: 9, links: 19, research: 0, social: 0, notices: 0, automation: 0, statuses: 0 });
    assert.equal(caps.exceeded, null);
    assert.deepEqual(caps.limits, PER_ACCOUNT_DAY);
    await seed.action(db, { userId: "u_ada", kind: "create", t: t + 1 });
    await seed.action(db, { userId: "u_ada", kind: "link", t: t + 2 });
    db.reset();
    caps = await dailyCaps(db, "u_ada", "generate", t + 3);
    assert.deepEqual(caps.exceeded, { cap: "creations", limit: 10, used: 10 });
    assert.deepEqual((await dailyCaps(db, "u_ada", "link", t + 3)).exceeded, { cap: "links", limit: 20, used: 20 });
    // Another kind is still allowed; Ben has his own count.
    assert.equal((await dailyCaps(db, "u_ada", "edit", t + 3)).exceeded, null);
    assert.deepEqual((await dailyCaps(db, "u_ben", "create", t + 3)).used, { actions: 1, creations: 1, links: 0, research: 0, social: 0, notices: 0, automation: 0, statuses: 0 });
    // The next day, the window has moved on.
    assert.equal((await dailyCaps(db, "u_ada", "create", t + 86_400)).exceeded, null);
    assert.equal(db.totals.written, 0);
    assert.deepEqual(db.scans, []);
    // 100 actions of any kind.
    // (The 4 generations of yesterday have left the window by then: 26 + 74 = 100.)
    for (let i = 0; i < 74; i++) await seed.action(db, { userId: "u_ada", kind: "edit", t: t + 10 + i });
    db.reset();
    assert.deepEqual((await dailyCaps(db, "u_ada", "rename", t + 100)).exceeded, { cap: "actions", limit: 100, used: 100 });
    const p = overCap({ cap: "creations", limit: 10, used: 10 });
    assert.equal(p.status, 429);
    assert.equal(p.code, "too_many");
    assert.match(p.message, /10 repositories created in the last 24 hours/);
    assert.equal(db.totals.written, 0);
  });

  test("the global cap: today's rows of every account and every webhook, from the rows, nothing written", async () => {
    const db = w.forge;
    const t = T0;
    await seed.action(db, { userId: "u_ada", kind: "create", t, rows: 6 });
    await seed.action(db, { userId: "u_ben", kind: "link", t: t - 3_600, rows: 5 });
    await seed.action(db, { userId: "u_ada", kind: "edit", t: t - 86_400, rows: 400 }); // yesterday
    await seed.delivery(db, { delivery: "d-1", t, rows: 2 });
    await seed.delivery(db, { delivery: "d-2", t: t - 60, rows: 1 });
    await seed.delivery(db, { delivery: "d-0", t: t - 86_400, rows: 2 }); // yesterday
    db.reset();
    assert.equal(await globalRowsToday(db, t), 14);
    assert.equal(await globalRowsToday(db, t + 86_400), 0);
    assert.equal(await globalCap(db, t, 10), null);
    for (let i = 0; i < 5; i++) await seed.action(db, { userId: "u_ada", kind: "edit", t: t + i, rows: (FORGE_ROWS_PER_DAY - 20) / 5 });
    db.reset();
    assert.equal(await globalCap(db, t, 6), null);
    const over = await globalCap(db, t, 7);
    assert.ok(over);
    assert.equal(over.status, 503);
    assert.equal(over.code, "quota");
    assert.equal(over.extra.retryAfter, untilNextDay(t));
    assert.equal(db.totals.written, 0);
    assert.deepEqual(db.scans, []);
  });

  test("the caps' numbers are the design's", () => {
    assert.equal(ACTION_PAYLOAD_BYTES, 1_048_576);
    assert.equal(WEBHOOK_BYTES, WEBHOOK_MAX_BYTES);
    assert.equal(FORGE_ROWS_PER_DAY, 5_000);
    assert.deepEqual(PER_ACCOUNT_DAY, { actions: 100, creations: 10, links: 20, research: 20, social: 300, notices: 500, automation: 50, statuses: 300 });
    assert.equal(GRACE_SECONDS, 30 * 86_400);
    assert.deepEqual(CAP_OF, { create: "creations", generate: "creations", link: "links", research_open: "research", star: "social", star_list: "social", follow: "social", profile: "social", notice: "notices", token: "automation", hook: "automation", status: "statuses" });
    assert.equal(utcDay(T0), 20_724);
    assert.equal(untilNextDay(T0), 43_200);
  });
});

describe("the answers", () => {
  const TOKENS = ["ghu_16C7e42F292c6912E7710c838347Ae178B4a", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "memtok_3_1001_k23757", "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.c2lnbmF0dXJl"];

  test("every GitBackendError code has its status and its sentence, and never a token", async () => {
    for (const code of GIT_ERROR_CODES) {
      const secret = TOKENS[GIT_ERROR_CODES.indexOf(code) % TOKENS.length];
      const e = new GitBackendError(code, `request with Bearer ${secret} failed: ${secret}`, {
        retryAfter: code === "rate_limited" ? 120 : undefined,
        fallbackUrl: code === "unsupported" ? "https://github.com/ada/eeg/blame/main/a.py" : undefined,
      });
      const res = problemAnswer(gitProblem(e));
      assert.equal(res.status, STATUS[code], code);
      const text = await res.text();
      for (const t of TOKENS) assert.ok(!text.includes(t), `${code}: ${t}`);
      assert.ok(!/Bearer (?!\[…\])/.test(text), code);
      const error = JSON.parse(text).error;
      assert.equal(error.code, code);
      assert.ok(error.message.length > 10, code);
      assert.equal(res.headers.get("Cache-Control"), "no-store", code);
      if (code !== "invalid" && code !== "rate_limited") assert.equal(error.message, GIT_MESSAGES[code], code);
    }
    const limited = problemAnswer(gitProblem(new GitBackendError("rate_limited", "quota", { retryAfter: 120 })));
    assert.equal(limited.headers.get("Retry-After"), "120");
    assert.match((await body(limited)).error.message, /about 2 minutes/);
    const unsupported = await body(problemAnswer(gitProblem(new GitBackendError("unsupported", "no blame", { fallbackUrl: "https://github.com/ada/eeg/blame/main/a.py" }))));
    assert.equal(unsupported.error.fallbackUrl, "https://github.com/ada/eeg/blame/main/a.py");
    assert.equal((await body(problemAnswer(gitProblem(new GitBackendError("conflict", "moved"))))).error.offer, "new_branch");
    // A wrong request keeps its detail, redacted.
    const invalid = await body(problemAnswer(gitProblem(new GitBackendError("invalid", `not a branch name ${TOKENS[0]}`))));
    assert.match(invalid.error.message, /not a branch name/);
    assert.ok(!JSON.stringify(invalid).includes(TOKENS[0]));
    // A forge page with a code, a state or a token in it never goes to the page.
    for (const url of ["https://github.com/login/oauth/authorize?code=abc", "https://github.com/x?state=s", "javascript:alert(1)", "https://u:p@github.com/", `https://github.com/${TOKENS[0]}`]) {
      assert.equal(safeUrl(url), false, url);
      const r = await body(problemAnswer(gitProblem(new GitBackendError("unsupported", "x", { fallbackUrl: url }))));
      assert.equal(r.error.fallbackUrl, undefined, url);
    }
    assert.equal(safeUrl("http://localhost:8788/ada/eeg"), true);
  });

  test("redact: GitHub's token prefixes, bearer headers, JWTs, codes in queries, long secrets", () => {
    for (const t of TOKENS) assert.ok(!redact(`x ${t} y`).includes(t), t);
    assert.equal(redact("Authorization: Bearer abc.def"), "Authorization: Bearer […]");
    assert.equal(redact("GET /cb?code=123abc&state=xyz&x=1"), "GET /cb?code=[…]&state=[…]&x=1");
    assert.equal(redact("not a repository name"), "not a repository name");
  });

  test("a failure is logged redacted", async () => {
    const logged: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      failure(new Error(`exchange failed for ${TOKENS[0]}`), "/api/forge/act");
      failure(new GitBackendError("unauthorized", `token ${TOKENS[2]} refused`), "/api/forge/act");
    } finally {
      console.error = real;
    }
    assert.equal(logged.length, 2);
    for (const line of logged) for (const t of TOKENS) assert.ok(!line.includes(t), line);
  });
});

describe("the rows (store.ts)", () => {
  let db: FakeForgeD1;
  beforeEach(() => {
    db = fakeForgeD1();
  });
  const write = async (...writes: { stmt: unknown; rows: number }[]) => {
    const before = db.totals.written;
    await db.batch(writes.map((x) => x.stmt as never));
    return db.totals.written - before;
  };

  test("the migration loads, and its CHECKs list the kinds, modes and states of types.ts", () => {
    assert.ok(FORGE_SCHEMA.includes("CREATE TABLE repos"));
    const between = (from: string, to: string) => FORGE_SCHEMA.slice(FORGE_SCHEMA.indexOf(from), FORGE_SCHEMA.indexOf(to, FORGE_SCHEMA.indexOf(from)));
    const listed = (text: string) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    // The kinds as the migrations leave them (0002 rebuilt `actions` with phase 03's commit).
    const actions = (db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'actions'").get() as { sql: string }).sql;
    const kinds = actions.slice(actions.indexOf("kind         TEXT NOT NULL CHECK (kind IN ("), actions.indexOf("))", actions.indexOf("CHECK (kind IN (")));
    assert.deepEqual(listed(kinds), [...ROW_KINDS]);
    assert.ok(/WITHOUT ROWID/.test(actions));
    // The job kinds as the migrations leave them (0006 rebuilt `jobs` with phase 07's release and deposit).
    const jobs = (db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get() as { sql: string }).sql;
    assert.deepEqual(listed(jobs.slice(jobs.indexOf("kind        TEXT NOT NULL CHECK (kind IN ("), jobs.indexOf("))", jobs.indexOf("CHECK (kind IN (")))), [...JOB_KINDS]);
    assert.deepEqual(listed(between("mode             TEXT NOT NULL", "),")), [...REPO_MODES]);
    assert.deepEqual(listed(between("CHECK (state IN (", "))")), [...REPO_STATES]);
    const indexes = db.sqlite.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as { name: string }[];
    // Phase 10: a person's tokens, and the hooks of a subject (0009_automation.sql).
    assert.deepEqual(indexes.map((i) => i.name).sort(), ["api_tokens_user", "hooks_subject", "repos_path", "research_paper"]);
  });

  test("a repository: inserted with its index (2 rows), found by key and by path in any case", async () => {
    const insert = store.insertRepo(db, { forge: "github", repoId: "101", ownerId: "7", ownerLogin: "Ada-Fixture", name: "EEG", mode: "created", installationId: "55", linkedBy: "u_ada", template: true }, T0);
    assert.equal(insert.rows, 2);
    assert.equal(await write(insert), 2);
    const byKey = await store.first<Record<string, unknown>>(store.repoByKey(db, "github", "101"));
    assert.equal(byKey?.owner_login, "ada-fixture");
    assert.equal(byKey?.name, "eeg");
    assert.equal(byKey?.template, 1);
    assert.equal(byKey?.state, "active");
    assert.equal((await store.first<{ repo_id: string }>(store.repoByPath(db, "github", "ADA-FIXTURE", "Eeg")))?.repo_id, "101");
    assert.equal(await store.first(store.repoByPath(db, "memory", "ada-fixture", "eeg")), null);
    // A second insert of the same id is refused by the key.
    await assert.rejects(write(store.insertRepo(db, { forge: "github", repoId: "101", ownerId: "7", ownerLogin: "x", name: "y", mode: "public", linkedBy: "u" }, T0)));
    // A public repository never keeps an installation; an installed one must have one.
    await write(store.insertRepo(db, { forge: "github", repoId: "102", ownerId: "7", ownerLogin: "ada", name: "p", mode: "public", installationId: "55", linkedBy: "u" }, T0));
    assert.equal((await store.first<{ installation_id: string | null }>(store.repoByKey(db, "github", "102")))?.installation_id, null);
    await assert.rejects(write(store.insertRepo(db, { forge: "github", repoId: "103", ownerId: "7", ownerLogin: "ada", name: "i", mode: "installed", linkedBy: "u" }, T0)));
    // No email address in a name, no forge the database does not know.
    await assert.rejects(write(store.insertRepo(db, { forge: "github", repoId: "104", ownerId: "7", ownerLogin: "a@b.org", name: "n", mode: "public", linkedBy: "u" }, T0)));
    assert.throws(() => store.insertRepo(db, { forge: "gitlab", repoId: "1", ownerId: "7", ownerLogin: "a", name: "n", mode: "public", linkedBy: "u" }, T0));
    assert.deepEqual(db.scans, []);
  });

  test("a repository's changes: 1 row, 2 when its path moves; guarded updates write nothing when stale", async () => {
    await write(store.insertRepo(db, { forge: "github", repoId: "101", ownerId: "7", ownerLogin: "ada", name: "eeg", mode: "public", linkedBy: "u_ada", headAt: T0 }, T0));
    const head = store.updateRepo(db, "github", "101", { head: "a".repeat(40), headAt: T0 + 10 }, T0 + 10);
    assert.equal(head.rows, 1);
    assert.equal(await write(head), 1);
    // Older news: nothing.
    assert.equal(await write(store.updateRepo(db, "github", "101", { head: "b".repeat(40), headAt: T0 + 5 }, T0 + 20, { headAtBelow: T0 + 5 })), 0);
    assert.equal((await store.first<{ head: string }>(store.repoByKey(db, "github", "101")))?.head, "a".repeat(40));
    const rename = store.updateRepo(db, "github", "101", { ownerLogin: "Lab", name: "EEG-2" }, T0 + 30);
    assert.equal(rename.rows, 2);
    assert.equal(await write(rename), 2);
    assert.equal(await store.first(store.repoByPath(db, "github", "ada", "eeg")), null);
    assert.equal((await store.first<{ repo_id: string }>(store.repoByPath(db, "github", "lab", "eeg-2")))?.repo_id, "101");
    // A restore only from pending_deletion.
    assert.equal(await write(store.updateRepo(db, "github", "101", { state: "active" }, T0, { states: ["pending_deletion"] })), 0);
    await assert.rejects(write(store.updateRepo(db, "github", "101", { state: "pending_deletion" }, T0)), /CHECK/);
    await write(store.updateRepo(db, "github", "101", { state: "pending_deletion", deleteAfter: T0 + GRACE_SECONDS }, T0));
    assert.equal(await write(store.updateRepo(db, "github", "101", { state: "active", deleteAfter: null }, T0, { states: ["pending_deletion"] })), 1);
    // Hidden (made private on GitHub): the path is blanked, and nothing finds it by path.
    await write(store.updateRepo(db, "github", "101", { state: "hidden", ownerLogin: "", name: "" }, T0));
    assert.equal(await store.first(store.repoByPath(db, "github", "", "")), null);
    // A path cannot be blanked while the repository is shown.
    await write(store.insertRepo(db, { forge: "github", repoId: "105", ownerId: "7", ownerLogin: "ada", name: "x", mode: "public", linkedBy: "u" }, T0));
    await assert.rejects(write(store.updateRepo(db, "github", "105", { name: "" }, T0)), /CHECK/);
    assert.throws(() => store.updateRepo(db, "github", "101", {}, T0));
    assert.deepEqual(db.scans, []);
  });

  test("an account's repositories: the index's prefix, by name, filtered, never the hidden ones", async () => {
    await seed.repo(db, { forge: "github", repoId: "1", ownerLogin: "ada", name: "b-repo", mode: "created", installationId: "5" });
    await seed.repo(db, { forge: "github", repoId: "2", ownerLogin: "ada", name: "a-repo", template: true });
    await seed.repo(db, { forge: "github", repoId: "3", ownerLogin: "ada", name: "c-repo" }, T0, { state: "pending_deletion", deleteAfter: T0 + GRACE_SECONDS });
    await seed.repo(db, { forge: "github", repoId: "4", ownerLogin: "ben", name: "a-repo" });
    await seed.repo(db, { forge: "github", repoId: "6", ownerLogin: "ada", name: "gone" }, T0, { state: "hidden" });
    db.reset();
    const names = async (o: Parameters<typeof store.reposOfOwner>[3] = {}) => (await store.all<{ name: string }>(store.reposOfOwner(db, "github", "Ada", o))).map((r) => r.name);
    assert.deepEqual(await names(), ["a-repo", "b-repo", "c-repo"]);
    assert.deepEqual(await names({ limit: 2 }), ["a-repo", "b-repo"]);
    assert.deepEqual(await names({ after: "b-repo" }), ["c-repo"]);
    assert.deepEqual(await names({ mode: "created" }), ["b-repo"]);
    assert.deepEqual(await names({ template: true }), ["a-repo"]);
    assert.deepEqual(db.scans, []);
    // "gone" is hidden: never listed, never found by its path.
    assert.equal(forgeRows(db, "repos").find((r) => r.repo_id === "6")?.state, "hidden");
    assert.equal(await store.first(store.repoByPath(db, "github", "ada", "gone")), null);
  });

  test("papers: attached (1 row each), attached again as linked, detached; DOIs only, lower case", async () => {
    await seed.repo(db, { forge: "github", repoId: "1", ownerLogin: "ada", name: "eeg" });
    const writes = store.linkPapers(db, "github", "1", [{ paperId: "doi:10.5555/OSCR.fixture.1", status: "proposed" }, { paperId: "doi:10.5555/oscr.fixture.3", status: "linked" }], "u_ben", T0);
    assert.equal(await write(...writes), 2);
    assert.equal(await write(...store.linkPapers(db, "github", "1", [{ paperId: "doi:10.5555/oscr.fixture.1", status: "linked" }], "u_ada", T0 + 1)), 1);
    const papers = await store.all<{ paper_id: string; status: string; by_user: string }>(store.papersOf(db, "github", "1"));
    assert.deepEqual(papers.map((p) => [p.paper_id, p.status, p.by_user]), [
      ["doi:10.5555/oscr.fixture.1", "linked", "u_ada"],
      ["doi:10.5555/oscr.fixture.3", "linked", "u_ben"],
    ]);
    assert.equal(await write(store.unlinkPaper(db, "github", "1", "doi:10.5555/oscr.fixture.3")), 1);
    await assert.rejects(write(...store.linkPapers(db, "github", "1", [{ paperId: "pmcid:PMC1", status: "linked" }], "u", T0)), /CHECK/);
    assert.deepEqual(db.scans, []);
  });

  test("traced paths: how many maps and paths point to a repository", async () => {
    const add = db.sqlite.prepare("INSERT INTO traced_paths (forge, repo_id, path, paper_id, commit_sha, ranges) VALUES ('github', '1', ?, ?, ?, 2)");
    add.run("a.py", "doi:10.5555/oscr.fixture.1", "c".repeat(40));
    add.run("b.py", "doi:10.5555/oscr.fixture.1", "c".repeat(40));
    add.run("a.py", "doi:10.5555/oscr.fixture.3", "d".repeat(40));
    assert.deepEqual(await store.first(store.tracedCount(db, "github", "1")), { paths: 3, maps: 2 });
    assert.deepEqual(await store.first(store.tracedCount(db, "github", "2")), { paths: 0, maps: 0 });
    assert.deepEqual(db.scans, []);
  });

  test("the logs: one row each; a redelivery seen for three days; jobs in order, the pending ones from the tail", async () => {
    const nonce = store.newNonce();
    assert.match(nonce, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(await write(store.actionRow(db, { userId: "u_ada", t: T0, nonce, kind: "create", forge: "github", repoId: "1", githubUser: "4242001", outcome: "done", rows: 6 })), 1);
    const [row] = forgeRows(db, "actions");
    assert.deepEqual(row, { day: utcDay(T0), user_id: "u_ada", at: T0, nonce, kind: "create", forge: "github", repo_id: "1", github_user: "4242001", outcome: "done", rows: 6, subject: "" });
    await assert.rejects(write(store.actionRow(db, { userId: "u_ada", t: T0, nonce: store.newNonce(), kind: "delete" as never, outcome: "done", rows: 1 })), /CHECK/);
    await assert.rejects(write(store.actionRow(db, { userId: "u_ada", t: T0, nonce: store.newNonce(), kind: "edit", githubUser: "ada-fixture", outcome: "done", rows: 1 })), /CHECK/);
    assert.equal(await write(store.deliveryRow(db, { delivery: "72d3162e-cc78-11e3-81ab-4c9367dc0958", t: T0, event: "push", rows: 2 })), 1);
    for (const [dt, seen] of [[0, true], [86_400, true], [3 * 86_400, true], [4 * 86_400, false]] as const) {
      const r = await store.first(store.deliverySeen(db, "72d3162e-cc78-11e3-81ab-4c9367dc0958", T0 + dt));
      assert.equal(r !== null, seen, String(dt));
    }
    assert.equal(await store.first(store.deliverySeen(db, "another", T0)), null);
    assert.equal(await write(store.insertJob(db, { kind: "link", forge: "github", repoId: "1", userId: "u_ada" }, T0)), 1);
    await write(store.insertJob(db, { kind: "delete_due", forge: "github", repoId: "1", notBefore: T0 + GRACE_SECONDS }, T0));
    await write(store.insertJob(db, { kind: "push", forge: "github", repoId: "2", ref: "main" }, T0));
    assert.throws(() => store.insertJob(db, { kind: "delete_due", forge: "github", repoId: "1" }, T0));
    db.sqlite.prepare("UPDATE jobs SET done_at = ?, outcome = 'done' WHERE id = 1").run(T0 + 60);
    const pending = await store.all<{ id: number; kind: string }>(store.pendingJobsOf(db, "github", "1"));
    assert.deepEqual(pending.map((j) => [j.id, j.kind]), [[2, "delete_due"]]);
    // The Mac's answer carries no email address.
    assert.throws(() => db.sqlite.prepare("UPDATE jobs SET done_at = 1, outcome = 'failed', message = 'write to a@b.org' WHERE id = 3").run(), /CHECK/);
    assert.deepEqual(db.scans, []);
  });

  test("installations: as the latest webhook says (1 row), removed (1 row)", async () => {
    const inst = { forge: "github", id: "55", accountId: "7", accountLogin: "Ada-Fixture", accountType: "user" as const, selection: "selected" as const, suspended: false };
    assert.equal(await write(store.upsertInstallation(db, inst, T0)), 1);
    assert.equal(await write(store.upsertInstallation(db, { ...inst, suspended: true, selection: "all" }, T0 + 1)), 1);
    assert.deepEqual(await store.first(store.installationById(db, "github", "55")), {
      forge: "github", id: "55", account_id: "7", account_login: "ada-fixture", account_type: "user", selection: "all", suspended: 1, updated_at: T0 + 1,
    });
    assert.equal(await write(store.deleteInstallation(db, "github", "55")), 1);
    assert.equal(await store.first(store.installationById(db, "github", "55")), null);
    assert.deepEqual(db.scans, []);
  });

  test("the fake D1 notices a scan", async () => {
    await db.prepare("SELECT * FROM repos WHERE linked_by = ?").bind("u").all();
    assert.equal(db.scans.length, 1);
    assert.match(db.scans[0], /^SCAN repos/);
  });
});

describe("the registry and the backend", () => {
  test("every kind has its file; the registry refuses an unknown or a duplicate kind", () => {
    assert.deepEqual(Object.keys(REGISTERED_IN).sort(), [...ACTION_KINDS].sort());
    for (const [kind] of ACTIONS) assert.ok(isActionKind(kind), kind);
    const fake = (kind: string): AnyActionSpec => ({
      kind: kind as never,
      needsRepo: false,
      validate: (p) => p,
      describe: () => "a test",
      perform: async () => ({ result: null, writes: [] }),
      check: () => true,
    });
    assert.equal(registry([fake("edit"), fake("topics")]).size, 2);
    assert.throws(() => registry([fake("edit"), fake("edit")]), /twice/);
    assert.throws(() => registry([fake("push")]), /not an action kind/);
  });

  test("the backend: the injected double, or GitHub's built from the environment, asked nothing until used", () => {
    assert.equal(forgeBackend(w.env, { backend: w.backend }), w.backend);
    let calls = 0;
    const github = forgeBackend({}, { fetch: (async () => {
      calls += 1;
      return new Response("{}");
    }) as typeof fetch });
    assert.equal(github.forge, "github");
    assert.equal(github.links.clone({ forge: "github", owner: "ada", name: "eeg" }), "https://github.com/ada/eeg.git");
    assert.equal(calls, 0);
    // Development mocks: https, or http on this machine only.
    assert.equal(forgeBackend({ FORGE_GITHUB_WEB_URL: "http://localhost:8790" }).links.repo({ forge: "github", owner: "a", name: "b" }), "http://localhost:8790/a/b");
    assert.throws(() => forgeBackend({ FORGE_GITHUB_API_URL: "http://example.org" }), GitBackendError);
  });

  test("the Worker's bundle imports nothing from website/tests/", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const tests = resolve(here, "..");
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"|(?:^|\n)\s*import\s+"(\.[^"]+)"/g)) {
        const spec = m[1] ?? m[2];
        const target = resolve(dirname(file), spec);
        assert.ok(!target.startsWith(tests + "/"), `${file} imports ${spec}`);
        if (target.endsWith(".ts")) visit(target);
      }
    };
    visit(resolve(here, "../../worker/index.ts"));
    assert.ok([...seen].some((f) => f.endsWith("/forge/service/index.ts")));
    assert.ok([...seen].some((f) => f.endsWith("/forge/github/index.ts")));
    assert.ok(seen.size > 30);
  });
});
