// POST /api/forge/asset: a release asset, attached as the person (night phase 07, E5; docs/RELEASES.md;
// D00-4, D00-9, D07-*). The second half of the authorized action `asset_upload` (act-releases.ts), for
// a file: the page confirmed {release, name, label?, size, sha256, contentType} at start, GitHub
// authorized it, and the callback page posts the file itself as this request's body.
//
// Signed in (Origin, CSRF), like act. The completion comes in headers, the file as the body:
//   X-Forge-Code, X-Forge-State   what GitHub brought back
//   X-Forge-Payload               the payload's exact text, base64url (its SHA-256 was bound at start)
//   Content-Length                the file's length, required: at most ASSET_UPLOAD_BYTES (25 MiB),
//                                 else 413 before anything is read; it must be the payload's `size`
//   the body                      the file, raw: never parsed, never buffered, never hashed here (the
//                                 Worker's 10 ms of CPU): streamed to GitHub's upload host, its length
//                                 held to the one declared (a longer or shorter body fails the upload)
// Then the same steps as act (act.ts `runAction`): the flow, the payload's digest, the spec's checks,
// the exchange, the identity, FORGE_OPEN, the caps, the upload as the person, GitHub's answer checked
// (the size, and GitHub's own SHA-256 against the one the page computed: a different file is removed
// again), the action row. Only `asset_upload` completes here; act never carries a file.
//
// Larger files go on GitHub's own release page (up to 2 GiB), or to Zenodo or Hugging Face (D00-9);
// the registry never downloads an asset itself.

import { signedIn } from "../../account/guard.ts";
import { runAction } from "./act.ts";
import { ASSET_UPLOAD_BYTES } from "./caps.ts";
import { clearFlowCookie } from "./flow.ts";
import { problemAnswer } from "./http.ts";
import { ForgeProblem, type ForgeRequest } from "./types.ts";

/** The payload's text in a header: base64url, at most this long (the payload is a few hundred bytes). */
export const PAYLOAD_HEADER_CHARS = 8 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });

/** base64url (no padding) → the UTF-8 text, or null. */
export function fromBase64url(value: string | null): string | null {
  if (!value || value.length > PAYLOAD_HEADER_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
    return decoder.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** The text as base64url (the callback page's side). */
export function toBase64url(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The body held to its declared length: more bytes, or fewer, and the stream fails (the upload with
 *  it, before anything is recorded). In workerd, a FixedLengthStream carries the length to GitHub. */
export function heldTo(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  let seen = 0;
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        seen += chunk.byteLength;
        if (seen > size) ctl.error(new Error("the file is longer than declared"));
        else ctl.enqueue(chunk);
      },
      flush(ctl) {
        if (seen !== size) ctl.error(new Error("the file is shorter than declared"));
      },
    }),
  );
  const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  if (typeof Fixed !== "function") return counted;
  const fixed = new Fixed(size);
  void counted.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}

function tooLarge(): ForgeProblem {
  return new ForgeProblem(
    413,
    "too_large",
    `A file passes through the registry up to ${ASSET_UPLOAD_BYTES / 2 ** 20} MiB: a larger one goes on GitHub's own release page (up to 2 GiB), or to Zenodo or Hugging Face. Nothing was done.`,
  );
}

export async function handleAsset(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  // Every answer from here ends the flow (one authorization, one attempt).
  const cookies = [...s.cookies, clearFlowCookie()];
  const say = (p: ForgeProblem) => problemAnswer(p, cookies);
  const h = r.request.headers;
  const length = Number(h.get("Content-Length") ?? "");
  if (!Number.isInteger(length) || length < 1) return say(new ForgeProblem(411, "length_required", "The file's length is not said: choose the file again, then attach it."));
  if (length > ASSET_UPLOAD_BYTES) return say(tooLarge());
  const code = h.get("X-Forge-Code") ?? "";
  const state = h.get("X-Forge-State") ?? "";
  const payload = fromBase64url(h.get("X-Forge-Payload"));
  if (!code || code.length > 200 || !state || state.length > 256 || payload === null || !r.request.body) {
    return say(new ForgeProblem(400, "bad_request", "The request is not the completion of a file's attachment."));
  }
  return runAction(r, s, cookies, { code, state, payload }, { upload: { body: heldTo(r.request.body, length), size: length }, kind: "asset_upload" });
}
