// The markup of the pages that are not built ahead of time, as HTML text: the catalogue's
// listing (also used by the static pages, src/components/Listing.astro), an entity's page
// (rendered in the browser from /records/<type>/NN.json, src/scripts/entity.ts) and the page
// of a paper past STATIC_PAPERS (rendered by the Worker from /records/paper/NN.json,
// worker/pages.ts). One implementation for the three, so that they cannot drift apart.
//
// The classes are science.css's, and only them. Every text is escaped (`esc`), every address
// is checked (`href`): only a web address or a path of this site becomes a link. Nothing here
// names the platform: the page's shell does (SITE_NAME, src/config.ts).
import { dateInWords, dayInWords, number, plural } from "./format.ts";
import { removalUrl } from "./removal.ts";
import { STATIC_PAPERS, type EntityType } from "./shards.ts";
import { status } from "./status.ts";

// ---------------------------------------------------------------------------------------
// Text and links.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** A text, safe inside an element or a quoted attribute. */
export const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** An address that may become a link: a web address, or a path of this site (not "//host"). */
export const href = (url: string | null | undefined) =>
  url && (/^https?:\/\/[^\s"<>]+$/i.test(url) || /^\/(?!\/)[^\s"<>]*$/.test(url)) ? url : "";

/** A link, or its text alone when the address is not one (`cls`: science.css's class). The text
 *  may break inside a long name (`wrap`: a repository, a dataset, an address), so that a phone
 *  never scrolls sideways. */
export function a(text: string, url: string | null | undefined, cls = ""): string {
  const h = href(url);
  const c = cls ? ` class="${esc(cls)}"` : "";
  return h ? `<a${c} href="${esc(h)}">${wrap(text)}</a>` : cls ? `<span${c}>${wrap(text)}</span>` : wrap(text);
}

/** A text that may hold long addresses or paths: a line break is allowed (<wbr>) after a slash,
 *  "&", "?", "=" or "|", and inside any run of 24 characters that has none, so that it wraps on
 *  a phone. The parts, unescaped (Wrap.astro joins them with <wbr />). */
export function wrapParts(text: string, run = 24): string[] {
  const parts: string[] = [];
  let start = 0;
  let length = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    length = /\s/.test(c) ? 0 : length + 1;
    const after = "/&?=|".includes(c) && text[i + 1] !== "/" && i + 1 < text.length && !/\s/.test(text[i + 1]);
    // Never between the two halves of a character outside the BMP.
    const high = c >= "\ud800" && c <= "\udbff";
    if (!high && (after || length >= run)) {
      parts.push(text.slice(start, i + 1));
      start = i + 1;
      length = 0;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
export const wrap = (text: string) => wrapParts(text).map(esc).join("<wbr>");

/** A linked text or a plain one: `href` "" for none. */
export type Link = { text: string; href: string };

/** "A, B, C": links where there is an address; "…, and 12 more" when the list was cut. */
const links = (list: readonly Link[], total = list.length) =>
  list.map((l) => a(l.text, l.href)).join(", ") + (total > list.length ? `, and ${esc(number(total - list.length))} more` : "");
const line = (label: string, html: string) => `<div class="line"><span class="label">${esc(label)}:</span> ${html}</div>`;
const statusWords = (s: string) => {
  const x = status(s);
  return x.tone ? `<span class="${x.tone}">${esc(x.label)}</span>` : esc(x.label);
};

// ---------------------------------------------------------------------------------------
// The catalogue's listing: one h2.day per day of publication, then a dl.listing.

/** A paper in a listing. `reader`: its Code ↔ Paper reader is built (a static page, #code); its
 *  code's names then lead there, not to the source. A code repository's `repo`
 *  (github.com/owner/name) serves the home page's filter, and the reader's choice of repository. */
export type Row = {
  slug: string;
  doi: string;
  title: string;
  journal: string;
  published: string;
  status: string;
  code: { repo?: string; url: string; name: string; license: string }[];
  /** Files readable in the reader; matches computed; the map's DOI once an author validated it. */
  files: number;
  pairs: number;
  map: string;
  /** Datasets cited (or data links, for an export older than Phase 2). */
  data: number;
  reader: boolean;
};

/** A row as a shard stores it: under its page's name, without the filter's `repo`. */
export type StoredRow = Omit<Row, "slug">;
export const storedRow = ({ slug: _, ...r }: Row): StoredRow => ({
  ...r,
  code: r.code.map(({ url, name, license }) => ({ url, name, license })),
});

const paperUrl = (slug: string) => `/paper/${slug}/`;
/** A DOI at doi.org: the characters an address cannot carry as they are (an old SICI DOI holds
 *  "<" and ">") are percent-encoded. */
export const doiUrl = (doi: string) => `https://doi.org/${doi.replace(/[%"#?<>\s{}|\\^`]/g, (c) => encodeURIComponent(c))}`;

function rowHtml(r: Row, n: number, searchable: boolean): string {
  const keys = searchable
    ? ` data-title="${esc(r.title.toLowerCase())}" data-doi="${esc(r.doi.toLowerCase())}"` +
      ` data-journal="${esc(r.journal.toLowerCase())}"` +
      ` data-repo="${esc(r.code.map((d) => `${d.repo ?? ""} ${d.url}`).join(" ").toLowerCase())}"`
    : "";
  const page = paperUrl(r.slug);
  const head = `<span class="num">[${n}]</span> `;
  const journal = line("Journal", esc(r.journal || "—"));
  if (r.code.length === 0) {
    return (
      `<dt${keys}>${head}${a(`doi:${r.doi}`, page)} [${a("paper", doiUrl(r.doi))}` +
      `${r.data > 0 ? `, ${a("data", `${page}#data`)}` : ""}]</dt>` +
      `<dd><div class="title">${esc(r.title)}</div>${journal}` +
      line("Status", `${statusWords(r.status)}${r.data > 0 ? `, ${esc(plural(r.data, "dataset"))} cited` : ""}`) +
      `</dd>`
    );
  }
  // With the reader built, the code is read on the paper's page first; the source comes last.
  const inReader = (d: Row["code"][number]) =>
    r.code.length > 1 && d.repo ? `${page}?${new URLSearchParams({ repo: d.repo }).toString()}#code` : `${page}#code`;
  const code = r.code.map((d) => `${a(d.name, r.reader ? inReader(d) : d.url, "code")} (${esc(d.license || "no license")})`).join(", ");
  const facts = [
    r.files > 0 ? `, ${esc(plural(r.files, "file"))} readable` : "",
    r.pairs > 0 ? `, ${esc(plural(r.pairs, "match", "matches"))}` : "",
    r.map ? `, map validated by an author (${a("DOI", doiUrl(r.map))})` : "",
  ].join("");
  return (
    `<dt${keys}>${head}${r.reader ? `${a("Code ↔ Paper", `${page}#code`, "reader-link")} ` : ""}` +
    `${a(`doi:${r.doi}`, page)} [${a("paper", doiUrl(r.doi))}, ${a("repository", `${page}#code`)}]</dt>` +
    `<dd><div class="title">${esc(r.title)}</div>${journal}` +
    line("Authors' code", code) +
    line("Status", `${statusWords(r.status)}${facts}`) +
    `</dd>`
  );
}

/** The papers by day of publication, from the most recent. */
export function byDay<T extends { published: string }>(rows: readonly T[]): { day: string; label: string; rows: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const day = r.published || "";
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(r);
  }
  return [...groups.entries()]
    .sort(([x], [y]) => (x < y ? 1 : x > y ? -1 : 0))
    .map(([day, list]) => ({ day, label: dayInWords(day), rows: list }));
}

/** A list of papers, the catalogue's way. `searchable`: the home page's filter reads the
 *  data-* attributes of each dt. */
export function listing(rows: readonly Row[], opts: { searchable?: boolean } = {}): string {
  let n = 0;
  return byDay(rows)
    .map(
      (d) =>
        `<h2 class="day">${esc(d.label)} <small>(${esc(plural(d.rows.length, "paper"))})</small></h2>` +
        `<dl class="listing">${d.rows.map((r) => rowHtml(r, (n += 1), opts.searchable ?? false)).join("")}</dl>`,
    )
    .join("");
}

// ---------------------------------------------------------------------------------------
// The entities (authors, journals, institutions, tools, datasets): their records, as the build
// writes them into /records/<type>/NN.json, and their pages.

export type Counts = { papers: number; with_code: number };
type EntityBase = {
  /** The papers listed, the most recent first: at most ENTITY_ROWS_MAX of the entity's. */
  papers: string[];
  /** Where the search finds all of them, when some are not listed. */
  search: string;
};
export type AuthorRecord = EntityBase & {
  orcid: string;
  name: string;
  counts: Counts;
  affiliations: string[];
  institutions: Link[];
  /** At most LINKS_MAX, the most used first, of `tools_total`. */
  tools: Link[];
  tools_total: number;
};
export type JournalRecord = EntityBase & {
  title: string;
  issn: string;
  eissn: string;
  publisher: string;
  counts: Counts & { read: number };
};
export type InstitutionRecord = EntityBase & {
  id: string;
  name: string;
  /** In words ("Germany"), and OpenAlex's type ("education"); "" when unknown. */
  country: string;
  type: string;
  counts: Counts;
  /** At most LINKS_MAX, by name, of `authors_total`. */
  authors: Link[];
  authors_total: number;
};
export type ToolRecord = EntityBase & {
  name: string;
  kind: string;
  homepage: string;
  rrid: string;
  rrid_url: string;
  counts: Counts & { repositories: number };
  /** At most LINKS_MAX, the most evidence first, of `counts.repositories`. */
  repositories: Link[];
};
export type DatasetRecord = EntityBase & {
  id: string;
  name: string;
  repository: string;
  url: string;
  license: string;
  counts: Counts;
};
export type EntityRecord = AuthorRecord | JournalRecord | InstitutionRecord | ToolRecord | DatasetRecord;
export type RecordOf<T extends EntityType> = {
  author: AuthorRecord;
  journal: JournalRecord;
  institution: InstitutionRecord;
  tool: ToolRecord;
  dataset: DatasetRecord;
}[T];

/** One file of /records/<type>/: the entities of the shard, by key, and the rows of their papers
 *  (each paper once, however many of the shard's entities list it). */
export type EntityShard<T extends EntityType = EntityType> = { entities: Record<string, RecordOf<T>>; rows: Record<string, StoredRow> };

/** What a page needs besides its body: its title (without the platform's name), its description,
 *  the last item of its breadcrumb. */
export type View = { title: string; description: string; crumb: string; html: string };

/** The list of the papers of an entity, with what it leaves out. */
function papersHtml(e: EntityBase, total: number, rows: Record<string, StoredRow>): string {
  const listed = e.papers.filter((s) => Object.hasOwn(rows, s)).map((slug): Row => ({ slug, ...rows[slug] }));
  const more = total - listed.length;
  const note =
    more > 0
      ? `<p class="line">The ${esc(number(listed.length))} most recent of its ${esc(plural(total, "paper"))} are listed here` +
        (href(e.search) ? `; ${a("all of them in the search", e.search)}` : "") +
        `.</p>`
      : "";
  return `<h2>Papers</h2>${note}${listing(listed)}`;
}

const orcidUrl = (orcid: string) => `https://orcid.org/${orcid}`;
const rorUrl = (id: string) => `https://ror.org/${id}`;

function author(e: AuthorRecord, rows: Record<string, StoredRow>): View {
  const html = [
    `<h1>${esc(e.name)}</h1>`,
    `<p class="summary">${esc(plural(e.counts.papers, "paper"))} with a page, ${esc(number(e.counts.with_code))} of them with the authors' code.</p>`,
    line("ORCID iD", a(orcidUrl(e.orcid), orcidUrl(e.orcid))),
    e.affiliations.length ? line("Latest affiliations", esc(e.affiliations.join("; "))) : "",
    e.institutions.length ? line("Institutions", links(e.institutions)) : "",
    e.tools.length ? line("Tools in the code of their papers", links(e.tools, e.tools_total)) : "",
    papersHtml(e, e.counts.papers, rows),
  ].join("");
  return { title: e.name, description: `The papers of ${e.name} with their code, code on request or data only.`, crumb: e.name, html };
}

function journal(e: JournalRecord, rows: Record<string, StoredRow>): View {
  const others = e.counts.papers - e.counts.with_code;
  const html = [
    `<h1>${esc(e.title)}</h1>`,
    `<p class="summary">${esc(plural(e.counts.with_code, "paper"))} with their authors' code out of ${esc(plural(e.counts.read, "paper"))} read in this journal` +
      `${others > 0 ? `; ${esc(number(others))} more with code on request or data only` : ""}.</p>`,
    line("ISSN", esc(e.issn || "—")),
    line("eISSN", esc(e.eissn || "—")),
    line("Publisher", esc(e.publisher || "—")),
    papersHtml(e, e.counts.papers, rows),
  ].join("");
  return { title: e.title, description: `The papers of ${e.title} with their code, code on request or data only.`, crumb: e.title, html };
}

function institution(e: InstitutionRecord, rows: Record<string, StoredRow>): View {
  const where = [e.country && `<span class="label">Country:</span> ${esc(e.country)}`, e.type && `<span class="label">Type:</span> ${esc(e.type)}`]
    .filter(Boolean)
    .join(" · ");
  const html = [
    `<h1>${esc(e.name)}</h1>`,
    `<p class="summary">${esc(plural(e.counts.papers, "paper"))} with a page by authors affiliated with this institution, ` +
      `${esc(number(e.counts.with_code))} of them with the authors' code.</p>`,
    line("ROR", a(rorUrl(e.id), rorUrl(e.id))),
    where ? `<div class="line">${where}</div>` : "",
    e.authors.length ? line("Authors with an ORCID iD", links(e.authors, e.authors_total)) : "",
    papersHtml(e, e.counts.papers, rows),
  ].join("");
  return { title: e.name, description: `The papers of authors at ${e.name} with their code, code on request or data only.`, crumb: e.name, html };
}

function tool(e: ToolRecord, rows: Record<string, StoredRow>): View {
  const more = e.counts.repositories - e.repositories.length;
  const repos =
    e.repositories.map((r) => `<li>${a(r.text, r.href, "code")}</li>`).join("") +
    (more > 0 ? `<li>and ${esc(plural(more, "other repository", "other repositories"))}, with less evidence</li>` : "");
  const html = [
    `<h1>${esc(e.name)}</h1>`,
    `<p class="summary">Found in the code of ${esc(plural(e.counts.papers, "paper"))}, in ` +
      `${esc(plural(e.counts.repositories, "repository", "repositories"))} of their authors.</p>`,
    e.kind ? line("Kind", esc(e.kind)) : "",
    href(e.homepage) ? line("Homepage", a(e.homepage, e.homepage)) : "",
    e.rrid ? line("RRID", a(e.rrid, e.rrid_url)) : "",
    `<h2>Repositories</h2><details${e.counts.repositories <= 12 ? " open" : ""}><summary>` +
      `${esc(plural(e.counts.repositories, "repository", "repositories"))} whose code uses ${esc(e.name)}</summary><ul>${repos}</ul></details>`,
    papersHtml(e, e.counts.papers, rows),
  ].join("");
  return { title: e.name, description: `The papers whose authors' code uses ${e.name}.`, crumb: e.name, html };
}

function dataset(e: DatasetRecord, rows: Record<string, StoredRow>): View {
  const html = [
    `<h1>${esc(e.name)}</h1>`,
    `<p class="summary">Cited by ${esc(plural(e.counts.papers, "paper"))} with a page, ${esc(number(e.counts.with_code))} of them with the authors' code.</p>`,
    line("Identifier", `<span class="code">${esc(e.id)}</span>`),
    e.repository ? line("Repository", esc(e.repository)) : "",
    href(e.url) ? line("Link", a(e.url, e.url)) : "",
    e.license ? line("License", esc(e.license)) : "",
    papersHtml(e, e.counts.papers, rows),
  ].join("");
  return { title: e.name, description: `The papers that cite the dataset ${e.id}.`, crumb: e.id, html };
}

/** The page of one entity, from its shard. */
export function entityView<T extends EntityType>(type: T, e: RecordOf<T>, rows: Record<string, StoredRow>): View {
  switch (type) {
    case "author":
      return author(e as AuthorRecord, rows);
    case "journal":
      return journal(e as JournalRecord, rows);
    case "institution":
      return institution(e as InstitutionRecord, rows);
    case "tool":
      return tool(e as ToolRecord, rows);
    default:
      return dataset(e as DatasetRecord, rows);
  }
}

/** The words of each type: the list's page, and what a missing entity is called. */
export const ENTITY_WORDS: Readonly<Record<EntityType, { list: string; listUrl: string; one: string }>> = {
  author: { list: "Authors", listUrl: "/authors/", one: "author" },
  journal: { list: "Journals", listUrl: "/journals/", one: "journal" },
  institution: { list: "Institutions", listUrl: "/institutions/", one: "institution" },
  tool: { list: "Tools", listUrl: "/tools/", one: "tool" },
  dataset: { list: "Datasets", listUrl: "/datasets/", one: "dataset" },
};

/** What an entity's page says when the registry does not know it. */
export function missingEntity(type: EntityType, key: string): View {
  const w = ENTITY_WORDS[type];
  const html =
    `<h1>No such ${esc(w.one)}</h1>` +
    `<p>The registry knows no ${esc(w.one)} at this address` +
    `${key ? ` (<span class="code">${esc(key)}</span>)` : ""}: it lists the ${esc(w.list.toLowerCase())} of the papers ` +
    `that have a page. ${a(`All the ${w.list.toLowerCase()}`, w.listUrl)}.</p>`;
  return { title: `No such ${w.one}`, description: "", crumb: key || w.one, html };
}

// ---------------------------------------------------------------------------------------
// A paper past STATIC_PAPERS: its record, as the build writes it into /records/paper/NN.json,
// and its page, rendered by the Worker.

export type Notice = { kind: string; id: string; date: string; source: string; url: string };
/** A data link found in the paper; `cited`: it names one of the datasets the paper cites, which
 *  the page lists by their own pages. */
export type DataLinkRecord = { repo: string; url: string; repository: string; cited: boolean };
export type PaperRecord = {
  /** The registry's id of the paper ("doi:10.…"), which the Contribute section's requests name. */
  id: string;
  slug: string;
  doi: string;
  title: string;
  journal: Link;
  published: string;
  /** The article type and the paper's license, in words ("Research article", "CC BY 4.0"). */
  type: string;
  license: string;
  status: string;
  /** Retractions, expressions of concern, corrections (said first, under the title). */
  notices: Notice[];
  authors: Link[];
  institutions: Link[];
  categories: Link[];
  /** `repo`: the registry's key of the repository (github.com/owner/name), which a correction names;
   *  `files`: its files' paths (at most removal.FILES_LISTED, `files_more` others) and `copies`,
   *  whether the site holds copies of their text: what a removal request may name. */
  code: {
    repo: string;
    name: string;
    url: string;
    license: string;
    state: string;
    copies?: boolean;
    /** Why no copy of its files is kept: their license ("license"), or a removal request ("withheld"). */
    held?: "license" | "withheld";
    files?: string[];
    files_more?: number;
  }[];
  files: number;
  pairs: number;
  map: string;
  datasets: Link[];
  /** Every data link found in the paper, those of the datasets cited included. */
  data: DataLinkRecord[];
  tools: Link[];
  /** The paper on Europe PMC. */
  europepmc: string;
};

const NOTICES: Record<string, string> = {
  retraction: "This paper has been retracted",
  concern: "An expression of concern has been published about this paper",
  correction: "A correction to this paper has been published",
  reinstatement: "This paper has been reinstated after a retraction",
};
const STATES: Record<string, string> = {
  alive: "the link answers",
  dead: "the link is dead",
  unverified: "not verified yet",
  unreachable: "unreachable at the last attempt",
  unverifiable: "cannot be verified",
};
const WITHOUT: Record<string, string> = {
  on_request: "The paper says that its authors' code is available on request: it was not published with the paper, so there is nothing to verify.",
  data_only: "The paper links to its data, not to its authors' code: see the Data section.",
};
/** A consortium paper lists hundreds of authors: the first ones, then folded. */
const SHOWN = 20;

/** What a correction may say a link is (src/components/paper/Contribute.astro's). */
const ROLES: readonly [string, string][] = [
  ["code", "the authors' code"],
  ["data", "their data"],
  ["tool", "a tool they used"],
  ["remove", "not this paper's: remove it"],
];
const options = (list: readonly [string, string][], selected = "") =>
  list.map(([value, text]) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(text)}</option>`).join("");

/** The Contribute section of a paper rendered on demand: the same ids and forms as the static
 *  pages' (Contribute.astro), so that the same script (src/scripts/paper-actions.ts) runs them —
 *  claim the paper, correct its links — and the same link to the removal request page (/removal/).
 *  The tracing map's validation and the badge stay on the static pages, which show the map. */
function contribute(p: PaperRecord): string {
  const back = `/paper/${p.slug}/`;
  const links = [
    ...p.code.map((r) => ({ repo: r.repo, url: r.url, role: "code", name: r.name })),
    ...p.data.map((d) => ({ repo: d.repo, url: d.url, role: "data", name: d.repo })),
  ].filter((l) => l.repo);
  const linkItems = links
    .map(
      (l) =>
        `<li data-repo="${esc(l.repo)}" data-role="${esc(l.role)}">` +
        `${href(l.url) ? `<a class="code" href="${esc(href(l.url))}">${wrap(l.name)}</a>` : `<span class="code">${wrap(l.name)}</span>`}: ` +
        `<select name="role-${esc(l.repo)}" aria-label="What ${esc(l.name)} is">${options(ROLES, l.role)}</select></li>`,
    )
    .join("");
  return (
    `<section id="contribute" data-paper="${esc(p.id)}" data-doi="${esc(p.doi)}" data-digest="" data-back="${esc(back)}">` +
    `<h2>Contribute</h2>` +
    `<p class="summary">The authors of this paper and the maintainers of its code can claim it and correct its record; ` +
    `anyone signed in can ask for its removal. Every request goes to the registry's own machine, which answers it; your ` +
    `account page follows them.</p>` +
    `<p id="contribute-status" role="status" aria-live="polite"></p>` +
    `<div id="contribute-signed-out"><p>${a("Sign in with ORCID", `/api/auth/orcid/start?return=${back}`)} to claim this paper ` +
    `as one of its authors or correct its record: when the paper's metadata lists your ORCID iD, you are recognized at once. ` +
    `Maintainers of its code: ${a("sign in with GitHub", `/api/auth/github/start?return=${back}`)}, then claim the repository ` +
    `on ${a("your account page", "/account/")}.</p></div>` +
    `<div id="contribute-signed-in" hidden><p id="contribute-who"></p>` +
    `<div id="claim-block" hidden><h3>Claim this paper</h3><p id="claim-state"></p>` +
    `<form id="claim-form" method="post" action="/api/claims" hidden>` +
    `<p>Your ORCID iD is not among this paper's authors in its metadata: say why you are one of them. The registry's rules verify ` +
    `the claim as soon as Crossref adds this paper to your ORCID record, once its publisher deposited your iD with it (checked each day, 30 days at most; a work you add yourself proves nothing; ${a("how claims are decided", "/policies/moderation/")}).</p>` +
    `<p><label for="claim-statement">Why you are one of its authors</label><br>` +
    `<textarea id="claim-statement" name="statement" rows="3" maxlength="1000" required></textarea></p>` +
    `<p><label for="claim-link">A page that shows it (optional)</label><br>` +
    `<input id="claim-link" name="link" type="text" inputmode="url" placeholder="https://" autocomplete="off"></p>` +
    `<p><button type="submit">Send the claim</button></p></form></div>` +
    `<div id="edit-block" hidden><h3>Correct its record</h3>` +
    `<p>Say what each link of this record is, remove the ones that are not the paper's, add the ones that are missing. The ` +
    `correction becomes a new version of the record.</p>` +
    `<form id="edit-form" method="post" action="/api/edits">` +
    (linkItems ? `<fieldset><legend>Its links</legend><ul id="edit-links">${linkItems}</ul></fieldset>` : "") +
    `<fieldset><legend>Links to add</legend>` +
    `<p><label for="edit-add">One address a line: a forge, an archive, a dataset</label><br>` +
    `<textarea id="edit-add" name="add" rows="2" spellcheck="false"></textarea></p>` +
    `<p><label for="edit-add-role">They are</label> <select id="edit-add-role" name="add-role">` +
    `<option value="code">the authors' code</option><option value="data">their data</option></select></p></fieldset>` +
    `<p><label for="edit-note">A note on the correction (optional)</label><br>` +
    `<textarea id="edit-note" name="note" rows="2" maxlength="500"></textarea></p>` +
    `<p><button type="submit">Send the correction</button></p></form>` +
    `<p id="edit-state" role="status" aria-live="polite"></p></div></div>` +
    `<h3 id="removal">Request its removal</h3>` +
    `<p>To ask for this record, the copies of its authors' scripts or its tracing map to be removed, use ` +
    `${a("the removal request page", removalUrl(p.id))}: signed in, you say who you are, what to remove and why, then review ` +
    `and confirm the request. Published rules decide every request (${a("how", "/policies/moderation/")}).</p>` +
    `<p id="removal-state"></p>` +
    `</section>`
  );
}

/** The page of a paper past STATIC_PAPERS, from its record. It says what it leaves out. */
export function paperView(p: PaperRecord): View {
  const hasCode = p.code.length > 0;
  const notices = p.notices
    .filter((n) => NOTICES[n.kind])
    .map(
      (n) =>
        `<p class="warning"><strong>${esc(NOTICES[n.kind])}</strong>${n.date ? ` (${esc(dateInWords(n.date))})` : ""}: ` +
        `${href(n.url) ? a(`the notice${n.id ? `, ${n.id}` : ""}`, n.url) : esc(`the notice ${n.id}`.trim())}` +
        `${n.source ? `, from ${esc(n.source)}` : ""}.</p>`,
    )
    .join("");
  const folded = p.authors.length > SHOWN + 5 ? p.authors.slice(SHOWN) : [];
  const shown = folded.length ? p.authors.slice(0, SHOWN) : p.authors;
  const authorsHtml = shown.length
    ? `<div class="line"><span class="label">Authors:</span> ${links(shown)}` +
      (folded.length ? `<details><summary>and ${esc(plural(folded.length, "other author"))}</summary>${links(folded)}</details>` : "") +
      `</div>`
    : "";
  const facts = [
    p.files > 0 ? `${plural(p.files, "file")} of its code read` : "",
    p.pairs > 0 ? `${plural(p.pairs, "match", "matches")} between paragraphs and code` : "",
  ].filter(Boolean);
  /** The data links other than those of the datasets cited (named by their pages already). */
  const others = p.data.filter((l) => !l.cited);
  const code = hasCode
    ? p.code
        .map(
          (r) =>
            `<section><h3>${href(r.url) ? `<a class="code" href="${esc(href(r.url))}">${wrap(r.name)}</a>` : `<span class="code">${wrap(r.name)}</span>`}</h3>` +
            line("License", esc(r.license || "none: the authors keep all their rights")) +
            line("State", r.state === "alive" ? `<span class="ok">${esc(STATES.alive)}</span>` : `<span class="warning">${esc(STATES[r.state] ?? r.state)}</span>`) +
            (r.copies
              ? line("Copies", "kept by the registry: this license allows it")
              : r.held === "withheld"
                ? line("Copies", "withheld at a removal request: read it at its source")
                : r.held === "license"
                  ? line("Copies", `none: the registry keeps no copy of code whose license does not allow redistribution (${a("how this works", "/policies/code/")}); read it at its source`)
                  : "") +
            `</section>`,
        )
        .join("")
    : "";
  const overview = [
    `<section id="overview"><h2>Overview</h2>`,
    authorsHtml,
    line("Journal", p.journal.text ? a(p.journal.text, p.journal.href) : "—"),
    p.published ? line("Published", esc(/^\d{4}-\d{2}-\d{2}$/.test(p.published) ? dateInWords(p.published) : dayInWords(p.published))) : "",
    p.type ? line("Type", esc(p.type)) : "",
    line("Status", statusWords(p.status)),
    line("DOI", a(p.doi, doiUrl(p.doi))),
    p.license ? line("License", esc(p.license)) : "",
    p.institutions.length ? line("Institutions", links(p.institutions)) : "",
    p.categories.length ? line("Categories", links(p.categories)) : "",
    `</section>`,
  ].join("");
  const codeSection = [
    `<section id="code"><h2>Code</h2>`,
    hasCode
      ? `<p>${facts.length ? `${esc(facts.join("; "))}. ` : ""}The Code ↔ Paper reader is built for the ` +
        `${esc(number(STATIC_PAPERS))} most recent papers only: this paper's code is read at its source.</p>`
      : `<p>${esc(WITHOUT[p.status] ?? "No code of the authors was found in the paper.")}</p>`,
    code,
    p.tools.length ? line("Tools found in the code", links(p.tools)) : "",
    p.map ? line("Tracing map", `validated by an author, ${a("its DOI", doiUrl(p.map))}`) : "",
    `</section>`,
  ].join("");
  // A paper with code opens on its code, as the static pages do (their reader); the others on
  // their overview.
  const tabs = hasCode
    ? `<li><a href="#code">Code</a></li><li><a href="#overview">Overview</a></li>`
    : `<li><a href="#overview">Overview</a></li><li><a href="#code">Code</a></li>`;
  const body = [
    `<h1>${wrap(p.title)}</h1>`,
    notices,
    `<nav class="tabs" aria-label="Sections of this page"><ul>${tabs}` +
      `<li><a href="#data">Data</a></li><li><a href="#contribute">Contribute</a></li></ul></nav>`,
    `<p class="summary">This page is built on request from the registry's record of the paper. The ` +
      `${esc(number(STATIC_PAPERS))} most recent papers have a fuller page, built ahead of time, with the Code ↔ Paper reader, ` +
      `the tracing map and its validation, the record's versions, how to cite it, similar papers and the README badge. ` +
      `This paper is older: its record, its code, its data and the requests about it are below.</p>`,
    hasCode ? codeSection + overview : overview + codeSection,
    `<section id="data"><h2>Data</h2>`,
    p.datasets.length ? `<h3>Datasets cited</h3><ul>${p.datasets.map((d) => `<li>${a(d.text, d.href)}</li>`).join("")}</ul>` : "",
    others.length
      ? `<h3>${p.datasets.length ? "Other data links" : "Data links"}</h3><ul>` +
        others
          .map(
            (l) =>
              `<li>${href(l.url) ? `<a class="code" href="${esc(href(l.url))}">${wrap(l.repo)}</a>` : `<span class="code">${wrap(l.repo)}</span>`}` +
              `${l.repository ? ` — ${esc(l.repository)}` : ""}</li>`,
          )
          .join("") +
        `</ul>`
      : "",
    p.datasets.length || others.length ? "" : `<p>No dataset cited, and no data link found.</p>`,
    `</section>`,
    contribute(p),
  ].join("");
  const access = [
    `<li>${a("The paper, at the publisher", doiUrl(p.doi))}</li>`,
    href(p.europepmc) ? `<li>${a("The paper on Europe PMC", p.europepmc)}</li>` : "",
    ...p.code.map((r) => (href(r.url) ? `<li><a href="${esc(href(r.url))}">${wrap(r.name)}</a></li>` : "")),
  ].join("");
  const sidebar =
    `<aside class="sidebar"><h3>Access</h3><ul>${access}</ul>` +
    (p.datasets.length ? `<h3>Data</h3><ul>${p.datasets.map((d) => `<li>${a(d.text, d.href)}</li>`).join("")}</ul>` : "") +
    (p.license ? `<h3>License</h3><ul><li>the paper: ${esc(p.license)}</li></ul>` : "") +
    `<h3>This record</h3><ul><li><a href="#contribute">Claim it, correct it</a></li><li>${a("Request removal", removalUrl(p.id))}</li></ul>` +
    `</aside>`;
  const s = status(p.status);
  return {
    title: p.title,
    description: hasCode ? `The code published by the authors of “${p.title}”.` : `“${p.title}”: ${s.label}.`,
    crumb: `doi:${p.doi}`,
    html: `<div class="record"><div class="body">${body}</div>${sidebar}</div>`,
  };
}

/** What the page of an unknown paper says. */
export function missingPaper(slug: string): View {
  return {
    title: "Page not found",
    description: "",
    crumb: "Page not found",
    html:
      `<h1>Page not found</h1><p>The registry has no paper at <span class="code">${esc(slug)}</span>. ` +
      `${a("The DOI lookup", "/lookup/")} finds any paper it has read.</p>`,
  };
}

