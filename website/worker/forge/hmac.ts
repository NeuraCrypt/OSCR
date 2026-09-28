// HMAC-SHA-256 over a webhook's raw body, checked in constant time by WebCrypto's own verify
// (as account/crypto.ts::hmacCheck does). Shared by GitHub's codec (X-Hub-Signature-256) and the
// test double's (X-Memory-Signature). The imported keys are cached per isolate, by secret.

import { fromHex, hex, utf8 } from "./objects.ts";

const keys = new Map<string, Promise<CryptoKey>>();

function key(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", utf8(secret) as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    k.catch(() => keys.delete(secret));
    keys.set(secret, k);
  }
  return k;
}

/** "sha256=<hex>" of the body under the secret. */
export async function signBody(secret: string, body: Uint8Array): Promise<string> {
  return `sha256=${hex(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), body as Uint8Array<ArrayBuffer>)))}`;
}

/** Whether `header` ("sha256=<64 hex>") signs the body under the secret; constant time. */
export async function checkBody(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  if (!secret || typeof header !== "string") return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  return crypto.subtle.verify("HMAC", await key(secret), fromHex(m[1]) as Uint8Array<ArrayBuffer>, body as Uint8Array<ArrayBuffer>);
}
