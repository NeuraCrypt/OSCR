// The command line's sign-in (night phase 14; device-core.ts, device.ts; D14-2): a code that writes
// nothing, sealed with the server key; an approval by a signed-in person who types the terminal's code
// (cookie, Origin, CSRF, FORGE_OPEN, the human check, caps); polls at most every 5 s for 15 minutes; the
// token made when collected, answered once, kept as a digest; a refusal; a token that revokes itself.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { handleApi } from "../../worker/forge/service/api.ts";
import {
  CODES_PER_MINUTE,
  DEVICE_PREFIX,
  deviceSeconds,
  grantKey,
  openDevice,
  openRequest,
  scopeMask,
  scopesOfMask,
  sealDevice,
  sealRequest,
  takeCode,
  takePoll,
  typedCode,
  USER_CODE,
  userCode,
  validateAsk,
  WRONG_CODES,
} from "../../worker/forge/service/device-core.ts";
import { TOKEN_SHAPE, TOKENS_PER_ACCOUNT } from "../../worker/forge/service/tokens-core.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import { signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { forgeWorld, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1", GITHUB_APP_CLIENT_ID: "Iv23liPUBLICID" } });
});
afterEach(() => w.restore());

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;
const ORIGIN = "https://registry.example";
const KEY = "test-server-key-0123456789abcdef0123456789";

function call(path: string, o: { token?: string | null; body?: unknown; headers?: Record<string, string>; method?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  return handleApi(new Request(`${ORIGIN}${path}`, { method: o.method ?? (o.body !== undefined ? "POST" : "GET"), headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), w.env, w.ctx, w.deps) as Promise<Response>;
}

async function start(ask: Json = { scopes: ["repos:read", "research:write"], days: 60, name: "Command line" }, ip = "198.51.100.7"): Promise<Json> {
  const res = await call("/api/forge/v1/device/code", { body: ask, headers: { "CF-Connecting-IP": ip } });
  const b = await body(res);
  assert.equal(res.status, 200, JSON.stringify(b));
  return b;
}

const requestOf = (b: Json): string => new URL(b.verification_uri).searchParams.get("r") ?? "";
const poll = (device: string) => call("/api/forge/v1/device/token", { body: { device_code: device } });
const decide = (b: ForgeBrowser, request: string, extra: Json) => b.post("/api/forge/device/decide", { request, turnstile: "XXXX.DUMMY.TOKEN.XXXX", ...extra });

describe("the pure parts", () => {
  test("a request and a device code, sealed for different purposes; a user code of 8 consonants", async () => {
    const r = { nonce: "AAAAAAAAAAAAAAAAAAAAAA", exp: T0 + 900, scopes: ["repos:read" as const, "statuses:write" as const], days: 30, name: "CLI" };
    const sealed = await sealRequest(KEY, r);
    assert.deepEqual(await openRequest(KEY, sealed), r);
    assert.equal(await openRequest("another-key-of-the-same-length-0123456789", sealed), null);
    const [p, m] = sealed.split(".");
    // Another request's payload under this seal, or scopes changed in the address: refused.
    const changed = Buffer.from(JSON.stringify({ v: 1, n: r.nonce, e: r.exp, s: 1023, d: 366, m: "CLI" })).toString("base64url");
    assert.equal(await openRequest(KEY, `${changed}.${m}`), null);
    assert.equal(await openRequest(KEY, `${p}.${m.slice(0, -1)}A`), null);
    const device = await sealDevice(KEY, r);
    assert.ok(device.startsWith(DEVICE_PREFIX));
    assert.deepEqual(await openDevice(KEY, device), { nonce: r.nonce, exp: r.exp });
    // A request is no device code, and a device code no request.
    assert.equal(await openDevice(KEY, `${DEVICE_PREFIX}${sealed}`), null);
    assert.equal(await openRequest(KEY, device.slice(DEVICE_PREFIX.length)), null);
    const code = await userCode(KEY, r.nonce);
    assert.match(code, USER_CODE);
    assert.equal(await userCode(KEY, r.nonce), code);
    assert.notEqual(await userCode(KEY, "BBBBBBBBBBBBBBBBBBBBBB"), code);
    assert.equal(typedCode(code.toLowerCase().replace("-", " ")), code);
    assert.equal(typedCode("AEIO-UAEI"), "");
    assert.equal(typedCode("BCD"), "");
    const k = await grantKey(r);
    assert.equal(k.day, Math.floor((T0 + 900) / 86_400));
    assert.match(k.ref, /^[0-9a-f]{64}$/);
    assert.deepEqual(scopesOfMask(scopeMask(["hooks:write", "repos:read"])), ["repos:read", "hooks:write"]);
  });

  test("what may be asked: known scopes, 1 to 366 days, a name without an address", () => {
    const ok = validateAsk({ scopes: ["social:write", "repos:read", "repos:read"] });
    assert.ok(!isProblem(ok) && ok.days === 30 && ok.name === "Command line");
    if (!isProblem(ok)) assert.deepEqual(ok.scopes, ["repos:read", "social:write"]);
    for (const bad of [{ scopes: [] }, { scopes: ["admin"] }, { scopes: ["repos:read"], days: 0 }, { scopes: ["repos:read"], days: 367 }, { scopes: ["repos:read"], name: "  " }, null]) {
      assert.ok(isProblem(validateAsk(bad)), JSON.stringify(bad));
    }
    const masked = validateAsk({ scopes: ["repos:read"], name: "ada@example.org's laptop" });
    assert.ok(!isProblem(masked) && !masked.name.includes("@"));
  });

  test("a code's life: 15 minutes; shorter only in development (DEVICE_CODE_SECONDS), never longer", () => {
    assert.equal(deviceSeconds({}), 900);
    assert.equal(deviceSeconds({ DEVICE_CODE_SECONDS: "12" }), 12);
    for (const v of ["4", "900", "3600", "x", "12.5", ""]) assert.equal(deviceSeconds({ DEVICE_CODE_SECONDS: v }), 900, v);
  });

  test("this isolate's limits: a poll every 5 s, 10 codes a minute an address", () => {
    const polls = new Map<string, number>();
    assert.ok(takePoll("n", T0, polls));
    assert.ok(!takePoll("n", T0 + 4, polls));
    assert.ok(takePoll("n", T0 + 5, polls));
    const codes = new Map();
    for (let i = 0; i < CODES_PER_MINUTE; i++) assert.ok(takeCode("a", T0, codes));
    assert.ok(!takeCode("a", T0, codes));
    assert.ok(takeCode("b", T0, codes));
    assert.ok(takeCode("a", T0 + 60, codes));
  });
});

describe("the flow", () => {
  test("a code writes nothing; approved with the terminal's code; the token made when collected, once", async () => {
    w.forge.reset();
    const s = await start();
    assert.equal(w.forge.totals.written, 0);
    assert.match(s.device_code, /^oscr_dc_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    assert.match(s.user_code, USER_CODE);
    assert.ok(s.verification_uri.startsWith(`${ORIGIN}/device/?r=`));
    assert.equal(s.expires_in, 900);
    assert.equal(s.interval, 5);
    assert.ok(!s.verification_uri.includes(s.user_code) && !s.verification_uri.includes(s.device_code));
    // Pending; too fast.
    const p1 = await poll(s.device_code);
    assert.equal(p1.status, 400);
    assert.equal((await body(p1)).error.code, "authorization_pending");
    assert.equal((await body(await poll(s.device_code))).error.code, "slow_down");
    // The page: signed in, what is asked.
    const ada = await signIn(w);
    const read = await body(await ada.fetch(`/api/forge/device?r=${requestOf(s)}`));
    assert.equal(read.state, "pending");
    assert.deepEqual(read.scopes.map((x: Json) => x.id), ["repos:read", "research:write"]);
    assert.equal(read.days, 60);
    assert.equal(read.can.approve, true);
    assert.ok(!JSON.stringify(read).includes(s.user_code));
    // The wrong code, then the right one.
    const wrong = await decide(ada, requestOf(s), { decision: "approve", code: "BCDF-GHJK" === s.user_code ? "ZZZZ-ZZZZ" : "BCDF-GHJK" });
    assert.equal(wrong.status, 400);
    assert.equal((await body(wrong)).error.code, "wrong_code");
    w.forge.reset();
    const ok = await decide(ada, requestOf(s), { decision: "approve", code: s.user_code.toLowerCase() });
    assert.equal(ok.status, 200, JSON.stringify(await body(ok)));
    assert.equal(w.forge.totals.written, 2);
    const [grant] = forgeRows(w.forge, "device_grants");
    assert.equal(grant.state, "approved");
    assert.ok(!JSON.stringify(grant).includes(s.device_code) && !JSON.stringify(grant).includes(s.user_code));
    assert.equal((await decide(ada, requestOf(s), { decision: "approve", code: s.user_code })).status, 409);
    // Collected: the token, answered once.
    w.advance(5);
    w.forge.reset();
    const got = await poll(s.device_code);
    const t = await body(got);
    assert.equal(got.status, 200, JSON.stringify(t));
    assert.ok(TOKEN_SHAPE.test(t.access_token));
    assert.deepEqual(t.scopes, ["repos:read", "research:write"]);
    assert.equal(t.expires_at, new Date((w.clock.t + 60 * 86_400) * 1000).toISOString());
    assert.equal(w.forge.totals.written, 4);
    assert.deepEqual(w.forge.scans, []);
    assert.ok(!JSON.stringify(forgeRows(w.forge, "api_tokens")).includes(t.access_token));
    const me = await body(await call("/api/forge/v1/user", { token: t.access_token }));
    assert.equal(me.github, "ada-fixture");
    assert.deepEqual(me.token.scopes, ["repos:read", "research:write"]);
    w.advance(5);
    assert.equal((await body(await poll(s.device_code))).error.code, "expired_token");
    assert.equal((await body(await ada.fetch(`/api/forge/device?r=${requestOf(s)}`))).state, "collected");
    // It shows in the settings' list, by its name.
    const list = await body(await ada.fetch("/api/forge/tokens"));
    assert.equal(list.tokens[0].name, "Command line");
  });

  test("refused: the terminal hears access_denied; a refusal is never refused", async () => {
    const s = await start();
    const bob = await signIn(w, "bob-fixture"); // not the owner: FORGE_OPEN closed
    const denied = await decide(bob, requestOf(s), { decision: "deny" });
    assert.equal(denied.status, 200);
    assert.equal((await body(await poll(s.device_code))).error.code, "access_denied");
  });

  test("FORGE_OPEN: only the owner approves until the content rules open the side", async () => {
    const s = await start();
    const bob = await signIn(w, "bob-fixture");
    const read = await body(await bob.fetch(`/api/forge/device?r=${requestOf(s)}`));
    assert.equal(read.can.approve, false);
    w.forge.reset();
    const refused = await decide(bob, requestOf(s), { decision: "approve", code: s.user_code });
    assert.equal(refused.status, 403);
    assert.equal((await body(refused)).error.code, "forge_closed");
    assert.equal(w.forge.totals.written, 0);
    assert.equal((await body(await poll(s.device_code))).error.code, "authorization_pending");
  });

  test("expired after 15 minutes: the poll and the page say so", async () => {
    const s = await start();
    w.advance(901);
    assert.equal((await body(await poll(s.device_code))).error.code, "expired_token");
    const ada = await signIn(w);
    assert.equal((await body(await ada.fetch(`/api/forge/device?r=${requestOf(s)}`))).expired, true);
    const late = await decide(ada, requestOf(s), { decision: "approve", code: s.user_code });
    assert.equal(late.status, 410);
  });

  test("the page's guards: sign-in, Origin, CSRF, the human check, a changed address, too many wrong codes", async () => {
    const s = await start();
    const anon = w.browser();
    assert.equal((await anon.fetch(`/api/forge/device?r=${requestOf(s)}`)).status, 401);
    const ada = await signIn(w);
    assert.equal((await ada.post("/api/forge/device/decide", { request: requestOf(s), decision: "approve", code: s.user_code }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await ada.post("/api/forge/device/decide", { request: requestOf(s), decision: "approve", code: s.user_code }, { csrf: "nope" })).status, 403);
    const human = await decide(ada, requestOf(s), { decision: "approve", code: s.user_code, turnstile: "" });
    assert.equal(human.status, 403);
    assert.equal((await body(human)).error.code, "human_check");
    const [p, m] = requestOf(s).split(".");
    const more = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), s: 1023 })).toString("base64url");
    assert.equal((await decide(ada, `${more}.${m}`, { decision: "approve", code: s.user_code })).status, 400);
    assert.equal((await ada.fetch(`/api/forge/device?r=${more}.${m}`)).status, 400);
    const s2 = await start();
    for (let i = 0; i < WRONG_CODES; i++) await decide(ada, requestOf(s2), { decision: "approve", code: s2.user_code === "BCDF-GHJK" ? "ZZZZ-ZZZZ" : "BCDF-GHJK" });
    assert.equal((await decide(ada, requestOf(s2), { decision: "approve", code: s2.user_code })).status, 429);
  });

  test("a code's asks: known scopes, days, 10 codes a minute an address", async () => {
    assert.equal((await call("/api/forge/v1/device/code", { body: { scopes: ["admin"] } })).status, 400);
    assert.equal((await call("/api/forge/v1/device/code", { body: { scopes: ["repos:read"], days: 400 } })).status, 400);
    for (let i = 0; i < CODES_PER_MINUTE; i++) await start(undefined, "203.0.113.9");
    const res = await call("/api/forge/v1/device/code", { body: { scopes: ["repos:read"] }, headers: { "CF-Connecting-IP": "203.0.113.9" } });
    assert.equal(res.status, 429);
    assert.equal((await body(await poll("oscr_dc_nothing.AAAA"))).error.code, "invalid_grant");
  });

  test("at the collection: 20 tokens an account, a suspended account", async () => {
    const ada = await signIn(w);
    const s = await start();
    assert.equal((await decide(ada, requestOf(s), { decision: "approve", code: s.user_code })).status, 200);
    for (let i = 0; i < TOKENS_PER_ACCOUNT; i++) assert.equal((await ada.post("/api/forge/tokens/write", { op: "create", name: `t${i}`, scopes: ["repos:read"] })).status, 201);
    w.advance(5);
    const full = await poll(s.device_code);
    assert.equal(full.status, 409);
    assert.equal((await body(full)).error.code, "too_many_tokens");
    const s2 = await start();
    assert.equal((await decide(ada, requestOf(s2), { decision: "approve", code: s2.user_code })).status, 409);
    const uid = (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github'").get() as { user_id: string }).user_id;
    w.forge.sqlite.prepare("INSERT INTO moderation (kind, ref, target, state, reason, by_whom, created_at, updated_at) VALUES ('account', ?, 'account:x', 'hidden', 'spam', 'owner', ?, ?)").run(uid, T0, T0);
    w.advance(5);
    assert.equal((await poll(s.device_code)).status, 403);
  });
});

describe("the other routes", () => {
  test("GET /api/forge/v1/cli: the App's public client id, the routes; no token", async () => {
    const b = await body(await call("/api/forge/v1/cli"));
    assert.equal(b.github.client_id, "Iv23liPUBLICID");
    assert.equal(b.device.code, "/api/forge/v1/device/code");
    assert.equal(b.device.interval, 5);
    assert.ok(!JSON.stringify(b).includes("secret"));
  });

  test("a token revokes itself, and only itself", async () => {
    const ada = await signIn(w);
    const make = async (name: string) => (await body(await ada.post("/api/forge/tokens/write", { op: "create", name, scopes: ["repos:read"] }))).token as string;
    const one = await make("one");
    const two = await make("two");
    w.forge.reset();
    const res = await call("/api/forge/v1/token/revoke", { token: one, body: {} });
    assert.equal(res.status, 200);
    assert.equal(w.forge.totals.written, 3 + 1); // its row, its index entry, the action; and its first use, once a day
    assert.equal((await call("/api/forge/v1/user", { token: one })).status, 401);
    assert.equal((await call("/api/forge/v1/user", { token: two })).status, 200);
    assert.equal((await call("/api/forge/v1/token/revoke", { body: {} })).status, 401);
  });
});
