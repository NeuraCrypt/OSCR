// The harvester's public export, read once when the site is built.
// See scripts/data.mjs: it comes from CATALOG_DIR, always exported in public mode.
import { existsSync, readFileSync } from "node:fs";
import raw from "../data/catalog.json";

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

/** Only web addresses become links: anything else in the data (a `javascript:` URL,
 *  say) is dropped, and the pages fall back to another link or to none. */
export const webUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : "");

export const catalog = raw as unknown as Catalog;
for (const a of catalog.articles) for (const r of a.code) r.url = webUrl(r.url);

/** The papers whose authors' code was found: they are the ones the site shows. */
export const withCode = catalog.articles.filter((a) => a.code.length > 0);

export const recordUrl = (a: Article) => `/paper/${a.slug}/`;
export const readerUrl = (a: Article) => `/paper/${a.slug}/code/`;
export const lot2 = (n: number) => String(n).padStart(2, "0");

/** The status, in words; `tone` is `ok`, `warning` or nothing (science.css). */
export const STATUSES: Record<string, { label: string; tone: "ok" | "warning" | "" }> = {
  code_verified: { label: "code verified", tone: "ok" },
  code_found: { label: "code found, not verified yet", tone: "warning" },
  code_empty: { label: "empty repository", tone: "warning" },
  code_dead: { label: "dead link", tone: "warning" },
  on_request: { label: "code on request", tone: "" },
  data_only: { label: "data only", tone: "" },
  none: { label: "no code", tone: "" },
  no_fulltext: { label: "full text unavailable", tone: "" },
};
export const status = (s: string) => STATUSES[s] ?? { label: s.replace(/_/g, " "), tone: "" as const };

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

const FORGE = /^(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/(.+)$/;

/** A repository as one reads it at a glance: "owner/repo", "Zenodo 123", "OSF abcde". */
export function shortName(d: Pick<Repo, "repo" | "url">): string {
  const m = d.repo.match(FORGE);
  if (m) {
    // The normalized name is in lower case; the URL keeps the authors' spelling.
    const u = d.url.match(/^https?:\/\/(?:www\.)?[^/]+\/([^?#]+?)(?:\.git)?\/?$/);
    return u && u[1].toLowerCase() === m[1] ? u[1] : m[1];
  }
  const z = d.repo.match(/^(zenodo|osf|figshare):(.+)$/);
  if (z) return `${{ zenodo: "Zenodo", osf: "OSF", figshare: "figshare" }[z[1]]} ${z[2]}`;
  return d.repo;
}

export { number, plural } from "./format";

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

/** "2026-09-21" → "Monday, 21 September 2026"; a month or a year alone stays so. */
export function dayInWords(day: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
  }
  if (/^\d{4}-\d{2}$/.test(day)) {
    return new Date(`${day}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  }
  if (/^\d{4}$/.test(day)) return day;
  return "Unknown date";
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
