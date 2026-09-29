// Pull requests in the /r/ shell (night phase 04, E3; docs/PULL_REQUESTS.md): the list
// (pulls/?q=…), the creation form under a comparison (compare/<base>...<head>?expand=1, and GitHub's
// pull/new/<branch>), and the dispatcher of pull/<n>[/tab], whose tabs the other elements register
// (`pullTabs`: repo-pull.ts, repo-pull-files.ts, repo-conflicts.ts).
//
// Read in the reader's browser, on the reader's own GitHub quota (D00-5): the list is 1 request (100
// pull requests), GitHub's search 1 (10 a minute) when the query needs what only it knows (reviews,
// comments); the creation form reads the default branch's tree (cached for the tab), the templates
// and CODEOWNERS raw (not counted), and asks whether a pull request is already open (1). Signed out,
// the Worker is asked nothing. Every write is one authorized action (act-pulls.ts): open a pull
// request, close or reopen the chosen ones (one authorization for them all).
//
// Everything is text nodes; like every browser script, it never names the platform.

import { GitBackendError } from "../../worker/forge/errors.ts";
import { codeownersPath, ownerInWords, parseCodeowners } from "../lib/codeowners.ts";
import { repoPath } from "../lib/forge.ts";
import { detectLanguage } from "../lib/highlight.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { closingNotice, declarePull, pullRow, searchRow } from "../lib/pull-view.ts";
import {
  chosenTemplate,
  closingRefs,
  DEFAULT_QUERY,
  defaultTitle,
  findTemplates,
  matchPull,
  newPullPath,
  parsePullQuery,
  parsePullTarget,
  planQuery,
  prefillOf,
  type PullTab,
  pullPath,
  pullsPath,
  researchTemplate,
  searchQuery,
  changeSummary,
  suggestReviewers,
  summaryInWords,
} from "../lib/pulls.ts";
import { type El, h } from "../lib/repo-view.ts";
import { el } from "./code-editor.ts";
import { show, toDom } from "./dom.ts";
import { confirmAction, signedInHint, signInLine, textAt, whoIsHere } from "./pull-common.ts";
import { type CodeEnv, codeViews, failed, repoRef } from "./repo-code.ts";
import { type CompareContext, compareExtras } from "./repo-history.ts";
import { changeTouches } from "./repo-traced.ts";
import { commitTouches } from "../lib/traced.ts";

/** The tabs of a pull request, by the element that builds each (E4: conversation, commits, checks;
 *  E5: files; E6: conflicts). */
export const pullTabs: Partial<Record<PullTab, (slot: HTMLElement, env: CodeEnv, number: number) => Promise<void>>> = {};

/** Pull requests read for one page of the list (GitHub's largest page). */
export const LIST_PAGE = 100;

const back = (env: CodeEnv) => pullsPath(env.repo);

// ─── pull/<n>: the dispatcher ────────────────────────────────────────────────

codeViews.pull = async (slot, env) => {
  const target = parsePullTarget(env.target.rest ?? []);
  if (!target) {
    show(slot, h("p", { class: "warning" }, "This address names no pull request: it reads pull/<number>, as on GitHub."), h("p", null, h("a", { href: pullsPath(env.repo) }, "The pull requests")));
    return;
  }
  if ("newFrom" in target) {
    // GitHub's "pull/new/<branch>": the comparison with the default branch, its form open.
    location.replace(newPullPath(env.repo, env.info.defaultBranch ?? "main", target.newFrom));
    return;
  }
  const tab = pullTabs[target.tab];
  if (tab) await tab(slot, env, target.number);
  else show(slot, h("p", null, "This part of the pull request's page is not built yet."));
};

// ─── the list ────────────────────────────────────────────────────────────────

const QUICK: [string, string][] = [
  ["Open", DEFAULT_QUERY],
  ["Closed", "is:pr is:closed"],
  ["Merged", "is:pr is:merged"],
  ["Yours", "is:pr is:open author:@me"],
  ["Asked to review", "is:pr is:open review-requested:@me"],
  ["Drafts", "is:pr is:open draft:true"],
];

async function mountPulls(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const params = new URLSearchParams(env.search);
  const q = (params.get("q") ?? DEFAULT_QUERY).slice(0, 500);
  const pageNo = /^[1-9][0-9]{0,2}$/.test(params.get("page") ?? "") ? Number(params.get("page")) : 1;
  const parsed = parsePullQuery(q);
  const plan = planQuery(parsed);
  const signedIn = signedInHint();
  const head: El[] = [
    h("div", { class: "code-head" }, h("h2", null, "Pull requests"), h("p", { class: "file-actions" }, h("a", { href: repoPath(env.repo, "compare") }, "New pull request"), " · ", h("a", { href: repoPath(env.repo, "forks") }, "Forks"))),
    h(
      "form",
      { class: "repo-search pull-filter", role: "search", id: "pull-filter" },
      h("label", { for: "pull-q" }, "Filter "),
      h("input", { type: "search", id: "pull-q", name: "q", value: q, autocomplete: "off", spellcheck: "false", placeholder: DEFAULT_QUERY }),
      " ",
      h("button", { type: "submit" }, "Filter"),
    ),
    h("p", { class: "pull-quick" }, ...QUICK.flatMap(([label, query], i) => [i ? " · " : "", query === q ? h("strong", null, label) : h("a", { href: pullsPath(env.repo, query) }, label)])),
  ];
  if (parsed.errors.length) head.push(h("p", { class: "warning" }, parsed.errors.join(" ")));
  show(slot, ...head, h("p", { "aria-live": "polite" }, "Reading the pull requests…"));

  // @me is the reader's own GitHub login: asked of the Worker only when the query names it.
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
  let rows: El[];
  let next: string | null = null;
  let note = "";
  try {
    if (plan.search) {
      const found = await env.session.issues.search(repoRef(env), searchQuery(qMe), { perPage: 50, cursor: pageNo > 1 ? String(pageNo) : null });
      rows = found.items.filter((i) => i.isPullRequest).map((i) => searchRow(env.repo, i));
      next = found.next;
      note = "Found by GitHub's search (it knows the reviews and comments; its answers may lag a minute behind).";
    } else {
      const list = await env.session.pulls.list(
        repoRef(env),
        { state: plan.state, base: plan.base ?? undefined, head: plan.head && plan.head.includes(":") ? plan.head : undefined, sort: plan.sort, direction: plan.direction },
        { perPage: LIST_PAGE, cursor: pageNo > 1 ? String(pageNo) : null },
      );
      const kept = list.items.filter((p) => matchPull(p, parsed.node, { me }));
      rows = kept.map((p) => pullRow(env.repo, p, signedIn));
      next = list.next;
      if (list.next) note = `Filtered among the ${LIST_PAGE} pull requests GitHub listed on this page; the next page holds older ones.`;
    }
  } catch (e) {
    const box = document.createElement("div");
    show(slot, ...head);
    slot.append(box);
    failed(box, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/pulls`, "pull requests");
    return;
  }
  const here = (n: number) => {
    const p = new URLSearchParams({ q });
    if (n > 1) p.set("page", String(n));
    return `${location.pathname}?${p}`;
  };
  show(
    slot,
    ...head,
    h("p", { class: "status-line" }, rows.length ? `${rows.length} ${rows.length === 1 ? "pull request matches" : "pull requests match"} “${q}”.` : `No pull request matches “${q}”.`, note ? ` ${note}` : ""),
    rows.length ? h("ul", { class: "pull-list", id: "pull-list" }, ...rows) : null,
    signedIn && rows.length && !plan.search
      ? h("p", { class: "pull-bulk" }, "With the chosen ones: ", h("button", { type: "button", id: "bulk-close" }, "Close"), " ", h("button", { type: "button", id: "bulk-reopen" }, "Reopen"), " (one authorization for them all).")
      : null,
    h("div", { id: "pull-act", "aria-live": "polite" }),
    h("p", { class: "pager" }, pageNo > 1 ? h("a", { href: here(pageNo - 1) }, "Newer") : null, pageNo > 1 && next ? " · " : null, next ? h("a", { href: here(pageNo + 1) }, "Older") : null),
  );
  slot.querySelector<HTMLFormElement>("#pull-filter")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = slot.querySelector<HTMLInputElement>("#pull-q")?.value.trim() || DEFAULT_QUERY;
    location.assign(pullsPath(env.repo, v));
  });
  const box = slot.querySelector<HTMLElement>("#pull-act");
  const bulk = (state: "open" | "closed") => {
    if (!box) return;
    const numbers = [...slot.querySelectorAll<HTMLInputElement>("#pull-list input[name=pull]:checked")].map((i) => Number(i.value));
    if (!numbers.length) {
      box.replaceChildren(el("p", { class: "warning" }, "Choose one or more pull requests first (the boxes on the left)."));
      return;
    }
    void confirmAction(box, declarePull({ ...env.repo, id: env.info.key.id }, "pull_edit", numbers.length === 1 ? { number: numbers[0], state } : { numbers, state }, back(env)));
  };
  slot.querySelector("#bulk-close")?.addEventListener("click", () => bulk("closed"));
  slot.querySelector("#bulk-reopen")?.addEventListener("click", () => bulk("open"));
}

codeViews.pulls = mountPulls;

// ─── the creation form, under a comparison ───────────────────────────────────

/** Whether a comparison's sides can make a pull request: branches (a fork's "owner:branch" on the
 *  head), no commit id, no ~ or ^. */
function pullSides(c: CompareContext, owner: string): { base: string; head: string; fork: boolean } | string {
  const { base, head } = c.spec;
  if (c.spec.dots !== 3) return "A pull request compares from the common ancestor (three dots).";
  if (base.owner || base.ancestry.length || /^[0-9a-f]{40}$/.test(base.ref)) return "A pull request goes into a branch of this repository.";
  if (head.ancestry.length || /^[0-9a-f]{40}$/.test(head.ref)) return "A pull request comes from a branch (of this repository, or owner:branch of a fork).";
  const fork = !!head.owner && head.owner.toLowerCase() !== owner.toLowerCase();
  return { base: base.ref, head: head.owner ? `${head.owner}:${head.ref}` : head.ref, fork };
}

async function mountCreate(into: HTMLElement, env: CodeEnv, c: CompareContext): Promise<void> {
  const sides = pullSides(c, env.repo.owner);
  if (typeof sides === "string") return;
  if (c.cmp.aheadBy === 0) {
    show(into, h("p", null, `There is nothing to open a pull request for: ${sides.head} has no commit that ${sides.base} lacks.`));
    return;
  }
  const ref = repoRef(env);
  // One open already? (1 request.)
  try {
    const headFilter = sides.head.includes(":") ? sides.head : `${env.repo.owner}:${sides.head}`;
    const open = await env.session.pulls.list(ref, { state: "open", head: headFilter, base: sides.base }, { perPage: 1 });
    if (open.items[0]) {
      show(into, h("p", { class: "status-line" }, "A pull request is already open for these branches: ", h("a", { href: pullPath(env.repo, open.items[0].number) }, `#${open.items[0].number} ${open.items[0].title}`), "."));
      return;
    }
  } catch {
    // said by the form's own reads, or by GitHub at the creation
  }
  const prefill = prefillOf(env.search);
  const expand = h("p", null, h("button", { type: "button", class: "primary", id: "pull-open" }, "Create a pull request"), ` from ${sides.head} into ${sides.base}: its author, reviewers and conversation stay in the registry.`);
  show(into, expand);
  const open = () => void buildForm(into, env, c, sides, prefill);
  if (prefill.expand) open();
  else into.querySelector("#pull-open")?.addEventListener("click", open);
}

async function buildForm(into: HTMLElement, env: CodeEnv, c: CompareContext, sides: { base: string; head: string; fork: boolean }, prefill: ReturnType<typeof prefillOf>): Promise<void> {
  const ref = repoRef(env);
  const def = env.info.defaultBranch;
  show(into, h("p", { "aria-live": "polite" }, "Reading the templates…"));
  // Templates and CODEOWNERS come from the default branch, as on GitHub (the tree is kept for the tab).
  let paths: string[] = [];
  let defHead: string | null = null;
  if (def) {
    try {
      defHead = await env.session.git.resolve(ref, def);
      paths = (await env.session.git.tree(ref, defHead, { recursive: true })).entries.filter((e) => e.type === "blob").map((e) => e.path);
    } catch {
      paths = [];
    }
  }
  const templates = findTemplates(paths);
  const chosen = chosenTemplate(templates.several, prefill.template) ?? templates.single;
  let body = prefill.body ?? (chosen && defHead ? ((await textAt(env, defHead, chosen, 64 * 1024)) ?? "") : "");
  const papers = (env.layer?.papers ?? []).map((p) => ({ title: p.title, doi: p.doi }));
  if (!body && papers.length) body = researchTemplate(papers);
  const coPath = codeownersPath(paths);
  const codeowners = coPath && defHead ? parseCodeowners((await textAt(env, defHead, coPath, 3 * 1024 * 1024)) ?? "", coPath) : null;
  const changed = c.cmp.files.items.map((f) => f.path);

  const title = el("input", { type: "text", id: "pr-title", name: "title", maxlength: "256", autocomplete: "off" });
  title.value = prefill.title ?? defaultTitle(sides.head, c.cmp.commits);
  const text = el("textarea", { id: "pr-body", name: "body", rows: "12", spellcheck: "true" });
  text.value = body;
  const preview = el("div", { class: "pull-preview", hidden: "" });
  const draft = el("input", { type: "checkbox", id: "pr-draft", name: "draft" });
  draft.checked = prefill.draft;
  const edits = el("input", { type: "checkbox", id: "pr-edits", name: "edits" });
  edits.checked = true;
  const reviewers = el("input", { type: "text", id: "pr-reviewers", name: "reviewers", autocomplete: "off", spellcheck: "false", placeholder: "GitHub logins, separated by commas" });
  reviewers.value = prefill.reviewers.join(", ");
  const closing = el("div", { "aria-live": "polite" });
  const said = el("div", { "aria-live": "polite" });
  const traced = el("div");
  const templatePick = el("select", { id: "pr-template", name: "template" });
  const options: [string, string][] = [["", "Keep this text"], ...templates.several.map((p): [string, string] => [p, `Template: ${p.split("/").pop()}`]), ["research", "The research template"]];
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    templatePick.append(o);
  }
  const summary = summaryInWords(changeSummary(c.cmp.files.items, (p) => detectLanguage(p)));
  const suggested = suggestReviewers({ codeowners, paths: changed, authors: [], author: null, requested: [] });

  const refresh = () => {
    const refs = closingRefs([title.value, text.value, ...c.cmp.commits.map((x) => x.message)], env.repo, env.endpoints.web);
    const note = closingNotice(refs, def !== null && sides.base === def, sides.base, env.repo);
    closing.replaceChildren(...(note ? [toDom(note)] : []));
  };
  title.addEventListener("input", refresh);
  text.addEventListener("input", refresh);
  refresh();

  const previewButton = el("button", { type: "button" }, "Preview");
  previewButton.addEventListener("click", async () => {
    if (!preview.hidden) {
      preview.hidden = true;
      previewButton.textContent = "Preview";
      return;
    }
    const r = await renderMarkdown(text.value, { repo: env.repo });
    preview.replaceChildren(toDom(r.el));
    preview.hidden = false;
    previewButton.textContent = "Back to the text";
  });
  templatePick.addEventListener("change", async () => {
    const v = templatePick.value;
    if (!v) return;
    const next = v === "research" ? researchTemplate(papers) : defHead ? await textAt(env, defHead, v, 64 * 1024) : null;
    if (next !== null && (!text.value.trim() || text.value === body || confirm("Replace the description with the template?"))) {
      text.value = next;
      body = next;
      refresh();
    }
  });

  const submit = (asDraft: boolean) => {
    const logins = reviewers.value.split(/[\s,]+/).map((s) => s.replace(/^@/, "")).filter(Boolean);
    const payload: Record<string, unknown> = { base: sides.base, head: sides.head, title: title.value, body: text.value, draft: asDraft || draft.checked };
    if (sides.fork) payload.maintainerCanModify = edits.checked;
    if (logins.length) payload.reviewers = logins;
    void confirmAction(said, declarePull({ ...env.repo, id: env.info.key.id }, "pull_open", payload, back(env), { branch: sides.base }));
  };
  const create = el("button", { type: "button", class: "primary", id: "pr-create" }, "Create pull request");
  create.addEventListener("click", () => submit(false));
  const createDraft = el("button", { type: "button", id: "pr-create-draft" }, "Create a draft");
  createDraft.addEventListener("click", () => submit(true));

  const form = el(
    "section",
    { class: "pull-form", "aria-label": "Open a pull request" },
    el("h2", {}, `Open a pull request: ${sides.head} → ${sides.base}`),
    el("p", {}, el("label", { for: "pr-title" }, "Title"), el("br"), title),
    el("p", { class: "pull-form-tools" }, el("label", { for: "pr-template" }, "Description "), templatePick, " ", previewButton),
    text,
    preview,
    closing,
    el("p", { class: "explain" }, "Closing keywords (“Fixes #12”) close those issues when it merges into the default branch. Markdown and math are shown as in the registry's viewer."),
    el("fieldset", { class: "choices" }, el("legend", {}, "Options"),
      el("p", {}, draft, " ", el("label", { for: "pr-draft" }, "A draft: not ready for review, nobody can merge it yet")),
      sides.fork ? el("p", {}, edits, " ", el("label", { for: "pr-edits" }, "Allow edits by the repository's maintainers (they may push to your fork's branch: applying suggestions, resolving conflicts)")) : null,
    ),
    el("p", {}, el("label", { for: "pr-reviewers" }, "Reviewers "), reviewers),
    suggested.length
      ? el("ul", { class: "pull-suggested" }, ...suggested.map((s) =>
          s.login
            ? el("li", {}, el("button", { type: "button", class: "link", "data-login": s.login }, `Ask ${s.login}`), `: ${s.reasons.join("; ")}`)
            : el("li", {}, `${s.owner ? ownerInWords(s.owner) : "An owner"}: ${s.reasons.join("; ")} (the registry asks people, not teams or addresses)`),
        ))
      : null,
    el("div", { class: "pull-summary" }, el("p", { class: "traced-title" }, "The change, in numbers"), ...summary.map((s) => el("p", {}, s))),
    traced,
    el("p", {}, create, " ", createDraft),
    said,
  );
  into.replaceChildren(form);
  form.querySelectorAll<HTMLButtonElement>("button[data-login]").forEach((b) =>
    b.addEventListener("click", () => {
      const login = b.dataset.login ?? "";
      const have = reviewers.value.split(/[\s,]+/).filter(Boolean);
      if (!have.some((x) => x.toLowerCase() === login.toLowerCase())) reviewers.value = [...have, login].join(", ");
    }),
  );
  if (!prefill.title) title.focus();
  // The tracing-map links the change touches (the maps' shard: a file of this site).
  try {
    const touched = await changeTouches(env, c.cmp.files.items, c.cmp.mergeBase);
    const note = commitTouches(touched, { subject: "This pull request", verb: "changes" });
    if (note) traced.replaceChildren(toDom(note));
  } catch {
    // a nicety
  }
}

compareExtras.push(mountCreate);

// ─── what the other pages need ───────────────────────────────────────────────

/** A GitHub failure said in the slot, with the pull request's page at the source (the last resort). */
export function pullFailed(slot: HTMLElement, env: CodeEnv, e: unknown, number: number | null): void {
  const source = `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/${number ? `pull/${number}` : "pulls"}`;
  failed(slot, e instanceof GitBackendError ? e : new GitBackendError("unavailable", "GitHub did not answer"), source, "pull request");
}
