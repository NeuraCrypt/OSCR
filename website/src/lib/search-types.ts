// One search across the registry (night phase 08, E4): the search page's types beside the papers, pure
// (the page: src/scripts/search-types.ts; the Worker: worker/forge-search.ts). See docs/SOCIAL.md
// "Search".
//
// - Papers stay the first type and the default (the Phase 3 search, components/Search.svelte).
// - Repositories, issues (the registry's research issues), people, topics: the registry's own index
//   (GET /api/search?type=…), one request when the form is submitted, never as one types (D3).
// - GitHub's issues and commits of ONE repository (the query names it: repo:owner/name): GitHub's
//   search API in the reader's browser, on the reader's own quota (10 searches a minute), shown in the
//   registry with links into its own pages. Across every repository the registry knows GitHub cannot
//   be asked (a query holds 5 operators at most), so the page says so.
// - Code: GitHub's code search needs a GitHub sign-in (GitHub's rule), so the page carries the query
//   there, "at the source", with the reason; the registry's own code index is deferred (D08-n).
// - A DOI typed alone goes to its paper (the DOI lookup finds the paper's page).

import { h, type El } from "./repo-view.ts";

export const SEARCH_TYPES = ["papers", "repositories", "issues", "people", "topics", "commits", "code"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export const TYPE_WORDS: Readonly<Record<SearchType, string>> = {
  papers: "Papers",
  repositories: "Repositories",
  issues: "Issues",
  people: "People",
  topics: "Topics",
  commits: "Commits",
  code: "Code",
};
/** The types the registry's own index answers. */
export const INDEXED: readonly SearchType[] = ["repositories", "issues", "people", "topics"];

export const readType = (value: string | null): SearchType => ((SEARCH_TYPES as readonly string[]).includes(value ?? "") ? (value as SearchType) : "papers");

const DOI = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i;

/** A DOI typed alone (as a DOI, "doi:…" or its doi.org address), else null. */
export function doiAlone(q: string): string | null {
  const m = DOI.exec(q.trim());
  return m ? m[1].replace(/[.,;]+$/, "") : null;
}

/** The DOI lookup's address for a DOI: it finds the paper's page, or says the registry has none. */
export const lookupUrl = (doi: string): string => `/lookup/?doi=${encodeURIComponent(doi)}`;

export interface Scope {
  owner: string;
  name: string;
}

const REPO_QUAL = /(?:^|\s)repo:([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?=\s|$)/;

/** The repository a query names (repo:owner/name), and the query without it. */
export function scopeOf(q: string): { scope: Scope | null; rest: string } {
  const m = REPO_QUAL.exec(q);
  if (!m || /^\.+$/.test(m[2])) return { scope: null, rest: q.trim() };
  return { scope: { owner: m[1], name: m[2] }, rest: q.replace(m[0], " ").replace(/\s+/g, " ").trim() };
}

/** GitHub's search API for the issues and pull requests of one repository (the reader's quota). */
export function githubIssuesApi(rest: string, scope: Scope, api = "https://api.github.com"): string {
  return `${api}/search/issues?q=${encodeURIComponent(`${rest} repo:${scope.owner}/${scope.name}`.trim())}&per_page=20`;
}

/** GitHub's search API for the commits of one repository (the reader's quota). */
export function githubCommitsApi(rest: string, scope: Scope, api = "https://api.github.com"): string {
  return `${api}/search/commits?q=${encodeURIComponent(`${rest} repo:${scope.owner}/${scope.name}`.trim())}&per_page=20`;
}

/** GitHub's own code search, the query carried over: at the source (it needs a GitHub sign-in). */
export function githubCodeSearch(rest: string, scope: Scope | null): string {
  const q = scope ? `${rest} repo:${scope.owner}/${scope.name}` : rest;
  return `https://github.com/search?type=code&q=${encodeURIComponent(q.trim())}`;
}

export interface GithubIssueHit {
  number: number;
  title: string;
  state: string;
  pull: boolean;
  comments: number;
  url: string;
}

/** GitHub's issue search answer, as the registry shows it: its own pages for each issue. */
export function parseIssueHits(body: unknown, scope: Scope): GithubIssueHit[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const base = `/r/${scope.owner.toLowerCase()}/${scope.name.toLowerCase()}/`;
  return items.flatMap((x) => {
    const i = x as Record<string, unknown>;
    if (typeof i.number !== "number" || typeof i.title !== "string") return [];
    const pull = !!i.pull_request;
    return [{ number: i.number, title: i.title, state: String(i.state ?? ""), pull, comments: Number(i.comments ?? 0), url: `${base}${pull ? "pull" : "issues"}/${i.number}` }];
  });
}

export interface GithubCommitHit {
  sha: string;
  message: string;
  date: string;
  url: string;
}

export function parseCommitHits(body: unknown, scope: Scope): GithubCommitHit[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const base = `/r/${scope.owner.toLowerCase()}/${scope.name.toLowerCase()}/`;
  return items.flatMap((x) => {
    const c = x as { sha?: unknown; commit?: { message?: unknown; committer?: { date?: unknown } } };
    if (typeof c.sha !== "string" || !/^[0-9a-f]{40}$/.test(c.sha)) return [];
    const message = String(c.commit?.message ?? "").split("\n")[0].slice(0, 200);
    return [{ sha: c.sha, message, date: String(c.commit?.committer?.date ?? "").slice(0, 10), url: `${base}commit/${c.sha}/` }];
  });
}

/** One result of the registry's index, as the page shows it. Only addresses of this site. */
export function resultView(r: Record<string, unknown>): El | null {
  const url = typeof r.url === "string" && r.url.startsWith("/") && !r.url.startsWith("//") ? r.url : null;
  if (!url) return null;
  const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
  switch (r.k) {
    case "repository": {
      const papers = Array.isArray(r.papers) ? (r.papers as { doi?: string; title?: string }[]) : [];
      return h("li", null, h("a", { href: url }, String(r.path ?? "")), n(r.stars) ? ` · ${n(r.stars)} ${n(r.stars) === 1 ? "star" : "stars"}` : "",
        papers.length ? h("p", { class: "line" }, h("span", { class: "label" }, "Code of "), papers.flatMap((p, i) => [i ? "; " : "", p.title || p.doi || ""])) : null);
    }
    case "issue":
      return h("li", null, h("a", { href: url }, String(r.title ?? "")), ` research#${String(r.n ?? "")} · `,
        h("span", { class: r.state === "open" ? "ok" : "" }, r.state === "open" ? "open" : "closed"),
        r.paper ? ` · the paper ${String(r.paper)}` : "", r.repo ? ` · ${String(r.repo)}` : "");
    case "person":
      return h("li", null, h("a", { href: url }, String(r.name || r.handle || "")), r.name ? ` ${String(r.handle ?? "")}` : "",
        r.bio ? h("p", { class: "line" }, String(r.bio)) : null);
    case "topic":
      return h("li", null, h("a", { href: url }, String(r.name ?? "")), r.featured ? " · featured" : "", n(r.stars) ? ` · ${n(r.stars)} stars` : "",
        r.description ? h("p", { class: "line" }, String(r.description)) : null);
    default:
      return null;
  }
}

/** A count in words for a tab ("3", "1,000+"). */
export const countWords = (n: number | undefined, capped: boolean | undefined): string =>
  n === undefined ? "" : `${n.toLocaleString("en-GB")}${capped ? "+" : ""}`;
