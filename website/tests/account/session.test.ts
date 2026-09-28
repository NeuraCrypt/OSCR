// Sessions and CSRF (worker/account/session.ts, index.ts): only the id's hash in D1, 30 days,
// sliding at most once a day, seen at most once an hour, sign-out deletes the row; every POST
// needs the session's CSRF token and the site's own Origin.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { sha256Hex } from "../../worker/account/crypto.ts";
import { ORIGIN, world, type World } from "./browser.ts";
import { everyText, rows } from "./d1.ts";

let w: World;
beforeEach(() => {
  w = world();
});
afterEach(() => w.restore());

const T0 = Date.UTC(2026, 8, 27, 8, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const updates = (w: World) => w.db.queries.filter((q) => q.startsWith("UPDATE sessions")).length;

test("D1 keeps the SHA-256 of the session id, never the id", async () => {
  const b = w.browser();
  await b.signIn("orcid");
  const id = b.cookie("__Host-oscr_session") ?? "";
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(rows(w.db, "sessions").map((s) => s.id_hash), [await sha256Hex(id)]);
  assert.ok(!everyText(w.db).includes(id));
});

test("a session: seen at most once an hour, extended at most once a day, over after 30 days", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const b = w.browser();
  await b.signIn("orcid");
  const [first] = rows(w.db, "sessions");
  assert.equal(first.expires_at, T0 / 1000 + 30 * 86_400);

  t.mock.timers.setTime(T0 + 10 * 60_000);
  assert.equal((await b.me()).signed_in, true);
  assert.equal(updates(w), 0, "ten minutes later: no write");

  t.mock.timers.setTime(T0 + 2 * HOUR);
  await b.me();
  assert.equal(updates(w), 1, "two hours later: last_seen_at");
  let [s] = rows(w.db, "sessions");
  assert.equal(s.last_seen_at, (T0 + 2 * HOUR) / 1000);
  assert.equal(s.expires_at, first.expires_at, "the expiry has not moved");
  assert.ok(!b.setCookies.some((c) => c.startsWith("__Host-oscr_session=")));

  t.mock.timers.setTime(T0 + 2 * HOUR + 30 * 60_000);
  await b.me();
  assert.equal(updates(w), 1, "within the hour: no write");

  t.mock.timers.setTime(T0 + DAY + 3 * HOUR);
  await b.me();
  assert.equal(updates(w), 2);
  [s] = rows(w.db, "sessions");
  assert.equal(s.expires_at, (T0 + DAY + 3 * HOUR) / 1000 + 30 * 86_400, "a day later: 30 days from now");
  assert.ok(b.setCookies.some((c) => /^__Host-oscr_session=[^;]+; .*Max-Age=2592000$/.test(c)), "and the cookie again");

  // 30 days without a visit: over, and the row goes.
  t.mock.timers.setTime(T0 + DAY + 3 * HOUR + 30 * DAY + 1000);
  const me = await b.me();
  assert.equal(me.signed_in, false);
  assert.equal(rows(w.db, "sessions").length, 0);
  assert.equal(b.cookie("__Host-oscr_session"), null, "the stale cookie is cleared");
});

test("signing out deletes the session: its cookie is then worth nothing", async () => {
  const b = w.browser();
  await b.signIn("github");
  const id = b.cookie("__Host-oscr_session") ?? "";
  const res = await b.post("/api/account/signout");
  assert.equal(res.status, 200);
  assert.ok(b.setCookies.includes("__Host-oscr_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"));
  assert.equal(rows(w.db, "sessions").length, 0);
  const thief = w.browser();
  thief.jar.set("__Host-oscr_session", id);
  assert.equal((await thief.me()).signed_in, false);
});

test("a sign-in cleans up the account's expired sessions", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  await w.browser().signIn("orcid");
  await w.browser().signIn("orcid");
  assert.equal(rows(w.db, "sessions").length, 2);
  t.mock.timers.setTime(T0 + 31 * DAY);
  await w.browser().signIn("orcid");
  assert.equal(rows(w.db, "sessions").length, 1);
});

test("every POST needs the session's CSRF token and the site's Origin", async () => {
  w.mock.who.orcid = { sub: "0000-0002-1825-0097", name: "Josiah Carberry" };
  const b = w.browser();
  await b.signIn("orcid");
  const other = w.browser();
  await other.signIn("github");
  const otherToken = (await other.me()).csrf;
  const code = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code ?? `ok ${res.status}`;
  const path = "/api/account/authorship";
  assert.equal(await code(await b.post(path, undefined, { csrf: null })), "bad_csrf");
  assert.equal(await code(await b.post(path, undefined, { csrf: "A".repeat(43) })), "bad_csrf");
  assert.equal(await code(await b.post(path, undefined, { csrf: otherToken })), "bad_csrf");
  assert.equal(await code(await b.post(path, undefined, { origin: null })), "bad_origin");
  assert.equal(await code(await b.post(path, undefined, { origin: "https://evil.example" })), "bad_origin");
  assert.equal(await code(await b.post(path, undefined, { headers: { "Sec-Fetch-Site": "cross-site" } })), "bad_origin");
  assert.equal(await code(await b.post(path, undefined, { headers: { "Sec-Fetch-Site": "same-origin" } })), "ok 200");
  assert.equal(await code(await b.post(path)), "ok 200");
  // Signed out: nothing to protect, nothing done.
  assert.equal(await code(await w.browser().post(path, undefined, { csrf: otherToken })), "signed_out");
});

test("the CSRF token is bound to the session: a new sign-in, a new token", async () => {
  const b = w.browser();
  await b.signIn("orcid");
  const before = (await b.me()).csrf;
  assert.match(before, /^[A-Za-z0-9_-]{43}$/);
  // Signed in, the same provider again only confirms the link: same session, same token.
  assert.equal((await b.signIn("orcid")).search, "?linked=orcid");
  assert.equal((await b.me()).csrf, before);
  await b.post("/api/account/signout");
  await b.signIn("orcid");
  const after = (await b.me()).csrf;
  assert.notEqual(after, before);
  const res = await b.post("/api/account/signout", undefined, { csrf: before });
  assert.equal(res.status, 403);
  assert.equal(rows(w.db, "sessions").length, 1);
});

test("nothing changes on a GET", async () => {
  const b = w.browser();
  await b.signIn("orcid");
  for (const path of ["/api/account/signout", "/api/account/authorship", "/api/account/maintainer"]) {
    assert.equal((await b.fetch(path)).status, 405, path);
  }
  assert.equal((await b.fetch("/api/account/me", { method: "POST", headers: { Origin: ORIGIN } })).status, 405);
  assert.equal(rows(w.db, "sessions").length, 1);
});
