// Test support: the two D1 databases of the search, as in-memory SQLite databases (node:sqlite,
// with FTS5), created from the real migrations (migrations/d1/), behind the part of the D1
// binding the Worker uses. Rows are written the way oscr/d1.py writes them.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { facetToken, ALL_TOKEN, FACET_BY_PARAM } from "../src/lib/facets.ts";
import type { D1Database, D1PreparedStatement, D1Result } from "../worker/d1.ts";

const MIGRATIONS = new URL("../../migrations/d1/", import.meta.url);

/** Whether this Node's SQLite has what the index needs (FTS5 with contentless_unindexed, SQLite
 *  3.47+). Without it, the suites that query a database are skipped, and say why. */
export const FTS5_READY: boolean = (() => {
  try {
    new DatabaseSync(":memory:").exec(
      "CREATE VIRTUAL TABLE t USING fts5(a, b UNINDEXED, content='', contentless_delete=1, contentless_unindexed=1)",
    );
    return true;
  } catch {
    return false;
  }
})();
export const NO_FTS5 = FTS5_READY ? false : "this Node's SQLite lacks FTS5 contentless_unindexed (3.47+)";

export type FakeD1 = D1Database & { sql: string[]; failWith?: string };

/** A D1 binding over node:sqlite. `meta.rows_read` is the number of rows returned: enough to
 *  check that the Worker adds the costs up (the real figures come from D1, docs/SEARCH.md). */
export function fakeD1(db: DatabaseSync): FakeD1 {
  const fake: FakeD1 = {
    sql: [],
    prepare(query: string): D1PreparedStatement {
      let values: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...v: unknown[]) {
          values = v;
          return stmt;
        },
        async all<T>(): Promise<D1Result<T>> {
          fake.sql.push(query);
          if (fake.failWith) throw new Error(fake.failWith);
          const rows = db.prepare(query).all(...(values as never[])).map((r) => ({ ...r }) as T);
          return { results: rows, success: true, meta: { rows_read: rows.length } };
        },
      };
      return stmt;
    },
    async batch<T>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const out: D1Result<T>[] = [];
      for (const s of stmts) out.push(await s.all<T>());
      return out;
    },
  };
  return fake;
}

export function databases(): { catalog: DatabaseSync; search: DatabaseSync } {
  const catalog = new DatabaseSync(":memory:");
  catalog.exec(readFileSync(new URL("catalog/0001_catalog.sql", MIGRATIONS), "utf8"));
  const search = new DatabaseSync(":memory:");
  search.exec(readFileSync(new URL("search/0001_search.sql", MIGRATIONS), "utf8"));
  return { catalog, search };
}

export type Paper = {
  pid: number;
  title: string;
  status?: string;
  journal?: string;
  published?: string;
  abstract?: string;
  authors?: string;
  tools?: string[];
  cited?: number;
  /** facet parameter → values */
  facets?: Record<string, string[]>;
};

/** One paper in both databases, as the projector writes it. */
export async function addPaper(dbs: { catalog: DatabaseSync; search: DatabaseSync }, p: Paper): Promise<void> {
  const status = p.status ?? "code_verified";
  const published = p.published ?? `${String(p.pid).slice(0, 4)}-${String(p.pid).slice(4, 6)}-${String(p.pid).slice(6, 8)}`;
  const facets: Record<string, string[]> = { status: [status], year: [published.slice(0, 4)], ...(p.facets ?? {}) };
  if (p.tools?.length) facets.tool = p.tools;
  const slug = `paper-${p.pid}`;
  const doc = {
    slug, doi: `10.5555/${p.pid}`, title: p.title, journal: p.journal ?? "Journal of Tests", published, status,
    code: status.startsWith("code_") ? [{ name: `lab/${p.pid}`, url: `https://github.com/lab/${p.pid}`, license: "MIT" }] : [],
    data: 0, files: 3, pairs: 0, cited: p.cited ?? null,
  };
  dbs.catalog
    .prepare(
      "INSERT INTO papers (pid, id, slug, doi, title, journal, journal_id, published, year, type, status, oa, license, " +
        "cited_by_count, has_alignment, languages, hosts, doc) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 'research-article', ?, 1, " +
        "'CC BY', ?, 0, '[]', '[]', ?)",
    )
    .run(p.pid, `doi:${doc.doi}`, slug, doc.doi, p.title, doc.journal, published, Number(published.slice(0, 4)), status,
      p.cited ?? null, JSON.stringify(doc));
  const tokens = [ALL_TOKEN];
  const fx: unknown[] = [p.cited ?? 0];
  for (const [param, values] of Object.entries(facets)) {
    const code = FACET_BY_PARAM.get(param)!.code;
    for (const v of values) {
      tokens.push(await facetToken(code, v));
      fx.push(code, v);
    }
  }
  dbs.search
    .prepare(
      "INSERT INTO paper_fts (rowid, title, keywords, mesh, authors, journal, repos, tools, ids, abstract, facets, fx) " +
        "VALUES (?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(p.pid, p.title, p.authors ?? "", doc.journal, doc.code.map((c) => `github.com/${c.name}`).join(" "),
      (p.tools ?? []).join(" "), doc.doi, p.abstract ?? "", tokens.join(" "), JSON.stringify(fx));
}

/** The summary rows of the unfiltered view: the counts and the number of papers. */
export function addSummary(catalog: DatabaseSync, counts: Record<string, [string, number][]>, papers: number): void {
  for (const [facet, values] of Object.entries(counts)) {
    values.forEach(([value, n], i) => catalog.prepare("INSERT INTO facet_counts VALUES (?, ?, ?, ?)").run(facet, i + 1, value, n));
  }
  catalog.prepare("INSERT INTO meta VALUES ('papers', ?)").run(String(papers));
}
