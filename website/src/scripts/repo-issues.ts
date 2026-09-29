// Issues in the /r/ shell (night phase 05, E4; docs/ISSUES.md): the list (issues/?q=…), the chooser
// (issues/new/choose), the new-issue form (issues/new: blank, a template, an issue form, or one of the
// registry's research forms), the labels (labels/) and the milestones (milestones/, milestone/<n>),
// and the dispatcher of issues/<n>, whose page repo-issue.ts registers (`issueViews.page`).
//
// Two kinds of issues in one list (D00-6): GitHub's, read in the reader's browser on the reader's own
// quota (the list endpoint, 100 an hour-page, 1 request; GitHub's search, 10 a minute, only for what
// only it knows), and the registry's research issues about this repository's papers (signed out: the
// nightly layer shard, "as of last night", 0 Worker requests; signed in: live, 1 request). Every
// write on GitHub is ONE authorized action (act-issues.ts): open an issue, close or reopen or label
// the chosen ones (one authorization for them all), the labels, the milestones. A research issue is
// the registry's own: POST /api/forge/research/open (1 request).
//
// Everything is text nodes; like every browser script, it never names the platform.

import { HUMAN_WAIT, humanToken } from "./human-check.ts";
import { maskEmails } from "../../worker/forge/mask.ts";
import type * as T from "../../worker/forge/types.ts";
import { TYPE_WORDS, type IssueSummary, type ResearchType } from "../../worker/forge/service/research-core.ts";
import { repoPath } from "../lib/forge.ts";
import {
  answerKey,
  answersToBody,
  checkAnswers,
  findIssueTemplates,
  parseConfig,
  parseForm,
  parseMarkdownTemplate,
  prefillAnswers,
  RESEARCH_FORMS,
  researchForm,
  researchPayload,
  type Answers,
  type FormElement,
  type IssueTemplate,
  type Problems,
  type TemplateConfig,
} from "../lib/issue-forms.ts";
import { dayOf, issueRow, labelEl, labelRow, milestoneInWords, parseSummaries } from "../lib/issue-view.ts";
import {
  chooserPath,
  DEFAULT_ISSUE_QUERY,
  DEFAULT_LABELS,
  fromGithub,
  fromResearch,
  hexOf,
  issuePath,
  issuePrefillOf,
  issueSearchQuery,
  issuesPath,
  labelsPath,
  matchIssue,
  milestonePath,
  milestonesPath,
  missingDefaults,
  newIssuePath,
  PALETTE,
  paletteOf,
  parseIssueQuery,
  parseIssueTarget,
  planIssueQuery,
  queryWords,
  researchPath,
  ruleSuggestions,
  similarIssues,
  sortIssues,
  suggestedLabels,
  suggestionInWords,
  taskProgress,
  progressInWords,
  type IssueItem,
} from "../lib/issues.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { declarePull } from "../lib/pull-view.ts";
import { type El, h } from "../lib/repo-view.ts";
import { show, toDom } from "./dom.ts";
import { confirmAction, el, signedInHint, signInLine, textAt, whoIsHere } from "./pull-common.ts";
import { type CodeEnv, codeViews, failed, repoRef } from "./repo-code.ts";

/** The issue's page (E5: repo-issue.ts registers it). */
export const issueViews: { page?: (slot: HTMLElement, env: CodeEnv, number: number) => Promise<void> } = {};

/** Issues read for one page of the list (GitHub's largest page). */
export const LIST_PAGE = 100;

const declare = (env: CodeEnv, kind: Parameters<typeof declarePull>[1], payload: Record<string, unknown>, back: string) =>
  declarePull({ ...env.repo, id: env.info.key.id }, kind, payload, back);

// ─── issues/…: the dispatcher ────────────────────────────────────────────────

codeViews.issues = async (slot, env) => {
  const target = parseIssueTarget(env.target.rest ?? []);
  if (!target) {
    show(slot, h("p", { class: "warning" }, "This address names no issue: it reads issues/<number>, as on GitHub."), h("p", null, h("a", { href: issuesPath(env.repo) }, "The issues")));
    return;
  }
  if ("list" in target) return mountIssues(slot, env);
  if ("choose" in target) return mountChooser(slot, env);
  if ("new" in target) return mountNewIssue(slot, env);
  if (issueViews.page) await issueViews.page(slot, env, target.number);
  else show(slot, h("p", null, "This part of the issue's page is not built yet."));
};

// ─── what the pages share ────────────────────────────────────────────────────

export interface ResearchRead {
  items: IssueSummary[];
  /** Read live from the Worker (signed in), or from the nightly shard. */
  live: boolean;
  can: { write: boolean; triage: boolean } | null;
  problem: string | null;
}

/** The papers of the repository, as research issues name them ("doi:10.…"). */
export const papersOf = (env: CodeEnv): string[] => (env.layer?.papers ?? []).map((p) => `doi:${p.doi.toLowerCase()}`).slice(0, 10);

/** The research issues about this repository: live signed in (1 request), from the nightly layer
 *  shard signed out (0 requests). */
export async function readResearch(env: CodeEnv): Promise<ResearchRead> {
  const papers = papersOf(env);
  if (!papers.length) return { items: [], live: false, can: null, problem: null };
  if (!signedInHint()) return { items: parseSummaries(env.layer?.research), live: false, can: null, problem: null };
  const q = new URLSearchParams();
  for (const p of papers) q.append("paper", p);
  q.set("repo", `${env.info.key.forge === "github" ? "github" : env.info.key.forge}:${env.info.key.id}`);
  try {
    const res = await fetch(`/api/forge/research?${q}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    const body = (await res.json().catch(() => ({}))) as { issues?: unknown; can?: { write?: unknown; triage?: unknown }; error?: { message?: unknown } };
    if (!res.ok) return { items: parseSummaries(env.layer?.research), live: false, can: null, problem: typeof body.error?.message === "string" ? body.error.message : "The registry did not answer." };
    return { items: parseSummaries(body.issues), live: true, can: { write: body.can?.write === true, triage: body.can?.triage === true }, problem: null };
  } catch {
    return { items: parseSummaries(env.layer?.research), live: false, can: null, problem: "The registry could not be reached: the research issues are as of last night." };
  }
}

/** The repository's labels by name (lower case) → colour (1 request; none when it fails). */
async function labelColors(env: CodeEnv): Promise<{ labels: T.Label[]; colors: Map<string, string> }> {
  try {
    const labels = (await env.session.issues.labels(repoRef(env), { perPage: 100 })).items;
    return { labels, colors: new Map(labels.map((l) => [l.name.toLowerCase(), l.color])) };
  } catch {
    return { labels: [], colors: new Map() };
  }
}

async function milestoneTitles(env: CodeEnv, state: "open" | "closed" | "all" = "all"): Promise<T.Milestone[]> {
  try {
    return (await env.session.issues.milestones(repoRef(env), state, { perPage: 100 })).items;
  } catch {
    return [];
  }
}

const option = (value: string, label: string, selected = false): HTMLOptionElement => {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = maskEmails(label);
  o.selected = selected;
  return o;
};

const csrfPost = async (path: string, payload: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> => {
  const who = await whoIsHere();
  if ("message" in who) return { ok: false, status: 401, body: { error: { message: who.message } } };
  try {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": who.csrf },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return { ok: false, status: 0, body: { error: { message: "The registry could not be reached: check the connection, then try again." } } };
  }
};

/** A registry write (a research issue): POST with the session's CSRF token. */
export const researchPost = csrfPost;

export const problemOf = (body: Record<string, unknown>): string => {
  const e = body.error as { message?: unknown } | undefined;
  return typeof e?.message === "string" ? e.message : "The registry did not take it.";
};

// ─── the list ────────────────────────────────────────────────────────────────

const QUICK: [string, string][] = [
  ["Open", DEFAULT_ISSUE_QUERY],
  ["Closed", "is:issue is:closed"],
  ["Yours", "is:issue is:open author:@me"],
  ["Assigned to you", "is:issue is:open assignee:@me"],
  ["Research issues", "is:issue is:open is:research"],
  ["Code–paper mismatches", "is:issue is:open type:mismatch"],
  ["Reproduction failures", "is:issue is:open type:reproduction"],
];

async function mountIssues(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const params = new URLSearchParams(env.search);
  const q = (params.get("q") ?? DEFAULT_ISSUE_QUERY).slice(0, 500);
  const pageNo = /^[1-9][0-9]{0,2}$/.test(params.get("page") ?? "") ? Number(params.get("page")) : 1;
  const parsed = parseIssueQuery(q);
  const plan = planIssueQuery(parsed);
  const signedIn = signedInHint();
  const head: El[] = [
    h(
      "div",
      { class: "code-head" },
      h("h2", null, "Issues"),
      h("p", { class: "file-actions" }, h("a", { href: chooserPath(env.repo), class: "primary-link" }, "New issue"), " · ", h("a", { href: labelsPath(env.repo) }, "Labels"), " · ", h("a", { href: milestonesPath(env.repo) }, "Milestones")),
    ),
    h(
      "form",
      { class: "repo-search pull-filter", role: "search", id: "issue-filter" },
      h("label", { for: "issue-q" }, "Filter "),
      h("input", { type: "search", id: "issue-q", name: "q", value: q, autocomplete: "off", spellcheck: "false", placeholder: DEFAULT_ISSUE_QUERY }),
      " ",
      h("button", { type: "submit" }, "Filter"),
      q !== DEFAULT_ISSUE_QUERY ? [" ", h("a", { href: issuesPath(env.repo) }, "Clear")] : null,
    ),
    h("p", { class: "pull-quick" }, ...QUICK.flatMap(([label, query], i) => [i ? " · " : "", query === q ? h("strong", null, label) : h("a", { href: issuesPath(env.repo, query) }, label)])),
  ];
  if (parsed.errors.length) head.push(h("p", { class: "warning" }, parsed.errors.join(" ")));
  show(slot, ...head, h("p", { "aria-live": "polite" }, "Reading the issues…"));

  let me: string | null = null;
  if (/@me\b/i.test(q)) {
    const who = await whoIsHere();
    if ("login" in who) me = who.login;
    if (!me) {
      show(slot, ...head);
      slot.append(signInLine("“@me” is your GitHub account: sign in with GitHub to filter by it."));
      return;
    }
  }
  const qMe = me ? q.replace(/@me\b/gi, me) : q;
  const items: IssueItem[] = [];
  const notes: string[] = [];
  let next: string | null = null;
  // GitHub's issues.
  if (plan.github) {
    try {
      if (plan.search) {
        const found = await env.session.issues.search(repoRef(env), issueSearchQuery(qMe), { perPage: 50, cursor: pageNo > 1 ? String(pageNo) : null });
        items.push(...found.items.filter((i) => !i.isPullRequest).map(fromGithub));
        next = found.next;
        notes.push("GitHub's issues found by its search (it knows the comments and who took part; its answers may lag a minute behind).");
      } else {
        const milestone = plan.milestone && /^\d+$/.test(plan.milestone) ? Number(plan.milestone) : undefined;
        const list = await env.session.issues.list(
          repoRef(env),
          {
            state: plan.state,
            labels: plan.labels.length ? plan.labels : undefined,
            milestone,
            assignee: plan.assignee && plan.assignee !== "*" ? plan.assignee.replace(/^@me$/i, me ?? "").replace(/^@/, "") || undefined : undefined,
            creator: plan.creator ? plan.creator.replace(/^@me$/i, me ?? "").replace(/^@/, "") || undefined : undefined,
            sort: plan.sort === "updated" || plan.sort === "comments" ? plan.sort : "created",
            direction: plan.direction,
          },
          { perPage: LIST_PAGE, cursor: pageNo > 1 ? String(pageNo) : null },
        );
        items.push(...list.items.map(fromGithub));
        next = list.next;
        if (list.next) notes.push(`GitHub's issues filtered among the ${LIST_PAGE} it listed on this page; the next page holds older ones.`);
      }
    } catch (e) {
      const box = document.createElement("div");
      show(slot, ...head);
      slot.append(box);
      failed(box, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/issues`, "issues");
      return;
    }
  }
  // The research issues (the first page only: they are few, and all read at once).
  let research: ResearchRead = { items: [], live: false, can: null, problem: null };
  if (plan.research && pageNo === 1) {
    research = await readResearch(env);
    items.push(...research.items.map(fromResearch));
    if (research.problem) notes.push(research.problem);
    else if (research.items.length && !research.live) notes.push("The research issues are as of last night; signed in, they are read live.");
  }
  const milestones = items.some((i) => i.milestone !== null) || /milestone:/.test(q) ? await milestoneTitles(env) : [];
  const ctx = { me, milestones: new Map(milestones.map((m) => [m.number, m.title])) };
  const kept = sortIssues(items.filter((i) => matchIssue(i, parsed.node, ctx)), plan, queryWords(parsed.node));
  const { labels, colors } = kept.some((i) => i.labels.length) || signedIn ? await labelColors(env) : { labels: [] as T.Label[], colors: new Map<string, string>() };
  const rows = kept.map((i) => issueRow(env.repo, i, { select: signedIn && !plan.search, colors, milestones: ctx.milestones, asOfLastNight: i.kind === "research" && !research.live }));
  const here = (n: number) => {
    const p = new URLSearchParams({ q });
    if (n > 1) p.set("page", String(n));
    return `${location.pathname}?${p}`;
  };
  const githubRows = kept.filter((i) => i.kind === "github").length;
  show(
    slot,
    ...head,
    h("p", { class: "status-line" }, kept.length ? `${kept.length} ${kept.length === 1 ? "issue matches" : "issues match"} “${q}”.` : `No issue matches “${q}”.`, notes.length ? ` ${notes.join(" ")}` : ""),
    rows.length ? h("ul", { class: "issue-list", id: "issue-list" }, ...rows) : null,
    signedIn && githubRows && !plan.search ? bulkBar(labels, milestones) : null,
    h("div", { id: "issue-act", "aria-live": "polite" }),
    h("p", { class: "pager" }, pageNo > 1 ? h("a", { href: here(pageNo - 1) }, "Newer") : null, pageNo > 1 && next ? " · " : null, next ? h("a", { href: here(pageNo + 1) }, "Older") : null),
    !env.layer?.papers.length ? h("p", { class: "explain" }, "Research issues (code–paper mismatches, reproduction failures, code errors) belong to a paper: this repository is attached to none yet.") : null,
  );
  slot.querySelector<HTMLFormElement>("#issue-filter")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = slot.querySelector<HTMLInputElement>("#issue-q")?.value.trim() || DEFAULT_ISSUE_QUERY;
    location.assign(issuesPath(env.repo, v));
  });
  wireBulk(slot, env);
}

function bulkBar(labels: readonly T.Label[], milestones: readonly T.Milestone[]): El {
  return h(
    "div",
    { class: "pull-bulk issue-bulk" },
    h("p", null, "With the chosen issues (one authorization for them all): ", h("button", { type: "button", "data-bulk": "completed" }, "Close as completed"), " ", h("button", { type: "button", "data-bulk": "not_planned" }, "Close as not planned"), " ", h("button", { type: "button", "data-bulk": "open" }, "Reopen")),
    labels.length
      ? h(
          "p",
          null,
          h("label", { for: "bulk-label" }, "Label "),
          h("select", { id: "bulk-label" }, ...labels.map((l) => h("option", { value: l.name }, l.name))),
          " ",
          h("button", { type: "button", "data-bulk": "label-add" }, "Add"),
          " ",
          h("button", { type: "button", "data-bulk": "label-remove" }, "Remove"),
        )
      : null,
    h(
      "p",
      null,
      h("label", { for: "bulk-milestone" }, "Milestone "),
      h("select", { id: "bulk-milestone" }, h("option", { value: "" }, "None"), ...milestones.filter((m) => m.state === "open").map((m) => h("option", { value: String(m.number) }, m.title))),
      " ",
      h("button", { type: "button", "data-bulk": "milestone" }, "Set"),
    ),
  );
}

function wireBulk(slot: HTMLElement, env: CodeEnv): void {
  const box = slot.querySelector<HTMLElement>("#issue-act");
  slot.querySelectorAll<HTMLButtonElement>("button[data-bulk]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!box) return;
      const numbers = [...slot.querySelectorAll<HTMLInputElement>("#issue-list input[name=issue]:checked")].map((i) => Number(i.value));
      if (!numbers.length) {
        box.replaceChildren(el("p", { class: "warning" }, "Choose one or more issues first (the boxes on the left)."));
        return;
      }
      const which = b.dataset.bulk;
      const payload: Record<string, unknown> = numbers.length === 1 ? { number: numbers[0] } : { numbers };
      if (which === "completed" || which === "not_planned") Object.assign(payload, { state: "closed", reason: which });
      else if (which === "open") payload.state = "open";
      else if (which === "label-add" || which === "label-remove") {
        const name = slot.querySelector<HTMLSelectElement>("#bulk-label")?.value ?? "";
        payload.labels = which === "label-add" ? { add: [name] } : { remove: [name] };
      } else if (which === "milestone") {
        const v = slot.querySelector<HTMLSelectElement>("#bulk-milestone")?.value ?? "";
        payload.milestone = v ? Number(v) : null;
      }
      void confirmAction(box, declare(env, "issue_edit", payload, `${location.pathname}${location.search}`));
    }),
  );
}

// ─── templates, forms, the chooser ───────────────────────────────────────────

interface Templates {
  templates: IssueTemplate[];
  broken: Problems[];
  config: TemplateConfig;
  /** The community files: contributing, security policy, support (the registry's views). */
  community: { label: string; href: string }[];
}

const COMMUNITY: [string, RegExp][] = [
  ["Contributing guidelines", /^(?:\.github\/|docs\/)?contributing(?:\.(?:md|txt|rst))?$/i],
  ["Security policy", /^(?:\.github\/|docs\/)?security(?:\.(?:md|txt|rst))?$/i],
  ["Support", /^(?:\.github\/|docs\/)?support(?:\.(?:md|txt|rst))?$/i],
  ["Code of conduct", /^(?:\.github\/|docs\/)?code_of_conduct(?:\.(?:md|txt|rst))?$/i],
];

/** The default branch's templates, forms and config (the tree once, cached for the tab; each file a
 *  raw read, not counted in the reader's quota). */
async function readTemplates(env: CodeEnv): Promise<Templates> {
  const def = env.info.defaultBranch;
  const out: Templates = { templates: [], broken: [], config: parseConfig(null), community: [] };
  if (!def) return out;
  let head: string;
  let paths: string[];
  try {
    head = await env.session.git.resolve(repoRef(env), def);
    paths = (await env.session.git.tree(repoRef(env), head, { recursive: true })).entries.filter((e) => e.type === "blob").map((e) => e.path);
  } catch {
    return out;
  }
  const found = findIssueTemplates(paths);
  for (const path of [...found.templates, ...(found.legacy ? [found.legacy] : [])].slice(0, 30)) {
    const text = await textAt(env, head, path, 256 * 1024);
    if (text === null) continue;
    const t = /\.ya?ml$/i.test(path) ? parseForm(text, path) : parseMarkdownTemplate(text, path);
    if ("problems" in t) out.broken.push(t);
    else out.templates.push(t);
  }
  if (found.config) out.config = parseConfig(await textAt(env, head, found.config, 64 * 1024));
  for (const [label, re] of COMMUNITY) {
    const p = paths.find((x) => re.test(x));
    if (p) out.community.push({ label, href: repoPath(env.repo, "blob", [def, ...p.split("/")]) });
  }
  return out;
}

const fileName = (path: string): string => path.split("/").pop() ?? path;

async function mountChooser(slot: HTMLElement, env: CodeEnv): Promise<void> {
  show(slot, h("p", { "aria-live": "polite" }, "Reading the templates…"));
  const t = await readTemplates(env);
  const papers = env.layer?.papers ?? [];
  const entry = (name: string, about: string, href: string, extra: El | null = null): El =>
    h("li", { class: "template-entry" }, h("p", { class: "title" }, h("a", { href }, name)), about ? h("p", { class: "line" }, about) : null, extra);
  show(
    slot,
    h("h2", null, "New issue"),
    t.community.length ? h("p", { class: "explain" }, "Helpful resources: ", ...t.community.flatMap((c, i) => [i ? " · " : "", h("a", { href: c.href }, c.label)])) : null,
    papers.length
      ? h(
          "section",
          { class: "template-group" },
          h("h3", null, "About the paper"),
          h("p", { class: "explain" }, "Research issues are the registry's own: the paper's authors and the code's maintainers read them beside the paper and its tracing map."),
          h("ul", { class: "template-list" }, ...RESEARCH_FORMS.map((f) => entry(f.name, f.about, newIssuePath(env.repo, { template: f.path })))),
        )
      : null,
    h("h3", null, papers.length ? "About the software" : "Templates"),
    t.templates.length
      ? h("ul", { class: "template-list" }, ...t.templates.map((f) => entry(f.name, f.about, newIssuePath(env.repo, { template: fileName(f.path) }))))
      : h("p", null, "The repository has no issue template of its own."),
    t.config.blankIssues || !t.templates.length ? h("p", null, h("a", { href: newIssuePath(env.repo, { blank: "1" }) }, "Open a blank issue"), ": a title and a description, nothing asked.") : h("p", { class: "explain" }, "The repository asks for its templates: blank issues are off."),
    t.config.contactLinks.length
      ? h(
          "section",
          { class: "template-group" },
          h("h3", null, "Elsewhere"),
          h("ul", { class: "template-list" }, ...t.config.contactLinks.map((c) => entry(c.name, c.about, c.url, h("p", { class: "line" }, `At ${new URL(c.url).host}: the repository's owners send these questions there.`)))),
        )
      : null,
    t.broken.length
      ? h("section", { class: "template-problems" }, h("h3", null, "Templates GitHub would refuse"), ...t.broken.map((b) => h("p", { class: "warning" }, `${b.path}: ${b.problems.join(" ")}`)))
      : null,
  );
}

// ─── the new-issue form ──────────────────────────────────────────────────────

/** A form element as DOM (the answers' inputs carry `data-key`). */
async function elementDom(e: FormElement, key: string, value: string | string[] | undefined, env: CodeEnv): Promise<HTMLElement> {
  const id = `f-${key}`;
  const req = e.required ? " (required)" : "";
  if (e.type === "markdown") {
    const r = await renderMarkdown(e.value, { repo: env.repo });
    const d = el("div", { class: "form-markdown" });
    d.append(toDom(r.el));
    return d;
  }
  const wrap = el("div", { class: "form-field" });
  const desc = e.description ? el("p", { class: "explain" }, e.description) : null;
  if (e.type === "input" || e.type === "textarea" || e.type === "upload") {
    const label = el("label", { for: id }, `${e.label}${req}`);
    const input =
      e.type === "textarea"
        ? el("textarea", { id, rows: "5", "data-key": key, spellcheck: "true" })
        : el("input", { type: "text", id, "data-key": key, autocomplete: "off" });
    if (e.placeholder) input.setAttribute("placeholder", maskEmails(e.placeholder));
    input.value = maskEmails(typeof value === "string" ? value : "");
    if (e.type === "upload") {
      wrap.append(label, desc ?? "", el("p", { class: "explain" }, "Files are not uploaded here yet (phase 16 checks them first): paste a link to the file instead."), input);
    } else wrap.append(label, desc ?? "", input);
    return wrap;
  }
  if (e.type === "dropdown") {
    const select = el("select", { id, "data-key": key });
    if (e.multiple) select.multiple = true;
    const chosen = new Set(Array.isArray(value) ? value : value ? [value] : []);
    if (!e.multiple) select.append(option("", "Choose…"));
    for (const o of e.options) select.append(option(o.label, o.label, chosen.has(o.label)));
    wrap.append(el("label", { for: id }, `${e.label}${req}`), desc ?? "", select);
    return wrap;
  }
  const set = el("fieldset", { class: "choices", "data-key": key });
  set.append(el("legend", {}, e.label));
  if (desc) set.append(desc);
  const chosen = new Set(Array.isArray(value) ? value : []);
  e.options.forEach((o, i) => {
    const box = el("input", { type: "checkbox", id: `${id}-${i}`, value: o.label });
    box.checked = chosen.has(o.label);
    set.append(el("label", { for: `${id}-${i}` }, box, ` ${o.label}${o.required ? " (required)" : ""}`));
  });
  return set;
}

function readAnswers(form: HTMLElement, t: IssueTemplate): Answers {
  const out: Answers = {};
  t.elements.forEach((e, i) => {
    const key = answerKey(e, i);
    if (e.type === "checkboxes") {
      out[key] = [...form.querySelectorAll<HTMLInputElement>(`fieldset[data-key="${CSS.escape(key)}"] input:checked`)].map((x) => x.value);
    } else if (e.type === "dropdown") {
      const s = form.querySelector<HTMLSelectElement>(`select[data-key="${CSS.escape(key)}"]`);
      out[key] = s ? [...s.selectedOptions].map((o) => o.value).filter(Boolean) : [];
    } else if (e.type !== "markdown") {
      out[key] = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-key="${CSS.escape(key)}"]`)?.value ?? "";
    }
  });
  return out;
}

async function mountNewIssue(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const prefill = issuePrefillOf(env.search);
  const params = new URLSearchParams(env.search);
  show(slot, h("p", { "aria-live": "polite" }, "Reading the templates…"));
  const t = await readTemplates(env);
  const papers = env.layer?.papers ?? [];
  let template: IssueTemplate | null = null;
  if (prefill.template?.startsWith("research:")) template = researchForm(prefill.template.slice("research:".length) as ResearchType);
  else if (prefill.template) template = t.templates.find((x) => fileName(x.path).toLowerCase() === prefill.template!.toLowerCase()) ?? null;
  else if (!params.has("blank") && t.templates.length === 1 && !t.config.blankIssues) template = t.templates[0];
  if (!template && !params.has("blank") && prefill.template === null && (t.templates.length || papers.length) && !t.config.blankIssues) {
    location.replace(chooserPath(env.repo));
    return;
  }
  if (template?.kind === "research" && !papers.length) {
    show(slot, h("p", { class: "warning" }, "Research issues belong to a paper, and this repository is attached to none yet: attach it to its paper first (the home page, “Papers”), or open an ordinary issue."), h("p", null, h("a", { href: newIssuePath(env.repo, { blank: "1" }) }, "Open an ordinary issue")));
    return;
  }
  const research = template?.kind === "research" ? (template.research as ResearchType) : null;
  const signedIn = signedInHint();
  const { labels } = research ? { labels: [] as T.Label[] } : await labelColors(env);
  const milestones = research ? [] : await milestoneTitles(env, "open");
  // The issues the draft is compared with (similar issues, duplicates): the first page (1 request).
  let known: IssueItem[] = [];
  try {
    known = (await env.session.issues.list(repoRef(env), { state: "all", sort: "updated" }, { perPage: 50 })).items.map(fromGithub);
  } catch {
    known = [];
  }
  const researchRead = await readResearch(env);
  known.push(...researchRead.items.map(fromResearch));

  const title = el("input", { type: "text", id: "issue-title", name: "title", maxlength: "256", autocomplete: "off" });
  title.value = maskEmails(prefill.title ?? template?.title ?? "");
  const body = el("textarea", { id: "issue-body", name: "body", rows: "12", spellcheck: "true" });
  body.value = maskEmails(prefill.body ?? (template?.kind === "markdown" ? template.body : ""));
  const preview = el("div", { class: "pull-preview", hidden: "" });
  const similar = el("div", { class: "similar", "aria-live": "polite" });
  const suggestions = el("div", { class: "rule-suggestions", "aria-live": "polite" });
  const said = el("div", { "aria-live": "polite" });
  const fields = el("div", { class: "issue-form-fields" });
  const answers = template && template.kind !== "markdown" ? prefillAnswers(template, env.search) : {};
  if (template && template.kind !== "markdown") for (const [i, e] of template.elements.entries()) fields.append(await elementDom(e, answerKey(e, i), answers[answerKey(e, i)], env));

  // The paper (research): the repository's papers; the prefilled DOI chosen.
  const paperPick = el("select", { id: "issue-paper" });
  for (const p of papers) paperPick.append(option(`doi:${p.doi.toLowerCase()}`, p.title ? `${p.title} (doi:${p.doi})` : `doi:${p.doi}`, prefill.doi === p.doi.toLowerCase()));
  // GitHub's labels, assignees, milestone (kept by GitHub for people who triage only).
  const chosenLabels = new Set([...(template?.labels ?? []), ...prefill.labels].map((l) => l.toLowerCase()));
  const labelBoxes = el("fieldset", { class: "choices issue-labels" }, el("legend", {}, "Labels"));
  for (const l of suggestedLabels(labels, known).slice(0, 40)) {
    const box = el("input", { type: "checkbox", value: l.name, id: `l-${l.name}` });
    box.checked = chosenLabels.has(l.name.toLowerCase());
    const mark = el("span", { class: "label-mark", "data-color": paletteOf(l.color), "aria-hidden": "true" });
    labelBoxes.append(el("label", { for: `l-${l.name}`, class: "label" }, box, " ", mark, l.name));
  }
  const assignees = el("input", { type: "text", id: "issue-assignees", autocomplete: "off", spellcheck: "false", placeholder: "GitHub logins, separated by commas" });
  assignees.value = [...(template?.assignees ?? []), ...prefill.assignees].join(", ");
  const milestone = el("select", { id: "issue-milestone" });
  milestone.append(option("", "None"));
  for (const m of milestones) milestone.append(option(String(m.number), m.title, prefill.milestone === m.number));
  const more = el("input", { type: "checkbox", id: "issue-more" });

  const refresh = () => {
    const text = `${title.value}\n${body.value}\n${template && template.kind !== "markdown" ? answersToBody(template, readAnswers(form, template)) : ""}`;
    const found = similarIssues({ title: title.value, body: body.value, path: prefill.path, paragraph: prefill.paragraph }, known);
    similar.replaceChildren(
      ...(found.length
        ? [
            el("p", { class: "similar-title" }, "Similar issues (by shared words; read them before opening a duplicate):"),
            el(
              "ul",
              {},
              ...found.map((f) =>
                el("li", {}, el("a", { href: f.item.kind === "research" ? researchPath(f.item.number) : issuePath(env.repo, f.item.number) }, `${f.item.kind === "research" ? "research" : ""}#${f.item.number} ${f.item.title}`), f.item.state === "closed" ? " (closed)" : ""),
              ),
            ),
          ]
        : []),
    );
    const s = ruleSuggestions(text, { type: research ?? null, labels: [...labelBoxes.querySelectorAll<HTMLInputElement>("input:checked")].map((x) => x.value) });
    suggestions.replaceChildren(
      ...s
        .filter((x) => !(research && x.field === "type"))
        .map((x) => {
          const p = el("p", { class: "rule-suggestion" }, suggestionInWords(x), " ");
          if (x.field === "label") {
            const box = labelBoxes.querySelector<HTMLInputElement>(`input[value="${CSS.escape(x.value)}"]`);
            if (box) {
              const accept = el("button", { type: "button" }, "Add it");
              accept.addEventListener("click", () => {
                box.checked = true;
                p.remove();
              });
              p.append(accept);
            } else p.append(el("span", { class: "explain" }, "(the repository has no such label)"));
          } else if (papers.length) {
            p.append(el("a", { href: newIssuePath(env.repo, { template: `research:${x.value}`, title: title.value.slice(0, 200), ...(prefill.doi ? { doi: prefill.doi } : {}) }) }, `File it as a ${TYPE_WORDS[x.value as ResearchType].toLowerCase()}`));
          }
          const decline = el("button", { type: "button", class: "link" }, "Decline");
          decline.addEventListener("click", () => p.remove());
          p.append(" ", decline);
          return p;
        }),
    );
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  };
  title.addEventListener("input", later);
  body.addEventListener("input", later);

  const previewButton = el("button", { type: "button" }, "Preview");
  previewButton.addEventListener("click", async () => {
    if (!preview.hidden) {
      preview.hidden = true;
      previewButton.textContent = "Preview";
      return;
    }
    const text = template && template.kind !== "markdown" ? answersToBody(template, readAnswers(form, template)) : body.value;
    const r = await renderMarkdown(text, { repo: env.repo });
    const p = taskProgress(text);
    preview.replaceChildren(toDom(r.el), ...(p.total ? [el("p", { class: "explain" }, progressInWords(p))] : []));
    preview.hidden = false;
    previewButton.textContent = "Back to the text";
  });

  const submit = async () => {
    said.replaceChildren();
    if (!signedIn) {
      said.replaceChildren(signInLine("Sign in to open an issue: the registry opens it as you, with your own account."));
      return;
    }
    if (research && template) {
      const { payload, problems } = researchPayload(template, readAnswers(form, template), title.value);
      if (problems.length) {
        said.replaceChildren(el("p", { class: "warning" }, problems.join(" ")));
        return;
      }
      Object.assign(payload, { paper: paperPick.value, repo: { forge: env.info.key.forge, id: env.info.key.id, path: `${env.repo.owner}/${env.repo.name}`.toLowerCase() } });
      if (prefill.section && !payload.section) payload.section = prefill.section;
      // Night phase 16: a research issue passes the human check (human-check.ts).
      const turnstile = await humanToken(form.querySelector<HTMLElement>('button[type="submit"]') ?? form);
      if (turnstile === null) return void said.replaceChildren(el("p", { class: "warning" }, HUMAN_WAIT));
      const res = await researchPost("/api/forge/research/open", { ...payload, turnstile });
      if (!res.ok) {
        said.replaceChildren(el("p", { class: "warning" }, problemOf(res.body)));
        return;
      }
      const id = Number(res.body.id);
      if (more.checked) {
        said.replaceChildren(el("p", { class: "ok" }, "Opened: ", el("a", { href: researchPath(id) }, `research#${id}`), ". The form is ready for the next one."));
        title.value = "";
        return;
      }
      location.assign(researchPath(id));
      return;
    }
    const checks = template && template.kind === "form" ? checkAnswers(template, readAnswers(form, template)) : [];
    if (checks.length) {
      said.replaceChildren(el("p", { class: "warning" }, checks.map((c) => c.message).join(" ")));
      return;
    }
    const text = template && template.kind === "form" ? answersToBody(template, readAnswers(form, template)) : body.value;
    const payload: Record<string, unknown> = { title: title.value, body: text };
    const ls = [...labelBoxes.querySelectorAll<HTMLInputElement>("input:checked")].map((x) => x.value);
    if (ls.length) payload.labels = ls;
    const as = assignees.value.split(/[\s,]+/).map((s) => s.replace(/^@/, "")).filter(Boolean);
    if (as.length) payload.assignees = as;
    if (milestone.value) payload.milestone = Number(milestone.value);
    if (template?.type) payload.type = template.type;
    if (prefill.parent) payload.parent = prefill.parent;
    const back = more.checked ? `${location.pathname}${location.search}` : issuesPath(env.repo);
    void confirmAction(said, declare(env, "issue_open", payload, back));
  };
  const create = el("button", { type: "button", class: "primary", id: "issue-create" }, research ? "Open the research issue" : "Create the issue");
  create.addEventListener("click", () => void submit());

  const heading = research ? `New research issue: ${TYPE_WORDS[research]}` : template ? `New issue: ${template.name}` : "New issue";
  const form = el(
    "section",
    { class: "pull-form issue-form", "aria-label": heading },
    el("h2", {}, heading),
    t.community.length && !research ? el("p", { class: "explain" }, "Helpful resources: ", ...t.community.flatMap((c, i) => [i ? " · " : "", el("a", { href: c.href }, c.label)])) : null,
    template?.about ? el("p", { class: "explain" }, template.about) : null,
    prefill.parent && !research ? el("p", { class: "explain" }, `It will be a sub-issue of #${prefill.parent}.`) : null,
    research ? el("p", {}, el("label", { for: "issue-paper" }, "The paper "), paperPick) : null,
    el("p", {}, el("label", { for: "issue-title" }, "Title"), el("br"), title),
    similar,
    template && template.kind !== "markdown" ? fields : el("div", {}, el("p", { class: "pull-form-tools" }, el("label", { for: "issue-body" }, "Description "), previewButton), body),
    template && template.kind !== "markdown" ? el("p", {}, previewButton) : null,
    preview,
    suggestions,
    research
      ? el("p", { class: "explain" }, "A research issue is the registry's own: its paper's authors and its code's maintainers read it beside the paper. Its author may copy it to GitHub later, as an ordinary issue.")
      : el(
          "details",
          { class: "issue-meta" },
          el("summary", {}, "Labels, assignees, milestone (GitHub keeps them for people who triage the repository's issues)"),
          labels.length ? labelBoxes : el("p", { class: "explain" }, "The repository has no labels yet: ", el("a", { href: labelsPath(env.repo) }, "its labels"), "."),
          el("p", {}, el("label", { for: "issue-assignees" }, "Assignees "), assignees),
          el("p", {}, el("label", { for: "issue-milestone" }, "Milestone "), milestone),
        ),
    el("p", {}, el("label", { for: "issue-more" }, more, " Create more: come back to this form after it")),
    el("p", {}, create, " ", el("a", { href: chooserPath(env.repo) }, "Choose another template")),
    said,
  );
  slot.replaceChildren(form);
  if (!title.value) title.focus();
  refresh();
}

// ─── labels ──────────────────────────────────────────────────────────────────

const paletteSelect = (id: string, selected: string): HTMLSelectElement => {
  const s = el("select", { id });
  for (const p of PALETTE) s.append(option(p.hex, p.name, p.name === selected));
  return s;
};

async function mountLabels(slot: HTMLElement, env: CodeEnv): Promise<void> {
  show(slot, h("p", { "aria-live": "polite" }, "Reading the labels…"));
  let labels: T.Label[];
  try {
    labels = (await env.session.issues.labels(repoRef(env), { perPage: 100 })).items;
  } catch (e) {
    failed(slot, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/labels`, "labels");
    return;
  }
  const signedIn = signedInHint();
  const missing = missingDefaults(labels);
  const back = labelsPath(env.repo);
  show(
    slot,
    h("div", { class: "code-head" }, h("h2", null, `Labels (${labels.length})`), h("p", { class: "file-actions" }, h("a", { href: issuesPath(env.repo) }, "Issues"), " · ", h("a", { href: milestonesPath(env.repo) }, "Milestones"))),
    labels.length
      ? h("ul", { class: "label-list" }, ...labels.map((l) => labelRow(l, issuesPath(env.repo, `is:issue is:open label:"${l.name}"`))))
      : h("p", null, "The repository has no labels."),
    h("p", { class: "explain" }, "A label's colour is shown as a small mark, from a palette of 16: the registry never paints a label as a pill."),
    signedIn ? h("div", { id: "label-forms" }) : h("p", { class: "explain" }, "Signed in, the people who triage the repository's issues create, change and delete labels here."),
    h("div", { id: "label-act", "aria-live": "polite" }),
  );
  const forms = slot.querySelector<HTMLElement>("#label-forms");
  const box = slot.querySelector<HTMLElement>("#label-act");
  if (!forms || !box) return;
  // Create one.
  const name = el("input", { type: "text", id: "label-name", maxlength: "50", autocomplete: "off" });
  const about = el("input", { type: "text", id: "label-about", maxlength: "100", autocomplete: "off" });
  const color = paletteSelect("label-color", "blue");
  const create = el("button", { type: "button" }, "Create the label");
  create.addEventListener("click", () => void confirmAction(box, declare(env, "issue_labels", { create: [{ name: name.value.trim(), color: color.value, description: about.value.trim() }] }, back)));
  // Change or delete one.
  const which = el("select", { id: "label-which" });
  for (const l of labels) which.append(option(l.name, l.name));
  const rename = el("input", { type: "text", id: "label-rename", maxlength: "50", autocomplete: "off", placeholder: "A new name (optional)" });
  const newAbout = el("input", { type: "text", id: "label-newabout", maxlength: "100", autocomplete: "off", placeholder: "A new description (optional)" });
  const newColor = paletteSelect("label-newcolor", "");
  newColor.prepend(option("", "Keep its colour", true));
  const change = el("button", { type: "button" }, "Change it");
  change.addEventListener("click", () => {
    const u: Record<string, unknown> = { name: which.value };
    if (rename.value.trim()) u.newName = rename.value.trim();
    if (newAbout.value.trim()) u.description = newAbout.value.trim();
    if (newColor.value) u.color = newColor.value;
    void confirmAction(box, declare(env, "issue_labels", { update: [u] }, back));
  });
  const remove = el("button", { type: "button" }, "Delete it");
  remove.addEventListener("click", () => void confirmAction(box, declare(env, "issue_labels", { delete: [which.value] }, back)));
  forms.append(
    el("section", { class: "pull-form" }, el("h3", {}, "A new label"), el("p", {}, el("label", { for: "label-name" }, "Name "), name), el("p", {}, el("label", { for: "label-about" }, "Description "), about), el("p", {}, el("label", { for: "label-color" }, "Colour "), color), el("p", {}, create)),
  );
  if (labels.length) {
    forms.append(el("section", { class: "pull-form" }, el("h3", {}, "Change a label"), el("p", {}, el("label", { for: "label-which" }, "The label "), which), el("p", {}, rename), el("p", {}, newAbout), el("p", {}, el("label", { for: "label-newcolor" }, "Colour "), newColor), el("p", {}, change, " ", remove, el("span", { class: "explain" }, " (deleting takes it off every issue and pull request)"))));
  }
  if (missing.length) {
    const add = el("button", { type: "button" }, `Add the ${missing.length === 1 ? "default label" : `${missing.length} default labels`} it lacks`);
    add.addEventListener("click", () => void confirmAction(box, declare(env, "issue_labels", { create: missing.map((l) => ({ name: l.name, color: hexOf(paletteOf(l.color)), description: l.description })) }, back)));
    forms.append(el("p", {}, add, el("span", { class: "explain" }, ` GitHub's defaults and the research ones: ${missing.map((l) => l.name).join(", ")}.`)));
  }
}

// ─── milestones ──────────────────────────────────────────────────────────────

async function mountMilestones(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const state = new URLSearchParams(env.search).get("state") === "closed" ? "closed" : "open";
  show(slot, h("p", { "aria-live": "polite" }, "Reading the milestones…"));
  let list: T.Milestone[];
  try {
    list = (await env.session.issues.milestones(repoRef(env), state, { perPage: 100 })).items;
  } catch (e) {
    failed(slot, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/milestones`, "milestones");
    return;
  }
  const signedIn = signedInHint();
  show(
    slot,
    h("div", { class: "code-head" }, h("h2", null, "Milestones"), h("p", { class: "file-actions" }, state === "open" ? h("strong", null, "Open") : h("a", { href: milestonesPath(env.repo) }, "Open"), " · ", state === "closed" ? h("strong", null, "Closed") : h("a", { href: `${milestonesPath(env.repo)}?state=closed` }, "Closed"), " · ", h("a", { href: issuesPath(env.repo) }, "Issues"))),
    list.length
      ? h("ul", { class: "milestone-list" }, ...list.map((m) => h("li", null, h("p", { class: "title" }, h("a", { href: milestonePath(env.repo, m.number) }, m.title)), h("p", { class: "line" }, milestoneInWords(m)), m.description ? h("p", { class: "line" }, m.description.slice(0, 300)) : null)))
      : h("p", null, state === "open" ? "No open milestone. A milestone gathers the issues of a version of the paper, a revision, a release." : "No closed milestone."),
    signedIn ? h("div", { id: "milestone-form" }) : null,
    h("div", { id: "milestone-act", "aria-live": "polite" }),
  );
  const form = slot.querySelector<HTMLElement>("#milestone-form");
  const box = slot.querySelector<HTMLElement>("#milestone-act");
  if (!form || !box) return;
  const title = el("input", { type: "text", id: "ms-title", maxlength: "256", autocomplete: "off" });
  const due = el("input", { type: "text", id: "ms-due", autocomplete: "off", placeholder: "2026-12-01 (optional)" });
  const about = el("textarea", { id: "ms-about", rows: "3" });
  const create = el("button", { type: "button" }, "Create the milestone");
  create.addEventListener("click", () => {
    const payload: Record<string, unknown> = { title: title.value };
    if (due.value.trim()) payload.dueOn = due.value.trim();
    if (about.value.trim()) payload.description = about.value;
    void confirmAction(box, declare(env, "issue_milestone", payload, milestonesPath(env.repo)));
  });
  form.append(el("section", { class: "pull-form" }, el("h3", {}, "A new milestone"), el("p", {}, el("label", { for: "ms-title" }, "Title "), title), el("p", {}, el("label", { for: "ms-due" }, "Due on "), due), el("p", {}, el("label", { for: "ms-about" }, "Description"), el("br"), about), el("p", {}, create)));
}

async function mountMilestone(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const n = Number(env.target.rest?.[0]);
  if (!Number.isInteger(n) || n < 1) {
    show(slot, h("p", { class: "warning" }, "This address names no milestone: it reads milestone/<number>, as on GitHub."));
    return;
  }
  show(slot, h("p", { "aria-live": "polite" }, "Reading the milestone…"));
  let m: T.Milestone | undefined;
  let issues: IssueItem[];
  try {
    m = (await milestoneTitles(env)).find((x) => x.number === n);
    issues = (await env.session.issues.list(repoRef(env), { milestone: n, state: "all", sort: "created", direction: "asc" }, { perPage: LIST_PAGE })).items.map(fromGithub);
  } catch (e) {
    failed(slot, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/milestone/${n}`, "milestone");
    return;
  }
  if (!m) {
    show(slot, h("p", { class: "warning" }, `The repository has no milestone #${n} (deleted, or never there).`), h("p", null, h("a", { href: milestonesPath(env.repo) }, "The milestones")));
    return;
  }
  const { colors } = await labelColors(env);
  const signedIn = signedInHint();
  show(
    slot,
    h("div", { class: "code-head" }, h("h2", null, m.title), h("p", { class: "file-actions" }, h("a", { href: milestonesPath(env.repo) }, "Milestones"), " · ", h("a", { href: newIssuePath(env.repo, { milestone: String(n) }) }, "New issue in this milestone"))),
    h("p", { class: "status-line" }, milestoneInWords(m)),
    m.description ? h("p", null, m.description) : null,
    issues.length ? h("ul", { class: "issue-list" }, ...issues.map((i) => issueRow(env.repo, i, { colors, milestones: new Map([[n, m!.title]]) }))) : h("p", null, "No issue in it yet."),
    signedIn
      ? h(
          "p",
          { class: "pull-bulk" },
          m.state === "open" ? h("button", { type: "button", "data-ms": "closed" }, "Close the milestone") : h("button", { type: "button", "data-ms": "open" }, "Reopen the milestone"),
          " ",
          h("button", { type: "button", "data-ms": "delete" }, "Delete it"),
        )
      : null,
    h("div", { id: "milestone-act", "aria-live": "polite" }),
  );
  const box = slot.querySelector<HTMLElement>("#milestone-act");
  slot.querySelectorAll<HTMLButtonElement>("button[data-ms]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!box) return;
      const payload = b.dataset.ms === "delete" ? { number: n, delete: true } : { number: n, state: b.dataset.ms };
      void confirmAction(box, declare(env, "issue_milestone", payload, b.dataset.ms === "delete" ? milestonesPath(env.repo) : milestonePath(env.repo, n)));
    }),
  );
}

codeViews.labels = mountLabels;
codeViews.milestones = mountMilestones;
codeViews.milestone = mountMilestone;

/** A label, for the other pages (repo-issue.ts). */
export const labelView = labelEl;
export { DEFAULT_LABELS, dayOf };
