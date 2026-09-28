// The full page of a paper (Phase 4): its sections beyond catalog.json, read once per paper
// when the site is built, from src/data/papers/NN.json (scripts/data.mjs copies them from the
// harvester's public export, written by oscr/paperpage.py). A paper's texts (its abstract,
// its availability statements) are there only under the licenses of decision D1.
import { existsSync, readFileSync } from "node:fs";
import { SITE_NAME } from "../config";
import { lot2, webUrl, type Article } from "./catalog";

export type Affiliation = { name: string; ror: string };
/** An author in order; `affiliations` are numbers in the paper's list of affiliations (from 1). */
export type PageAuthor = { name: string; orcid: string; affiliations: number[] };
export type Notice = { kind: string; id: string; date: string; source: string; url: string };
export type Funding = { funder: string; url: string; awards: string[] };
/** An institution of the paper's authors, by ROR id (from the JATS or OpenAlex). */
export type PaperInstitution = { ror: string; name: string; country: string };
/** OpenAlex's primary topic of the paper, with its place in OpenAlex's hierarchy. */
export type Topic = { id: string; name: string; subfield: string; field: string; domain: string };
export type Overview = {
  type: string;
  language: string;
  volume: string;
  issue: string;
  pages: string;
  dates: { received: string; accepted: string; online: string; print: string };
  pmid: string;
  license: string;
  open: boolean;
  has_abstract: boolean;
  abstract: string;
  authors: PageAuthor[];
  affiliations: Affiliation[];
  keywords: string[];
  mesh: { term: string; major: boolean }[];
  subjects: string[];
  funding: Funding[];
  cited_by: number | null;
  references: number | null;
  /** Where the counts came from, in words ("Europe PMC", "OpenAlex", "the paper"); "" unknown. */
  cited_by_source?: string;
  references_source?: string;
  rrids: { rrid: string; kind: string; name: string }[];
  notices: Notice[];
  // What OpenAlex adds (absent from an export made before it).
  institutions?: PaperInstitution[];
  topic?: Topic | null;
  openalex_id?: string;
  /** diamond, gold, hybrid, bronze, green or closed (OpenAlex's, from Unpaywall). */
  oa_status?: string;
  oa_url?: string;
  preprint?: { id: string; url: string } | null;
};
export type Features = {
  readme: boolean | null;
  citation_cff: boolean | null;
  license_file: boolean | null;
  env_files: string[];
  tests: boolean | null;
  ci: boolean | null;
  docs: boolean | null;
  notebooks: number | null;
};
/** What the Code section adds to a repository of catalog.json. */
export type RepoFacts = {
  commit_date: string;
  /** The README at the repository's root ("README.md"), where the badge goes (Phase 6). */
  readme?: string;
  files: number | null;
  scripts_listed: number;
  created: string;
  verified_on: string;
  features: Features | null;
  tools: { id: string; files: number; via: string }[];
  checks: { on: string; state: string; http: number | null }[];
};
/** Under an open license, each statement with its heading and text; otherwise its kind only. */
export type Statement = { kind: string; title?: string; text?: string };
export type Availability = {
  open: boolean;
  statements: Statement[];
  on_request: { code: boolean; data: boolean };
  points_to: { code: string[]; data: { dataset: string; repository: string }[] };
};
export type DataLink = { repo: string; url: string; dataset: string; repository: string; where: string };
export type MapFacts = {
  status: "validated" | "proposed" | "none";
  repositories: number;
  files: number;
  pairs: number;
  method: string;
  validated_by: { name: string; orcid: string; on: string }[];
  doi: string;
  concept_doi: string;
  deposited_on: string;
  record_url: string;
  json_url: string;
  /** The map's SHA-256 (oscr/zenodo.py map_digest): a validation from this page carries it (Phase 6). */
  digest?: string;
};
export type Change = {
  field: string;
  before?: string | number;
  after?: string | number;
  added?: string[];
  removed?: string[];
  n_added?: number;
  n_removed?: number;
  reordered?: boolean;
};
/** `by`: "harvester", or the role of the person whose correction made it (Phase 6): "author",
 *  "maintainer", "submitter" — never who. */
export type Version = { version: number; date: string; by: string; first: boolean; changes: Change[] };
export type Citation = { apa: string; bibtex: string; ris: string; csl: Record<string, unknown> };
export type Similar = { slug: string; score: number; reasons: string };
export type PaperPage = {
  overview: Overview;
  code: Record<string, RepoFacts>;
  availability: Availability;
  data: DataLink[];
  map: MapFacts;
  versions: Version[];
  cite: { paper: Citation; map: Citation | null };
  similar: Similar[];
};

const lots = new Map<number, Record<string, PaperPage>>();

/** A paper's sections, from its lot (`page_lot` in catalog.json); undefined for an export
 *  older than Phase 4, whose pages then show what catalog.json holds. */
export function pageOf(a: Article & { page_lot?: number }): PaperPage | undefined {
  if (typeof a.page_lot !== "number") return undefined;
  if (!lots.has(a.page_lot)) {
    const path = `src/data/papers/${lot2(a.page_lot)}.json`;
    const lot: Record<string, PaperPage> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    for (const p of Object.values(lot)) {
      for (const n of p.overview?.notices ?? []) n.url = webUrl(n.url);
      for (const f of p.overview?.funding ?? []) f.url = webUrl(f.url);
      for (const d of p.data ?? []) d.url = webUrl(d.url);
      if (p.map) {
        p.map.record_url = webUrl(p.map.record_url);
        p.map.json_url = webUrl(p.map.json_url);
      }
      if (p.cite?.map) p.cite.map = withPlatform(p.cite.map);
    }
    lots.set(a.page_lot, lot);
  }
  return lots.get(a.page_lot)![a.id];
}

// ---------------------------------------------------------------------------------------
// Words.

const TYPES: Record<string, string> = {
  "research-article": "Research article",
  "review-article": "Review",
  "systematic-review": "Systematic review",
  "brief-report": "Brief report",
  "short-report": "Short report",
  "rapid-communication": "Rapid communication",
  "methods-article": "Methods article",
  "data-paper": "Data paper",
  "case-report": "Case report",
  preprint: "Preprint",
  letter: "Letter",
  editorial: "Editorial",
  correction: "Correction",
  retraction: "Retraction notice",
  abstract: "Conference abstract",
  other: "Other",
};
export const typeLabel = (t: string) => TYPES[t] ?? (t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/-/g, " ") : "");

const LANGUAGES: Record<string, string> = {
  en: "English", fr: "French", de: "German", es: "Spanish", pt: "Portuguese", it: "Italian", nl: "Dutch",
  zh: "Chinese", ja: "Japanese", ko: "Korean", ru: "Russian", pl: "Polish", tr: "Turkish", ar: "Arabic",
};
export const languageLabel = (code: string) => LANGUAGES[code.toLowerCase()] ?? code;

/** "cc by-nc-nd" → "CC BY-NC-ND", "CC-BY-4.0" → "CC BY 4.0", "cc0" → "CC0". */
export function licenseLabel(license: string): string {
  const l = license.trim();
  const m = l.match(/^cc[\s_-]*(0|by(?:[\s_-]*(?:nc|nd|sa))*)(?:[\s_-]*v?(\d(?:\.\d)?))?$/i);
  if (!m) return l;
  const name = m[1] === "0" ? "CC0" : `CC ${m[1].toUpperCase().split(/[\s_-]+/).join("-")}`;
  return m[2] ? `${name} ${m[2]}` : name;
}

/** An integrity notice, in words: shown at the top of the page, except a comment. */
export const NOTICES: Record<string, string> = {
  retraction: "This paper has been retracted",
  concern: "An expression of concern has been published about this paper",
  correction: "A correction to this paper has been published",
  reinstatement: "This paper has been reinstated after a retraction",
  comment: "A comment on this paper has been published",
};
export const PROMINENT = new Set(["retraction", "concern", "correction", "reinstatement"]);

/** The fields of a version, in words. */
const FIELDS: Record<string, string> = {
  type: "Type",
  language: "Language",
  "journal.title": "Journal",
  "journal.issn": "ISSN",
  "journal.eissn": "Electronic ISSN",
  "journal.publisher": "Publisher",
  "journal.nlm_ta": "Journal abbreviation",
  volume: "Volume",
  issue: "Issue",
  pages: "Pages",
  "dates.received": "Received",
  "dates.accepted": "Accepted",
  "dates.epub": "Published online",
  "dates.ppub": "Published in print",
  "dates.collection": "Issue date",
  "dates.first_publication": "First published",
  authors: "Authors",
  keywords: "Keywords",
  mesh: "MeSH terms",
  funding: "Funding",
  references: "References",
  rrids: "RRIDs",
  integrity: "Integrity notices",
  code: "Code links",
  data: "Data links",
};
export const fieldLabel = (f: string) => FIELDS[f] ?? f;

/** What a first version recorded, in a few words: "4 authors", "type", "journal". */
export function recorded(changes: Change[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of changes) {
    const top = c.field.split(".")[0];
    if (seen.has(top)) continue;
    seen.add(top);
    const n = c.n_added ?? 0;
    const lists: Record<string, [string, string]> = {
      authors: ["author", "authors"],
      keywords: ["keyword", "keywords"],
      mesh: ["MeSH term", "MeSH terms"],
      funding: ["funder", "funders"],
      rrids: ["RRID", "RRIDs"],
      integrity: ["integrity notice", "integrity notices"],
      code: ["code link", "code links"],
      data: ["data link", "data links"],
    };
    if (lists[top]) out.push(`${n} ${n === 1 ? lists[top][0] : lists[top][1]}`);
    else if (top === "references") out.push(`${c.after} references`);
    else if (top === "journal" || top === "dates") out.push(top === "journal" ? "journal" : "dates");
    else out.push(fieldLabel(top).toLowerCase());
  }
  return out;
}

/** The features of a repository, in words: what it has, and what was looked for and not found. */
export function featureWords(f: Features): { has: string[]; lacks: string[] } {
  const has: string[] = [];
  const lacks: string[] = [];
  const add = (v: boolean | null, word: string) => (v === true ? has : v === false ? lacks : []).push(word);
  add(f.readme, "README");
  add(f.license_file, "license file");
  add(f.citation_cff, "CITATION.cff");
  if (f.env_files.length) has.push(`environment (${f.env_files.join(", ")})`);
  else lacks.push("environment file");
  add(f.tests, "tests");
  add(f.ci, "continuous integration");
  add(f.docs, "documentation");
  if (f.notebooks) has.push(`${f.notebooks} notebook${f.notebooks === 1 ? "" : "s"}`);
  return { has, lacks };
}

/** A statement's kind, in words. */
export const STATEMENT_KINDS: Record<string, string> = {
  code: "code availability statement",
  data: "data availability statement",
  code_and_data: "code and data availability statement",
};

/** The paragraphs of a text (blank lines between them). */
export const paragraphs = (text: string) => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/** A text cut into plain parts and web addresses, to make links of the addresses. */
export function linkify(text: string): (string | { href: string; text: string })[] {
  const out: (string | { href: string; text: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"()]+[^\s<>"().,;:!?'’”]/g)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push({ href: m[0], text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------------------------------------------------------------------------------------
// The map's citation: the export writes the platform, one of its creators, as "{platform}";
// the site puts its own name there, escaped for each format.

const PLATFORM = "{platform}";
const bibtexEscape = (s: string) =>
  s.replace(/[\\{}&%$#_~^]/g, (c) =>
    c === "\\" ? "\\textbackslash{}" : c === "~" ? "\\textasciitilde{}" : c === "^" ? "\\textasciicircum{}" : `\\${c}`,
  );

function withPlatform(c: Citation): Citation {
  const csl = JSON.parse(JSON.stringify(c.csl), (_, v) => (v === PLATFORM ? SITE_NAME : v));
  return {
    apa: c.apa.replaceAll(PLATFORM, SITE_NAME),
    bibtex: c.bibtex.replaceAll(PLATFORM, bibtexEscape(SITE_NAME)),
    ris: c.ris.replaceAll(PLATFORM, SITE_NAME.replace(/\s+/g, " ")),
    csl,
  };
}
