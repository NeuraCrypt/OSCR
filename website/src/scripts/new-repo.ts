// /new/, in the reader's browser (night phase 01, E2): the form of a new repository in the person's
// own GitHub account, pre-filled from the address (?name=…&description=…&paper=…&gitignore=…&
// license=…&template=owner/name…), and its creation as one authorized action (forge-client.ts:
// the sentence confirmed, then GitHub, then the callback page, which links the new repository's
// page and its quick setup).
//
// The pure parts (the prefill, the name's rules, the action's declaration) are exported for the
// tests; the page's wiring runs only in a browser. A signed-out reader asks the Worker nothing until
// they confirm (the GitHub handle for "from a template" is read only with the hint cookie).
// Everything is written as text nodes, never as HTML; like every browser script, it never names the
// platform (the page hands its name in: data-site).

import { type StartInput } from "../lib/forge.ts";
import { DEFAULT_BRANCH, DEFAULT_LICENCE, GITIGNORE_TEMPLATES, isGitignoreTemplate, isLicenceKey } from "../lib/forge-templates.ts";
import { SEGMENT } from "../../worker/forge/paths.ts";
import { describeCreate, describeGenerate, validateCreate, validateGenerate } from "../../worker/forge/service/act-create.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import { showConfirm, startAction } from "./forge-client.ts";

/** Where the new repository starts from. */
export type StartFrom = "empty" | "template";

export interface NewForm {
  from: StartFrom;
  name: string;
  description: string;
  homepage: string;
  readme: boolean;
  gitignore: string;
  license: string;
  defaultBranch: string;
  /** Mark the new repository as a template. */
  markTemplate: boolean;
  issues: boolean;
  wiki: boolean;
  /** "owner/name" of the template to start from. */
  template: string;
  /** The account that receives a repository made from a template (the person's, or an organization). */
  owner: string;
  includeAllBranches: boolean;
  /** DOIs, as typed. */
  papers: string[];
}

export const EMPTY_FORM: NewForm = {
  from: "empty",
  name: "",
  description: "",
  homepage: "",
  readme: true,
  gitignore: "",
  /** An open licence is offered by default (the page says why); the person may choose none. */
  license: DEFAULT_LICENCE,
  defaultBranch: "",
  markTemplate: false,
  issues: true,
  wiki: true,
  template: "",
  owner: "",
  includeAllBranches: false,
  papers: [],
};

/** The address's parameters the page reads; any other is dropped. */
export const PREFILL_KEYS = [
  "name", "description", "homepage", "readme", "gitignore", "license", "default_branch", "template", "owner",
  "include_all_branches", "visibility", "paper",
] as const;

const DOI = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?(10\.\d{4,9}\/[^\s"<>@]{1,190})$/i;

/** A repository name as GitHub takes it (the Worker checks the same: act-create.ts). */
export const isNewRepoName = (v: unknown): v is string => typeof v === "string" && SEGMENT.test(v) && !/\.git$/i.test(v);

/** "owner/name", or null. */
export function templateRef(value: unknown): { owner: string; name: string } | null {
  if (typeof value !== "string") return null;
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(value.trim());
  return m && SEGMENT.test(m[1]) && isNewRepoName(m[2]) ? { owner: m[1], name: m[2] } : null;
}

/** What the name breaks of GitHub's rules, in words, or null. */
export function nameProblem(name: string): string | null {
  if (!name) return "A name is needed.";
  if (name.length > 100) return "At most 100 characters.";
  if (/[^A-Za-z0-9._-]/.test(name)) return "Letters, digits, “.”, “-” and “_” only: GitHub turns other characters into “-”.";
  if (/^\.+$/.test(name)) return "Not only dots.";
  if (/\.git$/i.test(name)) return "It may not end in .git.";
  return null;
}

const clean = (v: string | null, most: number): string => (v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, most);
const yes = (v: string | null): boolean | null => (v === null ? null : /^(1|true|yes|on)$/i.test(v) ? true : /^(0|false|no|off)$/i.test(v) ? false : null);

/** The form as the address pre-fills it: only the known fields, each checked; a private visibility
 *  is never taken (public only), anything unknown or malformed is dropped and named in `dropped`.
 *  `compendium`: the research-compendium template ("owner/name") when the site offers one. */
export function prefill(search: string, compendium: string | null = null): { form: NewForm; dropped: string[] } {
  const q = new URLSearchParams(search);
  const form: NewForm = { ...EMPTY_FORM, papers: [] };
  const dropped: string[] = [];
  for (const key of new Set(q.keys())) if (!(PREFILL_KEYS as readonly string[]).includes(key)) dropped.push(key);
  const name = q.get("name");
  if (name !== null) {
    if (isNewRepoName(name.trim())) form.name = name.trim();
    else dropped.push("name");
  }
  if (q.get("description") !== null) form.description = clean(q.get("description"), 350);
  const homepage = q.get("homepage");
  if (homepage !== null) {
    try {
      const u = new URL(homepage);
      if (u.protocol === "https:" && !u.username && !u.password && homepage.length <= 255) form.homepage = u.href;
      else dropped.push("homepage");
    } catch {
      dropped.push("homepage");
    }
  }
  const readme = yes(q.get("readme"));
  if (readme !== null) form.readme = readme;
  // readme=0 asks for an EMPTY repository (an import needs one): no licence file either, unless asked.
  if (readme === false) form.license = "";
  const gitignore = q.get("gitignore");
  if (gitignore !== null) {
    const found = GITIGNORE_TEMPLATES.find((t) => t.toLowerCase() === gitignore.trim().toLowerCase());
    if (found) form.gitignore = found;
    else dropped.push("gitignore");
  }
  const license = q.get("license");
  if (license !== null) {
    const key = license.trim().toLowerCase();
    if (key === "none" || key === "") form.license = "";
    else if (isLicenceKey(key)) form.license = key;
    else dropped.push("license");
  }
  const branch = q.get("default_branch");
  if (branch !== null) {
    if (/^[A-Za-z0-9._-]{1,100}$/.test(branch) && !/^\.|\.lock$|\.\./.test(branch)) form.defaultBranch = branch;
    else dropped.push("default_branch");
  }
  const template = q.get("template");
  if (template !== null) {
    const t = template.trim() === "compendium" && compendium ? templateRef(compendium) : templateRef(template);
    if (t) {
      form.from = "template";
      form.template = `${t.owner}/${t.name}`;
    } else dropped.push("template");
  }
  const owner = q.get("owner");
  if (owner !== null) {
    if (SEGMENT.test(owner.trim())) form.owner = owner.trim();
    else dropped.push("owner");
  }
  const all = yes(q.get("include_all_branches"));
  if (all !== null) form.includeAllBranches = all;
  // Public only (D00-14): "public" is what the page does anyway; anything else is not taken.
  const visibility = q.get("visibility");
  if (visibility !== null && visibility.toLowerCase() !== "public") dropped.push("visibility");
  for (const p of q.getAll("paper")) {
    for (const word of p.split(/[\s,]+/)) {
      if (!word) continue;
      const m = DOI.exec(word.trim());
      if (m) {
        const doi = m[1].toLowerCase();
        if (!form.papers.includes(doi) && form.papers.length < 20) form.papers.push(doi);
      } else if (!dropped.includes("paper")) dropped.push("paper");
    }
  }
  return { form, dropped };
}

/** The action the form declares (create, or generate from a template; `back` is /new/), checked
 *  by the Worker's own rules (act-create.ts), with the sentence the Worker will repeat. */
export function declare(form: NewForm): { input: StartInput; sentence: string } | { problem: string } {
  const input = startInput(form);
  if ("problem" in input) return input;
  if (input.kind === "generate") {
    const parsed = validateGenerate(input.payload);
    return isProblem(parsed) ? { problem: parsed.message } : { input, sentence: `${describeGenerate(parsed)}.` };
  }
  const parsed = validateCreate(input.payload);
  return isProblem(parsed) ? { problem: parsed.message } : { input, sentence: `${describeCreate(parsed)}.` };
}

/** The action the form declares, before the Worker's checks: create, or generate from a template. */
export function startInput(form: NewForm): StartInput | { problem: string } {
  const problem = nameProblem(form.name);
  if (problem) return { problem: `The name: ${problem}` };
  const papers = form.papers.slice(0, 20);
  if (form.from === "template") {
    const t = templateRef(form.template);
    if (!t) return { problem: "Name the template as owner/name." };
    if (!SEGMENT.test(form.owner)) return { problem: "Name the GitHub account that receives the repository: yours, or an organization's." };
    const payload: Record<string, unknown> = { template: t, owner: form.owner, name: form.name, includeAllBranches: form.includeAllBranches, papers };
    if (form.description) payload.description = form.description;
    return { kind: "generate", repo: null, payload, back: "/new/" };
  }
  const payload: Record<string, unknown> = { name: form.name, readme: form.readme, template: form.markTemplate, papers };
  if (form.description) payload.description = form.description;
  if (form.homepage) payload.homepage = form.homepage;
  if (isGitignoreTemplate(form.gitignore)) payload.gitignore = form.gitignore;
  if (isLicenceKey(form.license)) payload.license = form.license;
  const first = form.readme || !!payload.gitignore || !!payload.license;
  if (form.defaultBranch && form.defaultBranch !== DEFAULT_BRANCH) {
    if (!first) return { problem: "An empty repository has no branch yet: its first push names it. Add a README, a .gitignore or a licence to name it here." };
    payload.defaultBranch = form.defaultBranch;
  }
  const features: Record<string, boolean> = {};
  if (!form.issues) features.issues = false;
  if (!form.wiki) features.wiki = false;
  if (Object.keys(features).length) payload.features = features;
  return { kind: "create", repo: null, payload, back: "/new/" };
}

// ─── the page ────────────────────────────────────────────────────────────────

const HINT = "__Host-oscr_signed_in=1";

function readForm(f: HTMLFormElement): NewForm {
  const v = (name: string) => ((f.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null)?.value ?? "").trim();
  const c = (name: string) => !!(f.elements.namedItem(name) as HTMLInputElement | null)?.checked;
  const radio = (name: string) => (f.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? "").trim();
  return {
    from: radio("from") === "template" ? "template" : "empty",
    name: v("name"),
    description: v("description"),
    homepage: v("homepage"),
    readme: c("readme"),
    gitignore: v("gitignore"),
    license: radio("license"),
    defaultBranch: v("default_branch"),
    markTemplate: c("mark_template"),
    issues: c("issues"),
    wiki: c("wiki"),
    template: radio("from") === "template" ? v("template") : "",
    owner: v("owner"),
    includeAllBranches: c("include_all_branches"),
    papers: v("papers").split(/[\s,]+/).filter(Boolean),
  };
}

function fill(f: HTMLFormElement, form: NewForm): void {
  const set = (name: string, value: string) => {
    const el = f.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (el) el.value = value;
  };
  const check = (name: string, on: boolean) => {
    const el = f.elements.namedItem(name) as HTMLInputElement | null;
    if (el) el.checked = on;
  };
  set("name", form.name);
  set("description", form.description);
  set("homepage", form.homepage);
  check("readme", form.readme);
  set("gitignore", form.gitignore);
  for (const r of f.querySelectorAll<HTMLInputElement>('input[name="license"]')) r.checked = r.value === form.license;
  set("default_branch", form.defaultBranch);
  check("mark_template", form.markTemplate);
  check("issues", form.issues);
  check("wiki", form.wiki);
  if (form.template) set("template", form.template);
  set("owner", form.owner);
  check("include_all_branches", form.includeAllBranches);
  set("papers", form.papers.join(" "));
  for (const r of f.querySelectorAll<HTMLInputElement>('input[name="from"]')) r.checked = r.value === form.from;
}

function main(): void {
  const f = document.getElementById("new-form") as HTMLFormElement | null;
  if (!f) return;
  const compendium = f.dataset.compendium || null;
  const { form, dropped } = prefill(location.search, compendium);
  fill(f, form);
  f.hidden = false;
  const said = document.getElementById("new-message");
  if (said && dropped.length) {
    said.className = "warning";
    said.textContent = `Left out of the address, as not usable here: ${dropped.join(", ")}.`;
  }
  const rules = document.getElementById("new-name-rules");
  const nameInput = f.elements.namedItem("name") as HTMLInputElement | null;
  const showRules = () => {
    if (!rules || !nameInput) return;
    const p = nameInput.value ? nameProblem(nameInput.value.trim()) : null;
    rules.className = p ? "warning" : "";
    rules.textContent = p ?? "Letters, digits, “.”, “-” and “_”; at most 100 characters.";
  };
  nameInput?.addEventListener("input", showRules);
  showRules();
  const sections = () => {
    const from = readForm(f).from;
    for (const el of f.querySelectorAll<HTMLElement>("[data-from]")) el.hidden = el.dataset.from !== from;
  };
  f.addEventListener("change", (ev) => {
    if ((ev.target as HTMLInputElement | null)?.name === "from") sections();
  });
  sections();
  // The GitHub handle of a signed-in reader, for "from a template" (one request, with the hint cookie only).
  const owner = f.elements.namedItem("owner") as HTMLInputElement | null;
  if (owner && !owner.value && document.cookie.split(/;\s*/).includes(HINT)) {
    void fetch("/api/account/me", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((me: { handles?: { github?: string | null } }) => {
        const login = me?.handles?.github;
        if (login && !owner.value && SEGMENT.test(login)) owner.value = login;
      })
      .catch(() => undefined);
  }
  const confirmBox = document.getElementById("new-confirm");
  f.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const declared = declare(readForm(f));
    if (!confirmBox) return;
    if ("problem" in declared) {
      const p = document.createElement("p");
      p.className = "warning";
      p.textContent = declared.problem;
      confirmBox.replaceChildren(p);
      return;
    }
    const { input, sentence } = declared;
    showConfirm(confirmBox, sentence, () => startAction(input, sentence));
    confirmBox.scrollIntoView({ block: "nearest" });
  });
}

if (typeof document !== "undefined" && typeof location !== "undefined") main();
