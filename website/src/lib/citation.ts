// "Cite this repository" (night phase 02, E6): a repository's CITATION.cff (a subset of YAML, read
// here), or its codemeta.json, as APA and BibTeX, the way GitHub offers them: the preferred citation
// (the paper) when the file names one, else the software itself; its DOI, its SWHID. Pure, no DOM,
// testable in Node (tests/forge-pages/citation.test.ts). An author's email address is never read.

import { maskEmails } from "../../worker/forge/mask.ts";

// ─── a YAML subset ───────────────────────────────────────────────────────────

export type Yaml = string | Yaml[] | { [k: string]: Yaml };

interface Line {
  indent: number;
  text: string;
}

/** A scalar: quoted ('…' with '' for ', "…" with escapes), a flow list [a, b], or plain (a comment
 *  after " #" dropped). */
function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
    if (m) return m[1].replace(/\\(["\\/bfnrt])/g, (_, c: string) => ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" })[c] ?? c).replace(/\\u([0-9a-fA-F]{4})/g, (_, x: string) => String.fromCharCode(parseInt(x, 16)));
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(s);
    if (m) return m[1].replace(/''/g, "'");
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    return s.slice(1, -1).split(",").map((x) => scalar(x)).filter((x) => x !== "");
  }
  return s.replace(/\s+#.*$/, "");
}

/** Where a "key:" ends in a line (not inside quotes); -1 when the line is no mapping entry. */
function keyEnd(text: string): number {
  const m = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:"'#][^:#]*?)\s*:(?=\s|$)/.exec(text);
  return m ? m[0].length : -1;
}

const unquoteKey = (k: string) => {
  const t = k.trim();
  return (t.startsWith('"') || t.startsWith("'")) ? String(scalar(t)) : t;
};

/** A YAML document of mappings, sequences and scalars (block style, flow lists, | and > blocks):
 *  what citation files use. Anchors, tags and multi-documents are not read. */
export function parseYaml(text: string): Yaml {
  const lines: Line[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n").slice(0, 5_000)) {
    if (/^\s*(?:#.*)?$/.test(raw) || /^(?:---|\.\.\.)\s*$/.test(raw)) {
      lines.push({ indent: -1, text: "" });
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    lines.push({ indent, text: raw.trim() });
  }
  let i = 0;
  const skip = () => {
    while (i < lines.length && lines[i].indent < 0) i++;
  };
  /** A block scalar (| or >) whose lines are indented deeper than `parent`. */
  const block = (parent: number, folded: boolean): string => {
    const out: string[] = [];
    let base = -1;
    while (i < lines.length) {
      const l = lines[i];
      if (l.indent >= 0 && l.indent <= parent) break;
      if (l.indent >= 0 && base < 0) base = l.indent;
      out.push(l.indent < 0 ? "" : " ".repeat(Math.max(0, l.indent - base)) + l.text);
      i++;
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    return folded ? out.join("\n").replace(/([^\n])\n(?=[^\n ])/g, "$1 ") : out.join("\n");
  };
  const value = (rest: string, indent: number): Yaml => {
    const r = rest.trim();
    if (r === "|" || r === "|-" || r === ">" || r === ">-") return block(indent, r.startsWith(">"));
    if (r !== "") return scalar(r);
    skip();
    if (i < lines.length && lines[i].indent > indent) return node(lines[i].indent);
    if (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) return node(indent);
    return "";
  };
  const node = (indent: number, depth = 0): Yaml => {
    skip();
    if (i >= lines.length || depth > 50) return "";
    if (lines[i].text === "-" || lines[i].text.startsWith("- ")) {
      const seq: Yaml[] = [];
      while (i < lines.length) {
        skip();
        const l = lines[i];
        if (!l || l.indent !== indent || !(l.text === "-" || l.text.startsWith("- "))) break;
        const inner = l.text.slice(1).trimStart();
        const innerIndent = indent + (l.text.length - inner.length);
        if (inner === "") {
          i++;
          seq.push(value("", indent));
        } else if (keyEnd(inner) >= 0) {
          // "- key: value" opens a mapping whose other keys are indented like "key"
          lines[i] = { indent: innerIndent, text: inner };
          seq.push(node(innerIndent, depth + 1));
        } else {
          i++;
          seq.push(scalar(inner));
        }
      }
      return seq;
    }
    if (keyEnd(lines[i].text) >= 0) {
      const map: { [k: string]: Yaml } = {};
      while (i < lines.length) {
        skip();
        const l = lines[i];
        if (!l || l.indent !== indent) break;
        const end = keyEnd(l.text);
        if (end < 0) break;
        const key = unquoteKey(l.text.slice(0, end).replace(/:$/, ""));
        i++;
        const v = value(l.text.slice(end), indent);
        if (!(key in map) && key !== "__proto__") map[key] = v;
      }
      return map;
    }
    const s = scalar(lines[i].text);
    i++;
    return s;
  };
  skip();
  return i < lines.length ? node(lines[i].indent) : "";
}

// ─── the citation ────────────────────────────────────────────────────────────

export interface Person {
  family: string;
  given: string;
  /** An entity (a lab, a consortium), or a person written in one piece. */
  name: string;
  orcid: string | null;
}

export interface Work {
  type: string;
  title: string;
  authors: Person[];
  version: string;
  year: string;
  month: string;
  doi: string | null;
  url: string;
  journal: string;
  volume: string;
  issue: string;
  pages: string;
  publisher: string;
}

export interface Citation {
  /** What to cite: the preferred citation when the file names one, else the software. */
  work: Work;
  software: Work;
  preferred: boolean;
  source: "CITATION.cff" | "codemeta.json";
  message: string;
}

const str = (v: Yaml | undefined): string => (typeof v === "string" ? maskEmails(v).trim() : "");
const obj = (v: Yaml | undefined): { [k: string]: Yaml } => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** An ORCID iD's address, or null. */
function orcidOf(v: string): string | null {
  const m = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/.exec(v);
  return m ? `https://orcid.org/${m[1]}` : null;
}

/** A DOI in any of its forms, bare ("10.…"), or null. */
export function doiOf(v: string): string | null {
  const m = /(10\.\d{4,9}\/[^\s"<>]+)/.exec(v);
  return m ? m[1].replace(/[.,;]+$/, "") : null;
}

function people(v: Yaml | undefined): Person[] {
  return (Array.isArray(v) ? v : [])
    .map((p) => obj(p))
    .map((p) => ({
      family: [str(p["name-particle"]), str(p["family-names"])].filter(Boolean).join(" "),
      given: str(p["given-names"]),
      name: str(p.name) || str(p.alias),
      orcid: orcidOf(str(p.orcid)),
    }))
    .filter((p) => p.family || p.given || p.name)
    .slice(0, 200);
}

function work(m: { [k: string]: Yaml }, type: string): Work {
  const date = str(m["date-released"]) || str(m["date-published"]);
  const ids = (Array.isArray(m.identifiers) ? m.identifiers : []).map(obj);
  const doi = doiOf(str(m.doi)) ?? doiOf(str(ids.find((x) => str(x.type) === "doi")?.value));
  const year = str(m.year) || (/^\d{4}/.exec(date)?.[0] ?? "");
  const pages = str(m.start) && str(m.end) ? `${str(m.start)}–${str(m.end)}` : str(m.pages) || str(m.start);
  return {
    type: str(m.type) || type,
    title: str(m.title),
    authors: people(m.authors),
    version: str(m.version),
    year,
    month: str(m.month) || (/^\d{4}-(\d{2})/.exec(date)?.[1] ?? ""),
    doi,
    url: /^https:\/\//.test(str(m["repository-code"])) ? str(m["repository-code"]) : /^https:\/\//.test(str(m.url)) ? str(m.url) : "",
    journal: str(m.journal) || str(obj(m.conference).name),
    volume: str(m.volume),
    issue: str(m.issue),
    pages,
    publisher: str(obj(m.publisher).name) || str(m.publisher),
  };
}

/** A CITATION.cff file as the citation GitHub offers; null when it has no title or no author. */
export function citationOfCff(text: string): Citation | null {
  const root = obj(parseYaml(text));
  const software = work(root, "software");
  if (!software.title || !software.authors.length) return null;
  const pref = obj(root["preferred-citation"]);
  const preferred = Object.keys(pref).length ? work(pref, "article") : null;
  const ok = preferred && preferred.title && preferred.authors.length;
  return { work: ok ? preferred : software, software, preferred: !!ok, source: "CITATION.cff", message: str(root.message) };
}

/** A codemeta.json file as a citation of the software; null when it has no name or no author. */
export function citationOfCodemeta(text: string): Citation | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const s = (v: unknown) => (typeof v === "string" ? maskEmails(v).trim() : "");
  const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []) as Record<string, unknown>[];
  const authors: Person[] = list(j.author)
    .map((a) => ({ family: s(a.familyName), given: s(a.givenName), name: s(a.name), orcid: orcidOf(s(a["@id"]) || s(a.identifier)) }))
    .filter((p) => p.family || p.given || p.name);
  const date = s(j.datePublished) || s(j.dateModified);
  const software: Work = {
    type: "software",
    title: s(j.name),
    authors,
    version: s(j.version) || s(j.softwareVersion),
    year: /^\d{4}/.exec(date)?.[0] ?? "",
    month: /^\d{4}-(\d{2})/.exec(date)?.[1] ?? "",
    doi: doiOf(s(j.identifier)) ?? doiOf(s(j["@id"])),
    url: /^https:\/\//.test(s(j.codeRepository)) ? s(j.codeRepository) : "",
    journal: "",
    volume: "",
    issue: "",
    pages: "",
    publisher: "",
  };
  if (!software.title || !authors.length) return null;
  return { work: software, software, preferred: false, source: "codemeta.json", message: "" };
}

// ─── APA and BibTeX ──────────────────────────────────────────────────────────

const initials = (given: string) =>
  given
    .split(/\s+/)
    .filter(Boolean)
    .map((g) => g.split("-").map((p) => `${p[0].toUpperCase()}.`).join("-"))
    .join(" ");

const apaName = (p: Person) => (p.family ? `${p.family}${p.given ? `, ${initials(p.given)}` : ""}` : p.name || p.given);

/** APA 7: authors (up to 20), year, title, version or journal, DOI or address. */
export function apa(w: Work): string {
  const names = w.authors.map(apaName);
  const who = names.length === 1 ? names[0] : names.length <= 20 ? `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}` : `${names.slice(0, 19).join(", ")}, … ${names[names.length - 1]}`;
  const year = `${/\.$/.test(who) ? who : `${who}.`} (${w.year || "n.d."})`;
  const link = w.doi ? `https://doi.org/${w.doi}` : w.url;
  const end = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);
  if (w.type === "software" || !w.journal) {
    const version = w.version ? ` (Version ${w.version})` : "";
    const kind = w.type === "software" ? " [Computer software]" : "";
    return [end(year), `${w.title}${version}${kind}.`, w.publisher ? end(w.publisher) : "", link].filter(Boolean).join(" ");
  }
  const where = `${w.journal}${w.volume ? `, ${w.volume}` : ""}${w.issue ? `(${w.issue})` : ""}${w.pages ? `, ${w.pages}` : ""}.`;
  return [end(year), end(w.title), where, link].filter(Boolean).join(" ");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const bib = (s: string) => s.replace(/[{}\\]/g, "").replace(/([&%$#_])/g, "\\$1");

/** BibTeX: @software for the software (with its version), @article or @misc for a paper. */
export function bibtex(w: Work): string {
  const first = w.authors[0];
  const key = `${(first?.family || first?.name || "anonymous").replace(/[^A-Za-z0-9]/g, "")}_${w.title.split(/\s+/)[0]?.replace(/[^A-Za-z0-9-]/g, "") ?? ""}_${w.year || "nd"}`;
  const kind = w.type === "software" ? "software" : w.journal ? "article" : "misc";
  const author = w.authors.map((p) => (p.family ? `${bib(p.family)}${p.given ? `, ${bib(p.given)}` : ""}` : `{${bib(p.name || p.given)}}`)).join(" and ");
  const fields: [string, string][] = [
    ["author", author],
    ["title", `{${bib(w.title)}}`],
    ["journal", bib(w.journal)],
    ["volume", bib(w.volume)],
    ["number", bib(w.issue)],
    ["pages", bib(w.pages.replace("–", "--"))],
    ["version", bib(w.version)],
    ["year", bib(w.year)],
    ["doi", w.doi ?? ""],
    ["url", w.url],
  ];
  const month = Number(w.month);
  const lines = fields.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${v}}`);
  if (month >= 1 && month <= 12) lines.splice(lines.length - 1, 0, `  month = ${MONTHS[month - 1]}`);
  return `@${kind}{${key},\n${lines.join(",\n")}\n}`;
}
