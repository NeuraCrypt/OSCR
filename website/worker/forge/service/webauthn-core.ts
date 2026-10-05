// The pure parts of WebAuthn (night phase 09, E5; docs/ACCOUNTS.md "Passkeys"): a minimal CBOR
// decoder, the COSE public key, the authenticator data, the DER-to-raw ECDSA conversion, the
// challenge cookie, and the signature check, with WebCrypto only (no dependency, nothing paid). The
// Worker verifies a registration and an assertion itself; it keeps only a PUBLIC key.
//
// OSCR uses passkeys for SUDO MODE (a step up while already signed in), not for the first sign-in
// (that is ORCID, GitHub or Google), so the account is always known and a credential is read by
// (user_id, cred_id): a key, never a scan.

import { base64url, fromBase64url, hmac, sameText, sha256 } from "../../account/crypto.ts";

// ─── a minimal CBOR decoder (the subset WebAuthn uses) ─────────────────────────

interface Cursor {
  b: Uint8Array;
  i: number;
}

function readLen(c: Cursor, info: number): number {
  if (info < 24) return info;
  if (info === 24) return c.b[c.i++];
  if (info === 25) {
    const v = (c.b[c.i] << 8) | c.b[c.i + 1];
    c.i += 2;
    return v;
  }
  if (info === 26) {
    const v = c.b[c.i] * 0x1000000 + (c.b[c.i + 1] << 16) + (c.b[c.i + 2] << 8) + c.b[c.i + 3];
    c.i += 4;
    return v;
  }
  if (info === 27) {
    // 64-bit length: WebAuthn never needs more than a few KiB, so the high word must be zero.
    const hi = c.b[c.i] * 0x1000000 + (c.b[c.i + 1] << 16) + (c.b[c.i + 2] << 8) + c.b[c.i + 3];
    const lo = c.b[c.i + 4] * 0x1000000 + (c.b[c.i + 5] << 16) + (c.b[c.i + 6] << 8) + c.b[c.i + 7];
    c.i += 8;
    if (hi !== 0) throw new Error("cbor length too large");
    return lo;
  }
  throw new Error("cbor indefinite length not supported");
}

/** A CBOR value: numbers, byte strings (Uint8Array), text strings, arrays, and maps (as a Map with
 *  number or string keys). Enough for an attestation object and a COSE key. */
export function decodeCbor(bytes: Uint8Array, start = 0): { value: unknown; end: number } {
  const c: Cursor = { b: bytes, i: start };
  const value = readItem(c);
  return { value, end: c.i };
}

function readItem(c: Cursor): unknown {
  const first = c.b[c.i++];
  const major = first >> 5;
  const info = first & 0x1f;
  switch (major) {
    case 0:
      return readLen(c, info); // unsigned int
    case 1:
      return -1 - readLen(c, info); // negative int
    case 2: {
      const len = readLen(c, info);
      const out = c.b.slice(c.i, c.i + len);
      c.i += len;
      return out;
    }
    case 3: {
      const len = readLen(c, info);
      const out = new TextDecoder().decode(c.b.slice(c.i, c.i + len));
      c.i += len;
      return out;
    }
    case 4: {
      const len = readLen(c, info);
      const arr: unknown[] = [];
      for (let k = 0; k < len; k++) arr.push(readItem(c));
      return arr;
    }
    case 5: {
      const len = readLen(c, info);
      const map = new Map<unknown, unknown>();
      for (let k = 0; k < len; k++) {
        const key = readItem(c);
        map.set(key, readItem(c));
      }
      return map;
    }
    case 7:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error("cbor simple value not supported");
    default:
      throw new Error(`cbor major type ${major} not supported`);
  }
}

// ─── the COSE public key ───────────────────────────────────────────────────────

export interface PublicKey {
  alg: -7 | -257;
  /** A JWK, ready for crypto.subtle.importKey. */
  jwk: JsonWebKey;
}

/** A COSE key map → {alg, jwk}, for ES256 (EC2 P-256) or RS256 (RSA), or null when it is neither. */
export function coseToKey(cose: Map<unknown, unknown>): PublicKey | null {
  const alg = cose.get(3);
  if (alg === -7) {
    const crv = cose.get(-1);
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) return null;
    return { alg: -7, jwk: { kty: "EC", crv: "P-256", x: base64url(x), y: base64url(y), ext: true } };
  }
  if (alg === -257) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) return null;
    return { alg: -257, jwk: { kty: "RSA", n: base64url(n), e: base64url(e), ext: true } };
  }
  return null;
}

// ─── authenticator data ─────────────────────────────────────────────────────────

export interface AuthData {
  rpIdHash: Uint8Array;
  up: boolean;
  uv: boolean;
  at: boolean;
  signCount: number;
  credId?: Uint8Array;
  cose?: Map<unknown, unknown>;
}

export function parseAuthData(bytes: Uint8Array): AuthData {
  if (bytes.length < 37) throw new Error("authenticator data too short");
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32];
  const signCount = bytes[33] * 0x1000000 + (bytes[34] << 16) + (bytes[35] << 8) + bytes[36];
  const out: AuthData = { rpIdHash, up: !!(flags & 0x01), uv: !!(flags & 0x04), at: !!(flags & 0x40), signCount };
  if (out.at) {
    // aaguid (16) + credIdLen (2) + credId + COSE key.
    const credIdLen = (bytes[53] << 8) | bytes[54];
    out.credId = bytes.slice(55, 55 + credIdLen);
    const { value } = decodeCbor(bytes, 55 + credIdLen);
    if (value instanceof Map) out.cose = value;
  }
  return out;
}

// ─── the DER → raw ECDSA signature ───────────────────────────────────────────────

/** A DER-encoded ECDSA signature (SEQUENCE of two INTEGERs) to the raw r||s of 64 bytes that
 *  WebCrypto's verify expects for P-256. */
export function derToRawEcdsa(der: Uint8Array): Uint8Array {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("not a DER sequence");
  // Length (one byte is enough for a P-256 signature).
  if (der[i] & 0x80) i += 1 + (der[i] & 0x7f);
  else i += 1;
  const readInt = (): Uint8Array => {
    if (der[i++] !== 0x02) throw new Error("not a DER integer");
    let len = der[i++];
    let v = der.slice(i, i + len);
    i += len;
    // Drop a leading zero (sign byte); left-pad to 32.
    while (v.length > 0 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error("integer too long");
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

// ─── the signature check ─────────────────────────────────────────────────────────

/** Verify an assertion's signature: data = authenticatorData || SHA-256(clientDataJSON), signed by
 *  the stored public key (ES256: DER ECDSA; RS256: PKCS#1 v1.5). */
export async function verifyAssertion(key: PublicKey, authData: Uint8Array, clientDataJSON: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const clientHash = await sha256Bytes(clientDataJSON);
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0);
  signed.set(clientHash, authData.length);
  if (key.alg === -7) {
    const pub = await crypto.subtle.importKey("jwk", key.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    let raw: Uint8Array;
    try {
      raw = derToRawEcdsa(signature);
    } catch {
      return false;
    }
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, raw as Uint8Array<ArrayBuffer>, signed as Uint8Array<ArrayBuffer>);
  }
  const pub = await crypto.subtle.importKey("jwk", key.jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, pub, signature as Uint8Array<ArrayBuffer>, signed as Uint8Array<ArrayBuffer>);
}

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** The SHA-256 of an rpId (its bytes), to compare with the authenticator data's rpIdHash. */
export async function rpIdHash(rpId: string): Promise<Uint8Array> {
  return sha256(rpId);
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ─── the client data ─────────────────────────────────────────────────────────────

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

export function parseClientData(json: Uint8Array): ClientData | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(json)) as Record<string, unknown>;
    if (typeof v.type !== "string" || typeof v.challenge !== "string" || typeof v.origin !== "string") return null;
    return { type: v.type, challenge: v.challenge, origin: v.origin };
  } catch {
    return null;
  }
}

// ─── the challenge cookie (a server-signed, short-lived value bound to the session) ──────────────

export const CHALLENGE_COOKIE = "__Host-oscr_wachal";
export const CHALLENGE_SECONDS = 300;
/** How long sudo mode lasts after a passkey assertion. */
export const SUDO_SECONDS = 600;

/** A fresh challenge (32 random bytes, base64url). */
export function newChallenge(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The cookie value binding a challenge to a session and a purpose ("create" or "get"), for
 *  CHALLENGE_SECONDS. Signed under the server key: the browser cannot forge one. */
export async function signChallenge(key: string, purpose: string, sessionHash: string, challenge: string, t: number): Promise<string> {
  const ts = Math.floor(t);
  const sig = await hmac(key, "webauthn", `${purpose}:${sessionHash}:${ts}:${challenge}`);
  return `${ts}.${challenge}.${sig}`;
}

/** The challenge a signed cookie carries, when it is this session's, this purpose's, and not older
 *  than CHALLENGE_SECONDS; else null. */
export async function openChallenge(key: string, purpose: string, sessionHash: string, cookie: string | null, t: number): Promise<string | null> {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [tsText, challenge, sig] = parts;
  const ts = Number(tsText);
  if (!Number.isInteger(ts) || !/^[A-Za-z0-9_-]+$/.test(challenge)) return null;
  if (Math.floor(t) - ts > CHALLENGE_SECONDS || ts > Math.floor(t) + 60) return null;
  const expected = await hmac(key, "webauthn", `${purpose}:${sessionHash}:${ts}:${challenge}`);
  return sameText(expected, sig) ? challenge : null;
}

/** A base64url text as bytes, or null when it is not base64url. */
export function bytesOf(b64: string): Uint8Array | null {
  try {
    return fromBase64url(b64);
  } catch {
    return null;
  }
}

export { base64url };
