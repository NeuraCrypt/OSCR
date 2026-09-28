// The ID tokens of ORCID and Google (OpenID Connect): an RS256 signature checked with WebCrypto
// against the provider's published keys (JWKS), then the claims: issuer, audience, expiry, nonce.
// One RSA verification costs a fraction of a millisecond of CPU; the keys are fetched once per
// isolate and hour (one subrequest), and again when a token names a key not seen yet (rotation).

import { type Bytes, fromBase64url, sameText } from "./crypto.ts";

export interface Jwk {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  azp?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  [claim: string]: unknown;
}

export interface Expected {
  jwksUri: string;
  /** The accepted `iss` values (Google writes its issuer with and without https://). */
  issuers: string[];
  /** The client id: the token must be meant for this application. */
  audience: string;
  /** The nonce sent with this sign-in's authorization request. */
  nonce: string;
  /** Unix seconds. */
  now: number;
}

export class IdTokenError extends Error {}

/** Seconds of clock difference tolerated between the provider and the Worker. */
const SKEW = 120;
const KEYS_TTL = 3600;
const keySets = new Map<string, { at: number; keys: Jwk[] }>();
const imported = new Map<string, Promise<CryptoKey>>();

async function fetchKeys(uri: string, now: number, fresh: boolean): Promise<Jwk[]> {
  const hit = keySets.get(uri);
  if (hit && !fresh && now - hit.at < KEYS_TTL) return hit.keys;
  const res = await fetch(uri, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new IdTokenError(`the provider's keys answered ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? (body.keys as Jwk[]) : [];
  keySets.set(uri, { at: now, keys });
  return keys;
}

/** The provider's signing key for this token: the one its `kid` names or, without a `kid`, the
 *  only RSA signing key published. */
function pick(keys: Jwk[], kid: string | undefined): Jwk | undefined {
  const rsa = keys.filter((k) => k.kty === "RSA" && (!k.use || k.use === "sig") && (!k.alg || k.alg === "RS256") && k.n && k.e);
  if (kid === undefined) return rsa.length === 1 ? rsa[0] : undefined;
  return rsa.find((k) => k.kid === kid);
}

function importKey(uri: string, jwk: Jwk): Promise<CryptoKey> {
  const id = `${uri}\n${jwk.kid ?? ""}\n${jwk.n}`;
  let key = imported.get(id);
  if (!key) {
    key = crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    key.catch(() => imported.delete(id));
    imported.set(id, key);
  }
  return key;
}

function part<T>(text: string, what: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(text))) as T;
  } catch {
    throw new IdTokenError(`the token's ${what} is not JSON`);
  }
}

export function decode(token: string): { header: { alg?: string; kid?: string }; claims: IdClaims; signed: string; signature: Bytes } {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || token.length > 16_384) throw new IdTokenError("not a signed JWT");
  let signature: Bytes;
  try {
    signature = fromBase64url(parts[2]);
  } catch {
    throw new IdTokenError("the token's signature is not base64url");
  }
  return {
    header: part(parts[0], "header"),
    claims: part(parts[1], "claims"),
    signed: `${parts[0]}.${parts[1]}`,
    signature,
  };
}

/** The claims OpenID Connect Core §3.1.3.7 asks a client to check. */
export function checkClaims(claims: IdClaims, expect: Expected): void {
  if (!claims || typeof claims !== "object") throw new IdTokenError("no claims");
  if (typeof claims.iss !== "string" || !expect.issuers.includes(claims.iss)) throw new IdTokenError("unexpected issuer");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(expect.audience)) throw new IdTokenError("the token is for another application");
  if ((audience.length > 1 || claims.azp !== undefined) && claims.azp !== expect.audience) {
    throw new IdTokenError("the token was issued to another party");
  }
  if (typeof claims.exp !== "number" || claims.exp + SKEW < expect.now) throw new IdTokenError("the token has expired");
  if (typeof claims.iat === "number" && claims.iat - SKEW > expect.now) throw new IdTokenError("the token is from the future");
  if (typeof claims.nonce !== "string" || !sameText(claims.nonce, expect.nonce)) throw new IdTokenError("the nonce does not match");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new IdTokenError("the token names nobody");
}

/** The claims of `token` once its signature and claims are checked; throws IdTokenError. */
export async function verifyIdToken(token: string, expect: Expected): Promise<IdClaims> {
  const { header, claims, signed, signature } = decode(token);
  if (header.alg !== "RS256") throw new IdTokenError(`unexpected algorithm ${String(header.alg)}`);
  let jwk = pick(await fetchKeys(expect.jwksUri, expect.now, false), header.kid);
  if (!jwk) jwk = pick(await fetchKeys(expect.jwksUri, expect.now, true), header.kid);
  if (!jwk) throw new IdTokenError("no published key of the provider signed this token");
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    await importKey(expect.jwksUri, jwk),
    signature,
    new TextEncoder().encode(signed),
  );
  if (!valid) throw new IdTokenError("the signature is not the provider's");
  checkClaims(claims, expect);
  return claims;
}

/** Forget the keys fetched (tests). */
export function forgetKeys(): void {
  keySets.clear();
  imported.clear();
}
