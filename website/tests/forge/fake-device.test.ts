// The fake GitHub's device flow (night phase 14): what the command line's GitHub sign-in asks of
// github.com, answered in GitHub's shapes, with the public client id only; approved, refused or expired
// by the test; renewed with the refresh token and no secret.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeGitHub } from "./fake-github.ts";
import { MemoryBackend } from "./memory.ts";

const client = { id: "Iv23liDEVICETEST", secret: "not-used-by-the-device-flow" };

function world() {
  const double = new MemoryBackend({ web: "http://127.0.0.1:9/web" });
  double.addUser("ada-fixture");
  return new FakeGitHub(double, client);
}

const post = async (fake: FakeGitHub, path: string, form: Record<string, string>) => {
  const res = await fake.handle("POST", new URL(`https://github.com${path}`), new Headers({ Accept: "application/json" }), new TextEncoder().encode(new URLSearchParams(form).toString()));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

test("a code, pending, approved, the token; the code used once", async () => {
  const fake = world();
  const start = await post(fake, "/login/device/code", { client_id: client.id });
  assert.equal(start.status, 200);
  assert.equal(start.body.verification_uri, "http://127.0.0.1:9/web/login/device");
  assert.equal(start.body.interval, 5);
  const device = String(start.body.device_code);
  assert.equal((await post(fake, "/login/oauth/access_token", { client_id: client.id, device_code: device, grant_type: GRANT })).body.error, "authorization_pending");
  assert.deepEqual(fake.approveDevice("approve", "ada-fixture"), [start.body.user_code]);
  const got = await post(fake, "/login/oauth/access_token", { client_id: client.id, device_code: device, grant_type: GRANT });
  assert.match(String(got.body.access_token), /^memtok_/);
  assert.equal(got.body.expires_in, 28_800);
  const me = await fake.handle("GET", new URL("https://api.github.com/user"), new Headers({ Authorization: `Bearer ${got.body.access_token}` }), new Uint8Array());
  assert.equal(((await me.json()) as { login: string }).login, "ada-fixture");
  assert.equal((await post(fake, "/login/oauth/access_token", { client_id: client.id, device_code: device, grant_type: GRANT })).body.error, "incorrect_device_code");
  // renewed with the public client id and the refresh token, once
  const renewed = await post(fake, "/login/oauth/access_token", { client_id: client.id, grant_type: "refresh_token", refresh_token: String(got.body.refresh_token) });
  assert.match(String(renewed.body.access_token), /^memtok_/);
  assert.equal((await post(fake, "/login/oauth/access_token", { client_id: client.id, grant_type: "refresh_token", refresh_token: String(got.body.refresh_token) })).body.error, "bad_refresh_token");
});

test("refused, expired, another client", async () => {
  const fake = world();
  assert.equal((await post(fake, "/login/device/code", { client_id: "someone-else" })).status, 401);
  const a = String((await post(fake, "/login/device/code", { client_id: client.id })).body.device_code);
  fake.approveDevice("deny");
  assert.equal((await post(fake, "/login/oauth/access_token", { client_id: client.id, device_code: a, grant_type: GRANT })).body.error, "access_denied");
  const b = String((await post(fake, "/login/device/code", { client_id: client.id })).body.device_code);
  fake.approveDevice("expire");
  assert.equal((await post(fake, "/login/oauth/access_token", { client_id: client.id, device_code: b, grant_type: GRANT })).body.error, "expired_token");
});
