// Test support: the community database as an in-memory SQLite database (node:sqlite), created from
// the real migration (migrations/d1-community/), behind the part of the D1 binding the Worker uses.
// Like D1: foreign keys on, a batch is one transaction, `undefined` cannot be bound.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "../../worker/account/types.ts";

const MIGRATION = new URL("../../../migrations/d1-community/0001_accounts.sql", import.meta.url);

export type FakeD1 = D1Database & { sqlite: DatabaseSync; queries: string[]; failWith?: string };

const READER = /^\s*(SELECT|WITH|PRAGMA)\b/i;

export function fakeD1(): FakeD1 {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(readFileSync(MIGRATION, "utf8"));

  const execute = <T>(query: string, values: unknown[]): D1Result<T> => {
    if (fake.failWith) throw new Error(fake.failWith);
    if (values.some((v) => v === undefined)) throw new Error(`D1_TYPE_ERROR: undefined bound in: ${query}`);
    fake.queries.push(query);
    const stmt = sqlite.prepare(query);
    if (READER.test(query)) {
      const rows = stmt.all(...(values as never[])).map((r) => ({ ...r }) as T);
      return { results: rows, success: true, meta: { rows_read: rows.length, rows_written: 0, changes: 0 } };
    }
    const r = stmt.run(...(values as never[]));
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
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

  const fake: FakeD1 = {
    sqlite,
    queries: [],
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
  };
  return fake;
}

/** Every row of a table, as plain objects. */
export function rows(db: FakeD1, table: string): Record<string, unknown>[] {
  return db.sqlite.prepare(`SELECT * FROM ${table}`).all().map((r) => ({ ...r }));
}

/** Every text value stored anywhere in the database. */
export function everyText(db: FakeD1): string {
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return tables.flatMap((t) => rows(db, t.name).flatMap((r) => Object.values(r).filter((v) => typeof v === "string"))).join("\n");
}

/** The Mac's facts, as `oscr community push` writes them. */
export function addFacts(db: FakeD1, facts: { papers?: [string, string, string, string][]; repos?: [string, string, string][] }): void {
  for (const [orcid, paper, slug, title] of facts.papers ?? []) {
    db.sqlite.prepare("INSERT OR REPLACE INTO paper_orcid (orcid, paper_id, slug, title) VALUES (?, ?, ?, ?)").run(orcid, paper, slug, title);
  }
  for (const [repo, host, owner] of facts.repos ?? []) {
    db.sqlite.prepare("INSERT OR REPLACE INTO repo_owner (repo, host, owner) VALUES (?, ?, ?)").run(repo, host, owner);
  }
}
