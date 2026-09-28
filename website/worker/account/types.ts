// The accounts (Phase 5): the types their modules share.
//
// The D1 interfaces are the part of Cloudflare's binding this code uses: the Workers runtime
// provides the binding (COMMUNITY, the `oscr_community` database), and the tests fake it over
// node:sqlite (website/tests/account/d1.ts).

export interface D1Meta {
  rows_read?: number;
  rows_written?: number;
  changes?: number;
  last_row_id?: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/** What the accounts read from the Worker's environment: Cloudflare secrets in production
 *  (`wrangler secret put`), the gitignored website/.dev.vars locally. docs/ACCOUNTS.md lists
 *  them; none is ever in the repository. */
export interface AccountEnv {
  /** The community database, `oscr_community` (migrations/d1-community/). */
  COMMUNITY?: D1Database;
  /** The server key: signs the sign-in's state cookie and derives the CSRF tokens. At least 32
   *  characters (`openssl rand -base64 48`). */
  SESSION_KEY?: string;
  ORCID_CLIENT_ID?: string;
  ORCID_CLIENT_SECRET?: string;
  /** https://sandbox.orcid.org (the default: sandbox first) or https://orcid.org. */
  ORCID_ISSUER?: string;
  /** "off" stops sending PKCE to ORCID, should its server ever refuse the parameters (it does
   *  not document them; RFC 6749 §3.1 says unknown ones are ignored). */
  ORCID_PKCE?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Development only: GitHub's and Google's addresses replaced by a local mock (https, or http
   *  on this machine only). Never set in production. */
  GITHUB_URL?: string;
  GITHUB_API_URL?: string;
  GOOGLE_ISSUER?: string;
  /** Development only: "1" adds X-D1-Queries, X-D1-Rows-Read and X-D1-Rows-Written to every
   *  answer, as D1 counts them (how docs/ACCOUNTS.md measured the writes per sign-in). */
  ACCOUNT_DEV_METRICS?: string;
}

export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}
