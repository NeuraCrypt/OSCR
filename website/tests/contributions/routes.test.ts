// The contributions' routes (worker/contributions/index.ts): which paths are theirs, what a signed-out
// reader gets, and the guards every write goes through, the session, its CSRF token, the site's
// Origin, as the accounts' own.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ORIGIN } from "../account/browser.ts";
import { rows } from "../account/d1.ts";
import { handleContributions } from "../../worker/contributions/index.ts";
import worker from "../../worker/index.ts";
import { ada, body, contributions, DIGEST, P1, removal, type Contributions } from "./world.ts";

let w: Contributions;
beforeEach(() => {
  w = contributions();
});
afterEach(() => w.restore());

const req = (path: string, init?: RequestInit) => new Request(new URL(path, ORIGIN), init);
const WRITES = ["/api/submissions", "/api/claims", "/api/edits", "/api/validations", "/api/reports", "/api/submissions/1/revise", "/api/submissions/1/publish"];

test("the contributions answer for their paths only", async () => {
  for (const path of ["/", "/api/search", "/api/account/me", "/api/submission", "/api/claimsx", "/paper/x/"]) {
    assert.equal(await handleContributions(req(path), w.env), null, path);
  }
  const ctx = { waitUntil() {} };
  for (const path of ["/api/contributions", "/api/contributions/paper?id=doi:10.5555/oscr.fixture.1", ...WRITES]) {
    const res = await worker.fetch(req(path), w.env, ctx);
    assert.notEqual(res.status, 404, path);
    assert.equal(res.headers.get("Cache-Control"), "no-store", path);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff", path);
  }
  for (const path of ["/api/contributions/other", "/api/submissions/x/publish", "/api/submissions/1/delete"]) {
    const res = await worker.fetch(req(path), w.env, ctx);
    assert.equal(res.status, 404, path);
  }
});

test("reads are GET, writes are POST", async () => {
  for (const path of WRITES) {
    assert.equal((await handleContributions(req(path), w.env))?.status, 405, path);
  }
  assert.equal((await handleContributions(req("/api/contributions", { method: "POST", headers: { Origin: ORIGIN } }), w.env))?.status, 405);
});

test("signed out: the paper's page learns it, the writes are refused, and nothing is written", async () => {
  const state = await body((await handleContributions(req(`/api/contributions/paper?id=${P1}`), w.env)) as Response);
  assert.deepEqual(state, { signed_in: false, available: true });
  assert.equal((await handleContributions(req("/api/contributions"), w.env))?.status, 401);
  for (const path of WRITES) {
    const res = (await handleContributions(req(path, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" }), w.env)) as Response;
    assert.equal(res.status, 401, path);
    assert.equal((await body(res)).error.code, "signed_out", path);
  }
  assert.equal(rows(w.db, "jobs").length, 0);
});

test("not set up: the page says so, the writes wait", async () => {
  const bare = { ...w.env, COMMUNITY: undefined };
  assert.deepEqual(await body((await handleContributions(req(`/api/contributions/paper?id=${P1}`), bare)) as Response), { signed_in: false, available: false });
  const res = (await handleContributions(req("/api/reports", { method: "POST", headers: { Origin: ORIGIN } }), bare)) as Response;
  assert.equal(res.status, 503);
  assert.equal((await body(res)).error.code, "not_configured");
});

test("a paper's id has the registry's shape", async () => {
  const b = await ada(w);
  for (const id of ["", "x", "doi:10.5555/UPPER", "https://doi.org/10.1/x", "doi:10.1/x y", `doi:10.1/${"x".repeat(300)}`]) {
    const res = await b.fetch(`/api/contributions/paper?id=${encodeURIComponent(id)}`);
    assert.equal(res.status, 400, id);
  }
  for (const id of [P1, "pmcid:PMC1234567"]) assert.equal((await b.fetch(`/api/contributions/paper?id=${encodeURIComponent(id)}`)).status, 200, id);
});

test("every write needs the session's CSRF token and the site's Origin", async () => {
  const b = await ada(w);
  const report = removal({ reason: "incorrect", details: "The code link is not the authors' code, but a student's copy." });
  let res = await b.post("/api/reports", report, { csrf: null });
  assert.equal(res.status, 403);
  assert.equal((await body(res)).error.code, "bad_csrf");
  res = await b.post("/api/reports", report, { csrf: "not-the-token" });
  assert.equal((await body(res)).error.code, "bad_csrf");
  res = await b.post("/api/reports", report, { origin: "https://evil.example" });
  assert.equal((await body(res)).error.code, "bad_origin");
  res = await b.post("/api/reports", report, { origin: null });
  assert.equal((await body(res)).error.code, "bad_origin");
  res = await b.post("/api/reports", report, { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal((await body(res)).error.code, "bad_origin");
  // The token of another session is worth nothing here.
  const other = await ada(w);
  const theirs = (await other.me()).csrf;
  res = await b.post("/api/validations", { paper_id: P1, map_digest: DIGEST }, { csrf: theirs });
  assert.equal((await body(res)).error.code, "bad_csrf");
  assert.equal(rows(w.db, "reports").length + rows(w.db, "validations").length, 0);
  assert.equal(rows(w.db, "jobs").length, 0);
  // With both: accepted.
  res = await b.post("/api/reports", report);
  assert.equal(res.status, 202);
});

test("a body that is not a JSON object, or too large, is not read", async () => {
  const b = await ada(w);
  const csrf = (await b.me()).csrf;
  const send = (text: string, type = "application/json") =>
    b.fetch("/api/reports", { method: "POST", headers: { Origin: ORIGIN, "X-CSRF-Token": csrf, "Content-Type": type }, body: text });
  for (const [text, type] of [["[1, 2]", "application/json"], ["not json", "application/json"], ["reason=other", "application/x-www-form-urlencoded"]]) {
    const res = await send(text, type);
    assert.equal(res.status, 400, text);
    assert.equal((await body(res)).error.code, "bad_request");
  }
  const res = await send(JSON.stringify({ paper_id: P1, reason: "other", details: "x".repeat(20_000) }));
  assert.equal((await body(res)).error.code, "bad_request");
});

test("the database failing: said in words, the quota apart", async () => {
  const b = await ada(w);
  const csrf = (await b.me()).csrf;
  w.db.failWith = "D1_ERROR: Your account has exceeded D1's free tier daily row written limit.";
  let res = await b.post("/api/reports", { paper_id: P1, reason: "incorrect" }, { csrf });
  assert.equal(res.status, 503);
  assert.equal((await body(res)).error.code, "quota");
  w.db.failWith = "D1_ERROR: D1 DB is overloaded.";
  res = await b.fetch("/api/contributions");
  assert.equal((await body(res)).error.code, "unavailable");
});

test("development metrics: the D1 figures of each answer, only when asked", async () => {
  const b = await ada(w);
  const plain = await b.fetch("/api/contributions");
  assert.equal(plain.headers.get("X-D1-Rows-Written"), null);
  b.env = { ...b.env, ACCOUNT_DEV_METRICS: "1" };
  const measured = await b.post("/api/reports", removal());
  assert.equal(measured.status, 202);
  assert.ok(Number(measured.headers.get("X-D1-Queries")) > 0);
});

test("the hint cookie: readable by the pages, set and cleared with the session, it grants nothing", async () => {
  const b = w.browser();
  await b.signIn("orcid");
  const hint = b.setCookies.find((c) => c.startsWith("__Host-oscr_signed_in="));
  assert.equal(hint, "__Host-oscr_signed_in=1; Path=/; Secure; SameSite=Lax; Max-Age=2592000");
  assert.ok(!/HttpOnly/i.test(hint ?? ""), "the pages' scripts read it");
  // Alone, it is nobody.
  const thief = w.browser();
  thief.jar.set("__Host-oscr_signed_in", "1");
  assert.deepEqual(await body(await thief.fetch(`/api/contributions/paper?id=${P1}`)), { signed_in: false, available: true });
  // Signing out clears both.
  await b.post("/api/account/signout");
  assert.ok(b.setCookies.includes("__Host-oscr_signed_in=; Path=/; Secure; SameSite=Lax; Max-Age=0"));
  assert.equal(b.cookie("__Host-oscr_signed_in"), null);
  // A session gone stale clears it on the next page that asks.
  const c = w.browser();
  await c.signIn("github");
  w.db.sqlite.prepare("DELETE FROM sessions").run();
  await c.fetch(`/api/contributions/paper?id=${P1}`);
  assert.equal(c.cookie("__Host-oscr_signed_in"), null);
  assert.equal(c.cookie("__Host-oscr_session"), null);
});
