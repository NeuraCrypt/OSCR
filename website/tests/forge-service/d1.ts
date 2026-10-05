// Test support: the forge database (`oscr_forge`) as an in-memory SQLite database (node:sqlite),
// created from the real migrations (migrations/d1-forge/, in order), behind the part of the D1
// binding the Worker uses. Like D1: a batch is one transaction, `undefined` cannot be bound. And
// what the forge service's budgets need to be tested:
// - `meta.rows_written` as D1 bills it: the rows a statement changes, plus one per index entry it
//   touches (an insert or a delete: every index of the table; an update: the indexes whose columns
//   it sets). `rows_read` is the rows a read returns (D1 counts the rows it scans: the plan check
//   below keeps the two close).
// - `scans`: every statement whose query plan reads a whole table of the forge database (SCAN
//   repos, …) instead of a key or an index. The service's rule is "never a scan": tests assert
//   that `scans` stays empty.
// - `totals`: the rows written and read since the database was made (or `reset()`).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "../../worker/account/types.ts";

const MIGRATIONS = new URL("../../../migrations/d1-forge/", import.meta.url);
/** The migrations' SQL, in the order wrangler applies them. */
export const FORGE_SCHEMA = readdirSync(MIGRATIONS)
  .filter((name) => /^\d{4}_.*\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(new URL(name, MIGRATIONS), "utf8"))
  .join("\n");

export interface FakeForgeD1 extends D1Database {
  sqlite: DatabaseSync;
  queries: string[];
  /** Statements that read a whole table, with the plan's line. */
  scans: string[];
  totals: { read: number; written: number; queries: number };
  /** The next statements fail with this message (D1's quota, an outage). */
  failWith?: string;
  reset(): void;
}

const READER = /^\s*(SELECT|WITH|PRAGMA)\b/i;

export function fakeForgeD1(schema = FORGE_SCHEMA): FakeForgeD1 {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(schema);

  const tables = new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name),
  );
  /** Each table's indexes, as their column lists. */
  const indexes = new Map<string, string[][]>();
  for (const table of tables) {
    const list = sqlite.prepare(`PRAGMA index_list(${table})`).all() as { name: string; origin: string }[];
    // A WITHOUT ROWID table's primary key is the table itself ("pk" origin): not an extra row. A
    // rowid table's text primary key is an index of its own: one.
    const sql = String((sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql: string }).sql);
    const withoutRowid = /WITHOUT\s+ROWID/i.test(sql);
    const extra = list.filter((i) => !(withoutRowid && i.origin === "pk"));
    indexes.set(
      table,
      extra.map((i) => (sqlite.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map((c) => c.name)),
    );
  }

  const written = (query: string, changes: number): number => {
    if (!changes) return 0;
    const insert = /^\s*(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)/i.exec(query);
    const del = /^\s*DELETE\s+FROM\s+(\w+)/i.exec(query);
    const update = /^\s*UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)\s+WHERE\s/i.exec(query);
    if (insert || del) return changes * (1 + (indexes.get((insert ?? del)![1])?.length ?? 0));
    if (update) {
      const set = new Set([...update[2].matchAll(/(\w+)\s*=/g)].map((m) => m[1]));
      const touched = (indexes.get(update[1]) ?? []).filter((cols) => cols.some((c) => set.has(c))).length;
      return changes * (1 + touched);
    }
    return changes;
  };

  const planOf = (query: string, values: unknown[]): void => {
    let plan: { detail: string }[] = [];
    try {
      plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...(values as never[])) as { detail: string }[];
    } catch {
      return;
    }
    for (const { detail } of plan) {
      const m = /^SCAN (\w+)/.exec(detail);
      if (m && tables.has(m[1])) fake.scans.push(`${detail} :: ${query.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  };

  const execute = <T>(query: string, values: unknown[]): D1Result<T> => {
    if (fake.failWith) throw new Error(fake.failWith);
    if (values.some((v) => v === undefined)) throw new Error(`D1_TYPE_ERROR: undefined bound in: ${query}`);
    fake.queries.push(query);
    fake.totals.queries += 1;
    planOf(query, values);
    const stmt = sqlite.prepare(query);
    if (READER.test(query)) {
      const rows = stmt.all(...(values as never[])).map((r) => ({ ...r }) as T);
      fake.totals.read += rows.length;
      return { results: rows, success: true, meta: { rows_read: rows.length, rows_written: 0, changes: 0 } };
    }
    const r = stmt.run(...(values as never[]));
    const w = written(query, Number(r.changes));
    fake.totals.written += w;
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), rows_written: w } };
  };

  const statement = (query: string, values: unknown[] = []): D1PreparedStatement & { query: string; values: unknown[] } => ({
    query,
    values,
    bind: (...v: unknown[]) => statement(query, v),
    async first<T>() {
      return (execute<T>(query, values).results[0] ?? null) as T | null;
    },
    async all<T>() {
      return execute<T>(query, values);
    },
    async run<T>() {
      return execute<T>(query, values);
    },
  });

  const fake: FakeForgeD1 = {
    sqlite,
    queries: [],
    scans: [],
    totals: { read: 0, written: 0, queries: 0 },
    prepare: (query: string) => statement(query),
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      sqlite.exec("BEGIN");
      try {
        const out = statements.map((s) => {
          const { query, values } = s as unknown as { query: string; values: unknown[] };
          return execute<T>(query, values);
        });
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    reset() {
      fake.queries = [];
      fake.scans = [];
      fake.totals = { read: 0, written: 0, queries: 0 };
    },
  };
  return fake;
}

/** Every row of a table, as plain objects. */
export function forgeRows(db: FakeForgeD1, table: string): Record<string, unknown>[] {
  return db.sqlite.prepare(`SELECT * FROM ${table}`).all().map((r) => ({ ...r }));
}

/** Rows in every table: what a refused request must leave unchanged. */
export function forgeCounts(db: FakeForgeD1): Record<string, number> {
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map((t) => [t.name, Number((db.sqlite.prepare(`SELECT count(*) AS n FROM ${t.name}`).get() as { n: number }).n)]));
}

/** Every text value stored anywhere in the database (no token, no email address, no private name). */
export function forgeText(db: FakeForgeD1): string {
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return tables.flatMap((t) => forgeRows(db, t.name).flatMap((r) => Object.values(r).filter((v) => typeof v === "string"))).join("\n");
}

/** Phase 08's tables, phase 10's, phase 16's and phase 14's, empty: what a write of the earlier phases
 *  leaves them (forgeCounts' comparisons). */
export const SOCIAL_EMPTY = {
  events: 0, follows: 0, notice_marks: 0, notice_state: 0, profiles: 0, star_list_items: 0, star_lists: 0, stars: 0,
  api_tokens: 0, hook_deliveries: 0, hooks: 0, statuses: 0,
  blocks: 0, content_reports: 0, interaction_limits: 0, moderation: 0, rights_requests: 0,
  device_grants: 0,
  repo_deps: 0, security_alerts: 0, alert_triage: 0,
} as const;
