// GitBackend's errors: one class, one code union. Every rejection of a backend is a
// `GitBackendError`; the Python counterpart (oscr/forge.py, `ForgeError`) uses the same codes.
//
// - Messages are short English sentences for logs. They never contain a token, a header or a
//   forge's answer copied as is. The pages turn the codes into words, as the search does.
// - `rate_limited` is never retried automatically: GitHub may ban an integration that keeps
//   calling while it is limited. `retryAfter` goes back to the caller.
// - The Worker answers each code with STATUS[code] and the problem body its routes already use,
//   { error: { code, message } } (account/http.ts).
//
// How GitHub's answers become codes: github/http.ts (the table of the design, §5).

export type GitErrorCode =
  /** The request is wrong: a name, a path, a missing field. */
  | "invalid"
  /** No credential, or a refused one (expired, revoked); any write when anonymous. */
  | "unauthorized"
  /** The credential may not do this (including OSCR's rule for installations, rules.ts). */
  | "forbidden"
  /** Absent, or not visible to this credential (GitHub answers 404 for both). */
  | "not_found"
  /** The state moved: a branch head, a name taken, a merge conflict. */
  | "conflict"
  /** A pull request the forge will not merge as asked. */
  | "not_mergeable"
  /** A write to an archived repository. */
  | "archived"
  /** Deleted, disabled or legally blocked (GitHub 410, 451). */
  | "gone"
  /** Over a limit of the forge or of OSCR. */
  | "too_large"
  /** A forge rate limit: wait `retryAfter` seconds; never retried automatically. */
  | "rate_limited"
  /** Not possible with this backend or credential: see `fallbackUrl`. */
  | "unsupported"
  /** The forge did not answer: network, timeout, 5xx, an unexpected answer. */
  | "unavailable";

export const GIT_ERROR_CODES: readonly GitErrorCode[] = [
  "invalid", "unauthorized", "forbidden", "not_found", "conflict", "not_mergeable", "archived",
  "gone", "too_large", "rate_limited", "unsupported", "unavailable",
];

export interface GitErrorExtra {
  retryAfter?: number;
  limit?: "primary" | "secondary";
  fallbackUrl?: string;
  forgeStatus?: number;
}

export class GitBackendError extends Error {
  readonly code: GitErrorCode;
  /** Seconds to wait (rate_limited; unavailable when the forge sent Retry-After). */
  readonly retryAfter: number | null;
  /** Which rate limit: primary (the hourly quota) or secondary (abuse protection). */
  readonly limit: "primary" | "secondary" | null;
  /** A forge page that can do it (unsupported; rate_limited for an anonymous reader). */
  readonly fallbackUrl: string | null;
  /** The forge's HTTP status, for logs. */
  readonly forgeStatus: number | null;

  constructor(code: GitErrorCode, message: string, extra: GitErrorExtra = {}) {
    super(message);
    this.name = "GitBackendError";
    this.code = code;
    this.retryAfter = extra.retryAfter ?? null;
    this.limit = extra.limit ?? null;
    this.fallbackUrl = extra.fallbackUrl ?? null;
    this.forgeStatus = extra.forgeStatus ?? null;
  }
}

/** The status the Worker answers for each code. */
export const STATUS: Record<GitErrorCode, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  not_mergeable: 409,
  archived: 409,
  gone: 410,
  too_large: 413,
  rate_limited: 429,
  unsupported: 501,
  unavailable: 503,
};

/** Whether `e` is a GitBackendError (of this code, when one is given). */
export function isGitError(e: unknown, code?: GitErrorCode): e is GitBackendError {
  return e instanceof GitBackendError && (code === undefined || e.code === code);
}

/** The Worker's problem body for an error: `{ error: { code, message } }`, and what a page may
 *  show besides (when to retry, a forge page that can do it). */
export function problemBody(e: GitBackendError): { error: { code: GitErrorCode; message: string; retryAfter?: number; fallbackUrl?: string } } {
  const error: { code: GitErrorCode; message: string; retryAfter?: number; fallbackUrl?: string } = { code: e.code, message: e.message };
  if (e.retryAfter !== null) error.retryAfter = e.retryAfter;
  if (e.fallbackUrl !== null) error.fallbackUrl = e.fallbackUrl;
  return { error };
}

export const invalid = (message: string): GitBackendError => new GitBackendError("invalid", message);
