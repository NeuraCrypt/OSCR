// A repository's documentation read as pages (night phase 02, E5): GitHub Pages adapted. The
// Markdown under docs/ (or at the root when there is no docs/) is rendered with the one renderer
// and science.css, with a list of the pages beside it; no author HTML, CSS or JavaScript ever runs
// (a Pages site built by Jekyll or a workflow stays at its own address, linked by the home's
// sidebar). Pure, no DOM, testable in Node (tests/forge-pages/docs.test.ts).

import { refSegments } from "./code-nav.ts";
import { repoPath, type RepoCoords } from "./forge.ts";
import { isMarkdownPath, joinPath, type MarkdownContext, type RepoLinkContext, repoResolvers, slugOf, USER_CONTENT } from "./markdown.ts";
import { type El, h } from "./repo-view.ts";

/** The pages the view lists at most. */
export const DOCS_PAGES = 500;

type Entry = { path: string; type: string };

const mdUnder = (entries: readonly Entry[], root: string): string[] =>
  entries.filter((e) => e.type === "blob" && isMarkdownPath(e.path) && (root === "" || e.path.startsWith(`${root}/`))).map((e) => e.path);

/** Where the documentation is: "docs" when docs/ holds Markdown, "" (the root) when the root does,
 *  null when the repository has none. */
export function docsRoot(entries: readonly Entry[]): string | null {
  if (mdUnder(entries, "docs").length) return "docs";
  return entries.some((e) => e.type === "blob" && isMarkdownPath(e.path) && !e.path.includes("/")) ? "" : null;
}

/** The pages of the documentation: its Markdown files, the index first in each directory. */
export function docsPages(entries: readonly Entry[], root: string): string[] {
  const rank = (p: string) => (/(?:^|\/)index\.md$/i.test(p) ? 0 : /(?:^|\/)readme\.md$/i.test(p) ? 1 : 2);
  const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  return mdUnder(entries, root)
    .sort((a, b) => dir(a).localeCompare(dir(b)) || rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, DOCS_PAGES);
}

/** The page a directory of the documentation opens on: its index, its README, or its first page. */
export function defaultPage(pages: readonly string[], dir: string): string | null {
  const prefix = dir ? `${dir}/` : "";
  const here = pages.filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
  return here.find((p) => /(?:^|\/)index\.md$/i.test(p)) ?? here.find((p) => /(?:^|\/)readme\.md$/i.test(p)) ?? here[0] ?? pages.find((p) => p.startsWith(prefix)) ?? null;
}

export const docsPath = (repo: RepoCoords, ref: string, page = ""): string => repoPath(repo, "docs", refSegments(ref, page));

/** A page's title for the list: its first heading, else its file name without ".md". */
export function pageTitle(path: string, text?: string | null): string {
  const heading = text ? /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1] : null;
  if (heading) return heading.replace(/[*_`]/g, "").slice(0, 120);
  const name = path.split("/").pop() ?? path;
  if (/^(?:index|readme)\.md$/i.test(name)) return path.includes("/") ? path.split("/").slice(-2, -1)[0] : "Home";
  return name.replace(/\.(?:md|markdown)$/i, "").replace(/[-_]+/g, " ");
}

/** The list of the pages beside the page shown: nested by directory, the current one marked. */
export function docsNav(repo: RepoCoords, ref: string, root: string, pages: readonly string[], current: string): El {
  const prefix = root ? `${root}/` : "";
  const items = pages.map((p) => {
    const rel = p.slice(prefix.length);
    const depth = rel.split("/").length - 1;
    const dirs = rel.split("/").slice(0, -1).join("/");
    const index = /(?:^|\/)(?:index|readme)\.md$/i.test(rel);
    const label = !depth ? pageTitle(rel) : index ? `${dirs}/` : `${dirs}/ ${pageTitle(rel)}`;
    return h("li", { class: depth ? `level-${Math.min(depth + 1, 4)}` : null }, h("a", { href: docsPath(repo, ref, p), "aria-current": p === current ? "page" : null }, label));
  });
  return h("nav", { class: "docs-nav", "aria-label": "The documentation's pages" }, h("p", { class: "docs-root" }, root ? `${root}/` : "The repository's Markdown"), h("ul", null, ...items));
}

/** The resolvers of a documentation page: links to other pages (".md", or ".html" as Jekyll writes
 *  them, or a directory) stay in the documentation; the rest as in any Markdown file. */
export function docsResolvers(c: RepoLinkContext & { pages: readonly string[] }): Pick<MarkdownContext, "resolveLink" | "resolveImage" | "repo"> {
  const base = repoResolvers(c);
  const pages = new Set(c.pages);
  return {
    ...base,
    resolveLink(href: string): string | null {
      if (!href.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//")) {
        const [pathPart, hash = ""] = href.split("#", 2);
        let decoded: string | null = null;
        try {
          decoded = decodeURIComponent(pathPart.split("?")[0]);
        } catch {
          decoded = null;
        }
        const target = decoded === null ? null : joinPath(c.dir, decoded);
        if (target !== null) {
          const stem = target.replace(/\.html?$/i, "").replace(/\/$/, "");
          const page = [target, `${stem}.md`, `${stem}/index.md`, `${stem}/README.md`, stem === "" ? "index.md" : ""].find((p) => p && pages.has(p));
          if (page) return `${docsPath(c.repo, c.ref, page)}${hash ? `#${USER_CONTENT}${slugOf(hash)}` : ""}`;
        }
      }
      return base.resolveLink!(href);
    },
  };
}
