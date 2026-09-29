// The Docs view of the /r/ shell (night phase 02, E5): a repository's documentation (the Markdown
// of docs/, or of the root) read as pages, with their list beside them, in science.css. GitHub
// Pages adapted: no author HTML, CSS or JavaScript runs; a Pages site keeps its own address.
//
// What it costs the reader's 60 anonymous GitHub requests an hour: the branches (1, kept for the
// tab) and the commit's tree (1, kept for the tab), as the code view; the pages and their images
// are raw reads, not counted.

import { text as utf8Text } from "../../worker/forge/objects.ts";
import { CODE_LIMITS, degradedView, isDirectory, licenceShows, refSegments, atSource } from "../lib/code-nav.ts";
import { defaultPage, docsNav, docsPages, docsPath, docsResolvers, docsRoot } from "../lib/docs.ts";
import { repoPath } from "../lib/forge.ts";
import { cutForRendering, outline, renderMarkdown } from "../lib/markdown.ts";
import { h } from "../lib/repo-view.ts";
import { show } from "./dom.ts";
import { codeViews, failed, openRef, type Opened, repoRef, sourceUrl, treeExtras } from "./repo-code.ts";
import { fillImages, scrollToHash } from "./repo-markdown.ts";

const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

codeViews.docs = async (slot, env) => {
  show(slot, h("p", { "aria-live": "polite" }, "Reading the documentation…"));
  let opened: Opened;
  try {
    opened = await openRef(env, env.target.rest ?? []);
  } catch (e) {
    failed(slot, e, sourceUrl(env, "tree", (env.target.rest ?? [])[0] ?? env.info.defaultBranch ?? "HEAD", "docs"), "documentation");
    return;
  }
  const ref = opened.ref.ref;
  const root = docsRoot(opened.entries);
  if (root === null) {
    show(slot, h("p", null, "This repository has no documentation in Markdown (a docs/ directory, or Markdown files at its root). ", h("a", { href: repoPath(env.repo, "tree", refSegments(ref)) }, "Its files"), "."));
    return;
  }
  const licence = licenceShows(env.info.licenseSpdx);
  if (!licence.show) {
    show(slot, h("p", null, licence.why), atSource("Its authors can add an open licence to show them.", sourceUrl(env, "tree", opened.commit, root)));
    return;
  }
  const pages = docsPages(opened.entries, root);
  const asked = opened.ref.path;
  const page = !asked || isDirectory(opened.entries, asked) ? defaultPage(pages, asked || root) : pages.includes(asked) ? asked : null;
  const nav = docsNav(env.repo, ref, root, pages, page ?? "");
  if (!page) {
    show(slot, h("div", { class: "docs-layout" }, nav, h("div", { class: "docs-main" }, degradedView({ code: "not_found" }, "", "page"))));
    return;
  }
  let text: string;
  try {
    const f = await env.session.git.readFile(repoRef(env), opened.commit, page, { maxBytes: CODE_LIMITS.displayBytes });
    text = utf8Text(f.bytes);
  } catch (e) {
    failed(slot, e, sourceUrl(env, "blob", opened.commit, page), "page");
    return;
  }
  const { text: shown, cut } = cutForRendering(text, CODE_LIMITS.renderBytes);
  const r = await renderMarkdown(shown, {
    ...docsResolvers({ repo: env.repo, ref, dir: dirOf(page), isDir: (p) => isDirectory(opened.entries, p), web: env.endpoints.web, raw: env.endpoints.raw, pages }),
    sourceUrl: sourceUrl(env, "blob", opened.commit, page),
  });
  const here = repoPath(env.repo, "blob", refSegments(ref, page));
  show(
    slot,
    h(
      "div",
      { class: "docs-layout" },
      nav,
      h(
        "div",
        { class: "docs-main" },
        h("p", { class: "docs-head" }, `The documentation at ${ref}: `, h("code", null, page), " · ", h("a", { href: here }, "Its file in the code view"), " · ", h("a", { href: repoPath(env.repo, "commits", refSegments(ref, page)) }, "History")),
        cut ? h("p", { class: "warning" }, "This page is longer than the viewer renders: the rest is in ", h("a", { href: `${here}?plain=1` }, "its source"), ".") : null,
        outline(r.headings),
        r.el,
      ),
    ),
  );
  await fillImages(slot, env, opened.commit, opened.entries);
  scrollToHash(slot);
};

/** On the home and the root's files: the way to the documentation, when docs/ holds Markdown. */
treeExtras.unshift(async (slot, env, opened, dir) => {
  if (dir !== "" || docsRoot(opened.entries) !== "docs") return;
  show(slot, h("p", { class: "docs-link" }, "Documentation: ", h("a", { href: docsPath(env.repo, opened.ref.ref) }, "read docs/ as pages"), ` (${docsPages(opened.entries, "docs").length.toLocaleString("en-GB")} in Markdown).`));
});
