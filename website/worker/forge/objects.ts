// Bytes as git sees them, shared by the adapters, the test double and the browser: a blob's id,
// git's binary rule, Git LFS pointers, hex and base64. WebCrypto only (workerd, Node, browsers).
//
// - A blob's id is the SHA-1 of "blob <size>\0" + bytes (the empty blob is
//   e69de29bb2d1d6434b8b29ae775ad8c2e48c5391; "hello world\n" is
//   3b18e512dba79e4c8300dd08aeb37f8e728b8dad). A raw read computes it locally, since the raw
//   CDN does not send it.
// - Binary: a NUL byte in the first 8,000 bytes (git's `buffer_is_binary`).
// - An LFS pointer is returned as is, with `lfs` set: its object is never fetched, since the
//   download would spend the owner's LFS bandwidth (D00-9). Pointers are under 1,024 bytes
//   (https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md).

import type { FileContent, ObjectId } from "./types.ts";

const encoder = new TextEncoder();

/** A text's UTF-8 bytes (over a plain ArrayBuffer, as WebCrypto wants them). */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/** Bytes as text, replacing what is not UTF-8. */
export function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Whether the bytes are valid UTF-8. */
export function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(h: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(h)) throw new Error("not hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** The runtime's own base64 (Uint8Array.prototype.toBase64, Uint8Array.fromBase64), when it has
 *  them: a web commit's 1 MiB is encoded in 0.15 ms there, 1.4 to 2 ms with the table below, and
 *  took 20 ms through String.fromCharCode and btoa (measured in V8, Node 26 and 22, 2026-09-29):
 *  too much for a Worker's 10 ms of CPU. */
const native = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array };
const hasToBase64 = typeof (Uint8Array.prototype as unknown as { toBase64?: unknown }).toBase64 === "function";
const ALPHABET = new TextEncoder().encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");

export function base64(bytes: Uint8Array): string {
  if (hasToBase64) return (bytes as unknown as { toBase64(): string }).toBase64();
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = ALPHABET[n >>> 18];
    out[o++] = ALPHABET[(n >>> 12) & 63];
    out[o++] = ALPHABET[(n >>> 6) & 63];
    out[o++] = ALPHABET[n & 63];
  }
  if (i < bytes.length) {
    const two = i + 1 < bytes.length;
    const n = (bytes[i] << 16) | ((two ? bytes[i + 1] : 0) << 8);
    out[o++] = ALPHABET[n >>> 18];
    out[o++] = ALPHABET[(n >>> 12) & 63];
    out[o++] = two ? ALPHABET[(n >>> 6) & 63] : 61;
    out[o++] = 61;
  }
  return new TextDecoder().decode(out);
}

export function fromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  if (native.fromBase64) return native.fromBase64(clean);
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function sha1(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>));
}

/** A git object's id: SHA-1 of "<type> <size>\0" + body. */
export async function objectId(type: "blob" | "tree" | "commit" | "tag", body: Uint8Array): Promise<ObjectId> {
  return hex(await sha1(concat([utf8(`${type} ${body.length}\u0000`), body])));
}

export function blobId(bytes: Uint8Array): Promise<ObjectId> {
  return objectId("blob", bytes);
}

/** git's rule: a NUL byte in the first 8,000 bytes. */
export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

const LFS_VERSION = "version https://git-lfs.github.com/spec/v1\n";

/** The LFS object a pointer names, or null when the bytes are not a pointer. */
export function lfsPointer(bytes: Uint8Array): { oid: string; size: number } | null {
  if (bytes.length >= 1024 || bytes.length < LFS_VERSION.length) return null;
  const t = text(bytes);
  if (!t.startsWith(LFS_VERSION)) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(t);
  const size = /^size (\d{1,15})$/m.exec(t);
  return oid && size ? { oid: oid[1], size: Number(size[1]) } : null;
}

/** A file's content as GitBackend returns it; the blob id is computed when not given. */
export async function fileContent(path: string, bytes: Uint8Array, sha?: ObjectId | null): Promise<FileContent> {
  return {
    path,
    sha: sha ?? (await blobId(bytes)),
    size: bytes.length,
    bytes,
    binary: isBinary(bytes),
    lfs: lfsPointer(bytes),
  };
}
