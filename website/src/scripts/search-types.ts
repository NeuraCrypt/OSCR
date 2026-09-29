// The search page's types (night phase 08, E4; src/lib/search-types.ts, docs/SOCIAL.md "Search"): the
// tabs Papers (the Phase 3 search, components/Search.svelte, untouched), Repositories, Issues, People,
// Topics (the registry's own index: GET /api/search?type=…, one request when the form is submitted or
// the address asks, never as one types, D3), Commits and GitHub's issues of one repository (GitHub's
// search API in the reader's browser, on the reader's own quota, shown here with links into the
// registry's own pages), Code (at the source: GitHub's code search needs a GitHub sign-in). A DOI typed
// alone goes to its paper. Like every browser script, it never names the platform.

import { githubEndpoints, h, type El } from "../lib/repo-view.ts";
import {
  countWords,
  doiAlone,
  githubCodeSearch,
  githubCommitsApi,
  githubIssuesApi,
  INDEXED,
  lookupUrl,
  parseCommitHits,
  parseIssueHits,
  readType,
  resultView,
  scopeOf,
  SEARCH_TYPES,
  TYPE_WORDS,
  type Scope,
  type SearchType,
} from "../lib/search-types.ts";
import { show } from "./dom.ts";

const root = document.getElementById("search-types");
const papers = document.getElementById("paper-search");
const params = new URLSearchParams(location.search);
const type = readType(params.get("type"));
const q = (params.get("q") ?? "").trim();
const api = githubEndpoints({ api: root?.dataset.githubApi ?? null }).api;

const MESSAGES: Record<string, string> = {
  quota: "The search has used its daily quota. Please try again tomorrow; meanwhile, Browse and the DOI lookup are static and always work.",
  not_configured: "The search is not set up yet. Browse and the DOI lookup are static and always work.",
  unavailable: "The search is unavailable at the moment. Please try again later.",
};

const ONE: Record<SearchType, string> = { papers: "paper", repositories: "repository", issues: "research issue", people: "person", topics: "topic", commits: "commit", code: "file" };

const pageOf = (t: SearchType, query: string, page = 1): string => {
  const p = new URLSearchParams();
  if (t !== "papers") p.set("type", t);
  if (query) p.set("q", query);
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return s ? `/search/?${s}` : "/search/";
};

function tabs(counts: Partial<Record<SearchType, string>> = {}): El {
  return h(
    "nav",
    { class: "tabs", "aria-label": "What to search" },
    h(
      "ul",
      null,
      SEARCH_TYPES.map((t) => h("li", null, h("a", { href: pageOf(t, q), "aria-current": t === type ? "page" : null }, TYPE_WORDS[t], counts[t] ? ` ${counts[t]}` : ""))),
    ),
  );
}

function form(): El {
  return h(
    "form",
    { action: "/search/", method: "get", role: "search", class: "search-form" },
    h("input", { type: "hidden", name: "type", value: type }),
    h("p", { class: "line" }, h("label", { for: "types-q" }, `Search ${TYPE_WORDS[type].toLowerCase()}`), " ", h("input", { id: "types-q", type: "search", name: "q", value: q, size: "40" }), " ", h("button", { type: "submit" }, "Search")),
    h(
      "p",
      { class: "explain" },
      type === "issues"
        ? "Words, \"a phrase\", -excluded, is:open or is:closed, type:code-error, type:mismatch or type:reproduction, doi:10.…, in:title; repo:owner/name also searches GitHub's own issues of that repository."
        : type === "repositories"
          ? "Words, \"a phrase\", -excluded, user:<login> or org:<login> (the owner), doi:10.… (a paper the code goes with)."
          : type === "commits"
            ? "Words, and repo:owner/name: GitHub's commits are searched one repository at a time."
            : type === "code"
              ? "Words, and repo:owner/name to search one repository's code."
            : "Words, \"a phrase\", -excluded.",
    ),
  );
}

async function indexed(box: HTMLElement, counts: (c: Partial<Record<SearchType, string>>) => void): Promise<void> {
  const page = Number(params.get("page") ?? "1") || 1;
  show(box, h("p", { class: "summary", "aria-live": "polite" }, "Searching…"));
  let body: Record<string, unknown> | null = null;
  let status = 0;
  try {
    const res = await fetch(`/api/search?${new URLSearchParams({ type, q, ...(page > 1 ? { page: String(page) } : {}) })}`, { headers: { Accept: "application/json" } });
    status = res.status;
    body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    body = null;
  }
  const error = (body?.error ?? null) as { code?: string; message?: string } | null;
  if (!body || error || status >= 400) {
    const code = error?.code ?? (status === 429 ? "quota" : "unavailable");
    show(box, h("p", { class: "warning" }, error?.message || MESSAGES[code] || MESSAGES.unavailable));
    return;
  }
  const c = (body.counts ?? {}) as Partial<Record<SearchType, number>>;
  const capped = (body.capped ?? {}) as Partial<Record<SearchType, boolean>>;
  counts(Object.fromEntries(INDEXED.map((t) => [t, countWords(c[t], capped[t])])));
  const results = (Array.isArray(body.results) ? body.results : []).map((r) => resultView(r as Record<string, unknown>)).filter((x): x is El => !!x);
  const total = c[type] ?? 0;
  const notices = Array.isArray(body.notices) ? (body.notices as string[]) : [];
  show(
    box,
    h("p", { class: "summary", "aria-live": "polite" }, total ? `${countWords(total, capped[type])} ${total === 1 && !capped[type] ? ONE[type] : TYPE_WORDS[type].toLowerCase()} found, as of the index's last push (each night).` : `No ${TYPE_WORDS[type].toLowerCase()} found.`),
    ...notices.map((n) => h("p", { class: "explain" }, n)),
    results.length ? h("ol", { class: "results", start: String((page - 1) * 20 + 1) }, results) : null,
    h("p", null, page > 1 ? h("a", { href: pageOf(type, q, page - 1) }, "Previous page") : null, page > 1 && results.length === 20 ? " · " : "", results.length === 20 ? h("a", { href: pageOf(type, q, page + 1) }, "Next page") : null),
  );
}

async function fromGithub(box: HTMLElement, kind: "issues" | "commits", scope: Scope, rest: string): Promise<void> {
  const url = kind === "issues" ? githubIssuesApi(rest, scope, api) : githubCommitsApi(rest, scope, api);
  show(box, h("p", { class: "summary", "aria-live": "polite" }, `Asking GitHub, on your own quota, for the ${kind} of ${scope.owner}/${scope.name}…`));
  try {
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", referrerPolicy: "no-referrer" });
    if (res.status === 403 || res.status === 429) {
      show(box, h("p", { class: "warning" }, "GitHub's search allows 10 searches a minute to a reader who is not signed in to GitHub: please wait a minute, then search again."));
      return;
    }
    if (!res.ok) {
      show(box, h("p", { class: "warning" }, res.status === 422 ? `GitHub does not know the repository ${scope.owner}/${scope.name}, or it is not public.` : "GitHub did not answer the search: please try again later."));
      return;
    }
    const body = (await res.json()) as unknown;
    if (kind === "issues") {
      const hits = parseIssueHits(body, scope);
      show(
        box,
        h("p", { class: "summary" }, `${hits.length ? hits.length : "No"} GitHub ${hits.length === 1 ? "issue or pull request" : "issues and pull requests"} of ${scope.owner}/${scope.name} match, as GitHub answered you now.`),
        hits.length ? h("ol", { class: "results" }, hits.map((x) => h("li", null, h("a", { href: x.url }, x.title), ` ${x.pull ? "pull request" : "issue"} #${x.number} · `, h("span", { class: x.state === "open" ? "ok" : "" }, x.state), x.comments ? ` · ${x.comments} comments` : ""))) : null,
      );
    } else {
      const hits = parseCommitHits(body, scope);
      show(
        box,
        h("p", { class: "summary" }, `${hits.length ? hits.length : "No"} ${hits.length === 1 ? "commit" : "commits"} of ${scope.owner}/${scope.name} match, as GitHub answered you now.`),
        hits.length ? h("ol", { class: "results" }, hits.map((x) => h("li", null, h("a", { href: x.url }, x.message || x.sha.slice(0, 7)), ` ${x.sha.slice(0, 7)}${x.date ? ` · ${x.date}` : ""}`))) : null,
      );
    }
  } catch {
    show(box, h("p", { class: "warning" }, "GitHub could not be reached from your browser: check the connection, then try again."));
  }
}

function start(): void {
  if (!root) return;
  // A DOI typed alone goes to its paper.
  const doi = q ? doiAlone(q) : null;
  if (doi && !params.has("page")) {
    location.replace(lookupUrl(doi));
    return;
  }
  const nav = document.createElement("div");
  const counts: Partial<Record<SearchType, string>> = {};
  const drawTabs = () => show(nav, tabs(counts));
  drawTabs();
  root.prepend(nav);
  if (type === "papers") return;
  if (papers) papers.hidden = true;
  const body = document.createElement("div");
  const results = document.createElement("div");
  const github = document.createElement("div");
  root.append(body, results, github);
  show(body, form());
  const { scope, rest } = scopeOf(q);
  if (INDEXED.includes(type) && q) {
    void indexed(results, (c) => {
      Object.assign(counts, c);
      drawTabs();
    });
  } else if (INDEXED.includes(type)) {
    show(results, h("p", { class: "summary" }, "Type words, then Search: the registry searches only when you ask."));
  }
  if (type === "issues") {
    if (scope) {
      const button = h("button", { type: "button", id: "types-github" }, `Search GitHub's issues of ${scope.owner}/${scope.name}`);
      show(github, h("h2", null, "GitHub's own issues"), h("p", null, "The registry's research issues are listed above. GitHub's own issues and pull requests are asked of GitHub by your browser, on your own quota, when you ask: "), button);
      document.getElementById("types-github")?.addEventListener("click", () => void fromGithub(github, "issues", scope, rest));
    } else {
      show(github, h("p", { class: "explain" }, "GitHub's own issues are searched one repository at a time: add repo:owner/name to the query. GitHub's search holds five operators at most, so it cannot be asked about every repository the registry knows at once."));
    }
  }
  if (type === "commits") {
    if (scope && q) void fromGithub(results, "commits", scope, rest);
    else show(results, h("p", { class: "explain" }, "Commits are GitHub's: they are searched one repository at a time, by your browser, on your own quota. Add repo:owner/name to the query."));
  }
  if (type === "code") {
    show(
      results,
      h("p", null, "The registry's own index of the scripts it keeps (their licence allows it) is not built yet. GitHub's code search needs a GitHub sign-in (GitHub's rule), so the search is carried there:"),
      q ? h("p", { class: "at-source" }, h("a", { href: githubCodeSearch(rest, scope) }, "Search this code at the source, on GitHub")) : h("p", { class: "summary" }, "Type words first."),
    );
  }
}

start();
