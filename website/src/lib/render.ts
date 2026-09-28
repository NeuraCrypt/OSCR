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

/** A link, or its text alone when the address is not one (`cls`: science.css's class). */
export function a(text: string, url: string | null | undefined, cls = ""): string {
  const h = href(url);
  const c = cls ? ` class="${esc(cls)}"` : "";
  return h ? `<a${c} href="${esc(h)}">${esc(text)}</a>` : cls ? `<span${c}>${esc(text)}</span>` : esc(text);
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

/** A paper in a listing. `reader`: its Code ↔ Paper reader is built (a static page). A code
 *  repository's `repo` (github.com/owner/name) serves only the home page's filter. */
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
  const code = r.code.map((d) => `${a(d.name, d.url, "code")} (${esc(d.license || "no license")})`).join(", ");
  const facts = [
    r.files > 0 ? `, ${esc(plural(r.files, "file"))} readable` : "",
    r.pairs > 0 ? `, ${esc(plural(r.pairs, "match", "matches"))}` : "",
    r.map ? `, map validated by an author (${a("DOI", doiUrl(r.map))})` : "",
  ].join("");
  return (
    `<dt${keys}>${head}${r.reader ? `${a("Code ↔ Paper", `${page}code/`, "reader-link")} ` : ""}` +
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
export type PaperRecord = {
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
  code: { name: string; url: string; license: string; state: string }[];
  files: number;
  pairs: number;
  map: string;
  datasets: Link[];
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
  const code = hasCode
    ? p.code
        .map(
          (r) =>
            `<section><h3>${href(r.url) ? `<a class="code" href="${esc(href(r.url))}">${wrap(r.name)}</a>` : `<span class="code">${wrap(r.name)}</span>`}</h3>` +
            line("License", esc(r.license || "none: the authors keep all their rights")) +
            line("State", r.state === "alive" ? `<span class="ok">${esc(STATES.alive)}</span>` : `<span class="warning">${esc(STATES[r.state] ?? r.state)}</span>`) +
            `</section>`,
        )
        .join("")
    : "";
  const body = [
    `<h1>${wrap(p.title)}</h1>`,
    notices,
    `<nav class="tabs" aria-label="Sections of this page"><ul><li><a href="#overview">Overview</a></li>` +
      `<li><a href="#code">Code</a></li><li><a href="#data">Data</a></li></ul></nav>`,
    `<p class="summary">This page is built on request from the registry's record of the paper. The ` +
      `${esc(number(STATIC_PAPERS))} most recent papers have a fuller page, built ahead of time: the Code ↔ Paper reader, ` +
      `the tracing map, the record's versions, how to cite it, similar papers, and the forms to claim or correct it. ` +
      `This paper is older: its record, its code and its data are below.</p>`,
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
    `<section id="code"><h2>Code</h2>`,
    hasCode
      ? `<p>${facts.length ? `${esc(facts.join("; "))}. ` : ""}The Code ↔ Paper reader is built for the ` +
        `${esc(number(STATIC_PAPERS))} most recent papers only: this paper's code is read at its source.</p>`
      : `<p>${esc(WITHOUT[p.status] ?? "No code of the authors was found in the paper.")}</p>`,
    code,
    p.tools.length ? line("Tools found in the code", links(p.tools)) : "",
    p.map ? line("Tracing map", `validated by an author, ${a("its DOI", doiUrl(p.map))}`) : "",
    `</section>`,
    `<section id="data"><h2>Data</h2>`,
    p.datasets.length ? `<h3>Datasets cited</h3><ul>${p.datasets.map((d) => `<li>${a(d.text, d.href)}</li>`).join("")}</ul>` : `<p>No dataset cited.</p>`,
    `</section>`,
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

