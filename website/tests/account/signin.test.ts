// Sign-in (worker/account/index.ts, flow.ts, providers.ts): state, PKCE and nonce; each provider's
// callback against its mocked token and user endpoints; the session cookie; linking.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { sha256Hex } from "../../worker/account/crypto.ts";
import { ORIGIN, world, type World } from "./browser.ts";
import { rows } from "./d1.ts";
import { CLIENTS } from "./mock.ts";

let w: World;
beforeEach(() => {
  w = world();
});
afterEach(() => w.restore());

const SESSION = /^__Host-oscr_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/;

test("the start sends state, PKCE and a nonce, asks for no email, and keeps the flow in a signed cookie", async () => {
  for (const name of ["orcid", "github", "google"] as const) {
    const b = w.browser();
    const res = await b.fetch(`/api/auth/${name}/start`);
    assert.equal(res.status, 302);
    const to = new URL(res.headers.get("Location") ?? "");
    const q = to.searchParams;
    assert.equal(q.get("client_id"), CLIENTS[name].id);
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("redirect_uri"), `${ORIGIN}/api/auth/${name}/callback`);
    assert.match(q.get("state") ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.match(q.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
    // ORCID and Google: OpenID Connect, scope openid only (no email, no profile); GitHub: no scope.
    assert.equal(q.get("scope"), name === "github" ? null : "openid");
    assert.equal(q.has("nonce"), name !== "github");
    assert.doesNotMatch(to.search, /email|profile|user%3Aemail/);
    const [flow] = b.setCookies;
    assert.match(flow, /^__Host-oscr_flow=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
    // The verifier is in the signed cookie, never in the provider's address.
    assert.doesNotMatch(to.search, /code_verifier/);
  }
});

test("ORCID: the iD is the ID token's subject, the name ORCID's; a session begins", async () => {
  const b = w.browser();
  const landed = await b.signIn("orcid");
  assert.equal(landed.pathname + landed.search, "/account/?signed_in=orcid");
  const session = b.setCookies.find((c) => c.startsWith("__Host-oscr_session="));
  assert.match(session ?? "", SESSION);
  assert.ok(b.setCookies.some((c) => /^__Host-oscr_flow=; .*Max-Age=0$/.test(c)), "the flow cookie is cleared");
  const [user] = rows(w.db, "users");
  assert.equal(user.display_name, "Ada Fixture");
  assert.equal(user.orcid, "0000-0000-0000-001X");
  assert.deepEqual(rows(w.db, "identities").map((i) => [i.provider, i.subject, i.user_id]), [["orcid", "0000-0000-0000-001X", user.id]]);
  const [s] = rows(w.db, "sessions");
  assert.equal(s.id_hash, await sha256Hex(b.cookie("__Host-oscr_session") ?? ""));
  assert.equal(s.user_agent_hint, "");
  const me = await b.me();
  assert.equal(me.signed_in, true);
  assert.equal(me.user.display_name, "Ada Fixture");
  assert.deepEqual(me.handles, { orcid: "0000-0000-0000-001X", github: null });
  assert.equal(me.identities[0].url, "https://providers.test/orcid/0000-0000-0000-001X");
});

test("the token exchange sends the client's secret, the redirect URI and the PKCE verifier, server to server", async () => {
  await w.browser().signIn("orcid");
  const exchange = w.mock.log.find((l) => l.url.endsWith("/orcid/oauth/token"));
  assert.ok(exchange);
  assert.equal(exchange.form.grant_type, "authorization_code");
  assert.equal(exchange.form.client_secret, CLIENTS.orcid.secret);
  assert.equal(exchange.form.redirect_uri, `${ORIGIN}/api/auth/orcid/callback`);
  assert.match(exchange.form.code_verifier ?? "", /^[A-Za-z0-9_-]{43}$/);
  // A verifier that does not match the challenge sent at the start is refused by the provider.
  const b = w.browser();
  const landed = await b.signIn("orcid", { edit: (u) => u.searchParams.set("code_challenge", "A".repeat(43)) });
  assert.equal(landed.searchParams.get("error"), "provider_error");
  assert.equal(b.cookie("__Host-oscr_session"), null);
});

test("GitHub: the account comes from /user, with no scope; the email address it offers is dropped", async () => {
  w.mock.who.github = { id: 777, login: "Octo-Lab", name: null };
  const b = w.browser();
  assert.equal((await b.signIn("github")).search, "?signed_in=github");
  const [user] = rows(w.db, "users");
  assert.equal(user.github_login, "Octo-Lab");
  assert.equal(user.display_name, "Octo-Lab", "no name: the login");
  assert.deepEqual(rows(w.db, "identities").map((i) => [i.provider, i.subject]), [["github", "777"]]);
  assert.deepEqual(w.mock.githubCalls(), ["/user"]);
  const exchange = w.mock.log.find((l) => l.url.endsWith("/login/oauth/access_token"));
  assert.equal(exchange?.form.grant_type, undefined);
  assert.match(exchange?.form.code_verifier ?? "", /^[A-Za-z0-9_-]{43}$/);
});

test("Google: scope openid only, so no name, and nothing else is kept", async () => {
  const b = w.browser();
  assert.equal((await b.signIn("google")).search, "?signed_in=google");
  const [user] = rows(w.db, "users");
  assert.equal(user.display_name, "");
  assert.equal(user.orcid, null);
  assert.equal(user.github_login, null);
  assert.deepEqual(rows(w.db, "identities").map((i) => [i.provider, i.subject]), [["google", "109876543210987654321"]]);
  const me = await b.me();
  assert.deepEqual(me.identities.map((i: { handle: string; url: string }) => [i.handle, i.url]), [["", ""]]);
});

test("a callback needs the state of the browser that started it", async () => {
  const b = w.browser();
  const start = await b.fetch("/api/auth/orcid/start");
  const flow = b.cookie("__Host-oscr_flow") ?? "";
  const atProvider = new URL(start.headers.get("Location") ?? "");
  const back = new URL(w.mock.authorize(atProvider.toString()));
  const callback = back.pathname;
  const code = back.searchParams.get("code") ?? "";
  const state = back.searchParams.get("state") ?? "";
  const expired = async (res: Response) => {
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get("Location") ?? "", ORIGIN).searchParams.get("error"), "expired");
  };
  // Another browser (no flow cookie), a wrong state, a tampered cookie, another provider's flow.
  await expired(await w.browser().fetch(`${callback}?code=${code}&state=${state}`));
  await expired(await b.fetch(`${callback}?code=${code}&state=${"x".repeat(43)}`));
  b.jar.set("__Host-oscr_flow", `${flow.slice(0, 10)}${flow[10] === "A" ? "B" : "A"}${flow.slice(11)}`);
  await expired(await b.fetch(`${callback}?code=${code}&state=${state}`));
  b.jar.set("__Host-oscr_flow", flow);
  await expired(await b.fetch(`/api/auth/google/callback?code=${code}&state=${state}`));
  assert.equal(rows(w.db, "users").length, 0);
  // The right browser, once: then the code is spent.
  b.jar.set("__Host-oscr_flow", flow);
  const ok = await b.fetch(`${callback}?code=${code}&state=${state}`);
  assert.equal(new URL(ok.headers.get("Location") ?? "", ORIGIN).search, "?signed_in=orcid");
  b.jar.set("__Host-oscr_flow", flow);
  const again = await b.fetch(`${callback}?code=${code}&state=${state}`);
  assert.equal(new URL(again.headers.get("Location") ?? "", ORIGIN).searchParams.get("error"), "provider_error");
});

test("a flow expires after ten minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 27, 12) });
  const b = w.browser();
  const start = await b.fetch("/api/auth/github/start");
  t.mock.timers.setTime(Date.UTC(2026, 8, 27, 12, 11));
  const landed = await b.approve(start.headers.get("Location") ?? "");
  assert.equal(landed.searchParams.get("error"), "expired");
});

test("a refusal at the provider, a wrong nonce, a wrong ORCID iD: nobody is signed in", async () => {
  w.mock.deny = true;
  assert.equal((await w.browser().signIn("orcid")).searchParams.get("error"), "denied");
  w.mock.deny = false;
  w.mock.tamper = (c) => ({ ...c, nonce: "not-this-sign-in" });
  assert.equal((await w.browser().signIn("google")).searchParams.get("error"), "provider_error");
  w.mock.tamper = null;
  w.mock.who.orcid = { sub: "0000-0000-0000-0011", name: "Wrong Check Digit" };
  assert.equal((await w.browser().signIn("orcid")).searchParams.get("error"), "provider_error");
  assert.equal(rows(w.db, "users").length, 0);
  assert.equal(rows(w.db, "sessions").length, 0);
});

test("signed in, another provider's sign-in links it to the same account", async () => {
  const b = w.browser();
  await b.signIn("orcid");
  assert.equal((await b.signIn("github")).search, "?linked=github");
  assert.equal((await b.signIn("google")).search, "?linked=google");
  assert.equal(rows(w.db, "users").length, 1);
  assert.equal(rows(w.db, "sessions").length, 1, "linking keeps the session");
  const me = await b.me();
  assert.deepEqual(me.identities.map((i: { provider: string }) => i.provider), ["orcid", "github", "google"]);
  assert.deepEqual(me.handles, { orcid: "0000-0000-0000-001X", github: "ada-fixture" });
  assert.ok(me.providers.every((p: { linked: boolean }) => p.linked));
  // Later, signed out, any of them signs in to that one account.
  await b.post("/api/account/signout");
  await b.signIn("google");
  assert.equal((await b.me()).handles.orcid, "0000-0000-0000-001X");
  assert.equal(rows(w.db, "users").length, 1);
});

test("an identity another account holds is never taken, and one identity per provider", async () => {
  const first = w.browser();
  await first.signIn("github");
  const second = w.browser();
  w.mock.who.orcid = { sub: "0000-0002-1825-0097", name: "Josiah Carberry" };
  await second.signIn("orcid");
  assert.equal((await second.signIn("github")).searchParams.get("error"), "identity_in_use");
  // A second GitHub account on the ORCID account is refused too, once one is linked.
  w.mock.who.github = { id: 5150, login: "josiah-lab", name: "Josiah" };
  assert.equal((await second.signIn("github")).search, "?linked=github");
  w.mock.who.github = { id: 5151, login: "josiah-other", name: "Josiah" };
  assert.equal((await second.signIn("github")).searchParams.get("error"), "provider_already_linked");
  assert.equal(rows(w.db, "users").length, 2);
  assert.equal(rows(w.db, "identities").length, 3);
});

test("a flow started signed out never links, even when a session appears before its callback", async () => {
  const other = w.browser();
  await other.signIn("orcid");
  const b = w.browser();
  const start = await b.fetch("/api/auth/github/start");
  const stolen = other.cookie("__Host-oscr_session") ?? "";
  b.jar.set("__Host-oscr_session", stolen);
  assert.equal((await b.approve(start.headers.get("Location") ?? "")).search, "?signed_in=github");
  assert.equal(rows(w.db, "users").length, 2, "GitHub got an account of its own");
  // The browser's previous session was replaced by the new one.
  const hashes = rows(w.db, "sessions").map((s) => s.id_hash);
  assert.ok(!hashes.includes(await sha256Hex(stolen)));
});

test("every sign-in gets a new session id and deletes the browser's previous session", async () => {
  const b = w.browser();
  await b.signIn("orcid");
  const first = b.cookie("__Host-oscr_session");
  await b.post("/api/account/signout");
  await b.signIn("orcid");
  assert.notEqual(b.cookie("__Host-oscr_session"), first);
  assert.equal(rows(w.db, "sessions").length, 1);
});

test("the page to come back to is a page of this site, nothing else", async () => {
  const back = async (query: string) => (await w.browser().signIn("github", { query })).pathname;
  assert.equal(await back("?return=/paper/doi_10.5555_oscr.fixture.1/"), "/paper/doi_10.5555_oscr.fixture.1/");
  assert.equal(await back("?return=https://evil.example/"), "/account/");
  assert.equal(await back("?return=//evil.example/"), "/account/");
  assert.equal(await back("?return=/api/account/signout"), "/account/");
});
