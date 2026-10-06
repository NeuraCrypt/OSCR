// The GitHub adapter's request core: every request of a session goes through `Http`, and every
// answer that is not a success becomes a GitBackendError here.
//
// - Headers: `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` and
//   `User-Agent: code-registry-forge` (it does not name the platform). Authenticated sessions add
//   `Authorization: Bearer <token>`; an anonymous session sends none. Raw, diff and sha reads ask
//   for application/vnd.github.raw, .diff and .sha. Reads of the raw CDN send no header at all,
//   so a browser needs no CORS preflight there.
// - URLs: the configured base URLs only, path segments escaped. A cursor is a page number
//   (/^\d{1,5}$/) or a GraphQL end cursor, never an address: the Worker never fetches an address
//   a client chose. The `Link` header is read only to learn whether a next page exists.
// - Errors: the table below, in this order. The bodies behind errors are read at most to 4 KB,
//   to classify them; they are never copied into a message. A message never holds a token, a
//   header or a query string.
//     network error, timeout, abort          → unavailable
//     5xx                                    → unavailable (retryAfter from Retry-After)
//     401                                    → unauthorized
//     403/429, x-ratelimit-remaining: 0      → rate_limited, primary, retryAfter = reset − now
//                                              (≥ 1); anonymous: fallbackUrl = the same view on
//                                              the forge
//     403/429 with retry-after               → rate_limited, secondary, retryAfter = its value
//     403/429 saying "rate limit"            → rate_limited, secondary, 60 s (GitHub: "wait at
//                                              least one minute")
//     403 saying the repository is archived  → archived
//     other 403                              → forbidden
//     404                                    → not_found
//     405 on a pull request's merge          → not_mergeable
//     409 on a commit list ("Git Repository is empty") → not an error: the caller's empty page
//     other 409                              → conflict
//     410, 451                               → gone
//     413                                    → too_large
//     422 "No commit found for SHA" (an unknown revision), "Reference does not exist" → not_found
//     422 "already exists", "not a fast forward", "expected head sha" → conflict
//     other 422, other 4xx                   → invalid
//     a 2xx whose JSON is not the expected shape → unavailable ("unexpected answer", map.ts)
//   GraphQL (200 with `errors`): NOT_FOUND → not_found; a message saying the repository is
//   archived → archived; FORBIDDEN, INSUFFICIENT_SCOPES → forbidden; RATE_LIMITED → rate_limited; STALE_DATA or createCommitOnBranch's "expected branch
//   to point to" → conflict; input errors → invalid; anything else → unavailable. These types and
//   messages are GitHub's documented ones; check them against real answers once the App exists.
// - No automatic retry, on `rate_limited` above all: GitHub may ban an integration that keeps
//   calling while it is limited.
// - Counting (`cost()`): every request adds one to `requests`; a POST, PATCH, PUT or DELETE, a
//   GraphQL mutation or an upload also adds to `writes`; GraphQL calls to `graphql`; token mints
//   to `mints`. An anonymous read of the raw CDN is not counted (the reader's own quota).
// - Concurrency and timeouts: at most 6 requests waiting for headers per session (the Workers
//   limit on open connections), each with AbortSignal.timeout (10 s; uploads 60 s).

import { GitBackendError, invalid } from "../errors.ts";
import { checkPage } from "../paths.ts";
import type { Cost, CredentialKind, PageRequest } from "../types.ts";

export const USER_AGENT = "code-registry-forge";
export const API_VERSION = "2022-11-28";
export const MEDIA = {
  json: "application/vnd.github+json",
  raw: "application/vnd.github.raw",
  diff: "application/vnd.github.diff",
  sha: "application/vnd.github.sha",
  textMatch: "application/vnd.github.text-match+json",
} as const;

export interface Endpoints {
  web: string;
  api: string;
  uploads: string;
  raw: string;
}

/** What a request does, for an installation session's token (narrowed to one repository and to
 *  the permissions the act needs). */
export interface Scope {
  act: "read" | "write" | "check";
  repo?: string | null;
}

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface Req {
  method?: Method;
  base?: keyof Endpoints;
  /** Escaped already, starting with "/". */
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  json?: unknown;
  body?: Uint8Array | ReadableStream<Uint8Array> | URLSearchParams;
  contentType?: string;
  contentLength?: number;
  accept?: string;
  scope?: Scope;
  /** Overrides the session's authorization ("" or null: none). */
  authorization?: string | null;
  /** Counts as a write; default: any method but GET. */
  write?: boolean;
  graphql?: boolean;
  mint?: boolean;
  /** Counted in cost(); default true. */
  counted?: boolean;
  /** No GitHub header (the raw CDN). */
  bare?: boolean;
  /** The forge page of the same view: an anonymous reader's fallback when rate limited. */
  view?: string | null;
  /** Statuses returned to the caller instead of thrown. */
  ok?: number[];
  /** Where a status means more than the table says. */
  context?: "pull-merge";
  /** How messages name the request, when its path holds a value that stays out of logs. */
  label?: string;
  timeoutMs?: number;
}

export interface HttpOptions {
  fetch: typeof fetch;
  now: () => number;
  endpoints: Endpoints;
  timeoutMs: number;
  uploadTimeoutMs?: number;
  kind: CredentialKind;
  /** The Authorization header's value for a request of this scope; null: none. */
  authorization: (scope: Scope) => Promise<string | null>;
  maxConcurrent?: number;
}

export const unexpected = (what: string): GitBackendError =>
  new GitBackendError("unavailable", `unexpected answer from the forge (${what})`);

export class Http {
  readonly options: HttpOptions;
  readonly spent: Cost = { requests: 0, writes: 0, graphql: 0, mints: 0 };
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(options: HttpOptions) {
    this.options = options;
  }

  get kind(): CredentialKind {
    return this.options.kind;
  }

  url(req: Req): string {
    const base = this.options.endpoints[req.base ?? "api"];
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    }
    const q = params.toString();
    return `${base}${req.path}${q ? `?${q}` : ""}`;
  }

  private async slot(): Promise<void> {
    if (this.active < (this.options.maxConcurrent ?? 6)) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  /** One request; its answer when it is a success (or listed in `req.ok`), a GitBackendError
   *  otherwise. */
  async send(req: Req): Promise<Response> {
    const method = req.method ?? "GET";
    const url = this.url(req);
    const headers = new Headers();
    if (!req.bare) {
      headers.set("Accept", req.accept ?? MEDIA.json);
      headers.set("X-GitHub-Api-Version", API_VERSION);
      headers.set("User-Agent", USER_AGENT);
    }
    const authorization =
      req.authorization !== undefined ? req.authorization : await this.options.authorization(req.scope ?? { act: method === "GET" ? "read" : "write" });
    if (authorization) headers.set("Authorization", authorization);
    let body: BodyInit | undefined;
    if (req.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(req.json);
    } else if (req.body !== undefined) {
      body = req.body as BodyInit;
      if (req.contentType) headers.set("Content-Type", req.contentType);
      if (req.contentLength !== undefined) headers.set("Content-Length", String(req.contentLength));
    }
    if (req.counted !== false) {
      this.spent.requests++;
      if (req.write ?? method !== "GET") this.spent.writes++;
      if (req.graphql) this.spent.graphql++;
      if (req.mint) this.spent.mints++;
    }
    const where = req.label ?? `${method} ${req.path}`;
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(req.timeoutMs ?? (req.base === "uploads" ? (this.options.uploadTimeoutMs ?? 60_000) : this.options.timeoutMs)),
    };
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) init.duplex = "half";
    let res: Response;
    await this.slot();
    try {
      res = await this.options.fetch(url, init);
    } catch {
      throw new GitBackendError("unavailable", `the forge did not answer ${where}`);
    } finally {
      this.release();
    }
    if (res.ok || req.ok?.includes(res.status)) return res;
    throw await errorFor(res, { where, anonymous: this.options.kind === "anonymous", view: req.view ?? null, now: this.options.now(), context: req.context });
  }

  /** A request whose answer is JSON. */
  async json(req: Req): Promise<unknown> {
    return readJson(await this.send(req));
  }

  /** A GraphQL query or mutation; its `data`. */
  async graphql(query: string, variables: Record<string, unknown>, o: { mutation: boolean; scope?: Scope; view?: string | null }): Promise<Record<string, unknown>> {
    const res = await this.send({
      method: "POST",
      path: "/graphql",
      json: { query, variables },
      write: o.mutation,
      graphql: true,
      scope: o.scope ?? { act: o.mutation ? "write" : "read" },
      view: o.view,
    });
    const body = (await readJson(res)) as { data?: unknown; errors?: unknown };
    if (Array.isArray(body?.errors) && body.errors.length) {
      throw graphqlError(body.errors, res.headers, { anonymous: this.options.kind === "anonymous", view: o.view ?? null, now: this.options.now() });
    }
    if (!body || typeof body.data !== "object" || body.data === null) throw unexpected("GraphQL");
    return body.data as Record<string, unknown>;
  }
}

export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw unexpected("not JSON");
  }
}

/** At most `max` bytes of a body, as text; the rest is cancelled. */
export async function readSome(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
    }
  } catch {
    return "";
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(Math.min(n, max));
  let at = 0;
  for (const p of parts) {
    const take = p.subarray(0, all.length - at);
    all.set(take, at);
    at += take.length;
    if (at >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

/** The whole body when it holds at most `max` bytes; null when it is larger (the rest is
 *  cancelled: a file over the cap is never read to its end). */
export async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  const announced = Number(res.headers.get("Content-Length") ?? "");
  if (Number.isFinite(announced) && announced > max) {
    res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) {
        reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  } catch {
    throw new GitBackendError("unavailable", "the forge's answer was cut");
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface ErrorContext {
  where: string;
  anonymous: boolean;
  view: string | null;
  now: number;
  context?: "pull-merge";
}

function seconds(value: string | null): number | null {
  if (value === null || !/^\d{1,10}$/.test(value.trim())) return null;
  return Number(value.trim());
}

function rateLimited(headers: Headers, text: string, c: { anonymous: boolean; view: string | null; now: number }, status: number): GitBackendError | null {
  const fallback = c.anonymous && c.view ? { fallbackUrl: c.view } : {};
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = seconds(headers.get("x-ratelimit-reset"));
    const retryAfter = Math.max(1, reset === null ? 60 : reset - c.now);
    return new GitBackendError("rate_limited", "the forge's hourly quota is spent", { retryAfter, limit: "primary", forgeStatus: status, ...fallback });
  }
  const after = seconds(headers.get("retry-after"));
  if (after !== null) {
    return new GitBackendError("rate_limited", "the forge asks to slow down", { retryAfter: Math.max(1, after), limit: "secondary", forgeStatus: status, ...fallback });
  }
  if (status === 429 || /rate limit/i.test(text)) {
    return new GitBackendError("rate_limited", "the forge asks to slow down", { retryAfter: 60, limit: "secondary", forgeStatus: status, ...fallback });
  }
  return null;
}

/** GitHub's answer as a GitBackendError (the table in this file's header). */
export async function errorFor(res: Response, c: ErrorContext): Promise<GitBackendError> {
  const status = res.status;
  const text = await readSome(res, 4096);
  let message = "";
  try {
    const parsed = JSON.parse(text) as { message?: unknown; errors?: unknown };
    message = `${typeof parsed.message === "string" ? parsed.message : ""} ${JSON.stringify(parsed.errors ?? "")}`;
  } catch {
    message = text;
  }
  const said = (code: ConstructorParameters<typeof GitBackendError>[0], what: string, extra: { retryAfter?: number } = {}) =>
    new GitBackendError(code, `${what} (${c.where})`, { forgeStatus: status, ...extra });
  if (status >= 500) {
    const after = seconds(res.headers.get("retry-after"));
    return said("unavailable", `the forge failed with ${status}`, after === null ? {} : { retryAfter: after });
  }
  if (status === 401) return said("unauthorized", "the forge refused the credential");
  if (status === 403 || status === 429) {
    const limited = rateLimited(res.headers, message, c, status);
    if (limited) return limited;
    if (/archived/i.test(message)) return said("archived", "the repository is archived");
    return said("forbidden", "the forge refused this to the credential");
  }
  if (status === 404) return said("not_found", "not found");
  if (status === 405 && c.context === "pull-merge") return said("not_mergeable", "the forge will not merge this pull request");
  if (status === 409) return said("conflict", "the state moved");
  if (status === 410 || status === 451) return said("gone", "gone");
  if (status === 413) return said("too_large", "too large for the forge");
  if (status === 422) {
    if (/No commit found for SHA|Reference does not exist/i.test(message)) return said("not_found", "not found");
    if (/already[ _]exists|not a fast[- ]forward|expected head sha|head branch was modified/i.test(message)) return said("conflict", "the state moved");
    return said("invalid", "the forge refused the request");
  }
  return said("invalid", `the forge answered ${status}`);
}

const INPUT_TYPES = new Set(["UNPROCESSABLE", "ARGUMENT_ERROR", "BAD_REQUEST", "INVALID", "UNPROCESSABLE_ENTITY"]);

/** A GraphQL answer's `errors` as a GitBackendError. */
export function graphqlError(errors: unknown[], headers: Headers, c: { anonymous: boolean; view: string | null; now: number }): GitBackendError {
  const first = (errors[0] ?? {}) as { type?: unknown; message?: unknown; extensions?: unknown };
  const type = typeof first.type === "string" ? first.type : "";
  const message = typeof first.message === "string" ? first.message : "";
  if (type === "NOT_FOUND") return new GitBackendError("not_found", "not found (GraphQL)");
  if (/archived/i.test(message)) return new GitBackendError("archived", "the repository is archived (GraphQL)");
  if (type === "FORBIDDEN" || type === "INSUFFICIENT_SCOPES") return new GitBackendError("forbidden", "the forge refused this to the credential (GraphQL)");
  if (type === "RATE_LIMITED" || type === "RATE_LIMIT") {
    // GraphQL's quota is the primary one (points an hour); without its headers, wait a minute.
    const fallback = c.anonymous && c.view ? { fallbackUrl: c.view } : {};
    return rateLimited(headers, "", c, 200) ?? new GitBackendError("rate_limited", "the forge's quota is spent", { retryAfter: 60, limit: "primary", ...fallback });
  }
  if (type === "STALE_DATA" || /expected branch to point to|expectedHeadOid|head sha didn.t match|stale/i.test(message)) {
    return new GitBackendError("conflict", "the state moved (GraphQL)");
  }
  if (INPUT_TYPES.has(type) || (!type && first.extensions && typeof first.extensions === "object")) {
    return new GitBackendError("invalid", "the forge refused the request (GraphQL)");
  }
  return new GitBackendError("unavailable", "the forge failed (GraphQL)");
}

// ─── pages ────────────────────────────────────────────────────────────────

/** A REST page: the cursor is a page number, 1 to 99,999. */
export function restPage(page?: PageRequest, max = 100): { page: number; perPage: number } {
  const { cursor, perPage } = checkPage(page, max);
  if (cursor !== null && !/^\d{1,5}$/.test(cursor)) throw invalid("not a page cursor");
  const n = cursor === null ? 1 : Number(cursor);
  if (n < 1) throw invalid("not a page cursor");
  return { page: n, perPage };
}

/** The next page's cursor: the Link header is read only to learn whether one exists. */
export function nextPage(res: Response, page: number): string | null {
  return /<[^>]*>\s*;\s*rel="next"/.test(res.headers.get("Link") ?? "") ? String(page + 1) : null;
}

/** A GraphQL page: the cursor is the connection's endCursor. */
export function graphPage(page?: PageRequest): { after: string | null; first: number } {
  const { cursor, perPage } = checkPage(page);
  if (cursor !== null && !/^[A-Za-z0-9+/=_:-]{1,200}$/.test(cursor)) throw invalid("not a page cursor");
  return { after: cursor, first: perPage };
}
