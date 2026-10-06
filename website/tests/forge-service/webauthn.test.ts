// Passkeys / WebAuthn (night phase 09, E5): the pure decoder and signature parts, then a full round
// trip against the routes with a test authenticator built on WebCrypto (a real ES256 key, a real
// signature): register a passkey, use it to enter sudo mode, and the refusals (a tampered signature,
// a wrong origin, a counter that went backward).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { base64url, fromBase64url, sha256 } from "../../worker/account/crypto.ts";
import { coseToKey, decodeCbor, derToRawEcdsa, openChallenge, parseAuthData, signChallenge } from "../../worker/forge/service/webauthn-core.ts";
import { signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { forgeWorld, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;
const RP_ID = "registry.test";
const ORIGIN = "https://registry.test";

// ─── a tiny CBOR encoder, for the test authenticator ────────────────────────────
function cborUint(n: number): Uint8Array {
  if (n < 24) return new Uint8Array([n]);
  if (n < 256) return new Uint8Array([24, n]);
  if (n < 65536) return new Uint8Array([25, n >> 8, n & 0xff]);
  return new Uint8Array([26, (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}
function head(major: number, n: number): Uint8Array {
  const u = cborUint(n);
  u[0] |= major << 5;
  return u;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
function cbor(value: unknown): Uint8Array {
  if (typeof value === "number") return value < 0 ? head(1, -1 - value) : head(0, value);
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (typeof value === "string") {
    const b = new TextEncoder().encode(value);
    return concat(head(3, b.length), b);
  }
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return concat(...parts);
  }
  throw new Error("unsupported");
}

function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32, 64));
  const seq = concat(r, s);
  return concat(new Uint8Array([0x30, seq.length]), seq);
}

/** A test authenticator: a real ES256 key, producing attestation objects and assertions the Worker
 *  verifies. */
class Authenticator {
  key!: CryptoKey;
  pub!: CryptoKey;
  credId = crypto.getRandomValues(new Uint8Array(32));
  count = 0;

  async init(): Promise<void> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    this.key = pair.privateKey;
    this.pub = pair.publicKey;
  }

  async authData(withCred: boolean, flagsExtra = 0): Promise<Uint8Array> {
    const rpIdHash = await sha256(RP_ID);
    const flags = 0x01 | 0x04 | (withCred ? 0x40 : 0) | flagsExtra; // UP + UV (+ AT)
    const count = new Uint8Array([(this.count >> 24) & 0xff, (this.count >> 16) & 0xff, (this.count >> 8) & 0xff, this.count & 0xff]);
    if (!withCred) return concat(rpIdHash, new Uint8Array([flags]), count);
    const jwk = await crypto.subtle.exportKey("jwk", this.pub);
    const cose = new Map<number, unknown>([
      [1, 2], // kty EC2
      [3, -7], // alg ES256
      [-1, 1], // crv P-256
      [-2, fromBase64url(jwk.x!)],
      [-3, fromBase64url(jwk.y!)],
    ]);
    const aaguid = new Uint8Array(16);
    const credLen = new Uint8Array([this.credId.length >> 8, this.credId.length & 0xff]);
    return concat(rpIdHash, new Uint8Array([flags]), count, aaguid, credLen, this.credId, cbor(cose));
  }

  clientData(type: string, challenge: string, origin = ORIGIN): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin }));
  }

  async attestation(challenge: string, origin = ORIGIN): Promise<{ id: string; clientDataJSON: string; attestationObject: string }> {
    const authData = await this.authData(true);
    const att = new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]);
    return { id: base64url(this.credId), clientDataJSON: base64url(this.clientData("webauthn.create", challenge, origin)), attestationObject: base64url(cbor(att)) };
  }

  async assertion(challenge: string, origin = ORIGIN, tamper = false): Promise<{ id: string; clientDataJSON: string; authenticatorData: string; signature: string }> {
    this.count += 1;
    const authData = await this.authData(false);
    const client = this.clientData("webauthn.get", challenge, origin);
    const clientHash = await sha256Bytes(client);
    const signed = concat(authData, clientHash);
    const rawSig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.key, signed));
    if (tamper) rawSig[0] ^= 0xff;
    return { id: base64url(this.credId), clientDataJSON: base64url(client), authenticatorData: base64url(authData), signature: base64url(rawToDer(rawSig)) };
  }
}

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

describe("the pure parts (webauthn-core.ts)", () => {
  test("CBOR round-trips a map with byte strings and negative keys; COSE to a JWK", async () => {
    const auth = new Authenticator();
    await auth.init();
    const authData = await auth.authData(true);
    const parsed = parseAuthData(authData);
    assert.equal(parsed.up, true);
    assert.equal(parsed.at, true);
    assert.ok(parsed.cose instanceof Map);
    const key = coseToKey(parsed.cose!);
    assert.ok(key && key.alg === -7 && key.jwk.kty === "EC");
  });

  test("a DER ECDSA signature becomes 64 raw bytes", () => {
    const der = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
    const raw = derToRawEcdsa(der);
    assert.equal(raw.length, 64);
    assert.equal(raw[31], 1);
    assert.equal(raw[63], 2);
  });

  test("the challenge cookie is this session's, this purpose's, and expires", async () => {
    const key = "k".repeat(40);
    const cookie = await signChallenge(key, "create", "sess", "chal-abc", 1000);
    assert.equal(await openChallenge(key, "create", "sess", cookie, 1100), "chal-abc");
    assert.equal(await openChallenge(key, "get", "sess", cookie, 1100), null); // wrong purpose
    assert.equal(await openChallenge(key, "create", "other", cookie, 1100), null); // wrong session
    assert.equal(await openChallenge(key, "create", "sess", cookie, 2000), null); // expired
    assert.equal(decodeCbor(cbor(42)).value, 42);
  });
});

describe("the routes", () => {
  test("register a passkey, then use it to enter sudo mode", async () => {
    const ada = await signIn(w, "ada-fixture");
    const auth = new Authenticator();
    await auth.init();

    const opts = await body(await ada.post("/api/forge/account/passkey", { op: "register_options" }));
    assert.equal(opts.rp.id, RP_ID);
    const reg = await auth.attestation(opts.challenge);
    const done = await body(await ada.post("/api/forge/account/passkey", { op: "register_verify", ...reg, label: "My laptop" }));
    assert.equal(done.ok, true);
    assert.equal(done.alg, "ES256");
    assert.equal(forgeRows(w.forge, "webauthn_credentials").length, 1);

    // It shows in the account security view.
    const view = await body(await ada.fetch("/api/forge/account/security"));
    assert.equal(view.passkeys.length, 1);
    assert.equal(view.passkeys[0].label, "My laptop");
    assert.equal(view.sudo.active, false);

    // Use it: request options, sign, verify, sudo mode on.
    const ao = await body(await ada.post("/api/forge/account/passkey", { op: "auth_options" }));
    assert.equal(ao.allowCredentials.length, 1);
    const assertion = await auth.assertion(ao.challenge);
    const sudo = await body(await ada.post("/api/forge/account/passkey", { op: "auth_verify", ...assertion }));
    assert.equal(sudo.ok, true);
    assert.equal(sudo.sudo.active, true);
    assert.equal((await body(await ada.fetch("/api/forge/account/security"))).sudo.active, true);
    assert.deepEqual(w.forge.scans, []);
  });

  test("a tampered signature, a wrong origin, and a backward counter are refused", async () => {
    const ada = await signIn(w, "ada-fixture");
    const auth = new Authenticator();
    await auth.init();
    const opts = await body(await ada.post("/api/forge/account/passkey", { op: "register_options" }));
    await ada.post("/api/forge/account/passkey", { op: "register_verify", ...(await auth.attestation(opts.challenge)) });

    // A tampered signature.
    const ao1 = await body(await ada.post("/api/forge/account/passkey", { op: "auth_options" }));
    const badSig = await auth.assertion(ao1.challenge, ORIGIN, true);
    assert.equal((await ada.post("/api/forge/account/passkey", { op: "auth_verify", ...badSig })).status, 400);

    // A wrong origin.
    const ao2 = await body(await ada.post("/api/forge/account/passkey", { op: "auth_options" }));
    const wrongOrigin = await auth.assertion(ao2.challenge, "https://evil.example");
    const wo = await ada.post("/api/forge/account/passkey", { op: "auth_verify", ...wrongOrigin });
    assert.equal(wo.status, 400);
    assert.equal((await body(wo)).error.code, "bad_origin");

    // A genuine assertion works (counter now ahead), then a replay with a lower counter is refused.
    const ao3 = await body(await ada.post("/api/forge/account/passkey", { op: "auth_options" }));
    const good = await auth.assertion(ao3.challenge); // count goes to 3
    assert.equal((await ada.post("/api/forge/account/passkey", { op: "auth_verify", ...good })).status, 200);
    const ao4 = await body(await ada.post("/api/forge/account/passkey", { op: "auth_options" }));
    auth.count = 0; // an old authenticator copy, counter behind
    const replay = await auth.assertion(ao4.challenge); // count = 1, below the stored 3
    const rep = await ada.post("/api/forge/account/passkey", { op: "auth_verify", ...replay });
    assert.equal(rep.status, 409);
  });

  test("rename and remove a passkey", async () => {
    const ada = await signIn(w, "ada-fixture");
    const auth = new Authenticator();
    await auth.init();
    const opts = await body(await ada.post("/api/forge/account/passkey", { op: "register_options" }));
    const reg = await body(await ada.post("/api/forge/account/passkey", { op: "register_verify", ...(await auth.attestation(opts.challenge)) }));
    await ada.post("/api/forge/account/passkey", { op: "rename", ref: reg.ref, label: "Phone" });
    assert.equal((await body(await ada.fetch("/api/forge/account/security"))).passkeys[0].label, "Phone");
    await ada.post("/api/forge/account/passkey", { op: "remove", ref: reg.ref });
    assert.equal(forgeRows(w.forge, "webauthn_credentials").length, 0);
  });
});
