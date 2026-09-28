// Randomness, hashes, HMAC and base64url, with WebCrypto only (the Workers runtime and Node share
// it). All cheap: a SHA-256 or an HMAC of a few bytes costs microseconds of CPU.

const encoder = new TextEncoder();

/** Bytes as the runtime's Web Crypto takes them. */
export type Bytes = ReturnType<typeof fromBase64url>;

export function randomBytes(n: number) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of a base64url text; throws when it is not one. */
export function fromBase64url(text: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A random secret as text: 32 bytes (256 bits) are 43 base64url characters. */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export async function sha256(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function sha256Hex(text: string): Promise<string> {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** PKCE (RFC 7636, method S256): the challenge sent with the authorization request; the verifier
 *  itself only travels with the code's exchange, server to server. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(verifier));
}

const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keys.set(secret, key);
  }
  return key;
}

/** HMAC-SHA-256 of `message` under the server key, for one `purpose` ("flow", "csrf"): a value
 *  signed for one purpose is never valid for another. */
export async function hmac(secret: string, purpose: string, message: string): Promise<string> {
  return base64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`${purpose}\n${message}`)));
}

/** Whether `signature` is `hmac(secret, purpose, message)`, compared in constant time. */
export async function hmacCheck(secret: string, purpose: string, message: string, signature: string): Promise<boolean> {
  let sig: Bytes;
  try {
    sig = fromBase64url(signature);
  } catch {
    return false;
  }
  if (sig.length !== 32) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), sig, encoder.encode(`${purpose}\n${message}`));
}

/** Two strings compared in a time that does not depend on where they differ. */
export function sameText(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
