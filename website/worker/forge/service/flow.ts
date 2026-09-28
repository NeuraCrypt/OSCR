// One authorized action in progress (D00-4; the design's §10.2 step 2, and §17). Between start and
// act the Worker keeps nothing in D1: the flow lives in a short cookie, `__Host-oscr_forge`
// (FLOW_SECONDS, 10 minutes; HttpOnly, Secure, SameSite=Lax, Path=/, no Domain), signed with the
// server key under the HMAC purpose "forge": a value signed for the sign-in's flow ("flow") or a
// CSRF token ("csrf") is never valid here, and a forge flow is never valid there
// (account/crypto.ts `hmac` puts the purpose in what it signs).
//
// It holds:
// - `st`, the `state` sent to GitHub: the callback must bring it back to this browser (the cookie),
//   which stops a forged callback;
// - `cv`, the PKCE verifier: only its SHA-256 went to GitHub; the verifier goes with the code's
//   exchange, server to server;
// - `act`, the declared action: its kind, the forge, the repository (by id or by path), the branch,
//   the head the page saw, and the SHA-256 of the payload the page keeps: act runs that action and
//   no other;
// - `sid`, the hash of the session that started it: act requires the same session;
// - `rt`, the page to come back to: a path of this site only;
// - `ins`, whether the flow went through the App's installation page;
// - `exp`, when it stops being valid.
// No token is ever in it: the token only exists during act.

import { base64url, fromBase64url, hmac, hmacCheck } from "../../account/crypto.ts";
import { clearCookie, setCookie } from "../../account/http.ts";
import { isRefName, OBJECT_ID, SEGMENT } from "../paths.ts";
import { FLOW_SECONDS } from "./caps.ts";
import { isActionKind, type ActionKind, type RepoTarget } from "./types.ts";

export const FORGE_COOKIE = "__Host-oscr_forge";
/** The HMAC purpose of the flow cookie: never "flow" (the sign-in's) or "csrf". */
export const FORGE_PURPOSE = "forge";
/** The static callback page (the App's callback URL, GitHub's `redirect_uri`). */
export const CALLBACK_PATH = "/forge/authorized/";
/** A flow cookie longer than this is not read at all. */
const MAX_COOKIE = 4096;

/** The action a flow authorizes, as the page declared it at start. */
export interface FlowAction {
  kind: ActionKind;
  /** The forge of the backend that started it ("github"; "memory" in the tests). */
  forge: string;
  repo: RepoTarget | null;
  branch: string | null;
  expectedHead: string | null;
  /** SHA-256 (hex, lower case) of the payload's exact text. */
  digest: string;
}

export interface ForgeFlow {
  v: 1;
  st: string;
  cv: string;
  act: FlowAction;
  sid: string;
  rt: string;
  ins: boolean;
  exp: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]{43,128}$/;

/** A path of this site to come back to, or null: "/…" with the characters of a page's path only,
 *  never "//" (another host), never a backslash, never /api/, at most 200 characters. */
export function sameOriginPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return null;
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(value) || value.startsWith("//") || value.startsWith("/api/")) return null;
  if (value.split("/").some((segment) => segment === "..")) return null;
  return value;
}

/** A repository as a page names it, checked: `{forge, id}` (digits) or `{forge, owner, name}`. The
 *  forge must be `forge` (the backend's own). */
export function repoTarget(value: unknown, forge: string): RepoTarget | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (r.forge !== forge) return undefined;
  if ("id" in r) {
    if (typeof r.id !== "string" || !/^\d{1,20}$/.test(r.id) || "owner" in r || "name" in r) return undefined;
    return { forge, id: r.id } as RepoTarget;
  }
  if (typeof r.owner !== "string" || !SEGMENT.test(r.owner) || typeof r.name !== "string" || !SEGMENT.test(r.name) || /\.git$/i.test(r.name)) {
    return undefined;
  }
  return { forge, owner: r.owner, name: r.name } as RepoTarget;
}

/** Whether a decoded value is a flow this code wrote (every field has its shape). */
function isFlow(f: unknown): f is ForgeFlow {
  if (!f || typeof f !== "object") return false;
  const x = f as Record<string, unknown>;
  if (x.v !== 1 || typeof x.exp !== "number" || !Number.isFinite(x.exp)) return false;
  if (typeof x.st !== "string" || !B64URL.test(x.st) || typeof x.cv !== "string" || !B64URL.test(x.cv)) return false;
  if (typeof x.sid !== "string" || !HEX64.test(x.sid) || sameOriginPath(x.rt) === null || typeof x.ins !== "boolean") return false;
  const a = x.act as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object" || !isActionKind(a.kind) || typeof a.forge !== "string" || typeof a.digest !== "string" || !HEX64.test(a.digest)) return false;
  if (repoTarget(a.repo, a.forge) === undefined) return false;
  if (!(a.branch === null || isRefName(a.branch))) return false;
  if (!(a.expectedHead === null || (typeof a.expectedHead === "string" && OBJECT_ID.test(a.expectedHead)))) return false;
  return true;
}

/** The cookie's value: base64url(JSON) "." HMAC-SHA-256 under the purpose "forge". */
export async function sealForgeFlow(key: string, flow: ForgeFlow): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(flow)));
  return `${body}.${await hmac(key, FORGE_PURPOSE, body)}`;
}

/** The flow of this cookie, when the server signed it for "forge", it has the right shape and it
 *  has not expired; otherwise null. */
export async function openForgeFlow(key: string, value: string | null | undefined, now: number): Promise<ForgeFlow | null> {
  if (!value || value.length > MAX_COOKIE) return null;
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra !== undefined) return null;
  if (!(await hmacCheck(key, FORGE_PURPOSE, body, signature))) return null;
  let flow: unknown;
  try {
    flow = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
  } catch {
    return null;
  }
  if (!isFlow(flow) || flow.exp < now) return null;
  return flow;
}

/** The Set-Cookie of a flow (10 minutes). */
export async function flowCookie(key: string, flow: ForgeFlow): Promise<string> {
  return setCookie(FORGE_COOKIE, await sealForgeFlow(key, flow), FLOW_SECONDS);
}

/** The Set-Cookie that ends a flow. */
export function clearFlowCookie(): string {
  return clearCookie(FORGE_COOKIE);
}

/** GitHub's `redirect_uri`: https://<site>/forge/authorized/. The App's callback URL must be
 *  exactly this (docs/FORGE.md, the owner's steps). */
export function callbackUrl(origin: string): string {
  return `${origin}${CALLBACK_PATH}`;
}

/** A request's body as text, at most `max` bytes (null above: the stream is cancelled there, and
 *  a declared Content-Length above is not read at all). Read once, never cloned. */
export async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}
