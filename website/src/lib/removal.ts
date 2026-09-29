// A removal request (Phase 6; the page /removal/, docs/CONTRIBUTIONS.md "Request a removal"): its
// vocabulary, its rules, and the facts of the paper it names. Shared by the page's script
// (src/scripts/removal.ts), which checks a request before its review step, and the Worker
// (worker/contributions/index.ts), which checks it again before it records it: the same rules and
// the same words on both sides. Nothing here reaches the network by itself (`loadFacts` is given
// the way to read the site's files), and nothing names the platform: "the registry".
//
// The facts of a paper come from files the site already has, never from a file of its own: the
// record of a paper rendered on demand (/records/paper/NN.json), or the static page of a recent
// paper, which carries them in a <script type="application/json" id="paper-facts"> at the top of
// its <main> (src/pages/paper/[slug]/index.astro). No new file per paper (CLAUDE.md, the file
// budget).
import type { PaperRecord } from "./render.ts";
import { shardOf, SHARDS } from "./shards.ts";

// ---------------------------------------------------------------------------------------------
// The vocabulary.

export type Choice<T extends string> = readonly (readonly [T, string])[];

/** Who asks. An author's request is marked verified when the account's ORCID iD is among the
 *  paper's authors (Phase 5's facts); the moderator's rules apply it then (lib/moderation.ts). */
export const ROLES = [
  ["author", "An author of this paper"],
  ["rights_holder", "The holder of the rights (copyright, license)"],
  ["named_person", "A person named in this record"],
  ["other", "Someone else"],
] as const satisfies Choice<string>;
export type RoleValue = (typeof ROLES)[number][0];

/** What to remove. Every scope but the whole record needs the paper's code. */
export const SCOPES = [
  ["record", "The whole record"],
  ["scripts", "Only the copies of the authors' scripts"],
  ["repository", "One repository's copies"],
  ["file", "One file"],
  ["map", "The tracing map"],
] as const satisfies Choice<string>;
export type ScopeValue = (typeof SCOPES)[number][0];

/** Why. "incorrect": the page suggests a correction of the record first, and still allows it. */
export const REASONS = [
  ["copyright", "Copyright or license"],
  ["personal_data", "Personal data"],
  ["not_my_work", "Wrongly attributed, or not my work"],
  ["retracted", "The paper was retracted"],
  ["incorrect", "The record is incorrect"],
  ["other", "Another reason"],
] as const satisfies Choice<string>;
export type ReasonValue = (typeof REASONS)[number][0];

/** The words of a stored value, the requests made before the page included ('author_request',
 *  and no role). */
export const REASON_WORDS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(REASONS.map(([v, t]) => [v, t.toLowerCase()])),
  author_request: "an author's request",
};
export const SCOPE_WORDS: Readonly<Record<string, string>> = {
  record: "the whole record",
  scripts: "the copies of the authors' scripts",
  repository: "one repository's copies",
  file: "one file",
  map: "the tracing map",
};
export const ROLE_WORDS: Readonly<Record<string, string>> = {
  author: "an author of the paper",
  rights_holder: "the holder of the rights",
  named_person: "a person named in the record",
  other: "someone else",
  "": "not said",
};

/** The justification's length, in characters, once its spaces are collapsed. */
export const DETAILS_MIN = 30;
export const DETAILS_MAX = 2000;
/** The evidence link's length. */
export const EVIDENCE_MAX = 300;
/** When an accepted request takes effect: the registry's nightly publication (tools/org.oscr.nightly.plist). */
export const NIGHTLY = "04:17";

const includes = <T extends string>(list: Choice<T>, value: unknown): value is T =>
  typeof value === "string" && list.some(([v]) => v === value);

// ---------------------------------------------------------------------------------------------
// No email address, anywhere (CLAUDE.md).

/** An email address, also written with spaces or brackets around the at sign ("name [at] lab.org").
 *  The contributions' texts lose theirs (worker/contributions/text.ts); a removal request's
 *  justification is refused with one, so that its author knows. */
export const ADDRESS = /[^\s@<>()[\]{},;:]+\s*(?:[@＠]|[[({]\s*at\s*[\])}])\s*[^\s@<>()[\]{},;:.]+(?:\s*(?:\.|[[({]\s*dot\s*[\])}])\s*[^\s@<>()[\]{},;:.]+)+/gi;

/** The first email address in `text`, or "". */
export function addressIn(text: string): string {
  return new RegExp(ADDRESS.source, "i").exec(text)?.[0] ?? "";
}

/** An https web address as the registry may keep it (no credentials, no at sign, at most
 *  EVIDENCE_MAX characters), or "". Never fetched by the Worker: a moderator opens it. */
export function httpsUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const t = value.trim();
  if (!t || t.length > EVIDENCE_MAX || /\s/.test(t)) return "";
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".") || u.href.includes("@")) return "";
  return u.href.length <= EVIDENCE_MAX ? u.href : "";
}

// ---------------------------------------------------------------------------------------------
// The paper a request names.

/** A code repository of a paper, as a removal request may name it: its key (github.com/owner/name,
 *  zenodo:123…), its name and address, whether the site holds copies of its text (`copies`: its
 *  license allows republishing it), and its files' paths (at most FILES_LISTED; `more` others). */
export type RepoFacts = { repo: string; name: string; url: string; license: string; copies: boolean; files: string[]; more: number };
export type PaperFacts = {
  id: string;
  slug: string;
  doi: string;
  title: string;
  /** The authors' names, in order (at most AUTHORS_LISTED; `authors_more` others). */
  authors: string[];
  authors_more: number;
  /** The authors' code: a paper without any has no copy of a script and no tracing map. */
  repos: RepoFacts[];
};

/** The files a request may name, per repository; the others are named with their repository. */
export const FILES_LISTED = 5000;
export const AUTHORS_LISTED = 50;

/** The page of a paper: the same rule as catalog.slug (Python) and paperSlug (worker/account). */
export function slugOf(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}

/** "https://doi.org/10.1234/ABC", "doi:10.1234/abc", "10.1234/abc" → "10.1234/abc"; "" otherwise. */
export function normalizeDoi(text: string): string {
  let doi = text.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").trim();
  if (doi.includes("%")) {
    try {
      doi = decodeURIComponent(doi);
    } catch {
      // not an encoded DOI: kept as typed
    }
  }
  doi = doi.toLowerCase();
  return /^10\.\d{3,9}\/\S+$/.test(doi) && doi.length <= 245 ? doi : "";
}

/** The paper a page's address names (?paper=): the registry's id ("doi:10.…", "pmcid:PMC…",
 *  "epmc:…") or a DOI, as typed or as a link. null when it names none. */
export function paperOf(value: string | null | undefined): { id: string; doi: string; slug: string } | null {
  const v = (value ?? "").trim();
  if (!v || v.length > 300) return null;
  const pmc = /^pmcid:\s*(PMC\d{1,12})$/i.exec(v);
  if (pmc) {
    const id = `pmcid:${pmc[1].toUpperCase()}`;
    return { id, doi: "", slug: slugOf(id) };
  }
  if (/^epmc:[A-Za-z0-9._-]{1,60}$/.test(v)) return { id: v, doi: "", slug: slugOf(v) };
  const doi = normalizeDoi(v);
  if (!doi) return null;
  const id = `doi:${doi}`;
  return { id, doi, slug: slugOf(id) };
}

/** The page of this form for a paper. */
export const removalUrl = (id: string) => `/removal/?paper=${encodeURIComponent(id)}`;

/** A code entry of a record, with the files the build adds (src/lib/records.ts). */
type RecordCode = PaperRecord["code"][number] & { copies?: boolean; files?: string[]; files_more?: number };

/** The facts of a paper rendered on demand, from its record (/records/paper/NN.json). */
export function factsOfRecord(r: PaperRecord): PaperFacts {
  return {
    id: r.id,
    slug: r.slug,
    doi: r.doi,
    title: r.title,
    authors: r.authors.slice(0, AUTHORS_LISTED).map((x) => x.text),
    authors_more: Math.max(0, r.authors.length - AUTHORS_LISTED),
    repos: (r.code as RecordCode[])
      .filter((c) => c.repo)
      .map((c) => {
        const files = (c.files ?? []).slice(0, FILES_LISTED);
        return {
          repo: c.repo,
          name: c.name,
          url: c.url,
          license: c.license,
          copies: c.copies === true,
          files,
          more: (c.files_more ?? 0) + Math.max(0, (c.files ?? []).length - files.length),
        };
      }),
  };
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** `value` as PaperFacts, when it has their shape (what a page carries is checked, not trusted). */
export function asFacts(value: unknown): PaperFacts | null {
  const f = value as Partial<PaperFacts> | null;
  if (!f || typeof f !== "object" || typeof f.id !== "string" || !f.id || !Array.isArray(f.repos) || !Array.isArray(f.authors)) return null;
  return {
    id: f.id,
    slug: text(f.slug) || slugOf(f.id),
    doi: text(f.doi),
    title: text(f.title),
    authors: f.authors.filter((a): a is string => typeof a === "string"),
    authors_more: Number(f.authors_more) || 0,
    repos: f.repos
      .filter((r): r is RepoFacts => !!r && typeof r === "object" && typeof (r as RepoFacts).repo === "string" && !!(r as RepoFacts).repo)
      .map((r) => ({
        repo: r.repo,
        name: text(r.name) || r.repo,
        url: text(r.url),
        license: text(r.license),
        copies: r.copies === true,
        files: Array.isArray(r.files) ? r.files.filter((p): p is string => typeof p === "string" && p !== "") : [],
        more: Number(r.more) || 0,
      })),
  };
}

/** The element of a static paper page that carries its facts. */
export const FACTS_ID = "paper-facts";
const FACTS_OPEN = new RegExp(`<script[^>]*\\sid="${FACTS_ID}"[^>]*>`);

/** The facts a page carries, read from its HTML as it arrives: the reading stops once they are
 *  read, at the top of the page's <main> (a few kilobytes), whatever the page's size. null when
 *  the page is not there or carries none. */
export async function factsFromPage(res: Response, most = 4_000_000): Promise<PaperFacts | null> {
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) html += decoder.decode(value, { stream: true });
      const open = FACTS_OPEN.exec(html);
      if (open) {
        const start = open.index + open[0].length;
        const end = html.indexOf("</script>", start);
        if (end >= 0) {
          try {
            return asFacts(JSON.parse(html.slice(start, end)));
          } catch {
            return null;
          }
        }
      } else if (html.includes("</main>")) return null;
      if (done || html.length > most) return null;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** How to read a file of the site: the browser's fetch, or the Worker's assets. */
export type Get = (path: string) => Promise<Response>;

/** The facts of the paper whose page is `slug`, from the site's files: the record of a paper
 *  rendered on demand, or the static page of a recent one, in the order asked (the browser reads
 *  the record first, a static file, so that a signed-out reader's view asks the Worker nothing;
 *  the Worker reads the page first, the top of it only). null when the registry has no page for
 *  it (a paper without code nor page, or a record withdrawn). */
export async function loadFacts(get: Get, slug: string, order: "record-first" | "page-first" = "record-first"): Promise<PaperFacts | null> {
  if (!/^[a-z0-9._-]{1,120}$/.test(slug)) return null;
  const fromRecord = async (): Promise<PaperFacts | null> => {
    const res = await get(`/records/paper/${await shardOf(slug, SHARDS.paper)}.json`);
    if (!res.ok) return null;
    const shard = (await res.json()) as Record<string, PaperRecord>;
    return Object.hasOwn(shard, slug) ? factsOfRecord(shard[slug]) : null;
  };
  const fromPage = async () => factsFromPage(await get(`/paper/${slug}/`));
  const [first, second] = order === "record-first" ? [fromRecord, fromPage] : [fromPage, fromRecord];
  return (await first()) ?? (await second());
}

// ---------------------------------------------------------------------------------------------
// A request, checked.

export type RemovalRequest = {
  role: RoleValue;
  scope: ScopeValue;
  repo: string;
  path: string;
  reason: ReasonValue;
  /** The justification, trimmed (the Worker cleans it as every contribution's text). */
  details: string;
  evidence_url: string;
};
export type Refusal = { status: number; code: string; message: string; field: string };
export type Checked = { ok: true; request: RemovalRequest } | ({ ok: false } & Refusal);

const refuse = (code: string, message: string, field: string, status = 400): Checked => ({ ok: false, status, code, message, field });

/** The justification's length as it is counted: spaces collapsed. */
export const detailsLength = (text: string) => Array.from(text.trim().replace(/\s+/g, " ")).length;

/** A removal request as the form sends it (`body`), checked against the paper's facts: who asks,
 *  what to remove (a repository and a file among the paper's own), why, a justification without
 *  an email address, an https evidence link, the two confirmations. */
export function checkRequest(body: Record<string, unknown>, facts: PaperFacts): Checked {
  const role = body.role;
  if (!includes(ROLES, role)) return refuse("bad_role", "Say who you are: an author, the holder of the rights, a person named in the record, or someone else.", "role");
  const scope = body.scope;
  if (!includes(SCOPES, scope)) return refuse("bad_scope", "Say what to remove.", "scope");
  let repo = "";
  let path = "";
  if (scope !== "record") {
    if (facts.repos.length === 0) {
      return refuse("no_code", "The registry holds no code of this paper, and so no copy of a script and no tracing map: only the whole record can be removed.", "scope");
    }
    if (scope === "repository" || scope === "file") {
      const r = facts.repos.find((x) => x.repo === body.repo);
      if (!r) return refuse("unknown_repo", "Choose one of this paper's repositories.", "repo");
      repo = r.repo;
      if (scope === "file") {
        path = typeof body.path === "string" ? body.path : "";
        if (!path || !r.files.includes(path)) return refuse("unknown_file", "Choose one of this repository's files.", "path");
        if (addressIn(path)) {
          return refuse("bad_file", "This file's name holds an email address, which the registry never keeps: ask for its repository's copies instead, and name the file in words.", "path");
        }
      }
    }
  }
  const reason = body.reason;
  if (!includes(REASONS, reason)) return refuse("bad_reason", "Say why the registry should remove it.", "reason");
  const details = typeof body.details === "string" ? body.details.trim() : "";
  const address = addressIn(details);
  if (address || /[@＠]/.test(details)) {
    return refuse(
      "email_in_text",
      `Your justification contains ${address ? `an email address (${address})` : "an at sign (@)"}: remove it. The registry never keeps an email address; the decision comes to this page and to your account page.`,
      "details",
    );
  }
  const n = detailsLength(details);
  if (n < DETAILS_MIN) return refuse("short_details", `Justify the request in at least ${DETAILS_MIN} characters (${n} now): what is wrong, and where.`, "details");
  if (n > DETAILS_MAX) return refuse("long_details", `Keep the justification to ${DETAILS_MAX} characters (${n} now): a link to a longer text can go with it.`, "details");
  const typed = typeof body.evidence_url === "string" ? body.evidence_url.trim() : "";
  const evidence = httpsUrl(typed);
  if (typed && !evidence) {
    return refuse("bad_evidence", `The evidence link must be a web address that starts with https:// (at most ${EVIDENCE_MAX} characters), or nothing.`, "evidence_url");
  }
  if (body.confirm_accurate !== true || body.confirm_review !== true) {
    return refuse("not_confirmed", "Confirm both statements: that what you give is accurate, and that you understand how requests are decided.", "confirm");
  }
  return { ok: true, request: { role, scope, repo, path, reason, details, evidence_url: evidence } };
}
