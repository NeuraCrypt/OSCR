// The GitHub App acting as itself: its JWT, and the installation tokens minted with it. WebCrypto
// only: no JWT library.
//
// The App's JWT (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app):
// - header {"alg":"RS256","typ":"JWT"}, claims {iat: now − 60, exp: now + 540, iss}: GitHub takes
//   the client ID (preferred) or the App ID as `iss`, and a lifetime of 10 minutes at most;
// - signed with RSASSA-PKCS1-v1_5 / SHA-256.
// - The key: WebCrypto imports PKCS#8 only, and GitHub hands out a PKCS#1 PEM ("-----BEGIN RSA
//   PRIVATE KEY-----"). Both are accepted: a PKCS#1 key is wrapped into PKCS#8 DER before
//   importKey, so the owner can paste GitHub's file as it is (as the Cloudflare secret
//   GITHUB_APP_PRIVATE_KEY). The wrapper:
//     30 <len>                                       SEQUENCE
//        02 01 00                                    INTEGER 0 (version)
//        30 0d 06 09 2a 86 48 86 f7 0d 01 01 01 05 00  AlgorithmIdentifier rsaEncryption, NULL
//        04 <len> <PKCS#1 DER>                       OCTET STRING
//   DER lengths: under 128, one byte; otherwise 0x80 | n, then n big-endian bytes.
// - The imported CryptoKey is cached per isolate. Signing costs about a millisecond of CPU and
//   happens only when an installation token is minted.
//
// Installation tokens: POST /app/installations/{id}/access_tokens with the JWT, narrowed to one
// repository and to the permissions the act needs (reading, or `checks: write` for OSCR's check
// run). The answer is {token, expires_at} (one hour). They are cached in a Map, in memory only
// (never D1, KV, a cookie or a log), until 5 minutes before they expire; the factory takes the
// map (`deps.tokenCache`) so the tests can see it. Requests that start together share one mint.
// Each mint counts one request and one `mints`.

import { GitBackendError } from "../errors.ts";
import { concat, fromBase64, utf8 } from "../objects.ts";
import type { Http } from "./http.ts";
import * as map from "./map.ts";

export type TokenCache = Map<string, { token: string; exp: number }>;

/** The isolate's installation tokens, when the caller gives no cache of its own. */
export const TOKEN_CACHE: TokenCache = new Map();

/** Seconds before expiry when a cached token is no longer used. */
export const TOKEN_MARGIN = 300;

/** What an installation token may do, per act (the App's permissions, narrowed). */
export const TOKEN_PERMISSIONS: Record<"read" | "check", Record<string, "read" | "write">> = {
  read: { metadata: "read", contents: "read", pull_requests: "read", issues: "read", checks: "read" },
  check: { metadata: "read", checks: "write" },
};

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function derLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

const RSA_ALGORITHM = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);

/** A PKCS#1 RSAPrivateKey wrapped as a PKCS#8 PrivateKeyInfo. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const octets = concat([Uint8Array.of(0x04), derLength(pkcs1.length), pkcs1]);
  const content = concat([Uint8Array.of(0x02, 0x01, 0x00), RSA_ALGORITHM, octets]);
  return concat([Uint8Array.of(0x30), derLength(content.length), content]);
}

const notAKey = () => new GitBackendError("unsupported", "the GitHub App's key is not a PEM private key");

/** The PKCS#8 DER of a PEM private key, PKCS#1 or PKCS#8. Tolerates "\n" written as two
 *  characters (a secret pasted on one line). */
export function pemToPkcs8(pem: string): Uint8Array {
  if (typeof pem !== "string") throw notAKey();
  const clean = pem.replace(/\\n/g, "\n").trim();
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(clean);
  if (!m || Boolean(m[1]) !== Boolean(m[3])) throw notAKey();
  let der: Uint8Array;
  try {
    der = fromBase64(m[2].replace(/\s+/g, ""));
  } catch {
    throw notAKey();
  }
  return m[1] ? pkcs1ToPkcs8(der) : der;
}

const imported = new Map<string, Promise<CryptoKey>>();

export function importAppKey(pem: string): Promise<CryptoKey> {
  let key = imported.get(pem);
  if (!key) {
    key = Promise.resolve()
      .then(() => pemToPkcs8(pem))
      .then((der) => crypto.subtle.importKey("pkcs8", der as Uint8Array<ArrayBuffer>, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]))
      .catch((e: unknown) => {
        imported.delete(pem);
        throw e instanceof GitBackendError ? e : notAKey();
      });
    imported.set(pem, key);
  }
  return key;
}

/** The App's JWT, valid 10 minutes at most (issued a minute early for clock drift). */
export async function appJwt(o: { issuer: string; privateKey: string; now: number }): Promise<string> {
  const header = b64url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(utf8(JSON.stringify({ iat: o.now - 60, exp: o.now + 540, iss: o.issuer })));
  const signed = `${header}.${claims}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importAppKey(o.privateKey), utf8(signed) as Uint8Array<ArrayBuffer>);
  return `${signed}.${b64url(new Uint8Array(signature))}`;
}

export interface MintInput {
  http: Http;
  installationId: string;
  repo?: string | null;
  permissions: Record<string, string>;
  issuer: string;
  privateKey: string;
  now: number;
  cache: TokenCache;
}

/** An installation token for this act on this repository, from the cache or freshly minted. */
export async function installationToken(o: MintInput): Promise<string> {
  const perms = Object.keys(o.permissions)
    .sort()
    .map((k) => `${k}:${o.permissions[k]}`)
    .join(",");
  const key = `${o.installationId}\n${o.repo ?? ""}\n${perms}`;
  const hit = o.cache.get(key);
  if (hit && hit.exp - TOKEN_MARGIN > o.now) return hit.token;
  if (hit) o.cache.delete(key);
  // Requests that start together share one mint.
  const inFlight = minting.get(o.cache)?.get(key);
  if (inFlight) return inFlight;
  const mint = mintToken(o, key);
  const forCache = minting.get(o.cache) ?? new Map<string, Promise<string>>();
  minting.set(o.cache, forCache);
  forCache.set(key, mint);
  try {
    return await mint;
  } finally {
    forCache.delete(key);
  }
}

/** The mints in flight, per cache. */
const minting = new WeakMap<TokenCache, Map<string, Promise<string>>>();

async function mintToken(o: MintInput, key: string): Promise<string> {
  const jwt = await appJwt({ issuer: o.issuer, privateKey: o.privateKey, now: o.now });
  const answer = map.obj(
    await o.http.json({
      method: "POST",
      path: `/app/installations/${encodeURIComponent(o.installationId)}/access_tokens`,
      json: { repositories: o.repo ? [o.repo] : undefined, permissions: o.permissions },
      authorization: `Bearer ${jwt}`,
      write: false,
      mint: true,
    }),
    "access token",
  );
  const token = map.str(answer, "token");
  const exp = Math.floor(Date.parse(map.str(answer, "expires_at")) / 1000);
  if (!token || !Number.isFinite(exp)) throw new GitBackendError("unavailable", "unexpected answer from the forge (access token)");
  o.cache.set(key, { token, exp });
  return token;
}
