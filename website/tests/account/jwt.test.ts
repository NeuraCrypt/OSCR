// The ID tokens (worker/account/jwt.ts): an RS256 signature checked against the provider's keys,
// then the claims. The key pair is made by the mock provider, in the test.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { base64url } from "../../worker/account/crypto.ts";
import { forgetKeys, IdTokenError, verifyIdToken } from "../../worker/account/jwt.ts";
import { MockProviders } from "./mock.ts";

const ISSUER = "https://providers.test/google";
const AUDIENCE = "test-client.apps.googleusercontent.com";
const NONCE = "the-nonce-of-this-sign-in";
const NOW = 1_790_400_000;

let mock: MockProviders;
let real: typeof fetch;

beforeEach(() => {
  mock = new MockProviders();
  real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => mock.handle(new Request(input, init))) as typeof fetch;
  forgetKeys();
});
afterEach(() => {
  globalThis.fetch = real;
  forgetKeys();
});

const expect = { jwksUri: `${ISSUER}/oauth2/v3/certs`, issuers: [ISSUER], audience: AUDIENCE, nonce: NONCE, now: NOW };
const claims = (extra: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: AUDIENCE,
  azp: AUDIENCE,
  sub: "109876543210987654321",
  iat: NOW - 5,
  exp: NOW + 600,
  nonce: NONCE,
  ...extra,
});
const refused = (p: Promise<unknown>, why: RegExp) => assert.rejects(p, (e: unknown) => e instanceof IdTokenError && why.test((e as Error).message));

test("a token signed by the provider, for this client and this sign-in, is accepted", async () => {
  const c = await verifyIdToken(await mock.sign(claims()), expect);
  assert.equal(c.sub, "109876543210987654321");
});

test("the provider's keys are fetched once, and again for a key not seen yet", async () => {
  await verifyIdToken(await mock.sign(claims()), expect);
  await verifyIdToken(await mock.sign(claims()), expect);
  const fetches = () => mock.log.filter((l) => l.url.endsWith("/certs")).length;
  assert.equal(fetches(), 1);
  await refused(verifyIdToken(await mock.sign(claims(), { kid: "rotated-key" }), expect), /no published key/);
  assert.equal(fetches(), 2, "one more fetch for the unknown key, then refused");
});

test("a signature by any other key is refused", async () => {
  mock.signWithOtherKey = true;
  await refused(verifyIdToken(await mock.sign(claims()), expect), /signature/);
});

test("an algorithm other than RS256 is refused, 'none' included", async () => {
  const enc = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)));
  const unsigned = `${enc({ alg: "none", typ: "JWT" })}.${enc(claims())}.`;
  await refused(verifyIdToken(unsigned, expect), /algorithm/);
  const token = await mock.sign(claims(), { alg: "HS256" });
  await refused(verifyIdToken(token, expect), /algorithm/);
});

test("the claims: issuer, audience, authorized party, expiry, issue time, nonce, subject", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ iss: "https://accounts.example.com" }, /issuer/],
    [{ aud: "another-client" }, /another application/],
    [{ aud: [AUDIENCE, "another-client"], azp: "another-client" }, /another party/],
    [{ exp: NOW - 3600 }, /expired/],
    [{ iat: NOW + 3600 }, /future/],
    [{ nonce: "a-replayed-nonce" }, /nonce/],
    [{ nonce: undefined }, /nonce/],
    [{ sub: "" }, /nobody/],
  ];
  for (const [extra, why] of cases) await refused(verifyIdToken(await mock.sign(claims(extra)), expect), why);
  // Two audiences are fine when this client is the authorized party.
  await verifyIdToken(await mock.sign(claims({ aud: [AUDIENCE, "another-client"] })), expect);
});

test("what is not a JWT is refused", async () => {
  for (const token of ["", "a.b", "a.b.c.d", "!!.!!.!!", `${base64url(new TextEncoder().encode("{"))}.e30.AA`]) {
    await assert.rejects(verifyIdToken(token, expect), IdTokenError);
  }
});
