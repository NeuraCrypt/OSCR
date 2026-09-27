// The entities of the site: authors, journals, institutions, tools, datasets and
// categories, read once when the site is built from src/data/entities/ (scripts/data.mjs
// copies them from the harvester's public export, written by oscr/entities.py). Only the
// papers that have a page count (decisions D2 and D7).
import { existsSync, readFileSync } from "node:fs";
import { webUrl, withPage, type Article } from "./catalog";

/** `papers`: the papers with a page; `with_code`: those with their authors' code. */
export type Counts = { papers: number; with_code: number };

/** An author with an ORCID iD: the only people merged across papers. */
export type Author = {
  orcid: string;
  name: string;
  given: string;
  family: string;
  papers: string[];
  affiliations: string[];
  institutions: string[];
  tools: string[];
  counts: Counts;
};
/** `read`: the in-scope papers read in the journal, with or without a page. */
export type Journal = {
  id: string;
  slug: string;
  title: string;
  issn: string;
  eissn: string;
  publisher: string;
  papers: string[];
  counts: Counts & { read: number };
};
/** An institution, by ROR id; its name is the affiliation most often written with it. */
export type Institution = { id: string; name: string; papers: string[]; authors: string[]; counts: Counts };
export type Tool = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  homepage: string;
  rrid: string;
  repositories: { repo: string; url: string; evidence: number }[];
  papers: string[];
  counts: Counts & { repositories: number };
};
export type Dataset = {
  id: string;
  slug: string;
  repository: string;
  url: string;
  title: string;
  license: string;
  papers: string[];
  counts: Counts;
};
export type CategoryValue = { slug: string; name?: string; counts: Counts; papers: string[] };
export type Categories = { min_confidence: number; facets: Record<string, Record<string, CategoryValue>> };
/** One value of one facet, with its page. */
export type Category = CategoryValue & { facet: string; value: string; name: string; url: string };

function load<T>(name: string, empty: T): T {
  const path = `src/data/entities/${name}.json`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : empty;
}

export const authors = load<Author[]>("authors", []);
export const journals = load<Journal[]>("journals", []);
export const institutions = load<Institution[]>("institutions", []);
export const tools = load<Tool[]>("tools", []);
export const datasets = load<Dataset[]>("datasets", []);
export const categories = load<Categories>("categories", { min_confidence: 0.6, facets: {} });
for (const t of tools) {
  t.homepage = webUrl(t.homepage);
  for (const r of t.repositories) r.url = webUrl(r.url);
}
for (const d of datasets) d.url = webUrl(d.url);

/** How many pages of each entity type are built ahead of time: the entities with the most
 *  papers. Beyond it, their pages will be rendered on demand by the Worker from D1 in
 *  Phase 3; until then an entity past the limit is named, without a link. Today's counts
 *  (about 1,000 authors with an ORCID iD, 300 journals, 100 tools, 150 datasets) are far
 *  below it, and so is the 20,000-file limit of a Worker's static assets. */
export const STATIC_MAX = {
  author: 2000,
  journal: 2000,
  institution: 2000,
  tool: 2000,
  dataset: 2000,
  category: 2000,
} as const;

/** The `n` entities with the most papers, then by name: those that get a static page. */
function top<T extends { counts: Counts }>(list: T[], n: number, name: (x: T) => string): T[] {
  return [...list].sort((x, y) => y.counts.papers - x.counts.papers || name(x).localeCompare(name(y))).slice(0, n);
}

export const authorPages = top(authors, STATIC_MAX.author, (a) => a.name);
export const journalPages = top(journals, STATIC_MAX.journal, (j) => j.title);
export const institutionPages = top(institutions, STATIC_MAX.institution, (i) => i.name);
export const toolPages = top(tools, STATIC_MAX.tool, (t) => t.name);
export const datasetPages = top(datasets, STATIC_MAX.dataset, (d) => d.title || d.id);

const authorSet = new Set(authorPages.map((a) => a.orcid));
const journalMap = new Map(journals.map((j) => [j.id, j]));
const journalSet = new Set(journalPages.map((j) => j.id));
const institutionMap = new Map(institutions.map((i) => [i.id, i]));
const institutionSet = new Set(institutionPages.map((i) => i.id));
const toolMap = new Map(tools.map((t) => [t.id, t]));
const toolSet = new Set(toolPages.map((t) => t.id));
const datasetMap = new Map(datasets.map((d) => [d.id, d]));
const datasetSet = new Set(datasetPages.map((d) => d.id));

/** An entity's page, or "" when it has none (not in the export, or past STATIC_MAX). */
export const authorUrl = (orcid: string) => (orcid && authorSet.has(orcid) ? `/author/${orcid}/` : "");
export const journalUrl = (id?: string) => (id && journalSet.has(id) ? `/journal/${journalMap.get(id)!.slug}/` : "");
export const institutionUrl = (id: string) => (institutionSet.has(id) ? `/institution/${id}/` : "");
export const toolUrl = (id: string) => (toolSet.has(id) ? `/tool/${toolMap.get(id)!.slug}/` : "");
export const datasetUrl = (id: string) => (datasetSet.has(id) ? `/dataset/${datasetMap.get(id)!.slug}/` : "");

export const journalOf = (id?: string) => (id ? journalMap.get(id) : undefined);
export const institutionOf = (id: string) => institutionMap.get(id);
export const toolOf = (id: string) => toolMap.get(id);
export const datasetOf = (id: string) => datasetMap.get(id);
const authorMap = new Map(authors.map((a) => [a.orcid, a]));
export const authorOf = (orcid: string) => authorMap.get(orcid);
export const datasetName = (d: Pick<Dataset, "id" | "title">) => d.title || d.id;
export const orcidUrl = (orcid: string) => `https://orcid.org/${orcid}`;
export const rorUrl = (id: string) => `https://ror.org/${id}`;
/** An RRID at the resolver, e.g. RRID:SCR_008633. */
export const rridUrl = (rrid: string) => (/^RRID:[A-Za-z]+_\S+$/.test(rrid) ? `https://scicrunch.org/resolver/${rrid}` : "");

/** The papers of an entity that have a page, in the entity's order. */
const pages = new Map(withPage.map((a) => [a.slug, a]));
export const papersOf = (slugs: string[]): Article[] =>
  slugs.map((s) => pages.get(s)).filter((a): a is Article => a !== undefined);

// Categories: the facets in the export's order, each value with its page.
const FACET_LABELS: Record<string, string> = {
  modality: "Modality",
  organism: "Organism",
  population: "Population",
  subfield: "Subfield",
};
export const facetLabel = (facet: string) =>
  FACET_LABELS[facet] ?? facet.charAt(0).toUpperCase() + facet.slice(1).replace(/[_-]+/g, " ");

const allCategories: Category[] = Object.entries(categories.facets).flatMap(([facet, values]) =>
  Object.entries(values).map(([value, v]) => ({ ...v, facet, value, name: v.name || value, url: `/browse/${facet}/${v.slug}/` })),
);
export const categoryPages = top(allCategories, STATIC_MAX.category, (c) => `${c.facet} ${c.value}`);
const categorySet = new Set(categoryPages.map((c) => c.url));
/** Each facet with its values, the values with the most papers first; `url` is "" past STATIC_MAX. */
export const facets = Object.keys(categories.facets).map((facet) => ({
  facet,
  label: facetLabel(facet),
  values: allCategories
    .filter((c) => c.facet === facet)
    .sort((x, y) => y.counts.papers - x.counts.papers || x.value.localeCompare(y.value))
    .map((c) => ({ ...c, url: categorySet.has(c.url) ? c.url : "" })),
}));

/** The categories of a paper, facet by facet, for its page. */
const categoriesByPaper = new Map<string, Category[]>();
for (const f of facets) {
  for (const c of f.values) {
    for (const slug of c.papers) {
      if (!categoriesByPaper.has(slug)) categoriesByPaper.set(slug, []);
      categoriesByPaper.get(slug)!.push(c);
    }
  }
}
export const categoriesOf = (a: Article) => categoriesByPaper.get(a.slug) ?? [];
