// Issue templates and issue forms (night phase 05, E3): where GitHub finds them in the default branch,
// what they say (Markdown templates with their front matter; issue forms, a YAML subset read by
// citation.ts's reader; config.yml's blank-issue switch and contact links), GitHub's validation of a
// form, the answers turned into the issue's text as GitHub writes it — and the registry's three
// research forms ("Code error", "Code–paper mismatch", "Reproduction failure"), offered by default
// when a repository has none of its own for them. Pure, no DOM, testable in Node
// (tests/forge-pages/issue-forms.test.ts). Nothing here ever runs: a form is data, rendered as view
// trees by the pages.
//
// Like every browser script, it never names the platform.

import { maskEmails } from "../../worker/forge/mask.ts";
import type { ResearchType } from "../../worker/forge/service/research-core.ts";
import { parseYaml, type Yaml } from "./citation.ts";

// ─── where they are ──────────────────────────────────────────────────────────

/** The folder of several templates and forms (GitHub's; the default branch only). */
export const TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";
/** The single legacy template, where GitHub still reads it. */
export const LEGACY_FILES = [".github/issue_template.md", "issue_template.md", "docs/issue_template.md"] as const;

export interface TemplateFiles {
  /** Issue forms (.yml, .yaml) and Markdown templates (.md), in GitHub's order: by file name. */
  templates: string[];
  config: string | null;
  legacy: string | null;
}

/** The templates of a tree (GitHub matches the folder's and the files' names in any case). */
export function findIssueTemplates(paths: Iterable<string>): TemplateFiles {
  const all = [...paths];
  const prefix = `${TEMPLATE_DIR.toLowerCase()}/`;
  const templates: string[] = [];
  let config: string | null = null;
  for (const p of all) {
    const low = p.toLowerCase();
    if (!low.startsWith(prefix) || low.slice(prefix.length).includes("/")) continue;
    const name = low.slice(prefix.length);
    if (name === "config.yml" || name === "config.yaml") config = p;
    else if (/\.(?:md|ya?ml)$/.test(name)) templates.push(p);
  }
  const lower = new Map(all.map((p) => [p.toLowerCase(), p]));
  const legacy = LEGACY_FILES.map((f) => lower.get(f)).find((p): p is string => !!p) ?? null;
  templates.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { templates, config, legacy };
}

// ─── the forms' model ────────────────────────────────────────────────────────

export type ElementType = "markdown" | "textarea" | "input" | "dropdown" | "checkboxes" | "upload";

export interface FormElement {
  type: ElementType;
  id: string | null;
  label: string;
  description: string;
  placeholder: string;
  value: string;
  /** A textarea's language: its answer is shown as a code block. */
  render: string;
  options: { label: string; required: boolean }[];
  multiple: boolean;
  /** A dropdown's default option (its index). */
  defaultOption: number | null;
  required: boolean;
  /** The registry's research fields (a research form's typed answers). */
  research?: ResearchField;
}

export type ResearchField = "paragraph" | "section" | "commit" | "path" | "lines" | "figure" | "datasets" | "environment" | "command" | "expected" | "observed" | "outcome";

export interface IssueTemplate {
  /** The file (or "research:<type>" for the registry's forms). */
  path: string;
  kind: "form" | "markdown" | "research";
  name: string;
  about: string;
  title: string;
  labels: string[];
  assignees: string[];
  /** GitHub's issue type ("Bug"), or a research type for the registry's forms. */
  type: string | null;
  /** A Markdown template's text. */
  body: string;
  /** A form's elements. */
  elements: FormElement[];
  research: ResearchType | null;
}

export interface Problems {
  path: string;
  problems: string[];
}

const str = (v: Yaml | undefined): string => (typeof v === "string" ? v : "");
const bool = (v: Yaml | undefined): boolean => v === "true" || v === "yes";
const list = (v: Yaml | undefined): string[] =>
  Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : [];
const obj = (v: Yaml | undefined): { [k: string]: Yaml } => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

const ELEMENT_TYPES: readonly ElementType[] = ["markdown", "textarea", "input", "dropdown", "checkboxes", "upload"];
const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** An issue form (GitHub's syntax), with GitHub's validation: a name, a description and a body are
 *  required; ids are unique and made of letters, digits, "-" and "_"; a label is unique among the
 *  elements; a form holds at least one element that is not Markdown; a dropdown has options. */
export function parseForm(text: string, path: string): IssueTemplate | Problems {
  const doc = obj(parseYaml(text.slice(0, 200_000)));
  const problems: string[] = [];
  const name = str(doc.name).trim();
  const about = str(doc.description).trim();
  if (!name) problems.push("It has no name (the “name” key).");
  if (!about) problems.push("It has no description (the “description” key).");
  const rawBody = doc.body;
  if (!Array.isArray(rawBody) || !rawBody.length) problems.push("It has no body (the “body” key, a list of elements).");
  const elements: FormElement[] = [];
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const [i, raw] of (Array.isArray(rawBody) ? rawBody : []).slice(0, 100).entries()) {
    const e = obj(raw);
    const type = str(e.type) as ElementType;
    if (!ELEMENT_TYPES.includes(type)) {
      problems.push(`Element ${i + 1} has no type GitHub knows (markdown, textarea, input, dropdown, checkboxes, upload).`);
      continue;
    }
    const a = obj(e.attributes);
    const v = obj(e.validations);
    const id = str(e.id).trim() || null;
    if (id !== null) {
      if (!ID.test(id)) problems.push(`Element ${i + 1}'s id “${id}” holds characters GitHub refuses (letters, digits, - and _ only).`);
      else if (ids.has(id)) problems.push(`The id “${id}” is used twice.`);
      ids.add(id);
    }
    const label = str(a.label).trim();
    if (type !== "markdown") {
      if (!label) problems.push(`Element ${i + 1} (${type}) has no label.`);
      else if (labels.has(label.toLowerCase())) problems.push(`The label “${label}” is used twice.`);
      labels.add(label.toLowerCase());
    } else if (!str(a.value).trim()) problems.push(`Element ${i + 1} (markdown) has no text (attributes.value).`);
    const options =
      type === "checkboxes"
        ? (Array.isArray(a.options) ? a.options : []).map((o) => ({ label: str(obj(o).label).trim(), required: bool(obj(o).required) })).filter((o) => o.label)
        : list(a.options).map((o) => ({ label: o, required: false }));
    if ((type === "dropdown" || type === "checkboxes") && !options.length) problems.push(`Element ${i + 1} (${type}) has no options.`);
    const def = str(a.default).trim();
    elements.push({
      type,
      id,
      label,
      description: str(a.description),
      placeholder: str(a.placeholder),
      value: str(a.value),
      render: /^[A-Za-z0-9+#._-]{1,30}$/.test(str(a.render)) ? str(a.render) : "",
      options,
      multiple: bool(a.multiple),
      defaultOption: /^\d{1,3}$/.test(def) && Number(def) < options.length ? Number(def) : null,
      required: bool(v.required),
    });
  }
  if (Array.isArray(rawBody) && rawBody.length && !elements.some((e) => e.type !== "markdown")) problems.push("It holds only Markdown: a form needs at least one field.");
  if (problems.length) return { path, problems };
  return {
    path,
    kind: "form",
    name,
    about,
    title: str(doc.title),
    labels: list(doc.labels).slice(0, 20),
    assignees: list(doc.assignees).slice(0, 10),
    type: str(doc.type).trim() || null,
    body: "",
    elements,
    research: null,
  };
}

/** A Markdown template: its front matter (name, about, title, labels, assignees, type) and its text. */
export function parseMarkdownTemplate(text: string, path: string): IssueTemplate | Problems {
  const t = text.replace(/\r\n?/g, "\n").slice(0, 200_000);
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  const front = m ? obj(parseYaml(m[1])) : {};
  const body = m ? t.slice(m[0].length) : t;
  const name = str(front.name).trim() || path.split("/").pop()!.replace(/\.md$/i, "");
  if (!m && !path.toLowerCase().includes("issue_template.md")) return { path, problems: ["It has no front matter: GitHub lists a template by its “name” and “about”."] };
  return {
    path,
    kind: "markdown",
    name,
    about: str(front.about).trim(),
    title: str(front.title),
    labels: list(front.labels).slice(0, 20),
    assignees: list(front.assignees).slice(0, 10),
    type: str(front.type).trim() || null,
    body,
    elements: [],
    research: null,
  };
}

export interface ContactLink {
  name: string;
  url: string;
  about: string;
}

export interface TemplateConfig {
  blankIssues: boolean;
  contactLinks: ContactLink[];
}

/** config.yml: whether blank issues are allowed (GitHub's default: yes), and contact links (https
 *  addresses only; the page shows them as links elsewhere, never loads them). */
export function parseConfig(text: string | null): TemplateConfig {
  if (!text) return { blankIssues: true, contactLinks: [] };
  const doc = obj(parseYaml(text.slice(0, 50_000)));
  const links = (Array.isArray(doc.contact_links) ? doc.contact_links : [])
    .map((x) => obj(x))
    .map((x) => ({ name: str(x.name).trim(), url: str(x.url).trim(), about: str(x.about).trim() }))
    .filter((x) => x.name && /^https:\/\/[^\s"<>]{3,500}$/.test(x.url) && !x.url.includes("@"))
    .slice(0, 20);
  return { blankIssues: doc.blank_issues_enabled === undefined ? true : bool(doc.blank_issues_enabled), contactLinks: links };
}

// ─── answers ─────────────────────────────────────────────────────────────────

/** An answer: text (textarea, input), the chosen options (dropdown, checkboxes: their labels). */
export type Answers = Record<string, string | string[]>;

export const answerKey = (e: FormElement, index: number): string => e.id ?? `field-${index}`;

/** What is missing or wrong, per field (GitHub's own checks). */
export function checkAnswers(form: IssueTemplate, answers: Answers): { key: string; message: string }[] {
  const out: { key: string; message: string }[] = [];
  form.elements.forEach((e, i) => {
    const key = answerKey(e, i);
    const a = answers[key];
    if (e.type === "checkboxes") {
      const chosen = new Set(Array.isArray(a) ? a : []);
      for (const o of e.options) if (o.required && !chosen.has(o.label)) out.push({ key, message: `“${o.label}” must be ticked.` });
      return;
    }
    if (e.type === "markdown" || !e.required) return;
    const empty = Array.isArray(a) ? a.length === 0 : !String(a ?? "").trim();
    if (empty) out.push({ key, message: `“${e.label}” is required.` });
  });
  return out;
}

/** The issue's text as GitHub writes a form's answers: a "### Label" heading per field, the answer
 *  (a code block when the field renders one), "_No response_" when empty; ticked boxes as "- [X]". */
export function answersToBody(form: IssueTemplate, answers: Answers): string {
  const parts: string[] = [];
  form.elements.forEach((e, i) => {
    if (e.type === "markdown") return;
    const a = answers[answerKey(e, i)];
    let text: string;
    if (e.type === "checkboxes") {
      const chosen = new Set(Array.isArray(a) ? a : []);
      text = e.options.map((o) => `- [${chosen.has(o.label) ? "X" : " "}] ${o.label}`).join("\n");
    } else if (e.type === "dropdown") {
      const chosen = (Array.isArray(a) ? a : a ? [a] : []).filter((x) => e.options.some((o) => o.label === x));
      text = chosen.length ? chosen.join(", ") : "_No response_";
    } else {
      const t = String(Array.isArray(a) ? a.join("\n") : (a ?? "")).trim();
      text = !t ? "_No response_" : e.render ? `\`\`\`${e.render}\n${t}\n\`\`\`` : t;
    }
    parts.push(`### ${e.label}\n\n${text}`);
  });
  return maskEmails(parts.join("\n\n"));
}

/** A form's first answers: the query's `<id>=` (GitHub's prefill by field id) or, for the research
 *  fields, `field.<name>=` (the registry's: the reader and the code view prefill passage, commit and
 *  lines), then each dropdown's default. */
export function prefillAnswers(form: IssueTemplate, search: string): Answers {
  const q = new URLSearchParams(search);
  const out: Answers = {};
  form.elements.forEach((e, i) => {
    const key = answerKey(e, i);
    const given = (e.id ? q.get(e.id) : null) ?? (e.research ? q.get(`field.${e.research}`) : null);
    if (e.type === "dropdown") {
      if (given !== null && e.options.some((o) => o.label === given)) out[key] = [given];
      else if (e.defaultOption !== null) out[key] = [e.options[e.defaultOption].label];
    } else if (e.type === "checkboxes") {
      if (given !== null) out[key] = given.split(",").filter((x) => e.options.some((o) => o.label === x));
    } else if (given !== null && given.length <= 65_536 && e.type !== "markdown") out[key] = given;
    else if (e.value && e.type !== "markdown") out[key] = e.value;
  });
  return out;
}

// ─── the registry's research forms ───────────────────────────────────────────

const field = (research: ResearchField, type: ElementType, label: string, description: string, required = false, extra: Partial<FormElement> = {}): FormElement => ({
  type,
  id: research,
  label,
  description,
  placeholder: "",
  value: "",
  render: "",
  options: [],
  multiple: false,
  defaultOption: null,
  required,
  research,
  ...extra,
});

const text = (id: string, label: string, description: string, required = false): FormElement => ({
  type: "textarea",
  id,
  label,
  description,
  placeholder: "",
  value: "",
  render: "",
  options: [],
  multiple: false,
  defaultOption: null,
  required,
});

const intro = (value: string): FormElement => ({ type: "markdown", id: null, label: "", description: "", placeholder: "", value, render: "", options: [], multiple: false, defaultOption: null, required: false });

const research = (type: ResearchType, name: string, about: string, elements: FormElement[]): IssueTemplate => ({
  path: `research:${type}`,
  kind: "research",
  name,
  about,
  title: "",
  labels: [],
  assignees: [],
  type,
  body: "",
  elements,
  research: type,
});

/** The three research forms, in this order. They are the registry's own objects (research issues,
 *  D00-6): answered, they open a research issue, not a GitHub issue. */
export const RESEARCH_FORMS: readonly IssueTemplate[] = [
  research("mismatch", "Code–paper mismatch", "The code does not do what the paper says, at one place of each: the paragraph, and the lines.", [
    intro("Name the paper's paragraph and the lines of the code that disagree. The tracing map links them; the paper's authors and the code's maintainers read this."),
    field("paragraph", "input", "The paper's paragraph", "Its number, as the tracing map and the reader number it.", true),
    field("section", "input", "Its section", "The heading, when you know it (2.3 Filtering)."),
    field("path", "input", "The file", "Its path in the repository (src/filter.py).", true),
    field("lines", "input", "The lines", "A line or a range: 12, or 12-18.", true),
    field("commit", "input", "The commit", "The full commit id the lines are read at (the reader gives it)."),
    text("says", "What the paper says", "In your words: the paper's text stays under its own licence.", true),
    text("does", "What the code does", "", true),
  ]),
  research("reproduction", "Reproduction failure", "You ran the authors' code and did not get the paper's result: the report says what, where and how.", [
    intro("A reproduction report: what you ran, where, with which data, and what came out. The registry runs nothing: the authors and other readers read your report."),
    field("outcome", "dropdown", "The outcome", "", true, { options: [{ label: "Not reproduced", required: false }, { label: "Partly reproduced", required: false }], defaultOption: 0 }),
    field("figure", "input", "The figure or table", "Which result of the paper (Figure 3, Table 2)."),
    field("commit", "input", "The commit", "The full commit id you ran."),
    field("environment", "textarea", "The environment", "The system, the language's version, the packages (a lock file's text, or its main lines).", true, { render: "text" }),
    field("datasets", "textarea", "The data", "Each dataset on its line: a DOI or a data repository's address."),
    field("command", "input", "The command", "What you ran (python run.py --seed 1)."),
    field("expected", "textarea", "What the paper reports", ""),
    field("observed", "textarea", "What came out", "The number, the figure, the error.", true),
  ]),
  research("code_error", "Code error", "An error in the code that may change the paper's results.", [
    intro("Say what is wrong, where, and what it changes. A plain bug of the software is an ordinary issue of the repository."),
    field("path", "input", "The file", "Its path in the repository, when you know it."),
    field("lines", "input", "The lines", "A line or a range: 12, or 12-18."),
    field("commit", "input", "The commit", "The full commit id."),
    text("error", "The error", "What the code does wrong.", true),
    text("effect", "What it changes in the paper", "The results, figures or numbers it may change."),
  ]),
];

export const researchForm = (type: ResearchType): IssueTemplate => RESEARCH_FORMS.find((f) => f.research === type) as IssueTemplate;

/** "12", "12-18", "L12-L18", "12–18": {start, end}, or null. */
export function readLines(text: string): { start: number; end: number } | null {
  const m = /^\s*L?(\d{1,7})\s*(?:[-–:]\s*L?(\d{1,7}))?\s*$/i.exec(text);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  return start >= 1 && end >= start ? { start, end } : null;
}

/** What a research form's answers make: the payload of POST /api/forge/research/open (the page adds
 *  the paper and the code), and the problems the page says before sending. */
export function researchPayload(form: IssueTemplate, answers: Answers, title: string): { payload: Record<string, unknown>; problems: string[] } {
  const problems = checkAnswers(form, answers).map((p) => p.message);
  const get = (id: string): string => {
    const a = answers[id];
    return (Array.isArray(a) ? a.join("\n") : (a ?? "")).trim();
  };
  const payload: Record<string, unknown> = { type: form.research, title: title.trim() };
  if (!title.trim()) problems.unshift("Give the issue a title.");
  const has = (r: ResearchField) => form.elements.some((e) => e.research === r);
  if (has("paragraph") && get("paragraph")) {
    const n = Number(get("paragraph").replace(/^¶\s*/, ""));
    if (!Number.isInteger(n) || n < 1) problems.push("The paragraph is a number (14).");
    else payload.paragraph = n;
  }
  if (has("section") && get("section")) payload.section = get("section");
  if (has("path") && get("path")) payload.path = get("path").replace(/^\/+/, "");
  if (has("lines") && get("lines")) {
    const l = readLines(get("lines"));
    if (!l) problems.push("The lines are a line or a range: 12, or 12-18.");
    else payload.lines = l;
  }
  if (has("commit") && get("commit")) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(get("commit"))) problems.push("The commit is a full commit id (40 hexadecimal characters).");
    else payload.commit = get("commit");
  }
  if (form.research === "reproduction") {
    payload.report = {
      outcome: get("outcome") === "Partly reproduced" ? "partially" : "failed",
      environment: get("environment"),
      datasets: get("datasets").split(/\n+/).map((x) => x.trim()).filter(Boolean),
      command: get("command"),
      expected: get("expected"),
      observed: get("observed"),
      figure: get("figure"),
    };
  }
  // The free texts become the issue's description, as GitHub writes a form's answers.
  const free = form.elements.filter((e) => e.type === "textarea" && !e.research);
  if (free.length) payload.body = answersToBody({ ...form, elements: free }, answers);
  return { payload, problems };
}
