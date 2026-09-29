// The entities of the site: authors, journals, institutions, tools, datasets and
// categories, read once when the site is built from src/data/entities/ (scripts/data.mjs
// copies them from the harvester's public export, written by oscr/entities.py). Only the
// papers that have a page count (decisions D2 and D7).
import { existsSync, readFileSync } from "node:fs";
import { webUrl, withPage, type Article } from "./catalog";
import { MAX_CATEGORIES } from "./shards.ts";

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
/** An institution, by ROR id: named as OpenAlex names it, else after the affiliation most often
 *  written with it; its country (ISO 3166-1 alpha-2) and type from OpenAlex, "" when unknown. */
export type Institution = {
  id: string;
  name: string;
  country?: string;
  type?: string;
  papers: string[];
  authors: string[];
  counts: Counts;
};
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

/** An entity's page: every entity of the export has one, rendered in the browser from its shard
 *  (src/pages/records/, src/scripts/entity.ts) behind one shell page per type, which
 *  public/_redirects serves for /author/<orcid>/ and the like. No file per entity: their number
 *  does not change the site's file count (lib/shards.ts). */
const journalMap = new Map(journals.map((j) => [j.id, j]));
const institutionMap = new Map(institutions.map((i) => [i.id, i]));
const toolMap = new Map(tools.map((t) => [t.id, t]));
const datasetMap = new Map(datasets.map((d) => [d.id, d]));
const authorMap = new Map(authors.map((a) => [a.orcid, a]));

/** An entity's page, or "" when the export does not know it. */
export const authorUrl = (orcid: string) => (orcid && authorMap.has(orcid) ? `/author/${orcid}/` : "");
export const journalUrl = (id?: string) => (id && journalMap.has(id) ? `/journal/${journalMap.get(id)!.slug}/` : "");
export const institutionUrl = (id: string) => (institutionMap.has(id) ? `/institution/${id}/` : "");
export const toolUrl = (id: string) => (toolMap.has(id) ? `/tool/${toolMap.get(id)!.slug}/` : "");
export const datasetUrl = (id: string) => (datasetMap.has(id) ? `/dataset/${datasetMap.get(id)!.slug}/` : "");

export const journalOf = (id?: string) => (id ? journalMap.get(id) : undefined);
export const institutionOf = (id: string) => institutionMap.get(id);
export const toolOf = (id: string) => toolMap.get(id);
export const datasetOf = (id: string) => datasetMap.get(id);
export const authorOf = (orcid: string) => authorMap.get(orcid);

/** The authors by the first letter of their family name, A to Z then "Other": one page of the
 *  list each (/authors/a/ …), so that no page of the list grows past a letter's share. */
const familyOf = (a: Author) => a.family || a.name.split(" ").pop() || a.name;
export const inIndex = (a: Author) => (a.family && a.given ? `${a.family}, ${a.given}` : a.name);
export const authorLetters: { letter: string; slug: string; authors: Author[] }[] = (() => {
  const sorted = [...authors].sort((x, y) => familyOf(x).localeCompare(familyOf(y)) || x.name.localeCompare(y.name));
  const groups = new Map<string, Author[]>();
  for (const a of sorted) {
    const first = familyOf(a).normalize("NFD").charAt(0).toUpperCase();
    const letter = /[A-Z]/.test(first) ? first : "Other";
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter)!.push(a);
  }
  return [...groups.entries()]
    .sort(([x], [y]) => (x === "Other" ? 1 : y === "Other" ? -1 : x.localeCompare(y)))
    .map(([letter, list]) => ({ letter, slug: letter.toLowerCase(), authors: list }));
})();
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
/** The categories with a page: those with the most papers, at most MAX_CATEGORIES (lib/shards.ts).
 *  Their number is the classification's vocabulary (about 60 values), not the catalogue's size. */
export const categoryPages = [...allCategories]
  .sort((x, y) => y.counts.papers - x.counts.papers || `${x.facet} ${x.value}`.localeCompare(`${y.facet} ${y.value}`))
  .slice(0, MAX_CATEGORIES);
const categorySet = new Set(categoryPages.map((c) => c.url));
/** Each facet with its values, the values with the most papers first; `url` is "" past MAX_CATEGORIES. */
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
