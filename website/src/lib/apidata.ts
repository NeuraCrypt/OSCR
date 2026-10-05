// The public API's static data, shaped once when the site is built (read at build time only: it
// touches src/data through catalog.ts and entities.ts, so the Worker never imports this). The
// Astro endpoints under src/pages/data/ write what this returns into /data/: the files the API
// serves and that power users fetch directly (the no-rate-limit path).
//
// Every rule of CLAUDE.md holds: the records come from the public export, already stripped of
// email addresses (scripts/data.mjs); no paper full text; a withdrawn paper is absent from the
// catalogue already, a withheld map carries no card. Only facts leave.
import { alignmentOf, catalog, europePmcUrl, recordUrl, type Article, type Repo } from "./catalog.ts";
import {
  authors, categoriesOf, datasetName, datasetOf, datasets, datasetUrl, institutions, journalOf, journals,
  journalUrl, toolOf, tools, toolUrl,
} from "./entities.ts";
import { doiUrl } from "./render.ts";
import { DATA_BASE, REPO_SHARDS } from "./apispec.ts";
import { shardOf, SHARDS } from "./shards.ts";

/** The repositories a run knows, with their facts (catalog.json's top-level list). */
type RepoFacts = {
  repo: string;
  url: string;
  host: string;
  state: string;
  license: string;
  scripts: number | null;
  languages: Record<string, number>;
  commit: string;
  commit_date?: string;
  articles: number;
  level: string;
};
const repositories = ((catalog as unknown as { repositories?: RepoFacts[] }).repositories ?? []) as RepoFacts[];

/** repo key -> the slugs of the papers that cite it as their authors' code, and whether the run
 *  judged its files redistributable (from the papers' own code entries). */
const citing = new Map<string, string[]>();
const redistributableOf = new Map<string, string>();
for (const a of catalog.articles) {
  for (const r of a.code) {
    if (!citing.has(r.repo)) citing.set(r.repo, []);
    citing.get(r.repo)!.push(a.slug);
    if (r.redistributable) redistributableOf.set(r.repo, r.redistributable);
  }
}

const codeOut = (r: Repo) => ({
  repo: r.repo,
  url: r.url,
  host: r.host,
  state: r.state,
  level: r.level,
  license: r.license,
  redistributable: r.redistributable,
  scripts: r.scripts,
  languages: r.languages,
  commit: r.commit,
});

/** One paper's public API record: facts only, from the catalogue (no page lot, no full text).
 *  `shard` names the static file that holds it (for the `source` link); "" when not yet known. */
export type ApiPaper = ReturnType<typeof apiPaper>;
export function apiPaper(a: Article, shard = "") {
  const j = journalOf(a.journal_id);
  return {
    id: a.id,
    doi: a.doi,
    slug: a.slug,
    title: a.title,
    published: a.published,
    status: a.status,
    families: a.families,
    page: a.page === true || a.code.length > 0,
    journal: { title: a.journal, id: a.journal_id ?? "", url: j ? journalUrl(a.journal_id) : "" },
    authors: (a.authors ?? []).map((p) => ({ name: p.name, orcid: p.orcid })),
    categories: categoriesOf(a).map((c) => ({ name: c.name, facet: c.facet, value: c.value })),
    tools: (a.tools ?? []).map((id) => ({ id, name: toolOf(id)?.name ?? id, url: toolUrl(id) })),
    datasets: (a.datasets ?? []).map((id) => {
      const d = datasetOf(id);
      return { id, name: d ? datasetName(d) : id, url: datasetUrl(id) };
    }),
    code: a.code.map(codeOut),
    data_links: a.data_links,
    matches: { aligned: !!a.alignment, pairs: a.alignment?.pairs ?? 0, method: a.alignment?.method ?? "" },
    map_doi: a.card?.doi ?? "",
    links: {
      record: recordUrl(a),
      doi: doiUrl(a.doi),
      europepmc: europePmcUrl(a),
      self: `/api/v1/paper/${encodeURIComponent(a.doi)}`,
      source: shard ? `${DATA_BASE}/papers/${shard}.json` : "",
    },
  };
}

/** One repository's public API record. `shard` names its static file (for the `source` link). */
export type ApiRepo = ReturnType<typeof apiRepo>;
export function apiRepo(r: RepoFacts, shard = "") {
  const papers = (citing.get(r.repo) ?? []).map((slug) => {
    const a = catalog.articles.find((x) => x.slug === slug);
    return a ? { doi: a.doi, title: a.title, record: recordUrl(a) } : { doi: "", title: "", record: `/paper/${slug}/` };
  });
  return {
    repo: r.repo,
    url: r.url,
    host: r.host,
    state: r.state,
    level: r.level,
    license: r.license,
    redistributable: redistributableOf.get(r.repo) ?? "",
    scripts: r.scripts,
    languages: r.languages,
    commit: r.commit,
    commit_date: r.commit_date ?? "",
    papers,
    links: { self: `/api/v1/repository/${r.repo}`, source: shard ? `${DATA_BASE}/repos/${shard}.json` : "" },
  };
}

/** Every paper's API record, grouped into at most SHARDS.paper files, keyed by the page's name
 *  (the same shard rule as /records/paper/). Covers EVERY paper with a page (static and on demand),
 *  unlike /records/paper/ which holds only the on-demand ones. */
export async function apiPaperShards(): Promise<Map<string, Record<string, ApiPaper>>> {
  const withPage = catalog.articles.filter((a) => a.page === true || a.code.length > 0);
  const out = new Map<string, Record<string, ApiPaper>>();
  for (const a of withPage) {
    const name = await shardOf(a.slug, SHARDS.paper);
    if (!out.has(name)) out.set(name, {});
    out.get(name)![a.slug] = apiPaper(a, name);
  }
  return new Map([...out.entries()].sort(([x], [y]) => (x < y ? -1 : 1)));
}

/** Every repository's API record, grouped into at most REPO_SHARDS files, keyed by the repo. */
export async function apiRepoShards(): Promise<Map<string, Record<string, ApiRepo>>> {
  const out = new Map<string, Record<string, ApiRepo>>();
  for (const r of repositories) {
    const name = await shardOf(r.repo, REPO_SHARDS);
    if (!out.has(name)) out.set(name, {});
    out.get(name)![r.repo] = apiRepo(r, name);
  }
  return new Map([...out.entries()].sort(([x], [y]) => (x < y ? -1 : 1)));
}

/** The catalogue's figures, for /data/stats.json and the /api/v1/stats endpoint. */
export function apiStats() {
  return { generated_at: catalog.generated_at, scope: catalog.scope, figures: catalog.figures };
}

/** The full public list of one entity type (the no-rate-limit bulk file). The arrays are the
 *  site's own records, already email-free. */
export function entityList(type: string): unknown {
  switch (type) {
    case "author":
      return authors;
    case "journal":
      return journals;
    case "institution":
      return institutions;
    case "tool":
      return tools;
    case "dataset":
      return datasets;
    default:
      return [];
  }
}

// --- the small bulk exports (CSV, JSONL), added to the build ---

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");

/** articles.csv: one row per paper, the catalogue's columns. */
export function articlesCsv(): string {
  const header = ["doi", "slug", "title", "journal", "published", "status", "families", "code_links", "data_links", "has_page", "pmcid"];
  const rows = catalog.articles.map((a) =>
    csvRow([a.doi, a.slug, a.title, a.journal, a.published, a.status, (a.families ?? []).join("; "), a.code.length, a.data_links, (a.page === true || a.code.length > 0) ? "yes" : "no", a.pmcid]),
  );
  return [csvRow(header), ...rows].join("\n") + "\n";
}

/** repositories.csv: one row per repository the registry knows. */
export function repositoriesCsv(): string {
  const header = ["repo", "url", "host", "state", "level", "license", "redistributable", "scripts", "languages", "commit", "commit_date", "citing_papers"];
  const rows = repositories.map((r) =>
    csvRow([
      r.repo, r.url, r.host, r.state, r.level, r.license, redistributableOf.get(r.repo) ?? "",
      r.scripts ?? "", Object.entries(r.languages ?? {}).map(([k, n]) => `${k}:${n}`).join("; "),
      r.commit, r.commit_date ?? "", (citing.get(r.repo) ?? []).length,
    ]),
  );
  return [csvRow(header), ...rows].join("\n") + "\n";
}

/** alignments.jsonl: one JSON object per aligned paper, its paragraph to code-line pairs. The
 *  pairs carry a paragraph NUMBER and short evidence terms, never a paper's text (scripts/data.mjs). */
export function alignmentsJsonl(): string {
  const lines: string[] = [];
  for (const a of catalog.articles) {
    const al = alignmentOf(a);
    if (!al || !al.pairs.length) continue;
    lines.push(JSON.stringify({ doi: a.doi, slug: a.slug, method: al.method, pairs: al.pairs }));
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}
