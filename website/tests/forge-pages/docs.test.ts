// The Docs view (night phase 02, E5): src/lib/docs.ts. Where a repository's documentation is, its
// pages in order, the page a directory opens on, the list beside the page, and links between pages
// kept in the view (".md", Jekyll's ".html", a directory); the /r/<o>/<n>/docs/… addresses.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defaultPage, docsNav, docsPages, docsPath, docsResolvers, docsRoot, pageTitle } from "../../src/lib/docs.ts";
import { parseRepoPath } from "../../src/lib/forge.ts";
import { textOf, walk } from "../../src/lib/repo-view.ts";

const repo = { owner: "lab", name: "tool" };
const blobs = (paths: string[]) => paths.map((path) => ({ path, type: "blob" }));

describe("the documentation", () => {
  test("docs/ first, else the root's Markdown, else none", () => {
    assert.equal(docsRoot(blobs(["README.md", "docs/index.md"])), "docs");
    assert.equal(docsRoot(blobs(["README.md", "src/a.py"])), "");
    assert.equal(docsRoot(blobs(["src/a.py", "src/notes.md"])), null);
  });

  test("its pages, the index first in each directory; the page a directory opens on", () => {
    const pages = docsPages(blobs(["docs/usage.md", "docs/index.md", "docs/api/README.md", "docs/api/z.md", "docs/logo.png", "src/x.md"]), "docs");
    assert.deepEqual(pages, ["docs/index.md", "docs/usage.md", "docs/api/README.md", "docs/api/z.md"]);
    assert.equal(defaultPage(pages, "docs"), "docs/index.md");
    assert.equal(defaultPage(pages, "docs/api"), "docs/api/README.md");
    assert.equal(defaultPage(["docs/b.md", "docs/a.md"], "docs"), "docs/b.md");
    assert.equal(defaultPage([], "docs"), null);
  });

  test("the list beside the page, the current one marked", () => {
    const pages = ["docs/index.md", "docs/getting-started.md", "docs/api/README.md"];
    const nav = docsNav(repo, "main", "docs", pages, "docs/getting-started.md");
    const links = [...walk(nav)].filter((e) => e.tag === "a");
    assert.deepEqual(links.map((a) => a.attrs.href), ["/r/lab/tool/docs/main/docs/index.md/", "/r/lab/tool/docs/main/docs/getting-started.md/", "/r/lab/tool/docs/main/docs/api/README.md/"]);
    assert.deepEqual(links.map((a) => a.attrs["aria-current"] ?? null), [null, "page", null]);
    assert.deepEqual(links.map(textOf), ["Home", "getting started", "api/"]);
    assert.equal(pageTitle("docs/x.md", "Intro\n\n## The *setup*\n"), "The setup");
  });

  test("links between pages stay in the view; others go to the code view", () => {
    const pages = ["docs/index.md", "docs/usage.md", "docs/api/index.md"];
    const r = docsResolvers({ repo, ref: "main", dir: "docs", isDir: (p) => p === "docs/api" || p === "src", pages });
    assert.equal(r.resolveLink!("usage.md#Install it"), "/r/lab/tool/docs/main/docs/usage.md/#user-content-install-it");
    assert.equal(r.resolveLink!("usage.html"), "/r/lab/tool/docs/main/docs/usage.md/");
    assert.equal(r.resolveLink!("api/"), "/r/lab/tool/docs/main/docs/api/index.md/");
    assert.equal(r.resolveLink!("../src"), "/r/lab/tool/tree/main/src/");
    assert.equal(r.resolveLink!("https://example.org"), "https://example.org");
    assert.equal(r.resolveLink!("#top"), "#user-content-top");
  });

  test("the addresses", () => {
    assert.equal(docsPath(repo, "main"), "/r/lab/tool/docs/main/");
    assert.deepEqual(parseRepoPath("/r/lab/tool/docs/main/docs/usage.md/"), { owner: "lab", name: "tool", view: "docs", rest: ["main", "docs", "usage.md"] });
    assert.deepEqual(parseRepoPath("/r/lab/tool/docs/"), { owner: "lab", name: "tool", view: "docs", rest: [] });
  });
});
