// The search page's types (night phase 08, E4; src/lib/search-types.ts): a DOI alone goes to its paper;
// repo:owner/name scopes GitHub's issues and commits, read in the reader's browser and shown with links
// into the registry's own pages; code at the source; results only with addresses of this site.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { textOf } from "../../src/lib/repo-view.ts";
import {
  doiAlone,
  githubCodeSearch,
  githubCommitsApi,
  githubIssuesApi,
  lookupUrl,
  parseCommitHits,
  parseIssueHits,
  readType,
  resultView,
  scopeOf,
} from "../../src/lib/search-types.ts";

describe("the search's types", () => {
  it("a DOI typed alone goes to its paper, whatever way it is written", () => {
    assert.equal(doiAlone("10.1234/eeg.2026"), "10.1234/eeg.2026");
    assert.equal(doiAlone("https://doi.org/10.1234/EEG.2026."), "10.1234/EEG.2026");
    assert.equal(doiAlone("doi:10.1234/x"), "10.1234/x");
    assert.equal(doiAlone("eeg 10.1234/x"), null);
    assert.equal(lookupUrl("10.1234/a b"), "/lookup/?doi=10.1234%2Fa%20b");
    assert.equal(readType("people"), "people");
    assert.equal(readType("wiki"), "papers");
  });

  it("repo:owner/name scopes GitHub's searches; the rest is the query", () => {
    const { scope, rest } = scopeOf("filter repo:Ada-Fixture/eeg is:open");
    assert.deepEqual(scope, { owner: "Ada-Fixture", name: "eeg" });
    assert.equal(rest, "filter is:open");
    assert.equal(scopeOf("repo:../x").scope, null);
    assert.equal(githubIssuesApi("filter", { owner: "a", name: "b" }), "https://api.github.com/search/issues?q=filter%20repo%3Aa%2Fb&per_page=20");
    assert.equal(githubCommitsApi("fix", { owner: "a", name: "b" }, "http://127.0.0.1:9490/api"), "http://127.0.0.1:9490/api/search/commits?q=fix%20repo%3Aa%2Fb&per_page=20");
    assert.equal(githubCodeSearch("butter", { owner: "a", name: "b" }), "https://github.com/search?type=code&q=butter%20repo%3Aa%2Fb");
  });

  it("GitHub's answers link into the registry's own pages", () => {
    const issues = parseIssueHits({ items: [{ number: 3, title: "Bug", state: "open", comments: 2 }, { number: 4, title: "PR", state: "closed", pull_request: {} }, { title: "no number" }] }, { owner: "Lab", name: "EEG" });
    assert.deepEqual(issues.map((i) => i.url), ["/r/lab/eeg/issues/3", "/r/lab/eeg/pull/4"]);
    const commits = parseCommitHits({ items: [{ sha: "a".repeat(40), commit: { message: "Fix the filter\n\nLong", committer: { date: "2026-09-01T00:00:00Z" } } }, { sha: "nope" }] }, { owner: "lab", name: "eeg" });
    assert.deepEqual(commits, [{ sha: "a".repeat(40), message: "Fix the filter", date: "2026-09-01", url: `/r/lab/eeg/commit/${"a".repeat(40)}/` }]);
  });

  it("a result shows only an address of this site", () => {
    assert.equal(resultView({ k: "repository", path: "lab/eeg", url: "https://evil.example/" }), null);
    assert.equal(resultView({ k: "repository", path: "lab/eeg", url: "//evil.example/" }), null);
    const repo = resultView({ k: "repository", path: "lab/eeg", url: "/r/lab/eeg/", stars: 2, papers: [{ doi: "10.1/x", title: "An EEG paper" }] });
    assert.match(textOf(repo), /lab\/eeg · 2 stars.*Code of An EEG paper/);
    assert.match(textOf(resultView({ k: "issue", n: 1, title: "Epochs", url: "/research/1", state: "open", paper: "10.1/x" })), /Epochs research#1 · open · the paper 10.1\/x/);
    assert.match(textOf(resultView({ k: "person", handle: "ada", name: "Ada", bio: "mail ada@example.org", url: "/u/ada/" })), /\[email hidden\]/);
  });
});
