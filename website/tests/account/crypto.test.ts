// The accounts' primitives: randomness, PKCE, HMAC, base64url (worker/account/crypto.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { base64url, fromBase64url, hmac, hmacCheck, pkceChallenge, randomToken, sameText, sha256Hex } from "../../worker/account/crypto.ts";

test("PKCE S256 gives RFC 7636's own example (appendix B)", async () => {
  assert.equal(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("a random token carries 256 bits, in base64url, and never repeats", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const t = randomToken();
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(fromBase64url(t).length, 32);
    seen.add(t);
  }
  assert.equal(seen.size, 2000);
});

test("base64url round-trips any bytes and refuses what is not base64url", () => {
  for (let n = 0; n < 40; n++) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    assert.deepEqual(fromBase64url(base64url(bytes)), bytes);
  }
  assert.throws(() => fromBase64url("a+b/"));
  assert.throws(() => fromBase64url("abcde"));
});

test("an HMAC holds for its key and purpose only", async () => {
  const key = "k".repeat(40);
  const sig = await hmac(key, "csrf", "session-hash");
  assert.equal(await hmacCheck(key, "csrf", "session-hash", sig), true);
  assert.equal(await hmacCheck(key, "flow", "session-hash", sig), false, "another purpose");
  assert.equal(await hmacCheck("j".repeat(40), "csrf", "session-hash", sig), false, "another key");
  assert.equal(await hmacCheck(key, "csrf", "other-hash", sig), false, "another message");
  assert.equal(await hmacCheck(key, "csrf", "session-hash", sig.slice(0, -2)), false, "cut");
  assert.equal(await hmacCheck(key, "csrf", "session-hash", "not base64url!"), false);
});

test("sameText compares whole strings", () => {
  assert.equal(sameText("abc", "abc"), true);
  assert.equal(sameText("abc", "abd"), false);
  assert.equal(sameText("abc", "abcd"), false);
  assert.equal(sameText("", ""), true);
});

test("sha256Hex is the SHA-256 of the UTF-8 text", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
