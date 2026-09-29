// Templates and writing aids of the registry's editor, their pure part (night phase 03, E5;
// docs/WEB_EDITING.md): no DOM, testable in Node (tests/forge-pages/templates.test.ts). The page part
// is src/scripts/repo-templates.ts.
//
// - Licences: a file named LICENSE (or LICENCE, COPYING, with .md or .txt) offers GitHub's licence
//   templates (their texts from GitHub's licences API, read in the reader's browser), the year and
//   the holder filled in; each says what it means for the registry (files are copied and shown only
//   under a licence that allows it).
// - Codes of conduct: CODE_OF_CONDUCT.md offers GitHub's templates (the Contributor Covenant, the
//   Citizen Code of Conduct, from its API), their contact field — an email address in the originals
//   — replaced by the repository's page in the registry, since the registry shows no address.
// - CITATION.cff from a paper the repository is linked to (its DOI and title as the preferred
//   citation; one author entry per person to fill, with an ORCID iD, never an email address), and
//   a research README; both checked as they are written (the viewer's own CITATION.cff reader).
// - Markdown: the toolbar's and the keys' edits (bold, italic, code, link, heading, quote, lists,
//   task list), a URL pasted over a selection made a link, cells pasted from a spreadsheet made a
//   table, and the slash commands /table, /code, /details and /cite <DOI>.

import { apa, citationOfCff, citationOfCodemeta, doiOf, parseYaml } from "./citation.ts";
import type { Edit, Sel } from "./editor.ts";
import { LICENCES, type Licence } from "./forge-templates.ts";

// ─── licences ────────────────────────────────────────────────────────────────

/** A file name GitHub reads as the licence (at the root). */
export const isLicenceName = (path: string | null): boolean => !!path && /^(?:licen[cs]e|copying)(?:\.(?:md|markdown|txt))?$/i.test(path);

export const isConductName = (path: string | null): boolean => !!path && /^(?:\.github\/|docs\/)?code[-_]of[-_]conduct(?:\.(?:md|markdown|txt))?$/i.test(path);

export const isCitationName = (path: string | null): boolean => !!path && /^citation\.cff$/i.test(path);

export const isReadmeName = (path: string | null): boolean => !!path && /^(?:\.github\/|docs\/)?readme\.md$/i.test(path);

/** The licences the picker offers: GitHub's templates, those for code first. */
export const LICENCE_CHOICES: readonly Licence[] = LICENCES;

/** What a licence means for the registry, in one sentence (the site's name handed in). */
export const licenceForRegistry = (l: Licence, site: string): string =>
  l.open ? `${site} may keep, show and cite copies of the files under it.` : `${site} shows the files' list only, and links to them at the source.`;

/** A licence's text with its placeholders filled: the year and the holder, as GitHub's templates
 *  write them ([year] [fullname], [yyyy] [name of copyright owner], <year> <name of author>). */
export function fillLicence(body: string, fill: { year: number; holder: string }): string {
  const holder = fill.holder.trim() || "the authors";
  return body
    .replace(/\[year\]|\[yyyy\]|<year>/g, String(fill.year))
    .replace(/\[fullname\]|\[name of copyright owner\]|<name of author>|\[COPYRIGHT HOLDER\]/g, holder);
}

// ─── codes of conduct ────────────────────────────────────────────────────────

export interface ConductChoice {
  /** GitHub's key (its codes-of-conduct API). */
  key: string;
  name: string;
}

export const CONDUCT_CHOICES: readonly ConductChoice[] = [
  { key: "contributor_covenant", name: "Contributor Covenant" },
  { key: "citizen_code_of_conduct", name: "Citizen Code of Conduct" },
];

/** A code of conduct's text with its contact filled: never an email address (the registry shows
 *  none), the repository's page in the registry instead, and the project's name. */
export function fillConduct(body: string, fill: { project: string; contact: string }): string {
  return body
    .replace(/\[INSERT (?:EMAIL ADDRESS|CONTACT METHOD)\]|\[INSERT CONTACT (?:EMAIL|ADDRESS)\]/gi, fill.contact)
    .replace(/\[PROJECT NAME\]|\[project name\]/g, fill.project)
    .replace(/[\p{L}\p{N}_.+%-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu, fill.contact);
}

// ─── CITATION.cff and README ─────────────────────────────────────────────────

export interface TemplatePaper {
  doi: string;
  title: string | null;
}

const yamlString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;

/** A CITATION.cff for the repository, citing the paper it supports as the preferred citation. */
export function citationTemplate(repo: { owner: string; name: string; web: string }, paper: TemplatePaper | null, licence: string | null): string {
  const lines = [
    "cff-version: 1.2.0",
    `message: ${yamlString(paper ? "If you use this software, please cite the paper it supports, and the software itself." : "If you use this software, please cite it as below.")}`,
    `title: ${yamlString(repo.name)}`,
    "type: software",
    "authors:",
    "  # One entry per person; an ORCID iD as https://orcid.org/…, never an email address.",
    `  - family-names: ${yamlString("Family name")}`,
    `    given-names: ${yamlString("Given names")}`,
    `    orcid: ${yamlString("https://orcid.org/0000-0000-0000-0000")}`,
    `repository-code: ${yamlString(repo.web)}`,
  ];
  if (licence) lines.push(`license: ${licence}`);
  if (paper) {
    lines.push(
      "preferred-citation:",
      "  type: article",
      `  title: ${yamlString(paper.title ?? "The paper's title")}`,
      `  doi: ${yamlString(paper.doi)}`,
      "  authors:",
      `    - family-names: ${yamlString("Family name")}`,
      `      given-names: ${yamlString("Given names")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** A research README's skeleton: what the code does, the paper, how to run it, the data, the
 *  licence, how to cite. */
export function readmeTemplate(repo: { name: string }, paper: TemplatePaper | null): string {
  return [
    `# ${repo.name}`,
    "",
    "What this code does, in two sentences.",
    "",
    paper ? `It supports the paper ${paper.title ? `“${paper.title}”, ` : ""}doi:${paper.doi}.` : "It supports the paper doi:10.…",
    "",
    "## Running it",
    "",
    "```sh",
    "# the environment, then the steps that reproduce the paper's results",
    "```",
    "",
    "## Data",
    "",
    "Where the data come from, and where they are deposited (a DOI).",
    "",
    "## Licence",
    "",
    "The licence of the code (the LICENSE file), and of the data if they differ.",
    "",
    "## How to cite",
    "",
    "See CITATION.cff.",
    "",
  ].join("\n");
}

/** A research metadata file checked as it is written: CITATION.cff (read as the viewer reads it),
 *  codemeta.json and .zenodo.json (JSON); null for other files. */
export function checkMetadata(path: string | null, text: string): { ok: boolean; said: string } | null {
  if (!path) return null;
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "citation.cff") {
    const problems: string[] = [];
    let root: Record<string, unknown> = {};
    try {
      const y = parseYaml(text);
      root = y && typeof y === "object" && !Array.isArray(y) ? (y as Record<string, unknown>) : {};
    } catch {
      return { ok: false, said: "Not readable as YAML." };
    }
    if (!root["cff-version"]) problems.push("cff-version is missing (1.2.0)");
    if (!root.message) problems.push("message is missing");
    if (!root.title) problems.push("title is missing");
    if (!Array.isArray(root.authors) || !root.authors.length) problems.push("authors are missing");
    if (/@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text)) problems.push("it holds an email address, which the registry never shows: an ORCID iD identifies a person");
    const pref = root["preferred-citation"] as Record<string, unknown> | undefined;
    if (pref && typeof pref === "object" && pref.doi && !doiOf(String(pref.doi))) problems.push("the preferred citation's doi is not a DOI");
    const c = citationOfCff(text);
    if (problems.length || !c) return { ok: false, said: `CITATION.cff: ${problems.length ? problems.join("; ") : "it needs a title and at least one author"}.` };
    return { ok: true, said: `CITATION.cff reads as: ${apa(c.work)}` };
  }
  if (name === "codemeta.json" || name === ".zenodo.json") {
    try {
      JSON.parse(text);
    } catch (e) {
      return { ok: false, said: `${name}: not valid JSON (${String((e as Error).message).slice(0, 120)}).` };
    }
    if (name === "codemeta.json") {
      const c = citationOfCodemeta(text);
      return c ? { ok: true, said: `codemeta.json reads as: ${apa(c.work)}` } : { ok: false, said: "codemeta.json: it needs a name and at least one author." };
    }
    return { ok: true, said: ".zenodo.json is valid JSON." };
  }
  return null;
}

// ─── Markdown ────────────────────────────────────────────────────────────────

export type MarkdownAction = "bold" | "italic" | "code" | "link" | "heading" | "quote" | "bullets" | "numbers" | "tasks";

const lineStart = (v: string, at: number) => v.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (v: string, at: number) => {
  const i = v.indexOf("\n", at);
  return i < 0 ? v.length : i;
};

/** The edit a toolbar button or its key makes on the selection. */
export function markdownEdit(value: string, sel: Sel, action: MarkdownAction): Edit {
  const picked = value.slice(sel.start, sel.end);
  const wrap = (open: string, close = open, placeholder = "text"): Edit => {
    // Already wrapped: unwrap.
    if (picked.startsWith(open) && picked.endsWith(close) && picked.length >= open.length + close.length) {
      const inner = picked.slice(open.length, picked.length - close.length);
      return { from: sel.start, to: sel.end, insert: inner, select: { start: sel.start, end: sel.start + inner.length } };
    }
    const inner = picked || placeholder;
    return { from: sel.start, to: sel.end, insert: `${open}${inner}${close}`, select: { start: sel.start + open.length, end: sel.start + open.length + inner.length } };
  };
  switch (action) {
    case "bold":
      return wrap("**");
    case "italic":
      return wrap("_");
    case "code":
      return picked.includes("\n") ? wrap("```\n", "\n```", "code") : wrap("`", "`", "code");
    case "link": {
      if (/^https?:\/\/\S+$/.test(picked)) {
        return { from: sel.start, to: sel.end, insert: `[text](${picked})`, select: { start: sel.start + 1, end: sel.start + 5 } };
      }
      const text = picked || "text";
      return { from: sel.start, to: sel.end, insert: `[${text}](url)`, select: { start: sel.start + text.length + 3, end: sel.start + text.length + 6 } };
    }
    default: {
      // Line prefixes: every line of the selection.
      const from = lineStart(value, sel.start);
      const to = lineEnd(value, sel.end > sel.start && value[sel.end - 1] === "\n" ? sel.end - 1 : sel.end);
      const lines = value.slice(from, to).split("\n");
      const prefix = (i: number) => (action === "heading" ? "### " : action === "quote" ? "> " : action === "bullets" ? "- " : action === "numbers" ? `${i + 1}. ` : "- [ ] ");
      const has = (l: string, i: number) => l.startsWith(prefix(i));
      const all = lines.every((l, i) => has(l, i) || !l.trim());
      const out = lines.map((l, i) => (!l.trim() && lines.length > 1 ? l : all ? (has(l, i) ? l.slice(prefix(i).length) : l) : prefix(i) + l));
      const insert = out.join("\n");
      return { from, to, insert, select: { start: from, end: from + insert.length } };
    }
  }
}

/** A URL pasted over a selection makes a Markdown link of it (GitHub's behaviour); null otherwise. */
export function pasteAsLink(value: string, sel: Sel, pasted: string): Edit | null {
  const url = pasted.trim();
  if (sel.start === sel.end || !/^https?:\/\/[^\s<>"]+$/.test(url) || url.length > 2000) return null;
  const picked = value.slice(sel.start, sel.end);
  if (picked.includes("\n") || /^https?:\/\//.test(picked)) return null;
  const insert = `[${picked}](${url})`;
  return { from: sel.start, to: sel.end, insert, select: { start: sel.start + insert.length, end: sel.start + insert.length } };
}

/** Cells pasted from a spreadsheet (tab-separated rows, at least two rows and two columns) as a
 *  Markdown table, the first row its header; null otherwise. */
export function pasteAsTable(pasted: string): string | null {
  const rows = pasted.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (rows.length < 2 || rows.length > 500) return null;
  const cells = rows.map((r) => r.split("\t"));
  const width = cells[0].length;
  if (width < 2 || width > 50 || cells.some((c) => c.length !== width)) return null;
  const esc = (s: string) => s.trim().replace(/\|/g, "\\|");
  const line = (c: string[]) => `| ${c.map(esc).join(" | ")} |`;
  return [line(cells[0]), `| ${cells[0].map(() => "---").join(" | ")} |`, ...cells.slice(1).map(line)].join("\n") + "\n";
}

/** A slash command on its own line, run when Enter is pressed at its end: the text that replaces
 *  the line, and what to select in it; null when the line is no command. */
export function slashCommand(line: string): { insert: string; select: [number, number] } | null {
  const m = /^\s*\/(table|code|details|cite)(?:\s+(.*))?$/.exec(line);
  if (!m) return null;
  const arg = (m[2] ?? "").trim();
  switch (m[1]) {
    case "table": {
      const size = /^(\d{1,2})\s*[x×]\s*(\d{1,2})$/.exec(arg);
      const rows = size ? Math.min(20, Math.max(1, Number(size[1]))) : 2;
      const cols = size ? Math.min(10, Math.max(1, Number(size[2]))) : 3;
      const head = `| ${Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(" | ")} |`;
      const rule = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
      const body = Array.from({ length: rows }, () => `| ${Array.from({ length: cols }, () => " ").join(" | ")} |`);
      const insert = [head, rule, ...body].join("\n");
      return { insert, select: [2, 2 + "Column 1".length] };
    }
    case "code": {
      const language = /^[A-Za-z0-9+#.-]{1,30}$/.test(arg) ? arg : "";
      return { insert: `\`\`\`${language}\n\n\`\`\``, select: [4 + language.length, 4 + language.length] };
    }
    case "details":
      return { insert: "<details>\n<summary>Summary</summary>\n\nThe details.\n\n</details>", select: [19, 26] };
    case "cite": {
      const doi = doiOf(arg);
      if (!doi) return { insert: "/cite 10.", select: [9, 9] };
      const insert = `[doi:${doi}](https://doi.org/${doi})`;
      return { insert, select: [insert.length, insert.length] };
    }
  }
  return null;
}
