// The GitHub side's search (night phase 08, E4): GET /api/search?type=repositories|issues|people|topics,
// beside the papers' (search.ts, the default type). ONE FTS5 index in oscr_search, `forge_fts`
// (migrations/d1/search/0002_forge.sql), pushed by the Mac from the night's PUBLIC static files
// (oscr/social.py): the repositories the registry knows, its research issues, the people whose profile
// is public, the topics. As fresh as the last push (the answer says when).
//
// A search runs only when submitted (D3: the page sends it on the form's submit, never as one types),
// and the quota message says when the index's share is spent (api.ts). The query: words (all of them),
// "quoted phrases", -excluded words, and GitHub's qualifiers the index knows: is:open, is:closed
// (issues), type:code-error|mismatch|reproduction (issues), user:<login> and org:<login>
// (repositories, the owner), repo:owner/name (a repository, its research issues), doi:<DOI>, in:title. Anything else is searched as words, and the answer
// says which qualifiers it did not use. Every term is quoted before it reaches FTS5: nothing a reader
// types is ever FTS5 syntax.
//
// GitHub's own issues, commits and code are not in this index: the page searches GitHub's issues and
// commits in the reader's browser, over the repositories the registry knows, on the reader's own
// quota; code needs a GitHub sign-in (GitHub's rule), so the page carries the query to GitHub's code
// search, and says why.

import type { D1Database } from "./d1.ts";

export const FORGE_TYPES = ["repositories", "issues", "people", "topics"] as const;
export type ForgeType = (typeof FORGE_TYPES)[number];
const KIND_OF: Readonly<Record<ForgeType, string>> = { repositories: "repository", issues: "issue", people: "person", topics: "topic" };

export const FORGE_PAGE_SIZE = 20;
export const FORGE_MAX_PAGE = 25;
/** Matches counted per type (a count past it says "more than"). */
export const COUNT_CAP = 1000;
const MAX_QUERY = 300;
const MAX_TERMS = 12;

export class ForgeSearchError extends Error {}

export interface ForgeQuery {
  type: ForgeType;
  q: string;
  page: number;
}

export interface ParsedForge {
  words: string[];
  phrases: string[];
  not: string[];
  is: "open" | "closed" | null;
  researchType: "code_error" | "mismatch" | "reproduction" | null;
  owner: string | null;
  /** repo:owner/name: the repository's research issues, or the repository itself. */
  repo: string[] | null;
  doi: string | null;
  inTitle: boolean;
  unused: string[];
}

const RESEARCH_TYPES: Readonly<Record<string, ParsedForge["researchType"]>> = {
  "code-error": "code_error",
  code_error: "code_error",
  mismatch: "mismatch",
  reproduction: "reproduction",
};

/** The words FTS5 sees in a text: letters and digits, lower case (unicode61's own split, roughly). */
function tokens(text: string): string[] {
  return (text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TERMS);
}

/** A reader's query, as the index uses it. */
export function parseForgeQuery(input: string): ParsedForge {
  const out: ParsedForge = { words: [], phrases: [], not: [], is: null, researchType: null, owner: null, repo: null, doi: null, inTitle: false, unused: [] };
  const text = input.slice(0, MAX_QUERY);
  for (const m of text.matchAll(/(-?)"([^"]*)"|(\S+)/g)) {
    if (m[2] !== undefined) {
      const t = tokens(m[2]);
      if (!t.length) continue;
      if (m[1]) out.not.push(t.join(" "));
      else out.phrases.push(t.join(" "));
      continue;
    }
    const raw = m[3];
    const q = /^([a-z-]+):(.+)$/i.exec(raw);
    if (q) {
      const [key, value] = [q[1].toLowerCase(), q[2]];
      if (key === "is" && (value === "open" || value === "closed")) out.is = value;
      else if (key === "type" && RESEARCH_TYPES[value.toLowerCase()]) out.researchType = RESEARCH_TYPES[value.toLowerCase()];
      else if ((key === "user" || key === "org") && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value)) out.owner = value.toLowerCase();
      else if (key === "repo" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(value)) out.repo = tokens(value);
      else if (key === "doi" && /^10\.\d{4,9}\/\S+$/.test(value)) out.doi = value.toLowerCase();
      else if (key === "in" && value.toLowerCase() === "title") out.inTitle = true;
      else {
        out.unused.push(raw);
        out.words.push(...tokens(raw));
      }
      continue;
    }
    if (raw.startsWith("-") && raw.length > 1) {
      const t = tokens(raw.slice(1));
      if (t.length) out.not.push(t.join(" "));
      continue;
    }
    out.words.push(...tokens(raw));
  }
  out.words = [...new Set(out.words)].slice(0, MAX_TERMS);
  return out;
}

const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** The FTS5 MATCH of one type: every term quoted; the filters on `kind`, the owner and the DOI on
 *  `ids`, words in the title only with in:title. */
export function forgeMatch(type: ForgeType, p: ParsedForge): string {
  const clauses = [`{kind} : ${quote(`zzk${KIND_OF[type]}`)}`];
  const where = p.inTitle ? "{title}" : "{title text ids}";
  for (const w of p.words) clauses.push(`${where} : ${quote(w)}`);
  for (const ph of p.phrases) clauses.push(`${where} : ${quote(ph)}`);
  if (p.is && type === "issues") clauses.push(`{kind} : ${quote(`zzs${p.is}`)}`);
  if (p.researchType && type === "issues") clauses.push(`{kind} : ${quote(`zzt${p.researchType.replace("_", "")}`)}`);
  if (p.owner && type === "repositories") clauses.push(`{ids} : ${quote(tokens(p.owner).join(" "))}`);
  if (p.repo?.length && (type === "repositories" || type === "issues")) clauses.push(`{ids} : ${quote(p.repo.join(" "))}`);
  if (p.doi) clauses.push(`{ids} : ${quote(tokens(p.doi).join(" "))}`);
  let match = clauses.join(" AND ");
  for (const n of p.not) match += ` NOT {title text ids} : ${quote(n)}`;
  return match;
}

/** What the reader asked, from the URL's parameters. */
export function readForgeQuery(params: URLSearchParams): ForgeQuery {
  const type = params.get("type") ?? "";
  if (!(FORGE_TYPES as readonly string[]).includes(type)) throw new ForgeSearchError(`“type” is papers or one of: ${FORGE_TYPES.join(", ")}.`);
  const q = (params.get("q") ?? "").trim();
  if (q.length > MAX_QUERY) throw new ForgeSearchError(`A search is ${MAX_QUERY} characters at most.`);
  const page = Number(params.get("page") ?? "1");
  if (!Number.isInteger(page) || page < 1 || page > FORGE_MAX_PAGE) throw new ForgeSearchError(`“page” is a number from 1 to ${FORGE_MAX_PAGE}.`);
  return { type: type as ForgeType, q, page };
}

export interface ForgeOutcome {
  type: ForgeType;
  q: string;
  page: number;
  size: number;
  results: unknown[];
  counts: Partial<Record<ForgeType, number>>;
  capped: Partial<Record<ForgeType, boolean>>;
  notices: string[];
  cost: { queries: number; rows_read: number };
}

/** The search: the type's page of results, and the matches of every type (for the tabs' counts),
 *  in ONE batch. Rows read: the results, and the matches counted (≤ COUNT_CAP a type). */
export async function runForgeSearch(db: D1Database, query: ForgeQuery): Promise<ForgeOutcome> {
  const p = parseForgeQuery(query.q);
  const notices: string[] = [];
  if (p.unused.length) notices.push(`Not used as qualifiers: ${p.unused.join(", ")} (searched as words).`);
  if (!p.words.length && !p.phrases.length && !p.is && !p.researchType && !p.owner && !p.repo && !p.doi) {
    notices.push("Type words to search for: everything of this type is listed meanwhile, the most relevant first.");
  }
  const size = FORGE_PAGE_SIZE;
  const stmts = [
    db.prepare("SELECT fx FROM forge_fts WHERE forge_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?").bind(forgeMatch(query.type, p), size, (query.page - 1) * size),
    ...FORGE_TYPES.map((t) => db.prepare("SELECT count(*) AS n FROM (SELECT rowid FROM forge_fts WHERE forge_fts MATCH ? LIMIT ?)").bind(forgeMatch(t, p), COUNT_CAP + 1)),
  ];
  const out = await db.batch(stmts);
  let rowsRead = 0;
  for (const r of out) rowsRead += Number(r.meta?.rows_read ?? 0);
  const results = ((out[0]?.results ?? []) as { fx: string }[]).flatMap((r) => {
    try {
      return [JSON.parse(r.fx) as unknown];
    } catch {
      return [];
    }
  });
  const counts: Partial<Record<ForgeType, number>> = {};
  const capped: Partial<Record<ForgeType, boolean>> = {};
  FORGE_TYPES.forEach((t, i) => {
    const n = Number((out[i + 1]?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
    counts[t] = Math.min(n, COUNT_CAP);
    capped[t] = n > COUNT_CAP;
  });
  return { type: query.type, q: query.q, page: query.page, size, results, counts, capped, notices, cost: { queries: stmts.length, rows_read: rowsRead } };
}
