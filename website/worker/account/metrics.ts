// Development only (ACCOUNT_DEV_METRICS=1): the D1 binding wrapped to add up what D1 reports for
// each statement, rows read and rows written as D1 bills them (indexes included), so that a local
// run can say what one sign-in costs. `first()` goes through `all()` to see D1's figures; the
// Worker's single-row reads are unchanged by it.

import type { D1Database, D1Meta, D1PreparedStatement, D1Result } from "./types.ts";

export interface Totals {
  queries: number;
  read: number;
  written: number;
}

type Wrapped = D1PreparedStatement & { inner: D1PreparedStatement };

export function counted(db: D1Database): { db: D1Database; totals: Totals } {
  const totals: Totals = { queries: 0, read: 0, written: 0 };
  const add = (meta: D1Meta | undefined) => {
    totals.read += meta?.rows_read ?? 0;
    totals.written += meta?.rows_written ?? 0;
  };
  const wrap = (inner: D1PreparedStatement): Wrapped => ({
    inner,
    bind: (...values: unknown[]) => wrap(inner.bind(...values)),
    async first<T>() {
      totals.queries += 1;
      const r = await inner.all<T>();
      add(r.meta);
      return (r.results[0] ?? null) as T | null;
    },
    async all<T>() {
      totals.queries += 1;
      const r = await inner.all<T>();
      add(r.meta);
      return r;
    },
    async run<T>() {
      totals.queries += 1;
      const r = await inner.run<T>();
      add(r.meta);
      return r;
    },
  });
  return {
    totals,
    db: {
      prepare: (query: string) => wrap(db.prepare(query)),
      async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
        totals.queries += statements.length;
        const results = await db.batch<T>(statements.map((s) => (s as Wrapped).inner ?? s));
        for (const r of results) add(r.meta);
        return results;
      },
    },
  };
}
