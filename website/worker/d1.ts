// The part of Cloudflare's D1 binding the Worker uses: prepared statements, run one by one or
// as a batch (one round trip). Declared here rather than taken from @cloudflare/workers-types,
// to keep the Worker's dependencies at zero; the tests implement it over node:sqlite.

export type D1Meta = { rows_read?: number; rows_written?: number; duration?: number };

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
