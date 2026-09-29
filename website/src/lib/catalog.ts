// The harvester's public export, read once when the site is built.
// See scripts/data.mjs: it comes from CATALOG_DIR, always exported in public mode.
import { existsSync, readFileSync } from "node:fs";
import raw from "../data/catalog.json";
import { dayInWords } from "./format";
import { shortName, webUrl } from "./names";
import type { Row } from "./render.ts";
import { STATIC_PAPERS, staticSelection } from "./shards.ts";

/** A repository cited by a paper as its authors' code, and what verification found. */
export type Repo = {
  repo: string;
  url: string;
  host: string;
  level: "found" | "alive" | "inventoried" | "imported";
  lot: number;
  files_read: number;
  state: string;
  license: string;
  redistributable: string;
  scripts: number | null;
  languages: Record<string, number>;
  type: string;
  swh: number | null;
  inventoried: boolean;
  commit: string;
  where: string;
};

/** A tracing map validated by an author: it then has a Zenodo DOI. */
export type Card = {
  validated_by: { name: string; orcid: string }[];
  doi?: string;
  concept_doi?: string;
};

/** An author as a paper lists them: `orcid` is "" when they have no (valid) ORCID iD. */
export type PaperAuthor = { name: string; orcid: string };

export type Article = {
  id: string;
  slug: string;
  doi: string;
  pmcid: string;
  fulltext_id: string;
  title: string;
  journal: string;
  published: string;
  status: string;
  families: string[];
  data_links: number;
  code: Repo[];
  card: Card | null;
  alignment: { lot: number; pairs: number; method: string } | null;
  /** Its tracing map withheld at a removal request (oscr reports accept): its card, its matches
   *  and its map's digest are then absent, and the pages say why. Only said when true. */
  map_withheld?: boolean;
  // Since Phase 2 (oscr/entities.py): whether the paper has a page (D2, D7) and, when it
  // has one, what its page links to. Absent from an older export.
  page?: boolean;
  authors?: PaperAuthor[];
  journal_id?: string;
  tools?: string[];
  datasets?: string[];
  // Since Phase 4 (oscr/paperpage.py): the lot of src/data/papers/ that holds the sections
  // of the paper's page.
  page_lot?: number;
};

/** A file of a lot of scripts. `text` is null when the license of the repository
 *  does not allow republishing it; `kind` "note" is a remark, not a file. */
export type LotFile = {
  path: string;
  language: string;
  kind: "script" | "doc" | "note";
  lines: number | null;
  text: string | null;
  truncated: boolean;
  note: string;
  source_url: string;
};
export type LotEntry = { repo: string; commit: string; license: string; published: boolean; files: LotFile[] };

/** A match computed by the harvester: paragraph `paragraph` of the paper (its index
 *  among the <p> of the JATS <body>) ↔ lines start_line..end_line of a file. */
export type Pair = {
  pair: number;
  paragraph: number;
  section: string;
  repo: string;
  path: string;
  start_line: number;
  end_line: number;
  symbol: string;
  score: number;
  evidence: string[];
};
export type Alignment = { method: string; fulltext_id: string; pairs: Pair[] };

type Catalog = {
  generated_at: string;
  public: boolean;
  scope: { sources: string; from: string; to: string };
  figures: Record<string, number>;
  articles: Article[];
};

export { shortName, webUrl } from "./names";

export const catalog = raw as unknown as Catalog;
for (const a of catalog.articles) for (const r of a.code) r.url = webUrl(r.url);

/** The papers whose authors' code was found: the home page lists them. */
export const withCode = catalog.articles.filter((a) => a.code.length > 0);

/** The papers that have a page (the owner's decision D2): the authors' code, code on
 *  request, or data only; never an off-topic paper (D7). An export older than Phase 2
 *  does not say: its papers with code keep their page. */
export const withPage = catalog.articles.filter((a) => a.page === true || a.code.length > 0);

/** The papers whose page is built ahead of time: the STATIC_PAPERS most recent (lib/shards.ts),
 *  with the Code ↔ Paper reader on the page of those with code. The others' pages are rendered
 *  on demand by the Worker (worker/pages.ts), from the records of src/pages/records/; they have
 *  no reader. */
const staticSlugs = staticSelection(withPage, staticCap());
/** STATIC_PAPERS, or a smaller number set in OSCR_STATIC_PAPERS: for the tests and the
 *  screenshots, which build the fixture with papers rendered on demand. Never a larger one. */
function staticCap(): number {
  const asked = Number.parseInt(process.env.OSCR_STATIC_PAPERS ?? "", 10);
  return Number.isInteger(asked) && asked >= 0 ? Math.min(asked, STATIC_PAPERS) : STATIC_PAPERS;
}
export const isStatic = (a: Pick<Article, "slug">) => staticSlugs.has(a.slug);
export const staticPages = withPage.filter(isStatic);
export const onDemand = withPage.filter((a) => !isStatic(a));

export const recordUrl = (a: Article) => `/paper/${a.slug}/`;
/** The paper's Code ↔ Paper reader, the first section of its page, or "" when it has none (no
 *  code, or no static page). Its former address, /paper/<slug>/code/, leads there (worker/pages.ts). */
export const readerUrl = (a: Article) => (a.code.length > 0 && isStatic(a) ? `/paper/${a.slug}/#code` : "");

/** A paper as the catalogue's listing shows it (lib/render.ts). */
export function rowOf(a: Article): Row {
  return {
    slug: a.slug,
    doi: a.doi,
    title: a.title,
    journal: a.journal,
    published: a.published,
    status: a.status,
    code: a.code.map((r) => ({ repo: r.repo, url: r.url, name: shortName(r), license: r.license })),
    files: a.code.reduce((n, d) => n + (d.files_read || 0), 0),
    pairs: a.alignment?.pairs ?? 0,
    map: a.card?.doi ?? "",
    data: a.datasets?.length ?? a.data_links,
    reader: readerUrl(a) !== "",
  };
}
export const lot2 = (n: number) => String(n).padStart(2, "0");

export { STATUSES, status } from "./status";

export const STATES: Record<string, string> = {
  alive: "the link answers",
  dead: "the link is dead",
  unverified: "not verified yet",
  unreachable: "unreachable at the last attempt",
  unverifiable: "cannot be verified",
};

export const LEVELS: Record<string, string> = {
  found: "found in the paper",
  alive: "the link answers",
  inventoried: "files inventoried",
  imported: "copy kept",
};


export { dateInWords, dayInWords, number, plural } from "./format";

/** The papers grouped by day of publication, from the most recent to the oldest. */
export function byDay(articles: Article[]): { day: string; label: string; articles: Article[] }[] {
  const groups = new Map<string, Article[]>();
  for (const a of articles) {
    const day = a.published || "";
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(a);
  }
  return [...groups.entries()]
    .sort(([x], [y]) => (x < y ? 1 : x > y ? -1 : 0))
    .map(([day, list]) => ({ day, label: dayInWords(day), articles: list }));
}

/** The date of the catalog, e.g. "26 September 2026, 21:23 UTC". */
export function generatedInWords(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return `${day}, ${d.toISOString().slice(11, 16)} UTC`;
}

/** The paper on Europe PMC, where the reader loads its text from. */
export function europePmcUrl(a: Article): string {
  const id = (a.fulltext_id || a.pmcid || "").toUpperCase();
  if (/^(PMC|PPR)\d+$/.test(id)) return `https://europepmc.org/article/${id.slice(0, 3)}/${id}`;
  return `https://europepmc.org/search?query=${encodeURIComponent(`DOI:"${a.doi}"`)}`;
}

/** The files of a repository, read in its lot (public/scripts/NN.json) at build time. */
const lots = new Map<number, Record<string, LotEntry>>();
export function lotEntry(d: Repo): LotEntry | undefined {
  if (!lots.has(d.lot)) {
    const path = `public/scripts/${lot2(d.lot)}.json`;
    const lot: Record<string, LotEntry> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    for (const e of Object.values(lot)) for (const f of e.files) f.source_url = webUrl(f.source_url);
    lots.set(d.lot, lot);
  }
  return lots.get(d.lot)![d.repo];
}

/** The pairs of a paper (src/data/alignments/NN.json), sorted by pair number. */
const alignmentLots = new Map<number, Record<string, Alignment>>();
export function alignmentOf(a: Article): Alignment | undefined {
  if (!a.alignment) return undefined;
  const lot = a.alignment.lot;
  if (!alignmentLots.has(lot)) {
    const path = `src/data/alignments/${lot2(lot)}.json`;
    alignmentLots.set(lot, existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  }
  const found = alignmentLots.get(lot)![a.id];
  return found && { ...found, pairs: [...found.pairs].sort((x, y) => x.pair - y.pair) };
}
